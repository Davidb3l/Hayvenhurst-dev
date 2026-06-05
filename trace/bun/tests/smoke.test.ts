/**
 * Live smoke test: drive the REAL V8 CPU profiler under the host runtime
 * (Bun), profile a CPU-bound sample function, and assert the derived edges
 * include the sample's own call graph. Also verifies the encoded payload sent
 * through an injected mock sender matches the wire contract end-to-end.
 *
 * This is the empirical proof that the in-process CPU profiler path works under
 * Bun (verified on Bun 1.3.13). If a future runtime lacks it, `install()`
 * returns false and we assert the graceful-degradation path instead of failing.
 */
import { describe, expect, test } from "bun:test";

import { HayvenTracer, DEFAULT_CONFIG } from "../src/tracer.ts";
import { Aggregator } from "../src/aggregator.ts";
import { Flusher, type Sender, type WirePayload } from "../src/flusher.ts";

// Named, CPU-bound functions so the profiler attributes samples to stable
// frame names. Exported-ish via module scope; their `url` is this test file,
// so we scope the tracer to this file's directory.
function smokeLeaf(n: number): number {
  let s = 0;
  for (let i = 1; i < n; i++) s += Math.sqrt(i) * Math.sin(i) + Math.log(i);
  return s;
}
function smokeMiddle(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += smokeLeaf(400);
  return s;
}
function smokeTop(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) s += smokeMiddle(40);
  return s;
}

function burn(ms: number): number {
  let acc = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) acc += smokeTop(40);
  return acc;
}

describe("live CPU profiler under the host runtime", () => {
  test("profiling a sample fn yields >=1 edge and a contract-valid payload", async () => {
    const calls: WirePayload[] = [];
    const sender: Sender = async (_url, body) => {
      calls.push(JSON.parse(body) as WirePayload);
    };

    const agg = new Aggregator();
    const flusher = new Flusher(agg, { daemonUrl: "http://localhost:7777", sender, source: "bun" });
    const tracer = new HayvenTracer(
      // Scope to THIS test file's directory so only smoke* frames are kept.
      { ...DEFAULT_CONFIG, projectPaths: [import.meta.dir], flushIntervalSeconds: 3600 },
      agg,
      flusher,
    );

    const ok = await tracer.install();
    if (!ok) {
      // Graceful-degradation path: no CPU profiler on this runtime.
      expect(tracer.isInstalled).toBe(false);
      expect(tracer.lastError).not.toBeNull();
      return;
    }

    burn(600);
    await tracer.harvest(); // stop+derive+restart
    await tracer.uninstall(); // final window + flush

    // We should have observed at least one edge among our sample functions.
    // (We can't assert exact counts — sampling is nondeterministic — only that
    // the capture path produced real edges.)
    const sent = calls.flatMap((c) => c.observations);
    const names = new Set(sent.flatMap((o) => [o.src, o.dst]));
    const sawSmoke = [...names].some((n) => n.includes("smoke"));

    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sawSmoke).toBe(true);

    // Every sent observation must satisfy the daemon's wire contract.
    for (const c of calls) {
      expect(c.source).toBe("bun");
      expect(Number.isInteger(c.sample_rate)).toBe(true);
      expect(c.sample_rate).toBeGreaterThanOrEqual(1);
      for (const o of c.observations) {
        expect(typeof o.src).toBe("string");
        expect(o.src.length).toBeGreaterThan(0);
        expect(typeof o.dst).toBe("string");
        expect(o.dst.length).toBeGreaterThan(0);
        expect(Number.isFinite(o.ts)).toBe(true);
        expect(Number.isInteger(o.observed)).toBe(true);
        expect(o.observed).toBeGreaterThanOrEqual(0);
        expect(o.observed).toBeLessThanOrEqual(0xffff);
        expect(o.weight).toBeLessThanOrEqual(0xffff);
        expect(o.weight).toBe(o.observed * c.sample_rate); // ±0 here
      }
    }
  }, 30000);
});
