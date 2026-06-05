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

import { Db } from "../src/db/queries.ts";
import {
  forgetMemory,
  listMemory,
  memoryForNode,
  pruneExpired,
  recordMemory,
  searchMemory,
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
