import { describe, expect, it } from "bun:test";

import { Db } from "../src/db/queries.ts";
import { searchFts, searchFtsSemantic } from "../src/db/fts.ts";
import type { InferLike } from "../src/db/queryExpansion.ts";

/**
 * `--semantic` / `?semantic=true` gate (CLAUDE.md item (3) optional follow-up).
 *
 * Wires the dormant model-gated `searchFtsSemantic` behind an explicit opt-in.
 * The LOAD-BEARING contract proven here is the no-model degrade: with NO infer
 * fn (the no-model path the CLI/route hit when no model is pulled),
 * `searchFtsSemantic` MUST NOT error and MUST return AT LEAST the model-free
 * `searchFts` results. The semantic terms are strictly additive (`X OR Y ⊇ X`),
 * so when a model IS present the result is a superset.
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
  db.upsertNode(mkNode("crdt/computeMerkle", "computeMerkle", "src/crdt/merkle.ts"));
  db.upsertNode(mkNode("crdt/merkleDiff", "merkleDiff", "src/crdt/merkle.ts"));
  db.upsertNode(mkNode("auth/login", "login", "src/auth/login.ts"));
  return db;
}

describe("searchFtsSemantic — no-model degrade (the --semantic safety contract)", () => {
  it("with NO infer fn → returns AT LEAST the model-free searchFts results (no error)", async () => {
    const db = seedRealDb();
    if (!db) return;
    const baseline = new Set(searchFts(db.handle, "merkle", 20).map((h) => h.id));
    expect(baseline.size).toBeGreaterThan(0);

    // `infer` undefined == the no-model path the CLI/route hit with no model.
    const hits = await searchFtsSemantic(db.handle, "merkle", undefined, 20);
    const ids = new Set(hits.map((h) => h.id));
    // ≥ the model-free results: every baseline hit is present.
    for (const id of baseline) expect(ids.has(id)).toBe(true);
    expect(ids.size).toBeGreaterThanOrEqual(baseline.size);
    db.close();
  });

  it("with NO infer fn → byte-identical id set to searchFts (no semantic terms folded in)", async () => {
    const db = seedRealDb();
    if (!db) return;
    const base = searchFts(db.handle, "login", 20).map((h) => h.id).sort();
    const sem = (await searchFtsSemantic(db.handle, "login", undefined, 20))
      .map((h) => h.id)
      .sort();
    expect(sem).toEqual(base);
    db.close();
  });

  it("an infer fn that ERRORS / times out → still degrades to the model-free base", async () => {
    const db = seedRealDb();
    if (!db) return;
    const base = new Set(searchFts(db.handle, "merkle", 20).map((h) => h.id));
    const throwing: InferLike = async () => {
      throw new Error("simulated infer timeout/spawn failure");
    };
    const hits = await searchFtsSemantic(db.handle, "merkle", throwing, 20);
    const ids = new Set(hits.map((h) => h.id));
    for (const id of base) expect(ids.has(id)).toBe(true);
    db.close();
  });

  it("an infer fn returning ok:false → degrades to the model-free base", async () => {
    const db = seedRealDb();
    if (!db) return;
    const base = new Set(searchFts(db.handle, "merkle", 20).map((h) => h.id));
    const failing: InferLike = async () => ({ ok: false, completion: "" });
    const hits = await searchFtsSemantic(db.handle, "merkle", failing, 20);
    const ids = new Set(hits.map((h) => h.id));
    for (const id of base) expect(ids.has(id)).toBe(true);
    db.close();
  });

  it("with a MODEL present (mock infer) → strictly additive: result ⊇ the model-free base", async () => {
    const db = seedRealDb();
    if (!db) return;
    // A pure-NL query that has ZERO literal token overlap with the identifiers,
    // so the model-free base alone returns nothing — the model's suggested
    // identifiers are what surface the rows. Proves the semantic OR-group adds
    // recall without ever removing a base hit.
    const nlQuery = "how do peers converge after a partition";
    const base = new Set(searchFts(db.handle, nlQuery, 20).map((h) => h.id));

    const mock: InferLike = async () => ({
      ok: true,
      completion: "computeMerkle, merkleDiff",
    });
    const hits = await searchFtsSemantic(db.handle, nlQuery, mock, 20);
    const ids = new Set(hits.map((h) => h.id));

    // Superset of the (possibly empty) base.
    for (const id of base) expect(ids.has(id)).toBe(true);
    // And the model's identifiers actually surfaced rows the base couldn't.
    expect(ids.has("crdt/computeMerkle")).toBe(true);
    expect(ids.has("crdt/merkleDiff")).toBe(true);
    db.close();
  });
});

/**
 * `--semantic` now honors `--path` (the bug this is the regression test for).
 *
 * Before the fix, `searchFtsSemantic` ignored the path filter entirely and
 * returned WHOLE-REPO hits, while the CLI/route still echoed `"path"` in the
 * JSON payload — the output LIED. This proves that with a fixture spanning two
 * path prefixes, scoping by one prefix returns ONLY nodes under it, both with a
 * mock infer present (model expansion confined to the scope) AND with
 * `infer=undefined` (the no-model degrade path). The absence of this test is
 * what let the bug ship.
 */
