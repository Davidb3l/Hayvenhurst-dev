/**
 * Apply schema + migrations to a `bun:sqlite` database handle.
 *
 * For v1 we only need version 0 -> 1 (initial schema). The pattern is set up
 * so future versions slot in without restructuring.
 */
import type { Database } from "bun:sqlite";

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

/** Drop all tables (used by `hayven reindex`). */
export function dropAll(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS nodes_fts_ai;
    DROP TRIGGER IF EXISTS nodes_fts_ad;
    DROP TRIGGER IF EXISTS nodes_fts_au;
    DROP TRIGGER IF EXISTS fleet_memory_fts_ai;
    DROP TRIGGER IF EXISTS fleet_memory_fts_ad;
    DROP TABLE  IF EXISTS nodes_fts;
    DROP TABLE  IF EXISTS fleet_memory_fts;
    DROP TABLE  IF EXISTS fleet_memory;
    DROP TABLE  IF EXISTS edges;
    DROP TABLE  IF EXISTS call_sites;
    DROP TABLE  IF EXISTS claims;
    DROP TABLE  IF EXISTS stats;
    DROP TABLE  IF EXISTS observations;
    DROP TABLE  IF EXISTS merge_rejections;
    DROP TABLE  IF EXISTS nodes;
  `);
  db.exec("PRAGMA user_version = 0");
}
