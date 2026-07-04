// E2 — graph-precise conflict: unit tests for the selectable adjacency GATE
// (findAdjacent / gatePredicate / scopesGraphConnected) and the new structural
// GraphAdjacencyOracle. Pure, deterministic, no DB/HTTP. The measured behavior
// (benign-block vs escape across gates/oracles) lives in
// bench/graph-precise-conflict.ts + bench/graph-precise-conflict-RESULTS.md.
import { describe, expect, test } from "bun:test";

import {
  edgeAdjacency,
  findAdjacent,
  gatePredicate,
  isAdjacent,
  scopesGraphConnected,
  type NeighborLookup,
} from "../src/conflict/adjacency.ts";
import {
  GraphAdjacencyOracle,
  HeuristicOracle,
  selectOracle,
  type ClaimContext,
} from "../src/conflict/oracle.ts";

// Tiny fixture graph:
//   a --edge--> b        (direct call/import edge a↔b)
//   a --edge--> c, and   b --edge--> c   → a and b BOTH call c (shared neighbor),
//                                          but there is ALSO a direct a↔b edge.
//   d --edge--> c, e --edge--> c → d and e share neighbor c, NO direct d↔e edge.
//   f, g: same module as one another, NO edges at all (pure co-location).
const EDGES: Record<string, string[]> = {
  "app/x/a": ["app/x/b", "app/y/c"],
  "app/x/b": ["app/y/c"],
  "app/z/d": ["app/y/c"],
  "app/z/e": ["app/y/c"],
  "app/q/f": [],
  "app/q/g": [],
};
const neighbors: NeighborLookup = (id) => {
  const out = new Set<string>();
  for (const dst of EDGES[id] ?? []) out.add(dst);
  for (const [src, dsts] of Object.entries(EDGES)) if (dsts.includes(id)) out.add(src);
  return [...out];
};

describe("E2 adjacency gate — scope predicates", () => {
  test("edgeAdjacency: only a direct edge, not a shared neighbor", () => {
    expect(edgeAdjacency(["app/x/a"], ["app/x/b"], neighbors)).toBe(true); // direct a↔b
    expect(edgeAdjacency(["app/z/d"], ["app/z/e"], neighbors)).toBe(false); // share c, no direct edge
    expect(edgeAdjacency(["app/q/f"], ["app/q/g"], neighbors)).toBe(false); // pure co-location
  });

  test("scopesGraphConnected: direct edge OR shared neighbor, but not pure co-location", () => {
    expect(scopesGraphConnected(["app/x/a"], ["app/x/b"], neighbors)).toBe(true); // direct
    expect(scopesGraphConnected(["app/z/d"], ["app/z/e"], neighbors)).toBe(true); // shared neighbor c
    expect(scopesGraphConnected(["app/q/f"], ["app/q/g"], neighbors)).toBe(false); // no edge, no shared nbr
  });

  test("isAdjacent (module+edge): also fires on pure module co-location", () => {
    expect(isAdjacent(["app/q/f"], ["app/q/g"], neighbors)).toBe(true); // same module app/q
    expect(isAdjacent(["app/x/a"], ["app/z/e"], neighbors)).toBe(false); // diff module, no edge/nbr overlap
  });

  test("gatePredicate returns the right predicate per gate", () => {
    const coloc: [string[], string[]] = [["app/q/f"], ["app/q/g"]]; // same module, no edge
    const sharedNbr: [string[], string[]] = [["app/z/d"], ["app/z/e"]]; // shared neighbor, no edge
    const direct: [string[], string[]] = [["app/x/a"], ["app/x/b"]]; // direct edge

    const moduleEdge = gatePredicate("module+edge", neighbors);
    const edge = gatePredicate("edge", neighbors);
    const graph = gatePredicate("graph", neighbors);

    // module+edge: co-located OR connected → all three are candidates.
    expect(moduleEdge(...coloc)).toBe(true);
    expect(moduleEdge(...sharedNbr)).toBe(true);
    expect(moduleEdge(...direct)).toBe(true);

    // edge: ONLY a direct edge.
    expect(edge(...coloc)).toBe(false);
    expect(edge(...sharedNbr)).toBe(false);
    expect(edge(...direct)).toBe(true);

    // graph: direct edge OR shared neighbor, NOT pure co-location.
    expect(graph(...coloc)).toBe(false);
    expect(graph(...sharedNbr)).toBe(true);
    expect(graph(...direct)).toBe(true);
  });
});

