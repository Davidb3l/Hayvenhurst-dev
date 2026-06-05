import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { Db } from "../src/db/queries.ts";
import { migrate } from "../src/db/migrations.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { searchFts } from "../src/db/fts.ts";

/**
 * v4 path-searchable FTS gate.
 *
 * ROOT CAUSE (dogfound 2026-06-01): `nodes_fts` indexed only
 * name/qualified_name/summary, so a query like "schema" missed every
 * `db/schema/*` entity whose NAME was `auth`/`projects`/… — the `db/schema/`
 * folder (the strongest locating signal) was invisible. The v4 fix adds a
 * normalized, tokenized `path` column populated from `file` (+ `id`).
 *
 * These tests build a tiny index directly (no daemon, no binary) and assert the
 * folder/file segments are now matchable, while exact-identifier search still
 * round-trips. They also prove an OLD (pre-v4) index upgrades cleanly in place.
 */

function mkNode(id: string, name: string, file: string) {
  return {
    id,
    name,
    qualified_name: name,
    kind: "function" as const,
    language: "typescript",
    file,
    range: [1, 2] as [number, number],
    ast_hash: "x",
    last_seen: 0,
    logical_clock: 0,
  };
}

describe("v4 path-searchable FTS", () => {
  it("surfaces a node whose FOLDER is the query but whose NAME is not", () => {
    const db = new Db(":memory:");
    const m = db.migrate();
    if (!m.appliedFts) return; // FTS not available on this build.

    // The exact dogfound shape: entity named `auth`, living under db/schema/.
    db.upsertNode(mkNode("db/schema/auth", "auth", "backend/src/db/schema/auth.ts"));
    db.upsertNode(mkNode("db/schema/projects", "projects", "backend/src/db/schema/projects.ts"));
    // A decoy literally NAMED `schema` (the admin route the old index found).
    db.upsertNode(mkNode("routes/admin/schema", "schema", "backend/src/routes/admin/schema.ts"));

    const hits = searchFts(db.handle, "schema");
    const ids = hits.map((h) => h.id);
    // BEFORE v4 only the decoy matched; now the db/schema/* tables surface too.
    expect(ids).toContain("db/schema/auth");
    expect(ids).toContain("db/schema/projects");
    db.close();
  });

  it("matches an interior folder segment (db) that appears in no name", () => {
    const db = new Db(":memory:");
    const m = db.migrate();
    if (!m.appliedFts) return;
    db.upsertNode(mkNode("db/queries/upsertNode", "upsertNode", "daemon/src/db/queries.ts"));
    const hits = searchFts(db.handle, "queries");
    expect(hits.map((h) => h.id)).toContain("db/queries/upsertNode");
    db.close();
  });

  it("does NOT regress exact-identifier search", () => {
    const db = new Db(":memory:");
    const m = db.migrate();
    if (!m.appliedFts) return;
    db.upsertNode(mkNode("auth/loginHandler", "loginHandler", "src/auth/login.ts"));
    const hits = searchFts(db.handle, "loginHandler");
    expect(hits[0]?.id).toBe("auth/loginHandler");
    db.close();
  });

  it("repopulates path on an UPDATE (re-ingest fires the AFTER UPDATE trigger)", () => {
    const db = new Db(":memory:");
    const m = db.migrate();
    if (!m.appliedFts) return;
    // First insert with no useful path.
    db.upsertNode(mkNode("x/thing", "thing", "tmp.ts"));
    // Re-ingest the SAME id with a path-rich file → ON CONFLICT UPDATE path.
    db.upsertNode(mkNode("x/thing", "thing", "backend/src/billing/invoices.ts"));
    const hits = searchFts(db.handle, "invoices");
    expect(hits.map((h) => h.id)).toContain("x/thing");
    db.close();
  });
});

describe("v3 → v4 in-place migration", () => {
  it("upgrades an OLD path-less FTS index and gains the searchable path", () => {
    const raw = new Database(":memory:");
    // Stand up the CURRENT schema first so `nodes` exists, then simulate a v3
    // index by dropping `nodes_fts` and recreating the OLD (path-less) shape +
    // OLD triggers, and walking user_version back to 3.
    migrate(raw);
    if (
      (raw
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='nodes_fts'",
        )
        .get()?.n ?? 0) === 0
    ) {
      raw.close();
      return; // FTS unavailable on this build.
    }

    raw.exec(`
      DROP TRIGGER IF EXISTS nodes_fts_ai;
      DROP TRIGGER IF EXISTS nodes_fts_ad;
      DROP TRIGGER IF EXISTS nodes_fts_au;
      DROP TABLE   IF EXISTS nodes_fts;
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id UNINDEXED, name, qualified_name, summary, tokenize = 'trigram'
      );
      CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(id, name, qualified_name, summary)
        VALUES (new.id, new.name, new.qualified_name, COALESCE(new.summary, ''));
      END;
      CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
        DELETE FROM nodes_fts WHERE id = old.id;
      END;
      CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
        DELETE FROM nodes_fts WHERE id = old.id;
        INSERT INTO nodes_fts(id, name, qualified_name, summary)
        VALUES (new.id, new.name, new.qualified_name, COALESCE(new.summary, ''));
      END;
    `);
    raw.exec("PRAGMA user_version = 3");

    // Seed a node via the OLD triggers — its path is NOT yet indexed.
    raw.exec(
      "INSERT INTO nodes (id, name, qualified_name, kind, language, file, range_start, range_end) " +
        "VALUES ('db/schema/auth', 'auth', 'auth', 'function', 'typescript', 'backend/src/db/schema/auth.ts', 1, 2)",
    );
    // Confirm the OLD index canNOT find it by folder.
    const beforeRaw = raw
      .query<{ id: string }, [string]>("SELECT id FROM nodes_fts WHERE nodes_fts MATCH ?")
      .all('"schema"');
    expect(beforeRaw.map((r) => r.id)).not.toContain("db/schema/auth");

    // Run the migration: it should rebuild nodes_fts with `path` and repopulate.
    // migrate() always lands on the LATEST SCHEMA_VERSION; the v3→v4 FTS rebuild
    // (the behavior under test) runs en route, then v4→v5 (call_sites) and v5→v6
    // (test_coverage + fleet_memory) follow, so the final toVersion is the current
    // SCHEMA_VERSION even though this case exercises the v3→v4 step.
    const result = migrate(raw);
    expect(result.fromVersion).toBe(3);
    expect(result.toVersion).toBe(SCHEMA_VERSION);

    const cols = raw
      .query<{ name: string }, []>("PRAGMA table_info(nodes_fts)")
      .all()
      .map((c) => c.name);
    expect(cols).toContain("path");

    // The folder is now searchable on the upgraded index.
    const hits = searchFts(raw, "schema");
    expect(hits.map((h) => h.id)).toContain("db/schema/auth");
    raw.close();
  });

  it("is idempotent — re-running migrate on a v4 DB does not error or duplicate", () => {
    const raw = new Database(":memory:");
    migrate(raw);
    raw.exec(
      "INSERT INTO nodes (id, name, qualified_name, kind, language, file, range_start, range_end) " +
        "VALUES ('db/schema/auth', 'auth', 'auth', 'function', 'typescript', 'backend/src/db/schema/auth.ts', 1, 2)",
    );
    expect(() => migrate(raw)).not.toThrow();
    const n = raw
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM nodes_fts WHERE id='db/schema/auth'")
      .get();
    expect(n?.n).toBe(1); // not duplicated by the second migrate
    raw.close();
  });
});
