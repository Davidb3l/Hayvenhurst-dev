/**
 * Lane C regressions in `db/migrations.ts`:
 *
 *   C1 — `hayven reindex` used to call `dropAll`, which dropped `fleet_memory`
 *        (+ its FTS shadow), `observations` and `claims`. None of those are
 *        derivable from a re-parse; fleet memory is agent/user-AUTHORED
 *        knowledge whose only copy is this SQLite file. Verified before the fix:
 *        notes before reindex = 2, after = 0. `dropDerived` must leave every
 *        preserved table byte-for-byte intact while still genuinely clearing the
 *        graph so the follow-up `--full` ingest rebuilds it.
 *
 *   C2 — `migrate()` stamped `user_version` DOWN unconditionally, so an old
 *        binary opening a newer index silently rewrote the version marker and
 *        then wrote through a schema it does not understand.
 *
 * Everything here runs against a throwaway SQLite file under the OS temp dir —
 * no global state, no `~/.hayven`, no registry, no daemon.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REINDEX_PRESERVED_TABLES,
  SchemaTooNewError,
  assertSchemaCompatible,
  currentUserVersion,
  dropDerived,
  migrate,
} from "../src/db/migrations.ts";
import { Db } from "../src/db/queries.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";

let dir: string;
let wrapper: Db;
let db: Database;

/**
 * `dropDerived` now REFUSES to run unless an ingest is marked in flight, so the
 * tests declare one through Lane B's PUBLIC API (`Db.beginIngest`) rather than
 * writing the `stats` key directly. That is deliberate: if Lane B renames the
 * marker key, `dropDerived`'s preserve-list stops matching and these go red,
 * instead of the detector being silently disarmed.
 */
function markThenDrop(): void {
  wrapper.beginIngest();
  dropDerived(db);
}

/** Populate BOTH the derived graph and every non-rebuildable table. */
function seed(d: Database): void {
  d.exec(`
    INSERT INTO nodes (id, name, qualified_name, kind, language, file)
      VALUES ('n1', 'authHandler', 'auth.authHandler', 'function', 'ts', 'src/auth.ts'),
             ('n2', 'login',       'auth.login',       'function', 'ts', 'src/auth.ts');
    INSERT INTO edges (src, dst, kind, weight) VALUES ('n1', 'n2', 'calls', 3);
    INSERT INTO call_sites (dst, src, kind, file, line, col)
      VALUES ('n2', 'n1', 'calls', 'src/auth.ts', 12, 4);
    INSERT INTO merge_rejections (file, phase, language, reason, detected_at)
      VALUES ('src/auth.ts', 'type', 'ts', 'tsc failed', 1);
    INSERT INTO stats (key, value) VALUES ('last_ingest_at', '1700000000000');

    -- Non-rebuildable. A re-parse cannot reproduce ANY of this.
    INSERT INTO fleet_memory (id, agent, node_id, kind, note, created)
      VALUES ('m1', 'agent-a', 'n1', 'decision', 'we rejected the retry loop here', 1),
             ('m2', 'agent-b', NULL, 'gotcha',   'the parser chokes on BOM files',  2);
    INSERT INTO observations (src, dst, ts, observed, weight, source)
      VALUES ('n1', 'n2', 1, 1, 5, 'trace');
    INSERT INTO test_coverage (test, entity, weight, source)
      VALUES ('t:auth', 'auth.login', 1, 'trace');
    INSERT INTO claims (id, agent, scope_json, fingerprint, intent, created, ttl)
      VALUES ('c1', 'agent-a', '["n1"]', 'fp', 'edit', 1, 600);
  `);
}

function count(d: Database, table: string): number {
  return d.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0;
}

function tableExists(d: Database, table: string): boolean {
  const row = d
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(table);
  return (row?.n ?? 0) > 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hayven-fixc-"));
  wrapper = new Db(join(dir, "index.sqlite"));
  db = wrapper.handle;
  migrate(db);
  seed(db);
});

