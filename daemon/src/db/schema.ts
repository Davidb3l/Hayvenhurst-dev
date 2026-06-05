/**
 * SQLite schema definitions. Markdown files are the source of truth;
 * SQLite is just the index. See PRD section 5.5.
 */

/**
 * The numeric schema version persisted in `PRAGMA user_version`.
 *
 *   1 — initial v0.0.1 schema (SQL-backed traces + claims).
 *   2 — Week 5 CRDT cutover: the `observations` and `claims` tables are
 *       wiped on first start at v2 (see ARCHITECTURE.md §13.4). The tables
 *       themselves remain as a denormalized read cache the daemon can rebuild
 *       from the CRDT op logs.
 *   3 — Week 7 Layer B (ARCHITECTURE.md §17.2): adds the `merge_rejections`
 *       side-table (the `merge_rejected` surface) and a `nodes.merge_flagged`
 *       column so failed-gate files are visibly flagged in the read cache
 *       without rolling back the (already-converged) CRDT. Additive only —
 *       no data is dropped at this step.
 *   4 — Path-searchable FTS: adds a tokenized `path` column to `nodes_fts`,
 *       populated from a normalized form of the node's `file` (+ `id`) so the
 *       directory/file segments become matchable. Before this, FTS indexed only
 *       name/qualified_name/summary, so a query like "schema" missed every
 *       `db/schema/*` entity (their names are `auth`/`projects`/…, and the
 *       `db/schema/` folder — the strongest signal — was invisible). Additive:
 *       a fresh DB gets the column from FTS_SQL; an existing index is rebuilt
 *       in-place by the v3→v4 migration step (no full reingest).
 *   5 — Line-precise call sites: adds the `call_sites` table, one row per
 *       RESOLVED call occurrence `(dst, src, kind, file, line, col)`. The
 *       `edges` table sums occurrences into `weight`; `call_sites` keeps each
 *       occurrence's 1-based (file, line, col) so `hayven refs --sites` can list
 *       exact call locations. Lookup key is `dst` (indexed). Additive — a fresh
 *       DB gets the table from SCHEMA_SQL; an existing DB gains it via the v4→v5
 *       migration step (no full reingest; the table simply fills on next ingest).
 *   6 — Per-test runtime coverage (Phase 0.0.4 — precise test-impact): adds the
 *       `test_coverage` table, one row per (test, entity) the trace collector
 *       observed a specific TEST execute. Where `observations` aggregates edges
 *       GLOBALLY (summed across all tests, losing per-test attribution — which
 *       over-reports `affected-tests`), `test_coverage` keeps the test context so
 *       the precise "which tests actually executed entity X" set is recoverable
 *       (coverage.py-equivalent recall AND precision, language-agnostic). Both
 *       endpoints are RAW runtime names resolved at read time, mirroring
 *       `observations`. Additive — a fresh DB gets it from SCHEMA_SQL; an existing
 *       DB gains it via the v5→v6 migration step (fills on the next traced run).
 */
export const SCHEMA_VERSION = 6;

/** Core relational tables. */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  language        TEXT,
  file            TEXT,
  range_start     INTEGER NOT NULL DEFAULT 0,
  range_end       INTEGER NOT NULL DEFAULT 0,
  ast_hash        TEXT,
  embedding       BLOB,
  summary         TEXT,
  last_seen       INTEGER,
  logical_clock   INTEGER NOT NULL DEFAULT 0,
  last_modified_by TEXT,
  -- §17.2 Layer B: set to 1 when this node's file failed the pre-merge verify
  -- gate. Advisory only — the CRDT is never rolled back; this just makes the
  -- rejected merge visible in the read cache. Cleared on a clean re-ingest.
  merge_flagged   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_name ON nodes(name);

CREATE TABLE IF NOT EXISTS edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  weight     INTEGER NOT NULL DEFAULT 1,
  last_seen  INTEGER,
  PRIMARY KEY (src, dst, kind)
);

CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);

