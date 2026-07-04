/**
 * FLEET MEMORY — storage + query engine (`daemon/src/db/fleet_memory.ts`).
 *
 * Fleet memory is the shared, cross-agent/cross-session KNOWLEDGE store (decisions,
 * dead-ends, gotchas, notes) keyed to the code graph — read-mostly, never blocks,
 * optionally TTL'd. These tests drive a synthetic in-memory Db (`new Db(":memory:")`
 * + `migrate()`, which creates the schema-v6 `fleet_memory` table) and pin:
 *   - record → read round trip preserving EVERY field (incl. scope + ttl);
 *   - `memoryForNode` matching BOTH a direct `node_id` AND scope-array membership,
 *     and NOT false-matching a substring (`foo` vs `foobar`);
 *   - expiry excluding a stale note from EVERY read, and `pruneExpired` removing it
 *     + returning the count;
 *   - `searchMemory` case-insensitive substring;
 *   - `listMemory` kind filter + limit + newest-first order;
 *   - `forgetMemory` true/false;
 *   - deterministic id (same fields+now → same id; different now → different id).
 *
 * `now` is injected everywhere so the suite is deterministic with no real clock.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import {
  forgetMemory,
  listMemory,
  memoryForNode,
  pruneExpired,
  recordMemory,
  searchMemory,
  searchMemorySubstring,
  type MemoryNote,
} from "../src/db/fleet_memory.ts";

/** A fresh migrated in-memory Db per test (no shared state, no disk). */
function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

describe("fleet_memory: record → read round trip", () => {
  it("preserves every field including scope and ttl", () => {
    const db = freshDb();
    const now = 1_000_000;
    const stored = recordMemory(db, {
      agent: "agent-a",
      nodeId: "mod/foo",
      kind: "decision",
      note: "chose sqlite over postgres for the index",
      scope: ["mod/bar", "mod/baz"],
      ttl: 3600,
      now,
      id: "fixed-id-1",
    });

    // The returned note reflects exactly what was asked for.
    expect(stored.id).toBe("fixed-id-1");
    expect(stored.agent).toBe("agent-a");
    expect(stored.nodeId).toBe("mod/foo");
    expect(stored.kind).toBe("decision");
    expect(stored.note).toBe("chose sqlite over postgres for the index");
    expect(stored.scope).toEqual(["mod/bar", "mod/baz"]);
    expect(stored.created).toBe(now);
    expect(stored.ttl).toBe(3600);

    // And reading it back out of the table yields an identical note (scope
    // round-trips through scope_json, nullable columns survive).
    const read = listMemory(db, now);
    expect(read.length).toBe(1);
    expect(read[0]).toEqual(stored as MemoryNote);
  });

  it("stores null agent/nodeId/ttl as null and empty scope as []", () => {
    const db = freshDb();
    const now = 2_000_000;
    const stored = recordMemory(db, {
      kind: "note",
      note: "repo-wide reminder",
      now,
      id: "fixed-id-2",
    });
    expect(stored.agent).toBeNull();
    expect(stored.nodeId).toBeNull();
    expect(stored.ttl).toBeNull();
    expect(stored.scope).toEqual([]);

    const read = listMemory(db, now);
    expect(read[0]?.agent).toBeNull();
    expect(read[0]?.nodeId).toBeNull();
    expect(read[0]?.ttl).toBeNull();
    expect(read[0]?.scope).toEqual([]);
  });
});

describe("fleet_memory: memoryForNode (direct node_id + scope-array membership)", () => {
  it("matches a direct node_id, a scope-array member, and rejects a substring false-match", () => {
    const db = freshDb();
    const now = 1_000;

    // Direct node_id match.
    recordMemory(db, {
      kind: "gotcha",
      note: "direct hit on foo",
      nodeId: "foo",
      now,
      id: "n-direct",
    });
    // scope-array membership: note about "other", but lists "foo" in scope.
    recordMemory(db, {
      kind: "decision",
      note: "scoped to include foo",
      nodeId: "other",
      scope: ["foo", "qux"],
      now: now + 1,
      id: "n-scope",
    });
    // The substring trap: a note about/scoped to "foobar" must NOT match "foo".
    recordMemory(db, {
      kind: "note",
      note: "about foobar only",
      nodeId: "foobar",
      scope: ["foobar"],
      now: now + 2,
      id: "n-foobar",
    });

    const hits = memoryForNode(db, "foo", now + 10);
    const ids = hits.map((h) => h.id).sort();
    expect(ids).toEqual(["n-direct", "n-scope"]);
    // Explicitly confirm the substring note was excluded.
    expect(ids).not.toContain("n-foobar");
  });

  it("returns newest-first and excludes expired notes", () => {
    const db = freshDb();
    // Two live + one expired, all about node "x".
    recordMemory(db, { kind: "note", note: "older", nodeId: "x", now: 100, id: "old" });
    recordMemory(db, { kind: "note", note: "newer", nodeId: "x", now: 200, id: "new" });
    // ttl 1s, created at 100ms → expires at 1100ms.
    recordMemory(db, { kind: "note", note: "stale", nodeId: "x", ttl: 1, now: 100, id: "stale" });

    const hits = memoryForNode(db, "x", 5_000);
    expect(hits.map((h) => h.id)).toEqual(["new", "old"]); // newest first, stale gone
  });
});