afterEach(() => {
  try {
    wrapper.close();
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("C1: reindex must not destroy non-rebuildable data", () => {
  it("dropDerived preserves fleet memory, observations, claims and test coverage", () => {
    expect(count(db, "fleet_memory")).toBe(2);
    expect(count(db, "fleet_memory_fts")).toBe(2);
    expect(count(db, "observations")).toBe(1);
    expect(count(db, "claims")).toBe(1);
    expect(count(db, "test_coverage")).toBe(1);

    markThenDrop();

    // THE regression: the old `dropAll` left these at 0.
    expect(count(db, "fleet_memory")).toBe(2);
    expect(count(db, "fleet_memory_fts")).toBe(2);
    expect(count(db, "observations")).toBe(1);
    expect(count(db, "claims")).toBe(1);
    expect(count(db, "test_coverage")).toBe(1);

    // Every table on the preserved list must still be a table, not just empty.
    for (const table of REINDEX_PRESERVED_TABLES) {
      expect(tableExists(db, table)).toBe(true);
    }
  });

  it("the actual note TEXT survives, not merely the row count", () => {
    markThenDrop();
    const notes = db
      .query<{ note: string }, []>("SELECT note FROM fleet_memory ORDER BY id")
      .all()
      .map((r) => r.note);
    expect(notes).toEqual([
      "we rejected the retry loop here",
      "the parser chokes on BOM files",
    ]);
  });

  it("still genuinely clears the derived graph", () => {
    markThenDrop();
    for (const table of ["nodes", "edges", "call_sites", "nodes_fts", "merge_rejections"]) {
      expect(tableExists(db, table)).toBe(false);
    }
  });

  it("keeps the `stats` TABLE but clears the keys that claim a successful ingest", () => {
    markThenDrop();
    // `stats` itself must survive — it carries both integrity detectors.
    expect(tableExists(db, "stats")).toBe(true);
    // …while `last_ingest_at` must go, or staleness reports a wiped index fresh.
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stats WHERE key='last_ingest_at'").get()
        ?.n,
    ).toBe(0);
  });

  it("the in-progress MARKER survives the drop (the detector must outlive the wipe)", () => {
    markThenDrop();
    // Read through Lane B's own API, not the raw key, so a rename over there
    // turns this red rather than silently disarming the detector.
    expect(wrapper.ingestInProgressSince()).not.toBeNull();
  });

  it("dropDerived REFUSES to clear an unmarked index", () => {
    // The ordering guard: wiping the graph without first declaring the ingest in
    // flight is precisely what leaves a zero-node index certifying itself healthy.
    expect(() => dropDerived(db)).toThrow(/no ingest is marked in flight/);
    // …and it must not have destroyed anything on the way out.
    expect(count(db, "nodes")).toBe(2);
    expect(count(db, "fleet_memory")).toBe(2);
  });

  it("a re-migrate after the drop rebuilds the graph tables and keeps memory searchable", () => {
    markThenDrop();
    migrate(db); // this is what the follow-up `--full` ingest does on open

    expect(count(db, "nodes")).toBe(0);
    expect(count(db, "edges")).toBe(0);
    expect(tableExists(db, "nodes_fts")).toBe(true);

    // The FTS shadow was never dropped, so recall works with no backfill.
    const hits = db
      .query<{ id: string }, [string]>(
        "SELECT f.id AS id FROM fleet_memory_fts f WHERE f.note MATCH ?",
      )
      .all("retry");
    expect(hits.map((h) => h.id)).toEqual(["m1"]);

    // And the nodes→nodes_fts triggers were recreated, so the rebuilt graph
    // is searchable again (a reindex that left FTS unwired would be silently
    // wrong in exactly the way this lane exists to prevent).
    db.exec(
      "INSERT INTO nodes (id, name, qualified_name, kind) VALUES ('n3','parse','p.parse','function')",
    );
    expect(count(db, "nodes_fts")).toBe(1);
  });

  it("does NOT reset user_version — preserved v7 rows must not look like a fresh DB", () => {
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
    markThenDrop();
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe("call_sites(file) index", () => {
  it("the per-file purge uses an index instead of full-scanning", () => {
    // `deleteCallSitesByFile` runs once per changed file on the incremental
    // ingest path. The pre-existing `(dst, file, line, col)` index cannot serve
    // a `WHERE file = ?` lookup because `dst` is the leading column, so every
    // purge scanned the whole table.
    const plan = db
      .query<{ detail: string }, [string]>(
        "EXPLAIN QUERY PLAN SELECT rowid FROM call_sites WHERE file = ?",
      )
      .all("src/auth.ts")
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("call_sites_file");
    expect(plan).not.toContain("SCAN call_sites");
  });

  it("is applied to an EXISTING index by a plain re-migrate, with no version bump", () => {
    db.exec("DROP INDEX IF EXISTS call_sites_file");
    migrate(db);
    const n = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='call_sites_file'",
      )
      .get()?.n;
    expect(n).toBe(1);
    // Deliberately NOT a SCHEMA_VERSION bump: it is a pure additive index, and
    // bumping would make an index this build touches unreadable to the previous
    // build via `assertSchemaCompatible`, for no benefit.
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe("C2: a schema downgrade must be refused, not silently stamped down", () => {
  it("migrate() throws on an index newer than this build and leaves it untouched", () => {
    const future = SCHEMA_VERSION + 35;
    db.exec(`PRAGMA user_version = ${future}`);
    db.exec("CREATE TABLE future_only (x TEXT)");
    db.exec("INSERT INTO future_only (x) VALUES ('written by a newer daemon')");

    expect(() => migrate(db)).toThrow(SchemaTooNewError);

    // The whole point: no downward rewrite, no data touched.
    expect(currentUserVersion(db)).toBe(future);
    expect(count(db, "future_only")).toBe(1);
  });

  it("the error names BOTH versions so the message is actionable", () => {
    db.exec("PRAGMA user_version = 42");
    let msg = "";
    try {
      migrate(db);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("v42");
    expect(msg).toContain(`v${SCHEMA_VERSION}`);
    expect(msg.toLowerCase()).toContain("upgrade");
  });

  it("equal and OLDER versions still migrate (the guard is one-directional)", () => {
    db.exec("PRAGMA user_version = 1"); // pre-CRDT-cutover index
    const result = migrate(db);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(SCHEMA_VERSION);
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });

  it("assertSchemaCompatible is callable standalone — reindex uses it before dropping", () => {
    expect(() => assertSchemaCompatible(db)).not.toThrow();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => assertSchemaCompatible(db)).toThrow(SchemaTooNewError);
  });
});
