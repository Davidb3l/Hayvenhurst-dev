import { describe, expect, test } from "bun:test";

import { deriveEdges, UINT16_MAX, type CpuProfile } from "../src/profile.ts";
import { makeResolver } from "../src/names.ts";

/**
 * Build a synthetic V8 CPU profile. `nodes` are given as
 * { id, fn, url, hit, children }. Deterministic — no live profiler.
 */
function profile(
  nodes: Array<{ id: number; fn: string; url?: string; hit?: number; children?: number[] }>,
): CpuProfile {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      callFrame: {
        functionName: n.fn,
        scriptId: String(n.id),
        url: n.url ?? "file:///proj/mod.ts",
        lineNumber: 0,
        columnNumber: 0,
      },
      hitCount: n.hit ?? 0,
      children: n.children ?? [],
    })),
  };
}

// A resolver scoped to /proj/ so synthetic frames are kept; internals dropped.
const resolver = makeResolver({ projectPaths: ["/proj/"] });

describe("deriveEdges (synthetic V8 CPU profile)", () => {
  test("derives caller->callee edges with subtree-summed observed counts", () => {
    // (root) -> top -> middle -> leaf
    //   leaf hit=10, middle hit=2, top hit=1
    const p = profile([
      { id: 1, fn: "(root)", url: "", children: [2] },
      { id: 2, fn: "top", url: "file:///proj/a.ts", hit: 1, children: [3] },
      { id: 3, fn: "middle", url: "file:///proj/a.ts", hit: 2, children: [4] },
      { id: 4, fn: "leaf", url: "file:///proj/a.ts", hit: 10 },
    ]);
    const edges = deriveEdges(p, resolver);
    const m = new Map(edges.map((e) => [`${e.src}->${e.dst}`, e.observed]));

    // (root) is a pseudo-frame -> dropped, so no "(root)->top" edge.
    expect(m.has("(root)->a:top")).toBe(false);
    // top -> middle: middle's subtree = middle(2)+leaf(10) = 12
    expect(m.get("a:top->a:middle")).toBe(12);
    // middle -> leaf: leaf subtree = 10
    expect(m.get("a:middle->a:leaf")).toBe(10);
  });

  test("aggregates the same (caller,callee) pair across multiple call sites", () => {
    // top calls helper twice (two distinct child nodes, same names).
    const p = profile([
      { id: 1, fn: "top", url: "file:///proj/a.ts", hit: 0, children: [2, 3] },
      { id: 2, fn: "helper", url: "file:///proj/a.ts", hit: 4 },
      { id: 3, fn: "helper", url: "file:///proj/a.ts", hit: 6 },
    ]);
    const edges = deriveEdges(p, resolver);
    expect(edges.length).toBe(1);
    expect(edges[0]).toMatchObject({ src: "a:top", dst: "a:helper", observed: 10 });
  });

  test("splices out dropped (internal) frames so kept caller reaches kept callee", () => {
    // user -> node:internal -> user2. The internal frame is dropped; the edge
    // should connect user -> user2 directly across it.
    const p = profile([
      { id: 1, fn: "userA", url: "file:///proj/a.ts", hit: 0, children: [2] },
      { id: 2, fn: "internalThing", url: "node:internal/foo", hit: 1, children: [3] },
      { id: 3, fn: "userB", url: "file:///proj/b.ts", hit: 5 },
    ]);
    const edges = deriveEdges(p, resolver);
    const m = new Map(edges.map((e) => [`${e.src}->${e.dst}`, e.observed]));
    expect(m.has("a:userA->b:userB")).toBe(true);
    // userB subtree = 5; the internal node's own hit is not attributed to a
    // kept edge as a separate dst (it's elided).
    expect(m.get("a:userA->b:userB")).toBe(5);
    expect([...m.keys()].some((k) => k.includes("internalThing"))).toBe(false);
  });

  test("drops anonymous frames (no stable resolvable name)", () => {
    const p = profile([
      { id: 1, fn: "named", url: "file:///proj/a.ts", hit: 0, children: [2] },
      { id: 2, fn: "", url: "file:///proj/a.ts", hit: 3, children: [3] },
      { id: 3, fn: "deep", url: "file:///proj/a.ts", hit: 4 },
    ]);
    const edges = deriveEdges(p, resolver);
    const m = new Map(edges.map((e) => [`${e.src}->${e.dst}`, e.observed]));
    // anon spliced out: named -> deep directly.
    expect(m.get("a:named->a:deep")).toBe(4);
    expect(edges.length).toBe(1);
  });

  test("no self-loops even if a frame name repeats adjacently", () => {
    const p = profile([
      { id: 1, fn: "rec", url: "file:///proj/a.ts", hit: 1, children: [2] },
      { id: 2, fn: "rec", url: "file:///proj/a.ts", hit: 2 },
    ]);
    const edges = deriveEdges(p, resolver);
    expect(edges.length).toBe(0); // a:rec -> a:rec is a self-loop, dropped
  });

  test("clamps observed to the uint16 ceiling", () => {
    const p = profile([
      { id: 1, fn: "top", url: "file:///proj/a.ts", hit: 0, children: [2] },
      { id: 2, fn: "hot", url: "file:///proj/a.ts", hit: 100000 },
    ]);
    const edges = deriveEdges(p, resolver);
    expect(edges[0]!.observed).toBe(UINT16_MAX);
  });

  test("empty / malformed profile yields no edges", () => {
    expect(deriveEdges({ nodes: [] }, resolver)).toEqual([]);
    expect(deriveEdges({ nodes: undefined as unknown as [] }, resolver)).toEqual([]);
  });
});
