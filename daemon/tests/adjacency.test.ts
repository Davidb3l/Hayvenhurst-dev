import { describe, expect, it } from "bun:test";

import {
  findAdjacent,
  findOverlap,
  isAdjacent,
  modulePrefix,
  scopeNeighbors,
  type ClaimLike,
  type NeighborLookup,
} from "../src/conflict/adjacency.ts";

/** Build a neighbor lookup from an explicit adjacency map. */
function stubNeighbors(map: Record<string, string[]>): NeighborLookup {
  return (id) => map[id] ?? [];
}

const noNeighbors: NeighborLookup = () => [];

describe("findOverlap (hard conflict)", () => {
  const active: ClaimLike[] = [
    { id: "claim_a", scope: ["auth/login/handler", "auth/login/validate"] },
    { id: "claim_b", scope: ["billing/invoice/create"] },
  ];

  it("detects intersecting scopes and names the entities", () => {
    const hit = findOverlap(["auth/login/handler", "auth/session/refresh"], active);
    expect(hit).not.toBeNull();
    expect(hit?.claim.id).toBe("claim_a");
    expect(hit?.entities).toEqual(["auth/login/handler"]);
  });

  it("returns null when scopes are disjoint", () => {
    expect(findOverlap(["auth/session/refresh"], active)).toBeNull();
  });
});

describe("modulePrefix", () => {
  it("drops the last /-segment", () => {
    expect(modulePrefix("auth/login/handler")).toBe("auth/login");
    expect(modulePrefix("auth/login/Session.refresh")).toBe("auth/login");
  });
  it("returns null for a bare module or top-level id", () => {
    expect(modulePrefix("index")).toBeNull();
    expect(modulePrefix("auth/login")).toBe("auth");
  });
});

describe("isAdjacent", () => {
  it("is true via a graph edge connecting the two scopes", () => {
    const neighbors = stubNeighbors({
      "auth/login/handler": ["billing/invoice/create"],
    });
    expect(isAdjacent(["auth/login/handler"], ["billing/invoice/create"], neighbors)).toBe(true);
  });

  it("is true via a shared containing module prefix", () => {
    // Both live in `auth/login` but share no scope entity and no edge.
    expect(
      isAdjacent(["auth/login/handler"], ["auth/login/validate"], noNeighbors),
    ).toBe(true);
  });

  it("is false when neither edge nor module prefix connects them", () => {
    expect(
      isAdjacent(["auth/login/handler"], ["billing/invoice/create"], noNeighbors),
    ).toBe(false);
  });

  it("detects edges in the reverse direction too", () => {
    const neighbors = stubNeighbors({
      "billing/invoice/create": ["auth/login/handler"],
    });
    expect(isAdjacent(["auth/login/handler"], ["billing/invoice/create"], neighbors)).toBe(true);
  });
});

describe("scopeNeighbors", () => {
  it("unions per-entity neighbors and excludes the scope's own ids", () => {
    const neighbors = stubNeighbors({
      "a/m/x": ["a/m/y", "b/n/z"],
      "a/m/y": ["a/m/x", "c/o/w"],
    });
    const result = scopeNeighbors(["a/m/x", "a/m/y"], neighbors).sort();
    expect(result).toEqual(["b/n/z", "c/o/w"]);
  });
});

describe("findAdjacent", () => {
  const active: ClaimLike[] = [
    { id: "edge_neighbor", scope: ["billing/invoice/create"] },
    { id: "module_sibling", scope: ["auth/login/validate"] },
    { id: "unrelated", scope: ["search/index/build"] },
  ];
  const neighbors = stubNeighbors({
    "auth/login/handler": ["billing/invoice/create"],
  });

  it("returns every active claim adjacent by edge or module prefix", () => {
    const adj = findAdjacent(["auth/login/handler"], active, neighbors).map((c) => c.id).sort();
    expect(adj).toEqual(["edge_neighbor", "module_sibling"]);
  });
});
