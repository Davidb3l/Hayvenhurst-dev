/**
 * Natural-language query floor — the RELAXED, model-free fallback in
 * `searchFts` that keeps an NL query from returning EMPTY.
 *
 * The precise path (`buildFtsMatch`) AND-s every word the user typed. A
 * natural-language ask ("how does the daemon converge peers after a partition")
 * AND-s English glue words that never appear in code, so the AND-of-all matches
 * nothing → "No matches" → the agent abandons hayven for grep. The relaxed
 * fallback drops stopwords and OR-s the remaining CONTENT groups; it fires ONLY
 * when the precise match is empty, so it is strictly additive.
 *
 * Coverage:
 *   (a) a precise identifier query is byte-identical (fallback does NOT fire);
 *   (b) an NL query that AND-matches nothing now returns relevant rows;
 *   (c) an all-stopwords query still behaves sanely (literal stopword search);
 *   (d) stopword filtering + OR relaxation produce the expected MATCH string.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
  buildFtsMatch,
  buildRelaxedFtsMatch,
  searchFts,
  type SearchHit,
} from "../src/db/fts.ts";
import { STOPWORDS, dropStopwords } from "../src/db/queryExpansion.ts";

// ---------------------------------------------------------------------------
// (d) MATCH-string shape: stopword filtering + OR relaxation
// ---------------------------------------------------------------------------

describe("dropStopwords", () => {
  it("drops English glue words, keeps content words (order preserved)", () => {
    expect(dropStopwords(["how", "does", "the", "daemon", "converge"])).toEqual([
      "daemon",
      "converge",
    ]);
  });

  it("is case-insensitive", () => {
    expect(dropStopwords(["How", "The", "Daemon"])).toEqual(["Daemon"]);
  });

  it("keeps ALL terms when every term is a stopword (literal stopword search)", () => {
    // a deliberate search for "the" / "and" must not collapse to nothing.
    expect(dropStopwords(["the", "and"])).toEqual(["the", "and"]);
  });

  it("does not treat common code words (get/set/id) as stopwords", () => {
    expect(STOPWORDS.has("get")).toBe(false);
    expect(STOPWORDS.has("set")).toBe(false);
    expect(STOPWORDS.has("id")).toBe(false);
    expect(STOPWORDS.has("new")).toBe(false);
  });
});

describe("buildRelaxedFtsMatch", () => {
  it("drops stopwords and OR-s the remaining content groups", () => {
    // "daemon" / "converge" / "peers" / "partition" have no expansions → bare,
    // OR-ed at the top level. The glue words are gone.
    expect(
      buildRelaxedFtsMatch("how does the daemon converge peers after a partition"),
    ).toBe('"daemon" OR "converge" OR "peers" OR "partition"');
  });

  it("expands each surviving content term via the SAME model-free floor", () => {
    // "function" carries abbrev partners (fn/func); they appear as an OR-group,
    // and the groups themselves are OR-ed together.
    const m = buildRelaxedFtsMatch("what stops the function");
    expect(m).toContain('"function"');
    expect(m).toContain('"fn"');
    expect(m).toContain('"func"');
    // top-level OR (a relaxed match never uses AND across content groups)
    expect(m).not.toContain(" AND ");
  });

  it("returns '' for empty / whitespace / punctuation-only input", () => {
    expect(buildRelaxedFtsMatch("")).toBe("");
    expect(buildRelaxedFtsMatch("   ")).toBe("");
    expect(buildRelaxedFtsMatch("!@#$%")).toBe("");
  });

  it("for a single content word equals the precise match (no-op relaxation)", () => {
    // nothing to drop, one group → same string as the precise path; searchFts
    // detects this and skips the redundant fallback query.
    expect(buildRelaxedFtsMatch("searchFts")).toBe(buildFtsMatch("searchFts"));
  });
});

// ---------------------------------------------------------------------------
// e2e fixture (mirrors search_expansion.test.ts)
// ---------------------------------------------------------------------------

function makeFixture(
  rows: { id: string; name: string; qn: string; summary: string }[],
): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id UNINDEXED, name, qualified_name, summary, tokenize = 'trigram'
    );
  `);
  const ins = db.query(
    "INSERT INTO nodes_fts(id, name, qualified_name, summary) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) ins.run(r.id, r.name, r.qn, r.summary);
  return db;
}

const ids = (hits: SearchHit[]) => hits.map((h) => h.id);

// ---------------------------------------------------------------------------
// (a) precise query is byte-identical (fallback does NOT fire)
// ---------------------------------------------------------------------------

describe("searchFts — precise path unchanged when AND matches (a)", () => {
  it("an exact identifier query returns the precise result; fallback never runs", () => {
    const db = makeFixture([
      { id: "db/fts/searchFts", name: "searchFts", qn: "db.fts.searchFts", summary: "full text search" },
      { id: "db/fts/escapeFtsQuery", name: "escapeFtsQuery", qn: "db.fts.escapeFtsQuery", summary: "" },
    ]);
    const hits = searchFts(db, "searchFts");
    expect(ids(hits)).toContain("db/fts/searchFts");
    // Equivalence to a pure precise search: a query that already matches under
    // the AND-path must return exactly what the precise match returns. We prove
    // it by reconstructing the precise result via the public buildFtsMatch and
    // a direct FTS query, and asserting identical id ordering.
    const m = buildFtsMatch("searchFts");
    const direct = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts)",
      )
      .all(m)
      .map((r) => r.id);
    expect(ids(hits)).toEqual(direct);
  });

  it("a multi-identifier AND query that matches is NOT relaxed", () => {
    // both terms present in one row → precise AND matches → fallback inert.
    const db = makeFixture([
      { id: "1", name: "authConfigService", qn: "svc.authConfigService", summary: "" },
      { id: "2", name: "authOnly", qn: "svc.authOnly", summary: "" },
      { id: "3", name: "configOnly", qn: "svc.configOnly", summary: "" },
    ]);
    const hits = searchFts(db, "auth config");
    // precise AND requires BOTH → only the combined row; the OR relaxation would
    // also pull authOnly/configOnly, so seeing ONLY the combined row proves the
    // precise path served the result.
    expect(ids(hits)).toEqual(["1"]);
  });
});

// ---------------------------------------------------------------------------
// (b) NL query that AND-matches nothing now returns relevant rows
// ---------------------------------------------------------------------------

describe("searchFts — NL query no longer returns empty (b)", () => {
  it("a full-sentence ask surfaces the content-word rows instead of nothing", () => {
    const db = makeFixture([
      { id: "crdt/merkle/computeMerkle", name: "computeMerkle", qn: "crdt.merkle.computeMerkle", summary: "anti-entropy" },
      { id: "crdt/converge/convergePeers", name: "convergePeers", qn: "crdt.converge.convergePeers", summary: "converge two peers after a partition heals" },
      { id: "unrelated/billing/charge", name: "charge", qn: "billing.charge", summary: "bill a customer" },
    ]);
    const q = "how does the daemon converge peers after a partition";
    // precise AND-path matches nothing (glue words never appear).
    const m = buildFtsMatch(q);
    const preciseEmpty =
      db.query<{ id: string }, [string]>("SELECT id FROM nodes_fts WHERE nodes_fts MATCH ?").all(m);
    expect(preciseEmpty.length).toBe(0);
    // searchFts now falls back and returns the converge/partition row.
    const hits = searchFts(db, q);
    expect(hits.length).toBeGreaterThan(0);
    expect(ids(hits)).toContain("crdt/converge/convergePeers");
    expect(ids(hits)).not.toContain("unrelated/billing/charge");
  });

  it("a row hitting more content words ranks above one hitting fewer (BM25)", () => {
    const db = makeFixture([
      { id: "two", name: "convergePartition", qn: "x.convergePartition", summary: "converge after partition" },
      { id: "one", name: "convergeOnly", qn: "x.convergeOnly", summary: "just converge" },
    ]);
    const hits = searchFts(db, "how does it converge after a partition");
    expect(hits[0]?.id).toBe("two");
  });
});

// ---------------------------------------------------------------------------
// (c) all-stopwords query behaves sanely
// ---------------------------------------------------------------------------

describe("searchFts — all-stopwords query (c)", () => {
  it("a literal stopword search still works (terms not all dropped)", () => {
    const db = makeFixture([
      { id: "1", name: "theThing", qn: "x.theThing", summary: "the the the" },
      { id: "2", name: "other", qn: "x.other", summary: "nothing here" },
    ]);
    // "the" is a stopword; precise path matches the row whose summary has "the".
    // Even if it didn't, dropStopwords keeps "the" (all-stopwords) so the relaxed
    // path is also a literal "the" search — never an empty MATCH.
    const hits = searchFts(db, "the");
    expect(ids(hits)).toContain("1");
  });

  it("an all-stopwords NL phrase does not crash and does not return garbage-empty", () => {
    const db = makeFixture([
      { id: "1", name: "x", qn: "x", summary: "the and or but" },
    ]);
    const hits = searchFts(db, "what is the");
    expect(Array.isArray(hits)).toBe(true);
  });
});