-- Line-precise call sites (schema v5). One row per RESOLVED call OCCURRENCE.
-- The \`edges\` table dedups occurrences into a single (src,dst,kind) row with a
-- summed \`weight\`; this table preserves each occurrence's 1-based (file, line,
-- col) so \`hayven refs --sites\` can print exact \`file:line:col\` call locations.
-- \`dst\` is the lookup key (the symbol whose call sites we want); \`src\` is the
-- caller entity. No primary key — the same (dst,src,file,line,col) is unique by
-- construction (one record per occurrence) and a full ingest clear+rewrites the
-- table, so duplicate rows can't accumulate.
CREATE TABLE IF NOT EXISTS call_sites (
  dst   TEXT NOT NULL,
  src   TEXT NOT NULL,
  kind  TEXT NOT NULL,
  file  TEXT,
  line  INTEGER,
  col   INTEGER
);

CREATE INDEX IF NOT EXISTS call_sites_dst ON call_sites(dst);
CREATE INDEX IF NOT EXISTS call_sites_dst_loc ON call_sites(dst, file, line, col);

CREATE TABLE IF NOT EXISTS claims (
  id          TEXT PRIMARY KEY,
  agent       TEXT,
  scope_json  TEXT,
  fingerprint TEXT,
  intent      TEXT,
  created     INTEGER,
  ttl         INTEGER
);

CREATE TABLE IF NOT EXISTS stats (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  src      TEXT NOT NULL,
  dst      TEXT NOT NULL,
  ts       INTEGER NOT NULL,
  observed INTEGER NOT NULL,
  weight   INTEGER NOT NULL,
  source   TEXT NOT NULL,
  PRIMARY KEY (src, dst, ts, source)
);

CREATE INDEX IF NOT EXISTS observations_dst ON observations(dst);

-- Phase 0.0.4: per-test runtime coverage. One row per (test, entity) the trace
-- collector observed a SPECIFIC test execute. \`test\` and \`entity\` are RAW
-- runtime names (\`<module>:<qualname>\`), resolved to graph node ids at read
-- time (mirrors \`observations\`). \`weight\` sums occurrences within that test.
-- Where \`observations\` is the GLOBAL summed edge graph (precise recall but, when
-- reverse-walked, over-reports because per-test paths collapse through shared
-- hubs), this table preserves the per-test attribution that makes the
-- \`affected-tests\` trace set both complete AND minimal. Lookup key is \`entity\`
-- (indexed): "which tests executed entity X".
CREATE TABLE IF NOT EXISTS test_coverage (
  test   TEXT NOT NULL,
  entity TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  PRIMARY KEY (test, entity, source)
);

CREATE INDEX IF NOT EXISTS test_coverage_entity ON test_coverage(entity);

-- Phase 0.0.4: fleet memory — durable per-agent learnings keyed to the graph,
-- so a later agent (or a future session) inherits what an earlier one discovered
-- instead of re-deriving it. One row per note: a decision, a dead-end, a gotcha,
-- or a freeform note, optionally attached to a graph \`node_id\` (indexed) and/or
-- a \`scope_json\` array of ids. \`ttl\` (seconds, nullable) lets ephemeral notes
-- expire; \`created\` is wall-clock ms. Distinct from \`claims\` (which coordinate
-- concurrent EDITS) — this is shared KNOWLEDGE, read-mostly, never blocks work.
CREATE TABLE IF NOT EXISTS fleet_memory (
  id         TEXT PRIMARY KEY,
  agent      TEXT,
  node_id    TEXT,
  kind       TEXT NOT NULL,
  note       TEXT NOT NULL,
  scope_json TEXT,
  created    INTEGER NOT NULL,
  ttl        INTEGER
);

CREATE INDEX IF NOT EXISTS fleet_memory_node ON fleet_memory(node_id);

-- §17.2 Layer B: the \`merge_rejected\` surface. One row per (file, phase)
-- rejection raised by the pre-merge verify gate. A side-table (not a column)
-- so the reason/phase/language detail survives independent of the nodes a
-- file maps to, and so a file with no surviving nodes can still report why its
-- merge was rejected. \`detected_at\` is wall-clock ms.
CREATE TABLE IF NOT EXISTS merge_rejections (
  file        TEXT NOT NULL,
  phase       TEXT NOT NULL,           -- 'syntax' | 'type'
  language    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  PRIMARY KEY (file, phase)
);

CREATE INDEX IF NOT EXISTS merge_rejections_detected ON merge_rejections(detected_at);
`;

/**
 * FTS5 virtual table with trigram tokenizer (SQLite >=3.34). The columns
 * mirror a subset of `nodes` we want full-text searchable. `id` is UNINDEXED
 * so it round-trips without being tokenized.
 *
 * `path` is the v4 addition: a NORMALIZED form of the node's `file` (+ `id`)
 * with the path separators (`/`, `.`, `-`, `_`) replaced by spaces, so the
 * trigram tokenizer indexes each folder/file segment as its own token. This
 * makes the directory layout searchable — e.g. a query "schema" now matches a
 * node living in `backend/src/db/schema/auth.ts` even when its name is `auth`.
 * `id` stays UNINDEXED so it still round-trips verbatim.
 */
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  qualified_name,
  summary,
  path,
  tokenize = 'trigram'
);
`;

/**
 * SQL expression that normalizes a node's path into a space-separated token
 * string for the FTS `path` column. We combine `file` (richest path coverage)
 * with `id` (covers nodes that have a null/empty `file` but a path-shaped id
 * like `db/schema/auth`), then replace every path/identifier separator
 * (`/`, `.`, `-`, `_`) with a space so the trigram tokenizer sees each segment.
 *
 * Parameterized by the row alias (`new` in triggers, `nodes` in the migration
 * repopulate) so the exact same normalization is used everywhere it matters.
 */
export function ftsPathExpr(alias: string): string {
  const src = `(COALESCE(${alias}.file, '') || ' ' || ${alias}.id)`;
  return `replace(replace(replace(replace(${src}, '/', ' '), '.', ' '), '-', ' '), '_', ' ')`;
}

/**
 * Triggers to keep `nodes_fts` in sync with `nodes`.
 *
 * NB: we cannot use UPSERT-friendly `INSERT OR REPLACE` on the FTS table
 * because FTS5 contentless/external-content modes have a different shape.
 * The triggers below cover the basic mirror case.
 */
export const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(id, name, qualified_name, summary, path)
  VALUES (new.id, new.name, new.qualified_name, COALESCE(new.summary, ''),
          ${ftsPathExpr("new")});
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
  DELETE FROM nodes_fts WHERE id = old.id;
  INSERT INTO nodes_fts(id, name, qualified_name, summary, path)
  VALUES (new.id, new.name, new.qualified_name, COALESCE(new.summary, ''),
          ${ftsPathExpr("new")});
END;
`;
