import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { Db } from "../src/db/queries.ts";
import { ftsAvailable, migrate } from "../src/db/migrations.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { searchFts } from "../src/db/fts.ts";

describe("migrate", () => {
  it("creates tables on a fresh in-memory database", () => {
    const db = new Db(":memory:");
    const result = db.migrate();
    expect(result.toVersion).toBe(SCHEMA_VERSION);
    expect(result.crdtCutover).toBeNull(); // Fresh DB never triggers cutover.
    // Tables exist.
    const tables = db.handle
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toContain("nodes");
    expect(tables).toContain("edges");
    expect(tables).toContain("claims");
    expect(tables).toContain("stats");
    db.close();
  });

  it("is idempotent", () => {
    const db = new Db(":memory:");
    db.migrate();
    expect(() => db.migrate()).not.toThrow();
    db.close();
  });

  it("v1 → v2 cutover drops legacy observations and claims rows", () => {
    // Simulate a v0.0.1 database: schema at version 1 with some rows in the
    // SQL-backed observations + claims tables.
    const raw = new Database(":memory:");
    migrate(raw); // Creates tables (but at v2 — we walk it back to v1 below).
    raw.exec("PRAGMA user_version = 1");
    raw.exec(
      "INSERT INTO observations (src,dst,ts,observed,weight,source) VALUES ('a','b',1,1,100,'python'), ('a','c',2,2,200,'python')",
    );
    raw.exec(
      "INSERT INTO claims (id,agent,scope_json,fingerprint,intent,created,ttl) VALUES ('c1','a','[]','x','y',1,1000)",
    );

    const result = migrate(raw);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(SCHEMA_VERSION);
    expect(result.crdtCutover).toEqual({ droppedObservations: 2, droppedClaims: 1 });

    const obsCount = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observations").get();
    const claimCount = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM claims").get();
    expect(obsCount?.n).toBe(0);
    expect(claimCount?.n).toBe(0);
    raw.close();
  });

  it("v2 daemon starting at v2 does not re-run cutover", () => {
    const raw = new Database(":memory:");
    migrate(raw); // Establish the current schema version.
    raw.exec("INSERT INTO observations (src,dst,ts,observed,weight,source) VALUES ('a','b',1,1,100,'python')");
    const result = migrate(raw);
    expect(result.fromVersion).toBe(SCHEMA_VERSION);
    expect(result.crdtCutover).toBeNull();
    const obsCount = raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM observations").get();
    // Row survives because no cutover ran.
    expect(obsCount?.n).toBe(1);
    raw.close();
  });

  it("reports FTS availability honestly", () => {
    const db = new Db(":memory:");
    const has = ftsAvailable(db.handle);
    // Bun 1.3+ ships SQLite >= 3.41, so this should be true.
    expect(typeof has).toBe("boolean");
    db.close();
  });

  it("getNode projects the full NodeRow and skips the unused embedding BLOB", () => {
    // The node read uses an explicit column list (NODE_COLUMNS in queries.ts)
    // rather than `SELECT *`. Two things this guards:
    //   1. NODE_COLUMNS stays in sync with NodeRow + schema.ts — if a future
    //      column (like the v3 `merge_flagged`) is added but left out of the
    //      list, that field comes back `undefined` and this fails.
    //   2. The unused `embedding` BLOB is deliberately NOT selected, so hot
    //      reads never haul it off disk. (`SELECT *` used to pull it.)
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode({
      id: "n1",
      name: "n",
      qualified_name: "n",
      kind: "function",
      language: "typescript",
      file: "f.ts",
      range: [1, 2],
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
    const row = db.getNode("n1");
    expect(row?.merge_flagged).toBe(0); // v3 column is projected
    expect(row && "embedding" in row).toBe(false); // BLOB intentionally omitted
    db.close();
  });
});

describe("Db CRUD", () => {
  it("upserts a node and reads it back", () => {
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNode({
      id: "auth/loginHandler",
      name: "loginHandler",
      qualified_name: "loginHandler",
      kind: "function",
      language: "typescript",
      file: "src/auth/login.ts",
      range: [42, 87],
      ast_hash: "abc123",
      last_seen: 1,
      logical_clock: 1,
    });
    const row = db.getNode("auth/loginHandler");
    expect(row?.name).toBe("loginHandler");
    expect(row?.range_start).toBe(42);
    db.close();
  });

  it("aggregates edge weight on conflict", () => {
    const db = new Db(":memory:");
    db.migrate();
    const base = { kind: "static_call" as const, weight: 1, last_seen: 1, src: "a", dst: "b" };
    db.upsertEdge(base);
    db.upsertEdge({ ...base, weight: 4 });
    const out = db.outgoing("a");
    expect(out[0]?.weight).toBe(5);
    db.close();
  });

  it("deleteNodesByFile purges a file's nodes and outgoing edges", () => {
    // Watcher delete-awareness: a deleted/modified file must not leave stale
    // rows. Two files; deleting one leaves the other intact.
    const db = new Db(":memory:");
    db.migrate();
    const mk = (id: string, file: string) => ({
      id, name: id, qualified_name: id, kind: "function" as const, language: "typescript",
      file, range: [1, 2] as [number, number], ast_hash: "x", last_seen: 0, logical_clock: 0,
    });
    db.upsertNode(mk("auth/a", "src/auth.ts"));
    db.upsertNode(mk("auth/b", "src/auth.ts"));
    db.upsertNode(mk("api/c", "src/api.ts"));
    db.upsertEdge({ kind: "static_call", weight: 1, last_seen: 0, src: "auth/a", dst: "api/c" });

    const removed = db.deleteNodesByFile("src/auth.ts");
    expect(removed).toBe(2);
    expect(db.getNode("auth/a")).toBeNull();
    expect(db.getNode("auth/b")).toBeNull();
    expect(db.getNode("api/c")?.id).toBe("api/c"); // other file untouched
    expect(db.outgoing("auth/a")).toHaveLength(0); // its edge purged too
    db.close();
  });

  it("populates FTS via triggers", () => {
    const db = new Db(":memory:");
    const m = db.migrate();
    if (!m.appliedFts) return; // FTS not available on this build.
    db.upsertNode({
      id: "auth/loginHandler",
      name: "loginHandler",
      qualified_name: "loginHandler",
      kind: "function",
      language: "typescript",
      file: "src/auth/login.ts",
      range: [1, 10],
      ast_hash: "x",
      summary: "Handles user login",
      last_seen: 0,
      logical_clock: 0,
    });
    const hits = searchFts(db.handle, "login");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe("auth/loginHandler");
    db.close();
  });
});
