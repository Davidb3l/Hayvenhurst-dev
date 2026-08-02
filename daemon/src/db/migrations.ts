/**
 * Apply schema + migrations to a `bun:sqlite` database handle.
 *
 * For v1 we only need version 0 -> 1 (initial schema). The pattern is set up
 * so future versions slot in without restructuring.
 */
import type { Database } from "bun:sqlite";

import { INGEST_IN_PROGRESS_KEY, inProgressSince, readInFlight } from "./index_health.ts";
import {
  FTS_FLEET_MEMORY_SQL,
  FTS_FLEET_MEMORY_TRIGGERS_SQL,
  FTS_SQL,
  FTS_TRIGGERS_SQL,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  ftsPathExpr,
} from "./schema.ts";

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  appliedFts: boolean;
  /**
   * Set when the Week 5 CRDT cutover (schema v1 → v2) dropped legacy SQL
   * rows from `observations` and `claims`. The caller (lifecycle.ts) emits
   * a `crdt_migration:dropped_legacy_sql_state` log line per
   * ARCHITECTURE.md §13.4 so the user has an audit trail. `null` when no
   * cutover ran on this start.
   */
  crdtCutover: { droppedObservations: number; droppedClaims: number } | null;
}

/**
 * Apply all pending migrations. Idempotent — safe to call on every daemon
 * startup. Returns metadata about what changed.
 */
export function migrate(db: Database): MigrationResult {
  const fromVersion = currentUserVersion(db);
  // MUST be the first thing we do — before SCHEMA_SQL, before any DDL. A
  // downgrade used to be accepted SILENTLY (we ran every migration step and
  // then stamped `user_version` DOWN to this build's SCHEMA_VERSION), so an old
  // binary opening an index a newer daemon wrote would rewrite the version
  // marker, hide the newer tables/columns it cannot see, and let every
  // subsequent write corrupt them. A stale `~/.local/bin/hayven` is exactly the
  // shape of the bug that re-armed today's incident, so this is a hard refusal.
  assertSchemaCompatible(db, fromVersion);
  let appliedFts = false;

  db.exec(SCHEMA_SQL);

  // v2 → v3 (§17.2 Layer B): `CREATE TABLE IF NOT EXISTS` above creates the
  // `merge_rejections` side-table on fresh DBs, but it cannot add the
  // `nodes.merge_flagged` column to a pre-existing `nodes` table. Add it
  // idempotently. (Fresh DBs already have the column from SCHEMA_SQL.)
  ensureNodesMergeFlaggedColumn(db);

  // v4 → v5 (line-precise call sites): the `call_sites` table + its indexes are
  // a pure additive `CREATE TABLE/INDEX IF NOT EXISTS` already emitted by
  // SCHEMA_SQL above, so both fresh and pre-existing DBs gain the empty table
  // here with no extra work — it fills on the next ingest (no full reingest
  // required). Bumping SCHEMA_VERSION to 5 records the cutover. Idempotent.

  // v5 → v6 (per-test runtime coverage): the `test_coverage` table + its index
  // are likewise additive `CREATE … IF NOT EXISTS` in SCHEMA_SQL above, so both
  // fresh and pre-existing DBs gain the empty table here. It fills on the next
  // traced run (a suite run under the collector); no reingest. Bumping
  // SCHEMA_VERSION to 6 records the cutover. Idempotent.

  if (ftsAvailable(db)) {
    // v3 → v4 (path-searchable FTS): an FTS table created before v4 lacks the
    // `path` column, and the `CREATE … IF NOT EXISTS` below would leave it as-is
    // (the table already exists, just with the old shape). Drop + recreate it —
    // with the new triggers — and repopulate from `nodes` so an existing index
    // gains the searchable path WITHOUT a full reingest. Runs only when an old
    // `nodes_fts` is present; a fresh DB skips it and gets the v4 shape directly
    // from FTS_SQL. Idempotent: after it runs once, the table already has `path`
    // and the probe is false on every subsequent start.
    rebuildFtsWithPathColumn(db);

    db.exec(FTS_SQL);
    db.exec(FTS_TRIGGERS_SQL);

    // v6 → v7 (fleet-memory FTS recall): create the `fleet_memory_fts` trigram
    // table + its sync triggers, then BACKFILL it from any existing
    // `fleet_memory` rows so `searchMemory`'s FTS path works on a pre-v7 DB
    // WITHOUT a reingest. `CREATE … IF NOT EXISTS` makes the create idempotent;
    // the backfill is version-gated (only when the table is newly empty but
    // `fleet_memory` already has rows) so it never duplicates on a re-run.
    db.exec(FTS_FLEET_MEMORY_SQL);
    db.exec(FTS_FLEET_MEMORY_TRIGGERS_SQL);
    backfillFleetMemoryFts(db);

    appliedFts = true;
  }

  const crdtCutover = fromVersion < 2 && fromVersion > 0 ? cutoverV1toV2(db) : null;

  setUserVersion(db, SCHEMA_VERSION);
  return { fromVersion, toVersion: SCHEMA_VERSION, appliedFts, crdtCutover };
}

