import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

import { Db } from "../src/db/queries.ts";
import { searchFts } from "../src/db/fts.ts";

/**
 * Tier 1.1 — scoped search gate (`--path` / `?path=` / `searchFts(opts.path)`).
 *
 * ROOT CAUSE (VirixiaField A/B, 2026-06-01): a whole-monorepo query surfaced
 * wrong-domain nodes — a frontend "provider" search returned BACKEND OAuth
 * nodes and buried the frontend answer. The v4 indexed `path` column existed
 * but nothing exposed a way to filter by it. This adds a path-PREFIX filter on
 * the node's `file` column, threaded through every fts code path.
 *
 * Requirements proven here:
 *   (a) `path` keeps only nodes whose file begins with the prefix;
 *   (b) the SAME query WITHOUT `path` returns the unfiltered SUPERSET (additive,
 *       and byte-identical to today);
 *   (c) trailing-slash normalization (`frontend` ≡ `frontend/`);
 *   (d) the prefix can't act as an FTS/LIKE wildcard (injection guard);
 *   (e) all THREE fts code paths honor it (rankedSearch w/ graph, the no-graph
 *       bm25Search fallback, and the relaxed NL fallback).
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

/** Real-schema (nodes + edges + nodes_fts) fixture — exercises rankedSearch. */
function seedRealDb(): Db | null {
  const db = new Db(":memory:");
  const m = db.migrate();
  if (!m.appliedFts) {
    db.close();
    return null; // FTS unavailable on this build → skip.
  }
  // Two distinct path prefixes, both with the literal token "provider" so an
  // unscoped query returns BOTH and the scoped query must keep only one.
  db.upsertNode(mkNode("fe/authProvider", "AuthProvider", "frontend/src/lib/authProvider.tsx"));
  db.upsertNode(mkNode("fe/queryProvider", "QueryProvider", "frontend/src/lib/queryProvider.tsx"));
  db.upsertNode(mkNode("be/oauthProvider", "oauthProvider", "backend/src/auth/oauthProvider.ts"));
  db.upsertNode(mkNode("be/wsProvider", "wsProvider", "backend/src/graphql/wsProvider.ts"));
  return db;
}