describe("fleet_memory: expiry + pruneExpired", () => {
  it("excludes a stale note from every read and pruneExpired removes it", () => {
    const db = freshDb();
    // Permanent note (ttl null) + an ephemeral note that will expire.
    recordMemory(db, { kind: "note", note: "permanent", nodeId: "p", now: 0, id: "perm" });
    // ttl 10s from created=1000ms → live until 11000ms.
    recordMemory(db, {
      kind: "deadend",
      note: "ephemeral deadend on p",
      nodeId: "p",
      scope: ["p"],
      ttl: 10,
      now: 1_000,
      id: "eph",
    });

    const beforeExpiry = 5_000; // both live
    const afterExpiry = 50_000; // ephemeral expired

    // While live, every read surfaces both.
    expect(listMemory(db, beforeExpiry).map((n) => n.id).sort()).toEqual(["eph", "perm"]);
    expect(memoryForNode(db, "p", beforeExpiry).map((n) => n.id).sort()).toEqual(["eph", "perm"]);
    expect(searchMemory(db, "deadend", beforeExpiry).map((n) => n.id)).toEqual(["eph"]);

    // After expiry, the ephemeral note vanishes from EVERY read path.
    expect(listMemory(db, afterExpiry).map((n) => n.id)).toEqual(["perm"]);
    expect(memoryForNode(db, "p", afterExpiry).map((n) => n.id)).toEqual(["perm"]);
    expect(searchMemory(db, "deadend", afterExpiry)).toEqual([]);

    // …but it's still physically in the table until pruned: pruneExpired returns
    // the count removed (just the 1 expired row; the permanent one is untouched).
    expect(pruneExpired(db, afterExpiry)).toBe(1);
    // A second prune is a no-op (nothing left expired).
    expect(pruneExpired(db, afterExpiry)).toBe(0);
    // The permanent note survives the prune.
    expect(listMemory(db, afterExpiry).map((n) => n.id)).toEqual(["perm"]);
  });

  it("pruneExpired never removes permanent (ttl null) notes even far in the future", () => {
    const db = freshDb();
    recordMemory(db, { kind: "note", note: "forever", now: 0, id: "forever" });
    expect(pruneExpired(db, Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(listMemory(db, Number.MAX_SAFE_INTEGER).map((n) => n.id)).toEqual(["forever"]);
  });
});

describe("fleet_memory: searchMemory (case-insensitive substring)", () => {
  it("matches a substring regardless of case and excludes expired", () => {
    const db = freshDb();
    recordMemory(db, { kind: "gotcha", note: "The Watcher Hangs on FSEvents", now: 10, id: "s1" });
    recordMemory(db, { kind: "note", note: "unrelated content", now: 20, id: "s2" });

    // Case-insensitive substring.
    expect(searchMemory(db, "watcher", 100).map((n) => n.id)).toEqual(["s1"]);
    expect(searchMemory(db, "FSEVENTS", 100).map((n) => n.id)).toEqual(["s1"]);
    // No match → empty.
    expect(searchMemory(db, "nonexistent", 100)).toEqual([]);
  });

  it("honors the limit cap and newest-first order", () => {
    const db = freshDb();
    recordMemory(db, { kind: "note", note: "match one", now: 1, id: "m1" });
    recordMemory(db, { kind: "note", note: "match two", now: 2, id: "m2" });
    recordMemory(db, { kind: "note", note: "match three", now: 3, id: "m3" });

    const limited = searchMemory(db, "match", 100, 2);
    expect(limited.map((n) => n.id)).toEqual(["m3", "m2"]); // newest 2 first
  });
});

describe("fleet_memory: listMemory (kind filter + limit + order)", () => {
  it("filters by kind, caps with limit, and returns newest-first", () => {
    const db = freshDb();
    recordMemory(db, { kind: "decision", note: "d1", now: 1, id: "d1" });
    recordMemory(db, { kind: "gotcha", note: "g1", now: 2, id: "g1" });
    recordMemory(db, { kind: "decision", note: "d2", now: 3, id: "d2" });
    recordMemory(db, { kind: "decision", note: "d3", now: 4, id: "d3" });

    // No filter → all four, newest first.
    expect(listMemory(db, 100).map((n) => n.id)).toEqual(["d3", "d2", "g1", "d1"]);

    // kind filter → only decisions, newest first.
    expect(listMemory(db, 100, { kind: "decision" }).map((n) => n.id)).toEqual([
      "d3",
      "d2",
      "d1",
    ]);

    // kind filter + limit.
    expect(
      listMemory(db, 100, { kind: "decision", limit: 2 }).map((n) => n.id),
    ).toEqual(["d3", "d2"]);
  });
});

describe("fleet_memory: forgetMemory", () => {
  it("returns true when a row is removed and false when the id is unknown", () => {
    const db = freshDb();
    recordMemory(db, { kind: "note", note: "to be forgotten", now: 1, id: "gone" });

    expect(forgetMemory(db, "gone")).toBe(true);
    expect(listMemory(db, 100)).toEqual([]);
    // Second delete of the same id (now absent) → false.
    expect(forgetMemory(db, "gone")).toBe(false);
    // Never-existed id → false.
    expect(forgetMemory(db, "never")).toBe(false);
  });
});

describe("fleet_memory: searchMemory FTS+expansion recall (substring MISSES, FTS HITS)", () => {
  it("recalls an identifier note (authHandler/auth_handler) for the query 'auth handler'", () => {
    const db = freshDb();
    // Two notes whose identifiers contain the query words run TOGETHER (camelCase
    // / snake_case). A contiguous-substring LIKE can't bridge the space in the
    // query; identifier tokenization in the expansion floor can.
    recordMemory(db, { kind: "gotcha", note: "the authHandler swallows 401s silently", now: 10, id: "h-camel" });
    recordMemory(db, { kind: "note", note: "auth_handler must run before the rate limiter", now: 20, id: "h-snake" });
    recordMemory(db, { kind: "note", note: "unrelated note about the parser", now: 30, id: "h-other" });

    // Baseline substring misses BOTH (no contiguous "auth handler" run anywhere).
    expect(searchMemorySubstring(db, "auth handler", 100)).toEqual([]);

    // FTS+expansion recalls both identifier notes, newest first, and never the
    // unrelated note.
    expect(searchMemory(db, "auth handler", 100).map((n) => n.id)).toEqual(["h-snake", "h-camel"]);
  });

  it("recalls a 'cfg' note for the query 'config' via the abbreviation table", () => {
    const db = freshDb();
    recordMemory(db, { kind: "note", note: "remember to reload cfg after a hot swap", now: 10, id: "abbr" });
    recordMemory(db, { kind: "note", note: "nothing relevant here", now: 20, id: "noise" });

    // Substring can't bridge config ↔ cfg (no shared contiguous run).
    expect(searchMemorySubstring(db, "config", 100)).toEqual([]);
    // The abbrev partner (config → cfg) is OR-ed into the MATCH → hit.
    expect(searchMemory(db, "config", 100).map((n) => n.id)).toEqual(["abbr"]);
  });

  it("recalls a multi-token note where only SOME words overlap (relaxed fallback)", () => {
    const db = freshDb();
    // The precise AND-of-all-words path can't match (no single note has every
    // word), but the relaxed fallback ORs the content words after dropping the
    // English stopword "the", so the best-overlap note still surfaces.
    recordMemory(db, { kind: "decision", note: "merkle anti-entropy converges peers", now: 10, id: "mt" });
    recordMemory(db, { kind: "note", note: "completely different subject", now: 20, id: "mt-noise" });

    expect(searchMemorySubstring(db, "how do peers converge", 100)).toEqual([]);
    expect(searchMemory(db, "how do peers converge", 100).map((n) => n.id)).toEqual(["mt"]);
  });
});

describe("fleet_memory: searchMemory FTS path preserves LIVE/order/limit/fallback", () => {
  it("excludes expired notes through the FTS path", () => {
    const db = freshDb();
    // Both notes contain the query identifier; one is expired at read time.
    recordMemory(db, { kind: "note", note: "the authHandler is live", now: 1_000, id: "live" });
    // ttl 1s, created at 1000ms → expires at 2000ms.
    recordMemory(db, { kind: "note", note: "the authHandler is stale", ttl: 1, now: 1_000, id: "stale" });

    // At 1500ms both are live; at 50_000ms only the permanent-ish one survives.
    expect(searchMemory(db, "auth handler", 1_500).map((n) => n.id).sort()).toEqual(["live", "stale"]);
    expect(searchMemory(db, "auth handler", 50_000).map((n) => n.id)).toEqual(["live"]);
  });

  it("returns newest-first and honors the limit cap through the FTS path", () => {
    const db = freshDb();
    recordMemory(db, { kind: "note", note: "authHandler one", now: 1, id: "f1" });
    recordMemory(db, { kind: "note", note: "authHandler two", now: 2, id: "f2" });
    recordMemory(db, { kind: "note", note: "authHandler three", now: 3, id: "f3" });

    // All three, newest first.
    expect(searchMemory(db, "authHandler", 100).map((n) => n.id)).toEqual(["f3", "f2", "f1"]);
    // Cap to the newest 2.
    expect(searchMemory(db, "authHandler", 100, 2).map((n) => n.id)).toEqual(["f3", "f2"]);
  });

  it("falls back to the substring path for punctuation-only input (empty MATCH)", () => {
    const db = freshDb();
    // A note whose text literally contains the punctuation run, so the substring
    // fallback can match it — proving the empty-MATCH path routed to substring.
    recordMemory(db, { kind: "note", note: "edge case: a->b transition", now: 10, id: "punct" });
    recordMemory(db, { kind: "note", note: "no arrows here", now: 20, id: "no-punct" });

    // "->" sanitizes to an EMPTY FTS MATCH (no word chars) → substring fallback,
    // which finds the literal "->" run.
    expect(searchMemory(db, "->", 100).map((n) => n.id)).toEqual(["punct"]);
    // And it agrees with calling the substring baseline directly.
    expect(searchMemory(db, "->", 100).map((n) => n.id)).toEqual(
      searchMemorySubstring(db, "->", 100).map((n) => n.id),
    );
  });

  it("FTS path stays at LEAST as good as substring for an exact contiguous term", () => {
    const db = freshDb();
    recordMemory(db, { kind: "gotcha", note: "The Watcher Hangs on FSEvents", now: 10, id: "x1" });
    recordMemory(db, { kind: "note", note: "unrelated content", now: 20, id: "x2" });

    // An exact word that substring already matched must still match via FTS.
    expect(searchMemorySubstring(db, "watcher", 100).map((n) => n.id)).toEqual(["x1"]);
    expect(searchMemory(db, "watcher", 100).map((n) => n.id)).toEqual(["x1"]);
  });
});

describe("fleet_memory: deterministic id derivation", () => {
  it("derives the same id for identical fields+now and a different id for a different now", () => {
    const db = freshDb();
    const base = {
      agent: "agent-x",
      nodeId: "node-y",
      kind: "decision" as const,
      note: "same note body",
    };

    // Same fields + same now → same derived id (idempotent re-record).
    const a = recordMemory(db, { ...base, now: 5_000 });
    const b = recordMemory(db, { ...base, now: 5_000 });
    expect(a.id).toBe(b.id);
    // Idempotent: re-recording the identical note didn't create a 2nd row.
    expect(listMemory(db, 10_000).length).toBe(1);

    // Same fields, DIFFERENT now → different id (so a later note is distinct).
    const c = recordMemory(db, { ...base, now: 6_000 });
    expect(c.id).not.toBe(a.id);
    expect(listMemory(db, 10_000).length).toBe(2);

    // The derived id is non-empty and prefixed (sanity on the hashing path).
    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id.startsWith("mem_")).toBe(true);
  });
});

describe("fleet memory FTS sync on a non-migrated write connection (the CLI path)", () => {
  // The daemonless `hayven memory` CLI opens the index via openProjectDb → a fresh
  // `new Db(path)` WITHOUT calling migrate(). recordMemory writes via INSERT OR
  // REPLACE; the fleet_memory_fts delete-then-insert sync only nets correctly when
  // recursive_triggers is ON, which the Db constructor now sets on every WRITE
  // connection (not just migrated ones). Regression guard: a same-id re-record on a
  // non-migrated connection must NOT leave a duplicate FTS row.
  it("a same-id re-record does not duplicate the FTS row (no migrate on reopen)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-mem-fts-"));
    const path = join(dir, "index.sqlite");
    try {
      // Create + migrate once (as `init`/`ingest` would), then close.
      const seed = new Db(path);
      seed.migrate();
      seed.close();

      // Reopen WITHOUT migrate — exactly what openProjectDb does for the CLI.
      const db = new Db(path);
      const input = { kind: "note" as const, note: "authHandler validates the bearer token", now: 1000 };
      recordMemory(db, input); // INSERT
      recordMemory(db, input); // same fields+now → same id → INSERT OR REPLACE

      // FTS recall returns the note exactly ONCE (no stale/duplicate FTS row).
      const hits = searchMemory(db, "auth handler", 1000);
      expect(hits.length).toBe(1);
      // And the raw FTS table holds a single row for that id.
      const id = hits[0]!.id;
      const ftsCount = db.handle
        .query<{ c: number }, [string]>("SELECT COUNT(*) c FROM fleet_memory_fts WHERE id = ?")
        .get(id)!.c;
      expect(ftsCount).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
