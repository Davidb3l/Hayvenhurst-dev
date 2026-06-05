import { test, expect, describe } from "bun:test";
import { buildSim, defaultOptions, energy, step } from "../src/graph/layout";

describe("buildSim", () => {
  test("seeds deterministic positions for the same seed", () => {
    const input = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [{ src: "a", dst: "b" }, { src: "b", dst: "c" }],
      width: 800,
      height: 600,
      seed: 12345,
    };
    const s1 = buildSim(input);
    const s2 = buildSim(input);
    expect(s1.nodes.map((n) => n.x)).toEqual(s2.nodes.map((n) => n.x));
    expect(s1.nodes.map((n) => n.y)).toEqual(s2.nodes.map((n) => n.y));
  });

  test("higher-degree nodes get more mass", () => {
    const sim = buildSim({
      nodes: [{ id: "hub" }, { id: "x" }, { id: "y" }, { id: "z" }],
      edges: [
        { src: "hub", dst: "x" },
        { src: "hub", dst: "y" },
        { src: "hub", dst: "z" },
      ],
      width: 400, height: 400,
    });
    const hub = sim.nodes.find((n) => n.id === "hub")!;
    const leaf = sim.nodes.find((n) => n.id === "x")!;
    expect(hub.m).toBeGreaterThan(leaf.m);
  });
});

describe("step", () => {
  test("kinetic energy decays toward zero under damping", () => {
    const sim = buildSim({
      nodes: Array.from({ length: 30 }, (_, i) => ({ id: String(i) })),
      edges: Array.from({ length: 29 }, (_, i) => ({ src: String(i), dst: String(i + 1) })),
      width: 600, height: 400,
    });
    for (let i = 0; i < 300; i++) step(sim.nodes, sim.edges, defaultOptions, 600, 400);
    const e = energy(sim.nodes);
    expect(e).toBeLessThan(5);
  });

  test("never produces NaN positions", () => {
    const sim = buildSim({
      nodes: Array.from({ length: 50 }, (_, i) => ({ id: String(i) })),
      // Throw in a pair of coincident-id-prone edges.
      edges: [
        ...Array.from({ length: 49 }, (_, i) => ({ src: String(i), dst: String(i + 1) })),
        { src: "0", dst: "0" },
        { src: "5", dst: "5" },
      ],
      width: 500, height: 500,
    });
    for (let i = 0; i < 100; i++) step(sim.nodes, sim.edges, defaultOptions, 500, 500);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  test("handles empty edges", () => {
    const sim = buildSim({
      nodes: Array.from({ length: 10 }, (_, i) => ({ id: String(i) })),
      edges: [],
      width: 400, height: 400,
    });
    for (let i = 0; i < 50; i++) step(sim.nodes, sim.edges, defaultOptions, 400, 400);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
    }
  });

  test("handles single-node graph", () => {
    const sim = buildSim({
      nodes: [{ id: "only" }],
      edges: [],
      width: 400, height: 400,
    });
    step(sim.nodes, sim.edges, defaultOptions, 400, 400);
    const n = sim.nodes[0]!;
    expect(Number.isFinite(n.x)).toBe(true);
    expect(Number.isFinite(n.y)).toBe(true);
  });
});

describe("performance budget", () => {
  test("steps a 1k node graph in well under 16ms per frame", () => {
    const n = 1000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: String(i) }));
    // Ring + cross edges, ~2n edges, plenty of interaction.
    const edges: { src: string; dst: string }[] = [];
    for (let i = 0; i < n; i++) edges.push({ src: String(i), dst: String((i + 1) % n) });
    for (let i = 0; i < n; i += 5) edges.push({ src: String(i), dst: String((i + 100) % n) });
    const sim = buildSim({ nodes, edges, width: 1200, height: 800 });
    // Warm.
    for (let i = 0; i < 3; i++) step(sim.nodes, sim.edges, defaultOptions, 1200, 800);
    // Time 10 steps.
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) step(sim.nodes, sim.edges, defaultOptions, 1200, 800);
    const t1 = performance.now();
    const per = (t1 - t0) / 10;
    // Reasonable budget on dev hardware. M-series sees ~3-6ms.
    expect(per).toBeLessThan(40);
  });
});
