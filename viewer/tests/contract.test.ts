// Contract tests: feed CAPTURED REAL daemon payloads through the api.*
// adapters and assert the output matches the shape the viewer components
// actually consume (StatsResponse, SearchHit, NodeDetail).
//
// This is the safety net whose absence let the server↔viewer shapes drift
// silently: the viewer was built against mocks, the daemon shipped different
// JSON, and nothing failed until a live daemon rendered broken. The payloads
// below are verbatim from curl against a live daemon — if the daemon contract
// changes again, these tests break and point at the exact adapter to update.

import { test, expect, describe } from "bun:test";
import { adaptStats, adaptSearch, adaptNode } from "../src/api/client";

describe("daemon contract: GET /api/stats", () => {
  // Verbatim live payload.
  const LIVE = {
    nodes: 1172,
    edges: 3995,
    claims: 0,
    traces: 0,
    gset_ops: 0,
    last_trace: null,
    last_ingest_at: 1780118898629,
    merge_rejections: 0,
    port: 7777,
  };

  test("maps last_ingest_at → last_ingest (epoch-ms) and defaults peers", () => {
    const s = adaptStats(LIVE);
    expect(s.nodes).toBe(1172);
    expect(s.edges).toBe(3995);
    expect(s.traces).toBe(0);
    // last_ingest must be the epoch-ms number (Stats.tsx does new Date(it)).
    expect(s.last_ingest).toBe(1780118898629);
    // and it must be a valid Date, NOT "never".
    expect(Number.isNaN(new Date(s.last_ingest as number).getTime())).toBe(false);
    // peers is never sent by the server → defaulted to [].
    expect(s.peers).toEqual([]);
    // recent_activity is absent (server doesn't send it; UI guards on it).
    expect(s.recent_activity).toBeUndefined();
  });

  test("null last_ingest_at maps to null (renders 'never')", () => {
    const s = adaptStats({ ...LIVE, last_ingest_at: null });
    expect(s.last_ingest).toBeNull();
  });
});

describe("daemon contract: GET /api/search", () => {
  const LIVE = {
    query: "decode",
    count: 20,
    hits: [
      {
        id: "crdt/wire/decode",
        name: "decode",
        qualified_name: "decode",
        summary: "",
        rank: -6.65,
      },
    ],
  };

  test("maps summary → snippet and rank → score", () => {
    const r = adaptSearch(LIVE);
    expect(r.hits).toHaveLength(1);
    const h = r.hits[0]!;
    expect(h.id).toBe("crdt/wire/decode");
    expect(h.name).toBe("decode");
    expect(h.snippet).toBe(""); // from summary, never undefined
    expect(h.score).toBe(-6.65); // from rank
    // The component renders h.score.toFixed(2) and h.snippet — both must be
    // defined so it does not throw.
    expect(typeof h.score).toBe("number");
    expect(() => h.score.toFixed(2)).not.toThrow();
    expect(typeof h.snippet).toBe("string");
  });

  test("empty summary stays a string, not undefined", () => {
    const r = adaptSearch({ hits: [{ id: "x/y", name: "y", rank: -1 }] });
    expect(r.hits[0]!.snippet).toBe("");
  });
});

describe("daemon contract: GET /api/nodes/<id>", () => {
  const LIVE = {
    node: {
      id: "native/src/serialize/wire.rs/decode_op",
      name: "decode_op",
      qualified_name: "decode_op",
      kind: "function" as const,
      language: "rust",
      file: "native/src/serialize/wire.rs",
      range: [400, 468] as [number, number],
      ast_hash: "abc123",
      last_seen: 1780118898507,
      logical_clock: 0,
    },
    neighbors: {
      callers: [
        { src: "a/b/caller", dst: "this/id", kind: "static_call" as const, weight: 1, last_seen: 123 },
      ],
      callees: [
        { src: "this/id", dst: "x/y/callee", kind: "static_call" as const, weight: 4, last_seen: 123 },
      ],
    },
    markdown: "---\nfront: matter\n---\n\n# decode_op\n\nbody text",
  };

  test("flattens node.*, tuple range → {start,end}, markdown → body_md", () => {
    const n = adaptNode(LIVE);
    expect(n.id).toBe("native/src/serialize/wire.rs/decode_op");
    expect(n.kind).toBe("function");
    expect(n.language).toBe("rust");
    expect(n.file).toBe("native/src/serialize/wire.rs");
    expect(n.range).toEqual({ start: 400, end: 468 });
    // body_md strips the leading YAML frontmatter (shown in the header instead).
    expect(n.body_md).toBe("# decode_op\n\nbody text");
    expect(n.body_md).not.toContain("front: matter");
  });

  test("builds caller NodeRefs from neighbors.callers (other node = src)", () => {
    const n = adaptNode(LIVE);
    expect(n.callers).toHaveLength(1);
    const c = n.callers[0]!;
    expect(c.id).toBe("a/b/caller");
    expect(c.name).toBe("caller"); // last path segment
    expect(c.weight).toBe(1);
  });

  test("builds callee NodeRefs from neighbors.callees (other node = dst)", () => {
    const n = adaptNode(LIVE);
    expect(n.callees).toHaveLength(1);
    const c = n.callees[0]!;
    expect(c.id).toBe("x/y/callee");
    expect(c.name).toBe("callee");
    expect(c.weight).toBe(4);
  });

  test("is defensive when edge.kind is briefly missing (cross-lane rollout)", () => {
    const noKind = {
      ...LIVE,
      neighbors: {
        callers: [{ src: "a/b/caller", dst: "this/id", weight: 1 } as never],
        callees: [],
      },
    };
    expect(() => adaptNode(noKind)).not.toThrow();
    const n = adaptNode(noKind);
    expect(n.callers[0]!.id).toBe("a/b/caller");
  });
});