/**
 * Schema v1 → v2 cutover for the Week 5 CRDT layer. Pre-MVP; no production
 * users (ARCHITECTURE.md §10 Q2). We drop the legacy SQL rows rather than
 * synthesize CRDT ops with fake logical clocks, because the latter risks
 * silent ordering bugs that bite long after the migration has shipped.
 *
 * Wrapped in a single transaction so a crash mid-migration leaves the DB at
 * v1 — the migration will simply re-run on the next start.
 */
function cutoverV1toV2(db: Database): { droppedObservations: number; droppedClaims: number } {
  const obs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observations").get();
  const cl = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims").get();
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM observations");
    db.exec("DELETE FROM claims");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    droppedObservations: obs?.n ?? 0,
    droppedClaims: cl?.n ?? 0,
  };
}

/**
 * Idempotently add `nodes.merge_flagged` (§17.2 Layer B). Safe to run on every
 * start: probes the table_info pragma and only ALTERs when the column is
 * missing, so it never errors on a DB that already has it.
 */
function ensureNodesMergeFlaggedColumn(db: Database): void {
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(nodes)")
    .all();
  if (cols.some((c) => c.name === "merge_flagged")) return;
  db.exec("ALTER TABLE nodes ADD COLUMN merge_flagged INTEGER NOT NULL DEFAULT 0");
}

/**
 * v3 → v4 (path-searchable FTS): rebuild a pre-v4 `nodes_fts` so it carries the
 * tokenized `path` column, then repopulate it from the existing `nodes` table.
 *
 * Probes the live FTS table's columns: if `nodes_fts` is absent (fresh DB —
 * FTS_SQL will create the v4 shape) or already has `path` (already migrated),
 * this is a no-op, so it's safe to run on every start. When an OLD shape is
 * found we DROP the triggers + table and recreate them from the v4 SCHEMA in
 * the caller (`FTS_SQL` + `FTS_TRIGGERS_SQL` run right after), then INSERT one
 * row per node with the SAME normalized `path` expression the triggers use
 * (`ftsPathExpr`). Wrapped in a transaction so a crash mid-rebuild leaves the
 * DB at v3 and the migration simply re-runs next start.
 */