function seedTwoPrefixDb(): Db | null {
  const db = new Db(":memory:");
  const m = db.migrate();
  if (!m.appliedFts) {
    db.close();
    return null; // FTS unavailable on this build → skip.
  }
  // Two prefixes, both carrying the literal token "merkle" so an UNSCOPED query
  // returns BOTH and a scoped query must keep only the in-prefix one. The model
  // mock suggests an identifier present in EACH prefix, so the scope must also
  // confine the model's expansion (not just the base match).
  db.upsertNode(mkNode("frontend/computeMerkle", "computeMerkle", "frontend/src/merkle.ts"));
  db.upsertNode(mkNode("backend/computeMerkle", "computeMerkle", "backend/src/merkle.ts"));
  db.upsertNode(mkNode("frontend/merkleDiff", "merkleDiff", "frontend/src/diff.ts"));
  db.upsertNode(mkNode("backend/merkleDiff", "merkleDiff", "backend/src/diff.ts"));
  return db;
}

describe("searchFtsSemantic — honors { path } (the --semantic + --path scope fix)", () => {
  it("UNSCOPED returns both prefixes; the { path } scope keeps only the in-prefix nodes (infer=undefined)", async () => {
    const db = seedTwoPrefixDb();
    if (!db) return;
    // Sanity: unscoped, both prefixes are present.
    const unscoped = new Set(
      (await searchFtsSemantic(db.handle, "merkle", undefined, 20)).map((h) => h.id),
    );
    expect(unscoped.has("frontend/computeMerkle")).toBe(true);
    expect(unscoped.has("backend/computeMerkle")).toBe(true);

    // Scoped to `frontend/` → ONLY frontend nodes, never any backend node.
    const scoped = await searchFtsSemantic(db.handle, "merkle", undefined, 20, {
      path: "frontend/",
    });
    expect(scoped.length).toBeGreaterThan(0);
    for (const h of scoped) expect(h.id.startsWith("frontend/")).toBe(true);
    const ids = new Set(scoped.map((h) => h.id));
    expect(ids.has("backend/computeMerkle")).toBe(false);
    expect(ids.has("backend/merkleDiff")).toBe(false);
    db.close();
  });

  it("with a MODEL present (mock infer), the scope confines the model's expansion too", async () => {
    const db = seedTwoPrefixDb();
    if (!db) return;
    // A pure-NL query (no literal token overlap) so the model's suggested
    // identifiers — which exist in BOTH prefixes — are what surface the rows.
    const nlQuery = "how do peers converge after a partition";
    const mock: InferLike = async () => ({
      ok: true,
      completion: "computeMerkle, merkleDiff",
    });
    const scoped = await searchFtsSemantic(db.handle, nlQuery, mock, 20, {
      path: "frontend/",
    });
    expect(scoped.length).toBeGreaterThan(0);
    // Model expansion surfaced rows, but ONLY within the scoped prefix.
    for (const h of scoped) expect(h.id.startsWith("frontend/")).toBe(true);
    const ids = new Set(scoped.map((h) => h.id));
    expect(ids.has("frontend/computeMerkle")).toBe(true);
    expect(ids.has("backend/computeMerkle")).toBe(false);
    expect(ids.has("backend/merkleDiff")).toBe(false);
    db.close();
  });
});