describe("E2 adjacency gate — findAdjacent", () => {
  const active = [
    { id: "coloc", scope: ["app/q/g"] }, // same module as app/q/f, no edge
    { id: "shared", scope: ["app/z/e"] }, // shares neighbor c with app/z/d
    { id: "direct", scope: ["app/x/b"] }, // direct edge with app/x/a
  ];

  test("default gate is module+edge (byte-compatible with legacy callers)", () => {
    // A co-located incoming (app/q/f) is adjacent to `coloc` under the default.
    const got = findAdjacent(["app/q/f"], active, neighbors).map((c) => c.id);
    expect(got).toContain("coloc");
  });

  test("edge gate drops co-located AND shared-neighbor candidates", () => {
    // Incoming app/z/d: only `shared` is graph-related (via neighbor c), and there
    // is no direct edge → edge gate selects NOTHING for it.
    expect(findAdjacent(["app/z/d"], active, neighbors, "edge")).toHaveLength(0);
    // Incoming app/x/a has a direct edge to `direct` (app/x/b).
    expect(findAdjacent(["app/x/a"], active, neighbors, "edge").map((c) => c.id)).toEqual(["direct"]);
  });

  test("graph gate keeps shared-neighbor but drops pure co-location", () => {
    // app/z/d shares the hub neighbor `c` with BOTH app/z/e (`shared`) and
    // app/x/b (`direct`) — so both are graph-connected — but NOT with the
    // co-located, edgeless app/q/g (`coloc`).
    const got = findAdjacent(["app/z/d"], active, neighbors, "graph").map((c) => c.id);
    expect(got).toContain("shared");
    expect(got).toContain("direct");
    expect(got).not.toContain("coloc");
    // A purely co-located incoming (app/q/f) selects nothing under the graph gate.
    expect(findAdjacent(["app/q/f"], active, neighbors, "graph")).toHaveLength(0);
  });
});

describe("E2 GraphAdjacencyOracle — structure-only verdict", () => {
  const oracle = new GraphAdjacencyOracle();
  const ctx = (scope: string[]): ClaimContext => ({
    scope,
    intent: "edit",
    neighbors: [...new Set(scope.flatMap((s) => neighbors(s)))].filter((n) => !scope.includes(n)),
  });

  test("conflict iff a direct dependency edge couples the scopes", async () => {
    const direct = await oracle.assess(ctx(["app/x/a"]), ctx(["app/x/b"]));
    expect(direct.conflict).toBe(true);
    expect(direct.oracle).toBe("graph-adjacency");

    // Shared neighbor only (d, e both call c) → NOT contract-coupled → no conflict.
    const shared = await oracle.assess(ctx(["app/z/d"]), ctx(["app/z/e"]));
    expect(shared.conflict).toBe(false);

    // Pure co-location → no conflict.
    const coloc = await oracle.assess(ctx(["app/q/f"]), ctx(["app/q/g"]));
    expect(coloc.conflict).toBe(false);
  });

  test("selectOracle resolves the graph-adjacency id without any env", () => {
    expect(selectOracle({ conflict: { oracle: "graph-adjacency" } })).toBeInstanceOf(GraphAdjacencyOracle);
    // Unchanged defaults: heuristic for the zero-config / unknown-key case.
    expect(selectOracle({ conflict: { oracle: "heuristic-v1" } })).toBeInstanceOf(HeuristicOracle);
    expect(selectOracle()).toBeInstanceOf(HeuristicOracle);
  });
});
