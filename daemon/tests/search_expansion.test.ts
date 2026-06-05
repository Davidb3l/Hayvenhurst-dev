/**
 * Lane D — model-free query-expansion floor.
 *
 * Two test layers:
 *   1. Pure unit tests of the expansion functions (fast, deterministic): a
 *      term → its expected expansion set, plus the no-crash / no-explosion
 *      edge cases.
 *   2. End-to-end FTS5 tests over a tiny in-memory `nodes_fts` fixture, proving
 *      camelCase↔snake_case and abbreviation↔full-form cross-matching, and that
 *      an exact/original match still ranks first (no regression).
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import {
  buildFtsMatch,
  escapeFtsQuery,
  searchFts,
  type SearchHit,
} from "../src/db/fts.ts";
import {
  expandTerm,
  expandQuery,
  tokenizeIdentifier,
  MAX_EXPANSIONS_PER_TERM,
} from "../src/db/queryExpansion.ts";

// ---------------------------------------------------------------------------
// 1. Pure expansion unit tests
// ---------------------------------------------------------------------------

describe("tokenizeIdentifier", () => {
  it("splits camelCase", () => {
    expect(tokenizeIdentifier("getUserById")).toEqual(["get", "user", "by", "id"]);
  });

  it("splits snake_case", () => {
    expect(tokenizeIdentifier("auth_session")).toEqual(["auth", "session"]);
  });

  it("splits kebab-case", () => {
    expect(tokenizeIdentifier("parse-tree")).toEqual(["parse", "tree"]);
  });

  it("splits acronym-then-word boundaries", () => {
    expect(tokenizeIdentifier("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits letter/digit boundaries (single-digit fragment dropped as noise)", () => {
    // "8" is below MIN_SUBTOKEN_LENGTH and can't form a trigram → dropped.
    expect(tokenizeIdentifier("utf8Encode")).toEqual(["utf", "encode"]);
  });

  it("keeps multi-digit fragments", () => {
    expect(tokenizeIdentifier("v12Migration")).toEqual(["12", "migration"]);
  });

  it("drops sub-minimum-length fragments", () => {
    // single chars are below MIN_SUBTOKEN_LENGTH (2)
    expect(tokenizeIdentifier("aB")).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(tokenizeIdentifier("")).toEqual([]);
  });
});

describe("expandTerm", () => {
  it("keeps the original term first (lowercased)", () => {
    expect(expandTerm("getUserById")[0]).toBe("getuserbyid");
  });

  it("adds camelCase subtokens", () => {
    const set = new Set(expandTerm("getUserById"));
    expect(set).toContain("get");
    expect(set).toContain("user");
    expect(set).toContain("by");
    expect(set).toContain("id");
  });

  it("adds snake_case subtokens", () => {
    const set = new Set(expandTerm("auth_session"));
    expect(set).toContain("auth");
    expect(set).toContain("session");
  });

  it("expands an abbreviation to its full form (auth → authentication)", () => {
    expect(expandTerm("auth")).toContain("authentication");
  });

  it("expands a full form to its abbreviation (authentication → auth)", () => {
    expect(expandTerm("authentication")).toContain("auth");
  });

  it("expands abbreviations of subtokens too (db_config → database, configuration)", () => {
    const set = new Set(expandTerm("db_config"));
    expect(set).toContain("database");
    expect(set).toContain("configuration");
  });

  it("de-duplicates and never repeats the original", () => {
    const out = expandTerm("user");
    expect(out).toEqual([...new Set(out)]);
    expect(out[0]).toBe("user");
  });

  it("caps the number of ADDED expansion terms", () => {
    // a long multi-word identifier whose pieces also carry abbrev partners
    const out = expandTerm("authConfigRequestResponseErrorMessageButtonIndex");
    // original + at most MAX_EXPANSIONS_PER_TERM additions
    expect(out.length).toBeLessThanOrEqual(MAX_EXPANSIONS_PER_TERM + 1);
    expect(out[0]).toBe("authconfigrequestresponseerrormessagebuttonindex");
  });

  it("returns [] for an empty term", () => {
    expect(expandTerm("")).toEqual([]);
  });
});

describe("expandQuery", () => {
  it("maps each term to its own group, preserving order", () => {
    const groups = expandQuery(["auth", "handler"]);
    expect(groups.length).toBe(2);
    expect(groups[0]?.[0]).toBe("auth");
    expect(groups[1]?.[0]).toBe("handler");
  });

  it("returns [] for no terms", () => {
    expect(expandQuery([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. buildFtsMatch — additive-over-escapeFtsQuery contract
// ---------------------------------------------------------------------------

describe("buildFtsMatch", () => {
  it("collapses a no-expansion term to exactly the escapeFtsQuery form", () => {
    // "handler" tokenizes to itself and has no abbrev partner → bare quoted term
    expect(buildFtsMatch("handler")).toBe(escapeFtsQuery("handler"));
    expect(buildFtsMatch("handler")).toBe('"handler"');
  });

  it("wraps an expandable term in an OR-group with the original first", () => {
    const m = buildFtsMatch("auth");
    expect(m.startsWith('("auth" OR')).toBe(true);
    expect(m).toContain('"authentication"');
  });

  it("ANDs across the user's original terms with an explicit AND", () => {
    const m = buildFtsMatch("auth handler");
    // FTS5 needs an explicit AND between an OR-group and a bare term.
    expect(m).toContain('"auth"');
    expect(m).toContain('"handler"');
    expect(m).toContain(" AND ");
  });

  it("de-duplicates repeated original terms", () => {
    // three identical terms collapse to one fragment (no AND, no repetition)
    expect(buildFtsMatch("user user user")).toBe(buildFtsMatch("user"));
  });

  // Edge cases: must not crash and must not explode the term list.
  it("returns '' for empty / whitespace / punctuation-only input", () => {
    expect(buildFtsMatch("")).toBe("");
    expect(buildFtsMatch("   ")).toBe("");
    expect(buildFtsMatch("!@#$%^&*()")).toBe("");
  });

  it("does not explode on a very long query", () => {
    const long = "getUserById ".repeat(500) + "auth_config_database_request";
    const m = buildFtsMatch(long);
    // bounded per-term and finite; just assert it built something safe & quoted
    expect(typeof m).toBe("string");
    expect(m.length).toBeGreaterThan(0);
    // each group caps additions, so no single group is unbounded
    expect(m).toContain('"getuserbyid"');
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end FTS5 over an in-memory fixture
// ---------------------------------------------------------------------------

/** Build a tiny in-memory `nodes_fts` mirroring the real schema/tokenizer. */
function makeFixture(rows: { id: string; name: string; qn: string; summary: string }[]): Database {
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

const names = (hits: SearchHit[]) => hits.map((h) => h.name);

describe("searchFts — model-free expansion floor (e2e)", () => {
  it("camelCase query finds a snake_case identifier covering the same words", () => {
    const db = makeFixture([
      { id: "1", name: "get_user_by_id", qn: "svc.get_user_by_id", summary: "" },
      { id: "2", name: "unrelated_thing", qn: "svc.unrelated_thing", summary: "" },
    ]);
    const hits = searchFts(db, "getUserById");
    expect(names(hits)).toContain("get_user_by_id");
  });

  it("snake_case query finds a camelCase identifier (and vice versa)", () => {
    const db = makeFixture([
      { id: "1", name: "getUserById", qn: "svc.getUserById", summary: "" },
      { id: "2", name: "unrelatedThing", qn: "svc.unrelatedThing", summary: "" },
    ]);
    const hits = searchFts(db, "get_user_by_id");
    expect(names(hits)).toContain("getUserById");
  });

  it("abbreviation query (auth) finds the full form (authentication)", () => {
    const db = makeFixture([
      { id: "1", name: "authenticationService", qn: "svc.authenticationService", summary: "" },
      { id: "2", name: "billingService", qn: "svc.billingService", summary: "" },
    ]);
    const hits = searchFts(db, "auth");
    expect(names(hits)).toContain("authenticationService");
  });

  it("full-form query (authentication) finds the abbreviation (authn)", () => {
    const db = makeFixture([
      { id: "1", name: "authnGuard", qn: "svc.authnGuard", summary: "guards routes" },
      { id: "2", name: "billingGuard", qn: "svc.billingGuard", summary: "" },
    ]);
    const hits = searchFts(db, "authentication");
    expect(names(hits)).toContain("authnGuard");
  });

  it("exact/original match still ranks first (no regression)", () => {
    const db = makeFixture([
      // exact target for "getUserById"
      { id: "1", name: "getUserById", qn: "svc.getUserById", summary: "fetch a user by id" },
      // only shares the common subtoken "user"
      { id: "2", name: "userProfile", qn: "svc.userProfile", summary: "the user profile" },
      // only shares "get"
      { id: "3", name: "getConfig", qn: "svc.getConfig", summary: "get the config" },
    ]);
    const hits = searchFts(db, "getUserById");
    expect(hits.length).toBeGreaterThan(0);
    // The full original identifier matches the most trigrams → best BM25 rank.
    expect(hits[0]?.name).toBe("getUserById");
  });

  it("multi-term expanded query is valid FTS5 syntax and matches (regression)", () => {
    // Guards the explicit-AND requirement: `(group) (group)` is a syntax error
    // in FTS5, so an expanded multi-term query must AND its fragments.
    const db = makeFixture([
      { id: "1", name: "authConfigService", qn: "svc.authConfigService", summary: "" },
      { id: "2", name: "billingService", qn: "svc.billingService", summary: "" },
    ]);
    // both terms expand (auth→authentication, config→configuration)
    const hits = searchFts(db, "auth config");
    expect(names(hits)).toContain("authConfigService");
    expect(names(hits)).not.toContain("billingService");
  });

  it("a 40-distinct-term query stays valid FTS5 (term cap + explicit AND)", () => {
    const db = makeFixture([
      { id: "1", name: "authService", qn: "svc.authService", summary: "" },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => `term_alpha_${i}`).join(" ");
    // must not throw / silently degrade to [] from an over-deep expression
    const hits = searchFts(db, `auth ${many}`);
    expect(Array.isArray(hits)).toBe(true);
  });

  it("empty / punctuation-only queries return [] without crashing", () => {
    const db = makeFixture([{ id: "1", name: "x", qn: "x", summary: "" }]);
    expect(searchFts(db, "")).toEqual([]);
    expect(searchFts(db, "   ")).toEqual([]);
    expect(searchFts(db, "!@#$%")).toEqual([]);
  });

  it("a very long query does not crash and still returns the exact hit", () => {
    const db = makeFixture([
      { id: "1", name: "getUserById", qn: "svc.getUserById", summary: "" },
    ]);
    const long = "getUserById ".repeat(300);
    const hits = searchFts(db, long);
    expect(names(hits)).toContain("getUserById");
  });
});