function rebuildFtsWithPathColumn(db: Database): void {
  // Does an FTS table exist at all? (sqlite_master lists virtual tables.)
  const exists = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='nodes_fts'",
    )
    .get();
  if ((exists?.n ?? 0) === 0) return; // Fresh DB — FTS_SQL creates the v4 shape.

  // Already has `path`? Then we're at v4 already — nothing to do.
  const cols = db
    .query<{ name: string }, []>("PRAGMA table_info(nodes_fts)")
    .all();
  if (cols.some((c) => c.name === "path")) return;

  db.exec("BEGIN");
  try {
    // Drop the old triggers + table so the caller's `IF NOT EXISTS` recreate
    // gets the NEW (v4, path-bearing) shape rather than skipping an existing one.
    db.exec(`
      DROP TRIGGER IF EXISTS nodes_fts_ai;
      DROP TRIGGER IF EXISTS nodes_fts_ad;
      DROP TRIGGER IF EXISTS nodes_fts_au;
      DROP TABLE   IF EXISTS nodes_fts;
    `);
    db.exec(FTS_SQL);
    db.exec(FTS_TRIGGERS_SQL);
    // Repopulate from the existing nodes rows. Same normalized path expression
    // (aliased to the `nodes` row here) the triggers use, so a migrated index is
    // byte-identical to a freshly-ingested one.
    db.exec(
      `INSERT INTO nodes_fts(id, name, qualified_name, summary, path)
         SELECT id, name, qualified_name, COALESCE(summary, ''),
                ${ftsPathExpr("nodes")}
           FROM nodes`,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * v6 → v7 (fleet-memory FTS recall): backfill `fleet_memory_fts` from the
 * existing `fleet_memory` rows.
 *
 * The table + triggers are created just before this runs, but the triggers only
 * mirror FUTURE writes — a DB that already accumulated notes before v7 would have
 * an EMPTY FTS index and `searchMemory`'s FTS path would silently return nothing
 * for those rows. We close that gap once: when the FTS index is empty but the
 * base table has rows, copy every (id, note) across. Idempotent + safe to run on
 * every start:
 *   - if `fleet_memory_fts` already has ANY row (a normal populated DB, or a
 *     prior backfill), it's a no-op (the count guard short-circuits);
 *   - a fresh DB has no `fleet_memory` rows, so the SELECT is empty anyway.
 * The count guard (rather than an unconditional INSERT) is what keeps a populated
 * v7 DB from double-inserting on the next start. Wrapped in a transaction so a
 * crash mid-backfill leaves the index empty and the backfill simply re-runs.
 */
function backfillFleetMemoryFts(db: Database): void {
  const ftsCount = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fleet_memory_fts")
    .get();
  if ((ftsCount?.n ?? 0) > 0) return; // already populated — nothing to backfill.

  const memCount = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fleet_memory")
    .get();
  if ((memCount?.n ?? 0) === 0) return; // fresh / empty base table — nothing to copy.

  db.exec("BEGIN");
  try {
    db.exec("INSERT INTO fleet_memory_fts(id, note) SELECT id, note FROM fleet_memory");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function currentUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

/** Thrown when an index was written by a hayven NEWER than this build. */
export class SchemaTooNewError extends Error {
  readonly indexVersion: number;
  readonly buildVersion: number;
  constructor(indexVersion: number, buildVersion: number) {
    super(
      `this index was written by a NEWER hayven (schema v${indexVersion}); ` +
        `this build only understands schema v${buildVersion}.\n` +
        "Refusing to touch it. Migrating an index DOWN silently discards the newer " +
        "schema's tables and columns and corrupts what the newer daemon wrote.\n" +
        "Upgrade hayven (or run the newer binary), then retry. If you are certain " +
        "you want the old build, point it at a different index directory instead.",
    );
    this.name = "SchemaTooNewError";
    this.indexVersion = indexVersion;
    this.buildVersion = buildVersion;
  }
}

/**
 * Refuse to operate on an index newer than this build understands.
 *
 * `migrate()` calls this before ANY DDL; destructive CLI paths that open the DB
 * WITHOUT migrating (`hayven reindex` opens a raw {@link Db} and drops tables)
 * must call it themselves — otherwise a stale binary happily rewrites an index
 * whose shape it does not know.
 *
 * Equal or older is fine (older is what the migration steps above are FOR).
 * Only "newer than us" is unrecoverable, because we cannot know what to preserve.
 */
export function assertSchemaCompatible(db: Database, fromVersion?: number): void {
  const version = fromVersion ?? currentUserVersion(db);
  if (version > SCHEMA_VERSION) throw new SchemaTooNewError(version, SCHEMA_VERSION);
}

function setUserVersion(db: Database, version: number): void {
  // PRAGMA does not support parameter binding in sqlite.
  db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
}

/**
 * Detect whether the running SQLite build was compiled with FTS5 + trigram
 * tokenizer. Trigram needs >= 3.34. We probe by attempting a no-op CREATE
 * inside a savepoint; if it fails, FTS is unavailable.
 */
export function ftsAvailable(db: Database): boolean {
  try {
    db.exec("SAVEPOINT fts_probe");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x, tokenize='trigram')");
    db.exec("DROP TABLE IF EXISTS _fts_probe");
    db.exec("RELEASE fts_probe");
    return true;
  } catch {
    try {
      db.exec("ROLLBACK TO fts_probe");
      db.exec("RELEASE fts_probe");
    } catch {
      // Ignore — probing failed.
    }
    return false;
  }
}

/**
 * Tables a `hayven reindex` MUST NOT destroy, because nothing can re-derive
 * them from a re-parse of the working tree:
 *
 *   - `fleet_memory` (+ its FTS shadow) — agent/user-AUTHORED knowledge:
 *     decisions, dead-ends, gotchas. There is no CRDT op-log behind it and no
 *     markdown mirror; SQLite is the only copy. This is the single most
 *     valuable non-derivable thing in the index.
 *   - `observations` / `test_coverage` — RUNTIME trace history. Only a traced
 *     run produces these; a parser cannot.
 *   - `claims` — live coordination state for other agents mid-edit.
 *
 * The old `dropAll` dropped the first three of these (and kept `test_coverage`
 * purely by accident of hand-enumeration), so `hayven reindex` silently and
 * permanently deleted user knowledge while its own help text said markdown was
 * "left untouched". {@link dropDerived} is the replacement.
 */
export const REINDEX_PRESERVED_TABLES = [
  "fleet_memory",
  "fleet_memory_fts",
  "observations",
  "claims",
  "test_coverage",
] as const;

/**
 * `stats` KEYS that must survive a reindex, because they are the two
 * independent detectors that make a half-written index announce itself
 * (`Db.checkIndexIntegrity`):
 *
 *   - `ingest_in_progress` — the in-flight ownership tokens. Set before the
 *     wipe, retracted only after the rebuild commits.
 *   - `last_ingest_nodes`  — the node-count watermark. `nodes === 0` while this
 *     says otherwise is unambiguous corruption, and it fires even if the marker
 *     was somehow lost.
 *
 * `dropDerived` used to `DROP TABLE stats`, which destroyed BOTH in the same
 * breath as the graph. A Ctrl-C or OOM between the drop and the follow-on
 * ingest then left a zero-node index reporting `{ok:true,reason:"ok"}` and
 * `stale:false`, so every query answered "No matches" and the user read that as
 * a fact about their code — the exact failure the marker discipline exists to
 * prevent. Everything ELSE in `stats` (`last_ingest_at`, `last_ingest_git_head`,
 * `last_ingest_warnings`) is deliberately cleared: those assert a SUCCESSFUL
 * ingest that has not happened yet, and leaving `last_ingest_at` behind is what
 * makes staleness lie.
 *
 * The marker key is the SHARED constant from `db/index_health.ts`, not a
 * literal: it used to be duplicated here (and privately in `db/queries.ts`), so
 * a rename could have silently taken this list out of sync with the detector it
 * exists to preserve.
 */
export const REINDEX_PRESERVED_STAT_KEYS = [
  INGEST_IN_PROGRESS_KEY,
  "last_ingest_nodes",
] as const;

/**
 * True when an ingest has declared itself in flight (any live token).
 *
 * Delegates to the ONE marker grammar in `db/index_health.ts`. This used to
 * hand-roll a third interpretation of the same row (`""` and `"[]"` absent,
 * everything else present), which disagreed with both `Db.ingestInProgressSince`
 * and `hasSeedableContent` on `"0"` and on non-numeric junk. Three readers of
 * one marker is how a detector ends up armed in one code path and disarmed in
 * another.
 */
function hasIngestMarker(db: Database): boolean {
  try {
    return inProgressSince(readInFlight(db)) !== null;
  } catch {
    return false; // no `stats` table at all — nothing has been marked.
  }
}

/**
 * COUNT(*) for each preserved table that currently exists. Missing tables are
 * omitted rather than counted as 0, so a pre-v7 index (no `fleet_memory_fts`)
 * does not read as "rows vanished".
 */
function preservedCounts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of REINDEX_PRESERVED_TABLES) {
    const exists = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table);
    if ((exists?.n ?? 0) === 0) continue;
    const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get();
    out[table] = row?.n ?? 0;
  }
  return out;
}

