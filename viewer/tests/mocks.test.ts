import { test, expect, describe } from "bun:test";
import { mockNeighbors, mockSearch, mockStats, mockNode, seedNames, seedEdges } from "../src/api/mocks";

describe("mock api", () => {
  test("stats reports the seed totals", () => {
    const s = mockStats();
    expect(s.nodes).toBe(seedNames.length);
    expect(s.edges).toBe(seedEdges.length);
  });

  test("neighbors returns the 1-hop subgraph for a known id", () => {
    const r = mockNeighbors("auth/login_handler");
    expect(r.center).toBe("auth/login_handler");
    expect(r.cluster_level).toBe("function");
    expect(r.nodes.length).toBeGreaterThan(1);
    expect(r.edges.length).toBeGreaterThan(0);
    expect(r.total_raw_nodes).toBe(r.nodes.length);
    // Every edge endpoint should be in the node set.
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const e of r.edges) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
  });

  test("neighbors returns the whole seed for unknown id", () => {
    const r = mockNeighbors("*");
    expect(r.nodes.length).toBe(seedNames.length);
    expect(r.total_raw_nodes).toBe(seedNames.length);
  });

  test("search filters by id substring", () => {
    const r = mockSearch("login");
    expect(r.hits.length).toBeGreaterThan(0);
    for (const h of r.hits) {
      expect(h.id.toLowerCase().includes("login") || h.name.toLowerCase().includes("login")).toBe(true);
    }
  });

  test("node detail composes callers and callees", () => {
    const n = mockNode("auth/login_handler");
    expect(n.id).toBe("auth/login_handler");
    expect(n.callers.length).toBeGreaterThan(0);
    expect(n.callees.length).toBeGreaterThan(0);
  });
});

describe("semantic clustering (PRD §12.3 LOD #1)", () => {
  test("cluster=module groups nodes by path prefix and emits counts", () => {
    const r = mockNeighbors("*", { cluster: "module" });
    expect(r.cluster_level).toBe("module");
    // Every node should be a module-level cluster with a count.
    for (const n of r.nodes) {
      expect(n.kind).toBe("module");
      expect(typeof n.count).toBe("number");
      expect(n.count!).toBeGreaterThan(0);
    }
    // Sum of counts == total raw nodes.
    const sum = r.nodes.reduce((a, n) => a + (n.count ?? 0), 0);
    expect(sum).toBe(r.total_raw_nodes);
    // Module names match real prefixes in the seed.
    const names = r.nodes.map((n) => n.name).sort();
    expect(names).toContain("auth");
    expect(names).toContain("db");
  });

  test("cluster=off forces function-level even on a large set", () => {
    const r = mockNeighbors("*", { cluster: "off" });
    expect(r.cluster_level).toBe("function");
  });

  test("cluster=auto stays function-level when below the threshold", () => {
    const r = mockNeighbors("*", { cluster: "auto" });
    expect(r.cluster_level).toBe("function");
  });

  test("module clusters emit cluster-kind edges with summed weights", () => {
    const r = mockNeighbors("*", { cluster: "module" });
    for (const e of r.edges) {
      expect(e.kind).toBe("cluster");
      expect(e.weight).toBeGreaterThan(0);
    }
  });

  test("scope restricts to a single module's nodes", () => {
    const r = mockNeighbors("*", { cluster: "off", scope: "auth" });
    expect(r.cluster_level).toBe("function");
    for (const n of r.nodes) {
      expect(n.id.startsWith("auth/")).toBe(true);
    }
  });
});