describe("scoped search — searchFts({ path })", () => {
  it("(a) keeps ONLY nodes whose file begins with the prefix", () => {
    const db = seedRealDb();
    if (!db) return;
    const scoped = searchFts(db.handle, "provider", 20, { path: "frontend" });
    const ids = scoped.map((h) => h.id).sort();
    expect(ids).toEqual(["fe/authProvider", "fe/queryProvider"]);
    expect(ids).not.toContain("be/oauthProvider");
    expect(ids).not.toContain("be/wsProvider");
    db.close();
  });

  it("(b) the SAME query WITHOUT path is the unfiltered SUPERSET (additive)", () => {
    const db = seedRealDb();
    if (!db) return;
    const unscoped = new Set(searchFts(db.handle, "provider", 20).map((h) => h.id));
    const scoped = new Set(
      searchFts(db.handle, "provider", 20, { path: "frontend" }).map((h) => h.id),
    );
    // unscoped ⊇ scoped, and unscoped has the backend nodes the scope removed.
    for (const id of scoped) expect(unscoped.has(id)).toBe(true);
    expect(unscoped.has("be/oauthProvider")).toBe(true);
    expect(unscoped.has("be/wsProvider")).toBe(true);
    expect(unscoped.size).toBeGreaterThan(scoped.size);
    db.close();
  });

  it("(b') an explicitly EMPTY path is identical to no path (byte-identical ids)", () => {
    const db = seedRealDb();
    if (!db) return;
    const none = searchFts(db.handle, "provider", 20).map((h) => h.id);
    const empty = searchFts(db.handle, "provider", 20, { path: "" }).map((h) => h.id);
    const ws = searchFts(db.handle, "provider", 20, { path: "   " }).map((h) => h.id);
    expect(empty).toEqual(none);
    expect(ws).toEqual(none);
    db.close();
  });

  it("(c) trailing slash is normalized — `frontend` ≡ `frontend/`", () => {
    const db = seedRealDb();
    if (!db) return;
    const a = searchFts(db.handle, "provider", 20, { path: "frontend" }).map((h) => h.id).sort();
    const b = searchFts(db.handle, "provider", 20, { path: "frontend/" }).map((h) => h.id).sort();
    expect(b).toEqual(a);
    expect(a).toEqual(["fe/authProvider", "fe/queryProvider"]);
    db.close();
  });

  it("(c') a deeper prefix narrows further", () => {
    const db = seedRealDb();
    if (!db) return;
    const ids = searchFts(db.handle, "provider", 20, { path: "backend/src/graphql" }).map(
      (h) => h.id,
    );
    expect(ids).toEqual(["be/wsProvider"]);
    db.close();
  });

  it("(d) the prefix CANNOT act as a LIKE/FTS wildcard (injection guard)", () => {
    const db = seedRealDb();
    if (!db) return;
    // `%` would, unescaped, match every path. `frontend_src` with a raw `_`
    // would match `frontend/src` (LIKE single-char). Both must match NOTHING
    // here because they're treated as literal path text.
    expect(searchFts(db.handle, "provider", 20, { path: "%" }).map((h) => h.id)).toEqual([]);
    expect(
      searchFts(db.handle, "provider", 20, { path: "frontend_src" }).map((h) => h.id),
    ).toEqual([]);
    // A literal underscore prefix only matches a genuine underscore path.
    db.upsertNode(mkNode("misc/underProvider", "underProvider", "weird_dir/provider.ts"));
    const lit = searchFts(db.handle, "provider", 20, { path: "weird_dir" }).map((h) => h.id);
    expect(lit).toEqual(["misc/underProvider"]);
    // And a `%` literal really in a path matches only that path.
    db.upsertNode(mkNode("misc/pctProvider", "pctProvider", "pct%dir/provider.ts"));
    const pct = searchFts(db.handle, "provider", 20, { path: "pct%dir" }).map((h) => h.id);
    expect(pct).toEqual(["misc/pctProvider"]);
    db.close();
  });

  it("(e-no-graph) the no-graph BM25 fallback honors the path filter", () => {
    // FTS-only fixture WITH a `nodes` table but NO `edges` → hasRerankTables is
    // false → search runs bm25Search, which must still scope by path.
    const db = new Database(":memory:");
    db.exec(`
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id UNINDEXED, name, qualified_name, summary, tokenize = 'trigram');
      CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, file TEXT);
    `);
    const insFts = db.query(
      "INSERT INTO nodes_fts(id,name,qualified_name,summary) VALUES (?,?,?,?)",
    );
    const insNode = db.query("INSERT INTO nodes(id,name,file) VALUES (?,?,?)");
    for (const [id, file] of [
      ["fe/p", "frontend/src/p.ts"],
      ["be/p", "backend/src/p.ts"],
    ] as const) {
      insFts.run(id, "provider", "provider", "");
      insNode.run(id, "provider", file);
    }
    const scoped = searchFts(db, "provider", 20, { path: "frontend" }).map((h) => h.id);
    expect(scoped).toEqual(["fe/p"]);
    // unscoped superset
    const all = searchFts(db, "provider", 20).map((h) => h.id).sort();
    expect(all).toEqual(["be/p", "fe/p"]);
    db.close();
  });

  it("(e-no-nodes) with NO nodes table, a path filter degrades to unfiltered (no crash)", () => {
    // Pure FTS-only fixture (no `nodes`, no `edges`). There's nothing to scope
    // against — search must still return results rather than throwing/[].
    const db = new Database(":memory:");
    db.exec(`CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id UNINDEXED, name, qualified_name, summary, tokenize = 'trigram');`);
    db.query("INSERT INTO nodes_fts(id,name,qualified_name,summary) VALUES (?,?,?,?)")
      .run("1", "provider", "provider", "");
    const hits = searchFts(db, "provider", 20, { path: "frontend" }).map((h) => h.id);
    expect(hits).toEqual(["1"]); // unfiltered fallback, not a crash/empty
    db.close();
  });

  it("(e-relaxed) the relaxed NL fallback also honors the path filter", () => {
    const db = seedRealDb();
    if (!db) return;
    // A multi-word NL query whose AND-of-all-terms matches nothing, forcing the
    // relaxed OR fallback. "provider" is a content token; the stopwords/other
    // words don't appear, so only the relaxed path can return rows.
    const q = "where is the provider configured anyway";
    const unscoped = searchFts(db.handle, q, 20).map((h) => h.id);
    expect(unscoped.length).toBeGreaterThan(0); // proves we hit the relaxed path
    const scoped = searchFts(db.handle, q, 20, { path: "frontend" }).map((h) => h.id).sort();
    expect(scoped.every((id) => id.startsWith("fe/"))).toBe(true);
    expect(scoped).toEqual(["fe/authProvider", "fe/queryProvider"]);
    db.close();
  });

  it("(case) matching is case-sensitive (paths are)", () => {
    const db = seedRealDb();
    if (!db) return;
    // The real paths are lowercase `frontend/`; `Frontend` must match nothing.
    expect(searchFts(db.handle, "provider", 20, { path: "Frontend" }).map((h) => h.id)).toEqual(
      [],
    );
    db.close();
  });
});