/**
 * Drop ONLY the tables a full re-ingest re-derives, for `hayven reindex`.
 *
 * Derived = `nodes`, `edges`, `call_sites`, the `nodes_fts` shadow, the
 * `merge_rejections` advisory side-table, and `stats` (pure ingest bookkeeping:
 * `last_ingest_*`, `ingest_in_progress`). Everything in
 * {@link REINDEX_PRESERVED_TABLES} is left in place — we PRESERVE rather than
 * drop-and-restore, so there is no window in which the only copy of a user's
 * fleet memory lives in a JS array.
 *
 * Two deliberate non-obvious choices:
 *
 *  - `user_version` is NOT reset. The old code stamped it to 0 because it had
 *    just emptied the whole database; now that v7 data SURVIVES, claiming v0
 *    would invite a re-migration against rows the migrations already ran on.
 *    The schema version genuinely did not change, so neither does the marker.
 *  - `fleet_memory`'s FTS triggers are NOT dropped. They only fire on
 *    `fleet_memory` writes, which this function does not perform.
 *
 * `fleet_memory.node_id` values referencing dropped nodes are intentionally left
 * dangling (there is no FK): the re-ingest reproduces the same node ids, so a
 * note re-attaches to its symbol rather than being orphaned.
 *
 * TRIPWIRE: the whole thing runs in one transaction and re-counts every
 * preserved table afterwards. If a row count moved — someone added a table to
 * the drop list, or a trigger cascaded — we ROLL BACK and throw instead of
 * proceeding. Losing the reindex is recoverable; losing fleet memory is not.
 */
