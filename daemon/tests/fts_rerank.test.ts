/**
 * Centrality-aware re-rank + model-gated semantic expansion (fts.ts).
 *
 * Layer 1 — ranking unit tests over a tiny in-memory `nodes_fts` + `nodes` +
 * `edges` fixture, proving:
 *   - a well-connected node (high degree) is lifted above a same-BM25 leaf;
 *   - a scaffold (test/bench) node is demoted below a same-BM25 product node;
 *   - an exact-identifier hit is NOT disturbed by the boost (the IMPL guard);
 *   - with no graph tables, search degrades to pure BM25 (no empty results).
 *
 * Layer 2 — semantic expansion (`searchFtsSemantic` + the queryExpansion
 * helpers) with a MOCK infer fn (no weights / no binary), proving:
 *   - a pure natural-language query (no literal token overlap) finds the target
 *     ONLY because the model's identifiers are OR-ed in;
 *   - with no model it falls back to exactly `searchFts` (identical results);
 *   - garbage / empty model output is parsed safely and never narrows the base.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { searchFts, searchFtsSemantic, type SearchHit } from "../src/db/fts.ts";
import {
  buildSemanticExpansionPrompt,
  expandQueryWithModel,
  MAX_SEMANTIC_TERMS,
  parseSemanticTerms,
} from "../src/db/queryExpansion.ts";

interface Row {
  id: string;
  name: string;
  qn?: string;
  summary?: string;
  file?: string;
  /** outgoing edge targets (callees) */
  out?: string[];
  /** incoming edge sources (callers) */
  inc?: string[];
}

/** Build an in-memory index mirroring the real schema: nodes_fts (trigram) +
 *  nodes (id, file) + edges (src, dst). */
