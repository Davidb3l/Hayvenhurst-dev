// Schema v7 → v8: the entity-id scheme migration (KNOWN_ISSUES #1).
//
// `scopeForFile` stopped eliding the first `src/` segment, so every stored id
// changes spelling. The graph is re-derivable and is dropped; `fleet_memory` is
// NOT re-derivable (agent/user-authored knowledge, no markdown mirror, no CRDT
// op log behind it — SQLite is the only copy) so its anchors must be REWRITTEN,
// never dropped. An earlier round already had to fix `reindex` for destroying
// exactly this table, which is why the preservation assertions here are
// row-for-row rather than "it still has some rows".
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { readIndexIntegrity } from "../src/db/index_health.ts";
import { migrate } from "../src/db/migrations.ts";
import {
  FTS_FLEET_MEMORY_SQL,
  FTS_FLEET_MEMORY_TRIGGERS_SQL,
  FTS_SQL,
  FTS_TRIGGERS_SQL,
  SCHEMA_SQL,
} from "../src/db/schema.ts";

/**
 * A throwaway in-memory index in the shape a v7 daemon left behind.
 *
 * v7 → v8 involves NO DDL change — only the SPELLING of the ids stored in the
 * existing columns — so building it from the current SCHEMA_SQL and stamping
 * `user_version = 7` is a faithful v7 index, not an approximation.
 *
 * The node set is deliberately the KNOWN_ISSUES #1 shape: `a/src/b.ts` and
 * `a/b.ts` both collided onto the module id `a/b` under v7, so a v7 index can
 * only ever have held ONE of them. That is what a real upgrader's index looks
 * like, and the migration has to remap anchors against it.
 */
function makeV7Index(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec(FTS_SQL);
  db.exec(FTS_TRIGGERS_SQL);
  db.exec(FTS_FLEET_MEMORY_SQL);
  db.exec(FTS_FLEET_MEMORY_TRIGGERS_SQL);

  const node = db.query<never, [string, string, string, string, string]>(
    "INSERT INTO nodes (id, name, qualified_name, kind, file) VALUES (?, ?, ?, ?, ?)",
  );
  // v7 ids: `src/` elided from the scope.
  node.run("auth/login", "login", "login", "module", "src/auth/login.ts");
  node.run("auth/login/loginHandler", "loginHandler", "loginHandler", "function", "src/auth/login.ts");
  node.run("auth/login/Session.refresh", "refresh", "Session.refresh", "method", "src/auth/login.ts");
  // A file with no `src/` anywhere — its id must NOT move.
  node.run("lib/util/x", "x", "x", "module", "lib/util/x.py");
  // The collision survivor: under v7 `a/src/b.ts` won the id `a/b`.
  node.run("a/b", "b", "b", "module", "a/src/b.ts");

  db.exec(
    "INSERT INTO edges (src, dst, kind, weight) VALUES " +
      "('auth/login/loginHandler', 'auth/login/Session.refresh', 'static_call', 1)",
  );
  db.exec(
    "INSERT INTO call_sites (dst, src, kind, file, line, col) VALUES " +
      "('auth/login/Session.refresh', 'auth/login/loginHandler', 'static_call', 'src/auth/login.ts', 3, 5)",
  );

  const mem = db.query<never, [string, string, string | null, string, string, string | null]>(
    "INSERT INTO fleet_memory (id, agent, node_id, kind, note, scope_json, created) " +
      "VALUES (?, ?, ?, ?, ?, ?, 1000)",
  );
  mem.run("m1", "agentA", "auth/login/loginHandler", "gotcha", "loginHandler swallows 401s", null);
  mem.run("m2", "agentB", "lib/util/x", "decision", "x.py stays sync on purpose", null);
  mem.run("m3", "agentC", "a/b", "dead-end", "tried caching module b", null);
  // A scoped note mixing a remappable id, an already-correct id, and an id that
  // matches no node at all (the migration must keep that last one verbatim).
  mem.run(
    "m4",
    "agentD",
    null,
    "note",
    "the auth + util lanes interact",
    JSON.stringify(["auth/login", "lib/util/x", "ghost/entity/never/indexed"]),
  );
  // An unanchored note — nothing to rewrite, must survive untouched.
  mem.run("m5", "agentE", null, "note", "no anchor at all", null);

  db.exec(
    "INSERT INTO claims (id, agent, scope_json, intent, created, ttl) " +
      "VALUES ('c1', 'agentA', '[\"auth/login/loginHandler\"]', 'refactor', 1000, 9999999999999)",
  );
  db.exec(
    "INSERT INTO observations (src, dst, ts, observed, weight, source) " +
      "VALUES ('auth/login/loginHandler', 'auth/login/Session.refresh', 5, 1, 2, 'py')",
  );
  db.exec(
    "INSERT INTO test_coverage (test, entity, weight, source) " +
      "VALUES ('tests/test_auth.py::test_login', 'auth:loginHandler', 1, 'py')",
  );

  const stat = db.query<never, [string, string]>("INSERT INTO stats (key, value) VALUES (?, ?)");
  stat.run("last_ingest_nodes", "5");
  stat.run("last_ingest_at", "1700000000000");
  stat.run("last_ingest_git_head", "deadbeef");

  db.exec("PRAGMA user_version = 7");
  return db;
}