export function dropDerived(db: Database): void {
  // PRECONDITION, not a courtesy: the caller must ALREADY have declared the
  // ingest in flight (`Db.beginIngest()`), because the instant the graph is
  // gone the index is unusable and only that marker says so. Refusing here is
  // what makes the "wipe first, mark never" ordering structurally impossible to
  // reintroduce from a future call site.
  if (!hasIngestMarker(db)) {
    throw new Error(
      "refusing to clear the graph: no ingest is marked in flight. " +
        "Call `db.beginIngest()` on this handle FIRST, otherwise an interrupted " +
        "rebuild leaves a zero-node index that reports itself healthy.",
    );
  }

  const keepKeys = REINDEX_PRESERVED_STAT_KEYS.map((k) => `'${k}'`).join(", ");
  db.exec("BEGIN");
  try {
    const before = preservedCounts(db);
    db.exec(`
      DROP TRIGGER IF EXISTS nodes_fts_ai;
      DROP TRIGGER IF EXISTS nodes_fts_ad;
      DROP TRIGGER IF EXISTS nodes_fts_au;
      DROP TABLE  IF EXISTS nodes_fts;
      DROP TABLE  IF EXISTS merge_rejections;
      DROP TABLE  IF EXISTS call_sites;
      DROP TABLE  IF EXISTS edges;
      DROP TABLE  IF EXISTS nodes;
      -- NOT \`DROP TABLE stats\`: that took the in-progress marker and the node
      -- watermark down with the graph. Clear only the keys that claim a
      -- successful ingest.
      DELETE FROM stats WHERE key NOT IN (${keepKeys});
    `);
    // Second tripwire, same spirit as the row-count one: the marker must still
    // be standing on the way out. If a future edit puts `stats` back on the drop
    // list, this rolls the whole thing back instead of shipping a wipe with no
    // detector behind it.
    if (!hasIngestMarker(db)) {
      throw new Error(
        "reindex aborted: clearing the graph would have destroyed the " +
          "ingest-in-progress marker, leaving an interrupted rebuild " +
          "indistinguishable from a healthy empty index. Nothing was changed.",
      );
    }
    const after = preservedCounts(db);
    for (const [table, count] of Object.entries(before)) {
      if (after[table] !== count) {
        throw new Error(
          `reindex aborted: it would have destroyed non-rebuildable data. ` +
            `"${table}" went from ${count} to ${after[table] ?? "missing"} rows. ` +
            "Nothing was changed. This is a bug in hayven; please report it.",
        );
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