function makeGraphFixture(rows: Row[]): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id UNINDEXED, name, qualified_name, summary, tokenize = 'trigram'
    );
    CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, file TEXT);
    CREATE TABLE edges (src TEXT, dst TEXT, kind TEXT, PRIMARY KEY (src, dst, kind));
    CREATE INDEX edges_dst ON edges(dst);
  `);
  const insFts = db.query(
    "INSERT INTO nodes_fts(id, name, qualified_name, summary) VALUES (?, ?, ?, ?)",
  );
  const insNode = db.query("INSERT INTO nodes(id, name, file) VALUES (?, ?, ?)");
  const insEdge = db.query("INSERT INTO edges(src, dst, kind) VALUES (?, ?, 'calls')");
  for (const r of rows) {
    insFts.run(r.id, r.name, r.qn ?? r.name, r.summary ?? "");
    insNode.run(r.id, r.name, r.file ?? "daemon/src/x.ts");
    for (const dst of r.out ?? []) insEdge.run(r.id, dst);
    for (const src of r.inc ?? []) insEdge.run(src, r.id);
  }
  return db;
}

const ids = (hits: SearchHit[]) => hits.map((h) => h.id);
const rankOf = (hits: SearchHit[], idSub: string) =>
  hits.findIndex((h) => h.id.includes(idSub)) + 1;

describe("searchFts — centrality re-rank", () => {
  it("lifts a well-connected node above a same-BM25 leaf", () => {
    // Two nodes with identical names → identical BM25 for query "walker".
    // Only difference: `hub` has many edges, `leaf` has none.
    const db = makeGraphFixture([
      { id: "pkg/leaf/walker", name: "walker" },
      {
        id: "pkg/hub/walker",
        name: "walker",
        out: ["a", "b", "c", "d", "e"],
        inc: ["f", "g", "h"],
      },
    ]);
    const hits = searchFts(db, "walker");
    expect(hits.length).toBe(2);
    // The connected implementation should rank first.
    expect(hits[0]?.id).toBe("pkg/hub/walker");
  });

  it("demotes a test/bench scaffold node below a same-BM25 product node", () => {
    const db = makeGraphFixture([
      { id: "tests/walker.test/walker", name: "walker", file: "daemon/tests/walker.test.ts" },
      { id: "pkg/impl/walker", name: "walker", file: "daemon/src/walker.ts" },
    ]);
    const hits = searchFts(db, "walker");
    expect(hits[0]?.id).toBe("pkg/impl/walker");
    // and the bench/ prefix is caught too
    const db2 = makeGraphFixture([
      { id: "bench/walker/walker", name: "walker", file: "bench/walker.ts" },
      { id: "pkg/impl/walker", name: "walker", file: "daemon/src/walker.ts" },
    ]);
    expect(searchFts(db2, "walker")[0]?.id).toBe("pkg/impl/walker");
  });

  it("does NOT disturb an exact-identifier top hit (IMPL guard)", () => {
    // The full original identifier matches far more trigrams than a distractor
    // that only shares a short subtoken, so BM25 gives it a comfortable lead.
    // The degree boost is bounded (α·log1p(degree)), so even a high-degree
    // distractor that only shares a subtoken must NOT overtake the exact hit.
    // (A larger corpus gives BM25 meaningful IDF separation — the degenerate
    // 2-doc case where every term's IDF≈0 is not representative of the index.)
    const filler: Row[] = Array.from({ length: 30 }, (_, i) => ({
      id: `pkg/filler${i}`,
      name: `unrelatedThing${i}`,
    }));
    const db = makeGraphFixture([
      { id: "pkg/getUserById", name: "getUserById", summary: "fetch a user by id" },
      {
        // shares only the common subtoken "user"; high degree.
        id: "pkg/userHub",
        name: "userRegistry",
        summary: "registry of user records",
        out: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        inc: ["k", "l", "m", "n", "o"],
      },
      ...filler,
    ]);
    const hits = searchFts(db, "getUserById");
    expect(hits[0]?.id).toBe("pkg/getUserById");
  });

  it("degrades to pure BM25 when the graph tables are absent", () => {
    // No `nodes`/`edges` tables → the re-rank can't run; must still return hits.
    const db = new Database(":memory:");
    db.exec(`CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id UNINDEXED, name, qualified_name, summary, tokenize = 'trigram');`);
    db.query("INSERT INTO nodes_fts(id,name,qualified_name,summary) VALUES (?,?,?,?)")
      .run("1", "walker", "walker", "");
    const hits = searchFts(db, "walker");
    expect(ids(hits)).toContain("1");
  });
});

describe("parseSemanticTerms", () => {
  it("parses a clean comma list and contributes subtokens", () => {
    const terms = parseSemanticTerms("computeMerkle, merkleDiff");
    expect(terms).toContain("computemerkle");
    expect(terms).toContain("merkle");
    expect(terms).toContain("diff");
  });

  it("tolerates prose / markdown noise around identifiers", () => {
    const terms = parseSemanticTerms("Here: anti_entropy, syncPeers and merkleTree.");
    expect(terms).toContain("anti_entropy");
    expect(terms).toContain("syncpeers");
  });

  it("does not crash on degenerate / empty model output", () => {
    expect(parseSemanticTerms("")).toEqual([]);
    expect(parseSemanticTerms("f.  partition\ng. partition_l_s_l_s")).toContain("partition");
  });

  it("caps the number of terms", () => {
    const many = Array.from({ length: 50 }, (_, i) => `idTerm${i}`).join(", ");
    expect(parseSemanticTerms(many).length).toBeLessThanOrEqual(MAX_SEMANTIC_TERMS);
  });

  it("prompt mentions the query and asks for identifiers only", () => {
    const p = buildSemanticExpansionPrompt("how do peers converge");
    expect(p).toContain("how do peers converge");
    expect(p.toLowerCase()).toContain("identifier");
  });
});

describe("expandQueryWithModel", () => {
  it("returns base only when no model is present (model-free parity)", async () => {
    const r = await expandQueryWithModel(["merkle"], "merkle tree", undefined);
    expect(r.semantic).toEqual([]);
    expect(r.base.length).toBeGreaterThan(0);
  });

  it("appends model identifiers as separate semantic terms", async () => {
    const infer = async () => ({ ok: true, completion: "computeMerkle, syncPeers" });
    const r = await expandQueryWithModel([], "how do peers converge", infer);
    expect(r.semantic).toContain("computemerkle");
    expect(r.semantic).toContain("syncpeers");
  });

  it("falls back to base on infer error / not-ok / throw", async () => {
    const notOk = await expandQueryWithModel(["x"], "q", async () => ({ ok: false, completion: "ignored" }));
    expect(notOk.semantic).toEqual([]);
    const threw = await expandQueryWithModel(["x"], "q", async () => {
      throw new Error("spawn failed");
    });
    expect(threw.semantic).toEqual([]);
  });
});

describe("searchFtsSemantic — additive recall (mock model)", () => {
  const corpus: Row[] = [
    { id: "crdt/merkle/computeMerkle", name: "computeMerkle", out: ["a", "b"] },
    { id: "crdt/merkle/MerkleDiff", name: "MerkleDiff" },
    { id: "sync/syncPeers", name: "syncPeers", inc: ["a"] },
    { id: "unrelated/parseConfig", name: "parseConfig" },
  ];

  it("a pure NL query finds the target ONLY via the model's identifiers", async () => {
    const db = makeGraphFixture(corpus);
    const nlQuery = "how does the daemon converge peers after a partition";
    // Without a model: pure-prose query has no code-token overlap → no hits.
    expect(await searchFtsSemantic(db, nlQuery, undefined)).toEqual([]);
    // With a model mapping it to identifiers: the targets surface.
    const infer = async () => ({
      ok: true,
      completion: "computeMerkle, MerkleDiff, syncPeers",
    });
    const hits = await searchFtsSemantic(db, nlQuery, infer);
    expect(rankOf(hits, "crdt/merkle")).toBeGreaterThan(0);
    expect(rankOf(hits, "sync/syncPeers")).toBeGreaterThan(0);
  });

  it("never NARROWS the base: a literal query keeps its hit even with model noise", async () => {
    const db = makeGraphFixture(corpus);
    // Garbage model output must not remove the literal `computeMerkle` hit.
    const noisy = async () => ({ ok: true, completion: "f. zzz, g. zzz_zzz" });
    const hits = await searchFtsSemantic(db, "computeMerkle", noisy);
    expect(ids(hits)).toContain("crdt/merkle/computeMerkle");
  });

  it("with no model, equals searchFts exactly", async () => {
    const db = makeGraphFixture(corpus);
    const sem = await searchFtsSemantic(db, "merkle", undefined);
    const plain = searchFts(db, "merkle");
    expect(ids(sem)).toEqual(ids(plain));
  });
});