function memoryRow(db: Database, id: string) {
  return db
    .query<{ id: string; node_id: string | null; note: string; scope_json: string | null }, [string]>(
      "SELECT id, node_id, note, scope_json FROM fleet_memory WHERE id = ?",
    )
    .get(id);
}

function count(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? -1;
}

function userVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;
}

describe("v7 → v8 id-scheme migration", () => {
  it("reports what it did", () => {
    const db = makeV7Index();
    const res = migrate(db);
    expect(res.fromVersion).toBe(7);
    expect(res.toVersion).toBe(8);
    expect(res.idScheme).not.toBeNull();
    // 4 of the 5 nodes change spelling; `lib/util/x` does not.
    expect(res.idScheme!.remapped).toBe(4);
    expect(res.idScheme!.ambiguous).toBe(0);
    db.close();
  });

  it("REWRITES fleet_memory anchors to the new ids (never drops them)", () => {
    const db = makeV7Index();
    const before = count(db, "fleet_memory");
    migrate(db);

    // Not one note may go missing — this table is the only copy.
    expect(count(db, "fleet_memory")).toBe(before);
    expect(count(db, "fleet_memory")).toBe(5);

    expect(memoryRow(db, "m1")?.node_id).toBe("src/auth/login/loginHandler");
    // No `src/` in this file's path — the anchor must be left exactly as it was.
    expect(memoryRow(db, "m2")?.node_id).toBe("lib/util/x");
    // The collision survivor was `a/src/b.ts`, so its anchor follows that file.
    expect(memoryRow(db, "m3")?.node_id).toBe("a/src/b");
    // Untouched, and still unanchored.
    expect(memoryRow(db, "m5")?.node_id).toBeNull();

    // Note TEXT is never rewritten — only the anchors.
    expect(memoryRow(db, "m1")?.note).toBe("loginHandler swallows 401s");
    db.close();
  });

  it("rewrites scope_json element-wise and preserves ids it does not recognise", () => {
    const db = makeV7Index();
    migrate(db);
    const scope = JSON.parse(memoryRow(db, "m4")!.scope_json!) as string[];
    expect(scope).toEqual([
      "src/auth/login",
      "lib/util/x",
      // Matches no node, so the migration must not invent a rewrite for it.
      "ghost/entity/never/indexed",
    ]);
    db.close();
  });

  it("keeps fleet_memory_fts consistent with the rewritten rows", () => {
    const db = makeV7Index();
    migrate(db);
    // The FTS shadow indexes (id, note) — neither changes — so it must still
    // have exactly one row per note and still match on the note text.
    expect(count(db, "fleet_memory_fts")).toBe(count(db, "fleet_memory"));
    const hit = db
      .query<{ id: string }, []>("SELECT id FROM fleet_memory_fts WHERE note MATCH 'swallows'")
      .all();
    expect(hit.map((h) => h.id)).toEqual(["m1"]);
    db.close();
  });

  it("preserves the other non-rebuildable tables untouched", () => {
    const db = makeV7Index();
    migrate(db);
    expect(count(db, "observations")).toBe(1);
    expect(count(db, "test_coverage")).toBe(1);
    expect(count(db, "claims")).toBe(1);
    db.close();
  });

  it("DROPS the id-keyed graph (it is re-derived by the forced reindex)", () => {
    const db = makeV7Index();
    migrate(db);
    expect(count(db, "nodes")).toBe(0);
    expect(count(db, "edges")).toBe(0);
    expect(count(db, "call_sites")).toBe(0);
    expect(count(db, "nodes_fts")).toBe(0);
    db.close();
  });

  it("leaves the index reading as UNUSABLE until the reindex runs", () => {
    const db = makeV7Index();
    migrate(db);
    // `last_ingest_nodes` is deliberately preserved so this existing detector
    // fires. Without it a wiped graph would report itself fresh-and-empty and
    // every query would answer "no matches" as if that were a fact about the
    // user's code.
    const integrity = readIndexIntegrity(db);
    expect(integrity.ok).toBe(false);
    expect(integrity.reason).toBe("empty-but-claims-content");
    expect(integrity.claimedNodes).toBe(5);
    db.close();
  });

  it("clears the stats that would otherwise claim a successful ingest", () => {
    const db = makeV7Index();
    migrate(db);
    const get = (k: string) =>
      db.query<{ value: string }, [string]>("SELECT value FROM stats WHERE key = ?").get(k)?.value ??
      null;
    expect(get("last_ingest_nodes")).toBe("5"); // preserved — it is the detector
    expect(get("last_ingest_at")).toBeNull(); // cleared — that ingest's output is gone
    expect(get("last_ingest_git_head")).toBeNull();
    expect(get("id_scheme_v8_migrated_at")).not.toBeNull();
    db.close();
  });

  it("is idempotent — a second migrate() is a no-op", () => {
    const db = makeV7Index();
    migrate(db);
    const anchors = memoryRow(db, "m1")?.node_id;
    const second = migrate(db);
    expect(second.fromVersion).toBe(8);
    expect(second.idScheme).toBeNull();
    // The critical half: a re-run must not remap an ALREADY-remapped anchor.
    expect(memoryRow(db, "m1")?.node_id).toBe(anchors);
    expect(count(db, "fleet_memory")).toBe(5);
    db.close();
  });

  it("does nothing to a brand-new (v0) database", () => {
    const db = new Database(":memory:");
    const res = migrate(db);
    expect(res.fromVersion).toBe(0);
    expect(res.idScheme).toBeNull();
    expect(userVersion(db)).toBe(8);
    db.close();
  });

  // AMBIGUITY GUARD. A repo holding both a FILE and a DIRECTORY of the same name
  // can land two distinct old ids on one new id (`a/src.ts::function b` and
  // `a/src/b.ts::module b` both spell `a/src/b`). Merging those anchors would
  // turn a stale note into a confidently MISATTRIBUTED one, which is strictly
  // worse than a visibly unanchored one.
  it("refuses to remap two old ids that collapse onto one new id", () => {
    const db = makeV7Index();
    const node = db.query<never, [string, string, string, string, string]>(
      "INSERT INTO nodes (id, name, qualified_name, kind, file) VALUES (?, ?, ?, ?, ?)",
    );
    // `a/src.ts` module `src`, function `b`  → v7 id `a/src/b`, v8 id `a/src/b`
    // `a/src/b.ts` module `b`                → v7 id `a/b`,     v8 id `a/src/b`
    node.run("a/src/b", "b", "b", "function", "a/src.ts");
    db.exec("UPDATE fleet_memory SET node_id = 'a/src/b' WHERE id = 'm5'");

    const res = migrate(db);
    expect(res.idScheme!.ambiguous).toBeGreaterThan(0);
    // Both anchors are left alone rather than merged onto one symbol.
    expect(memoryRow(db, "m3")?.node_id).toBe("a/b");
    expect(memoryRow(db, "m5")?.node_id).toBe("a/src/b");
    db.close();
  });

  describe("atomicity — a partial migration must be unrepresentable", () => {
    it("rolls back the ANCHOR REWRITE when the step aborts", () => {
      const db = makeV7Index();
      // Abort at the first anchor UPDATE, i.e. before the graph is dropped.
      db.exec(
        "CREATE TRIGGER boom BEFORE UPDATE ON fleet_memory BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      expect(() => migrate(db)).toThrow();

      expect(userVersion(db)).toBe(7);
      expect(memoryRow(db, "m1")?.node_id).toBe("auth/login/loginHandler");
      expect(count(db, "nodes")).toBe(5);
      db.close();
    });

    it("rolls back the GRAPH DROP and the version stamp when the step aborts AFTER the drop", () => {
      const db = makeV7Index();
      // Abort at the audit-stat INSERT, which runs AFTER the anchors are
      // rewritten AND after the graph is dropped. If DDL or the version stamp
      // escaped the transaction, this test is what catches it.
      db.exec("CREATE TRIGGER boom BEFORE INSERT ON stats BEGIN SELECT RAISE(ABORT, 'boom'); END");
      expect(() => migrate(db)).toThrow();

      // The whole step must have unwound: version, graph AND anchors.
      expect(userVersion(db)).toBe(7);
      expect(count(db, "nodes")).toBe(5);
      expect(count(db, "edges")).toBe(1);
      expect(count(db, "call_sites")).toBe(1);
      expect(memoryRow(db, "m1")?.node_id).toBe("auth/login/loginHandler");
      expect(memoryRow(db, "m4")?.scope_json).toBe(
        JSON.stringify(["auth/login", "lib/util/x", "ghost/entity/never/indexed"]),
      );
      db.close();
    });

    it("re-runs cleanly after an aborted attempt", () => {
      const db = makeV7Index();
      db.exec("CREATE TRIGGER boom BEFORE INSERT ON stats BEGIN SELECT RAISE(ABORT, 'boom'); END");
      expect(() => migrate(db)).toThrow();
      // Whatever interrupted us is gone; the next daemon start must complete it.
      db.exec("DROP TRIGGER boom");

      const res = migrate(db);
      expect(res.idScheme).not.toBeNull();
      expect(userVersion(db)).toBe(8);
      expect(memoryRow(db, "m1")?.node_id).toBe("src/auth/login/loginHandler");
      expect(count(db, "fleet_memory")).toBe(5);
      db.close();
    });
  });
});
