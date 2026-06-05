// Ad-hoc perf check for the force-directed layout.
// Run: bun tests/_perf.ts

import { buildSim, defaultOptions, step } from "../src/graph/layout";

function bench(n: number): { ms: number; per: number } {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: String(i) }));
  const edges: { src: string; dst: string }[] = [];
  for (let i = 0; i < n; i++) edges.push({ src: String(i), dst: String((i + 1) % n) });
  for (let i = 0; i < n; i += 5) edges.push({ src: String(i), dst: String((i + 100) % n) });
  const sim = buildSim({ nodes, edges, width: 1600, height: 1000 });
  // Warm
  for (let i = 0; i < 5; i++) step(sim.nodes, sim.edges, defaultOptions, 1600, 1000);
  const STEPS = 30;
  const t0 = performance.now();
  for (let i = 0; i < STEPS; i++) step(sim.nodes, sim.edges, defaultOptions, 1600, 1000);
  const t1 = performance.now();
  return { ms: t1 - t0, per: (t1 - t0) / STEPS };
}

for (const n of [100, 500, 1000, 2000, 5000]) {
  const r = bench(n);
  console.log(`n=${String(n).padStart(5)}  ${r.per.toFixed(2)} ms/frame  (total ${r.ms.toFixed(0)} ms over 30 steps)`);
}
