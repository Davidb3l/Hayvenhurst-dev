/**
 * The vitest-integration driver: config defaults, test-file context ids, and
 * the per-file profiler lifecycle (the fork-safety mechanism) driven against
 * the REAL V8 CPU profiler — mirroring tests/smoke.test.ts.
 */
import { describe, expect, test } from "bun:test";

import { HayvenTracer, DEFAULT_CONFIG } from "../src/tracer.ts";
import { Aggregator, CoverageAggregator } from "../src/aggregator.ts";
import { Flusher, type Sender, type WirePayload } from "../src/flusher.ts";
import {
  VitestTraceDriver,
  testFileContext,
  vitestConfigFromEnv,
  VITEST_DEFAULT_SAMPLING_US,
} from "../src/vitest_core.ts";

describe("vitestConfigFromEnv", () => {
  test("defaults sampling to the test-suite density; env still wins", () => {
    expect(vitestConfigFromEnv({}).samplingIntervalUs).toBe(VITEST_DEFAULT_SAMPLING_US);
    expect(
      vitestConfigFromEnv({ HAYVEN_TRACE_SAMPLING_US: "250" }).samplingIntervalUs,
    ).toBe(250);
  });

  test("inherits the standard env surface", () => {
    const cfg = vitestConfigFromEnv({ HAYVEN_TRACE_URL: "http://localhost:7791" });
    expect(cfg.daemonUrl).toBe("http://localhost:7791");
  });
});

describe("testFileContext", () => {
  test("path under the root -> path-qualified module id (ext stripped)", () => {
    expect(testFileContext("/repo/src/utils/body.test.ts", "/repo")).toBe(
      "src/utils/body.test",
    );
    expect(testFileContext("/repo/src/jsx/dom/index.test.tsx", "/repo")).toBe(
      "src/jsx/dom/index.test",
    );
  });

  test("path outside the root -> basename module id; unknown -> null", () => {
    expect(testFileContext("/elsewhere/x.test.ts", "/repo")).toBe("x.test");
    expect(testFileContext(undefined, "/repo")).toBeNull();
    expect(testFileContext("", "/repo")).toBeNull();
  });
});

// Named CPU-bound functions so the profiler attributes samples to stable
// frame names (same pattern as tests/smoke.test.ts).
function driverLeaf(n: number): number {
  let s = 0;
  for (let i = 1; i < n; i++) s += Math.sqrt(i) * Math.sin(i) + Math.log(i);
  return s;
}
function driverBurn(ms: number): number {
  let acc = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) acc += driverLeaf(4000);
  return acc;
}

describe("VitestTraceDriver lifecycle (real profiler)", () => {
  test("file start->test->file end: coverage attributed to the test file; nothing left armed", async () => {
    const calls: WirePayload[] = [];
    const sender: Sender = async (_url, body) => {
      calls.push(JSON.parse(body) as WirePayload);
    };
    const agg = new Aggregator();
    const cov = new CoverageAggregator();
    const flusher = new Flusher(agg, { daemonUrl: "http://x", sender, coverage: cov });
    const tracer = new HayvenTracer(
      {
        ...DEFAULT_CONFIG,
        projectPaths: [import.meta.dir],
        flushIntervalSeconds: 3600,
        samplingIntervalUs: 100,
        moduleRoot: import.meta.dir,
      },
      agg,
      flusher,
      cov,
    );
    const driver = new VitestTraceDriver(tracer);

    const ok = await driver.onFileStart();
    if (!ok) {
      // Graceful-degradation path: no CPU profiler on this runtime.
      expect(tracer.isInstalled).toBe(false);
      return;
    }

    // Simulate vitest running a test of this "file".
    await driver.onTestStart(`${import.meta.dir}/vitest_core.test.ts`);
    expect(tracer.coverageContext).toBe("vitest_core.test");
    driverBurn(400);
    await driver.onFileEnd();

    // Fork-safety invariants: session gone, profiler gone, context cleared.
    expect(tracer.isInstalled).toBe(false);
    expect(tracer.coverageContext).toBeNull();

    // Coverage rows went out tagged with the test FILE's module id.
    const covRows = calls.flatMap((c) => c.test_coverage ?? []);
    expect(covRows.length).toBeGreaterThanOrEqual(1);
    expect(covRows.every((r) => r.test === "vitest_core.test")).toBe(true);
    expect(covRows.some((r) => r.entity.includes("driver"))).toBe(true);

    // Re-install for a next file in a reused worker must work cleanly.
    expect(await driver.onFileStart()).toBe(true);
    await driver.onTestStart(`${import.meta.dir}/other.test.ts`);
    expect(tracer.coverageContext).toBe("other.test");
    await driver.onFileEnd();
    expect(tracer.isInstalled).toBe(false);
  }, 30000);

  test("context change harvests the pending window into the OLD context", async () => {
    const agg = new Aggregator();
    const cov = new CoverageAggregator();
    const flusher = new Flusher(agg, {
      daemonUrl: "http://x",
      sender: async () => {},
      coverage: cov,
    });
    const tracer = new HayvenTracer(
      {
        ...DEFAULT_CONFIG,
        projectPaths: [import.meta.dir],
        flushIntervalSeconds: 3600,
        samplingIntervalUs: 100,
        moduleRoot: import.meta.dir,
      },
      agg,
      flusher,
      cov,
    );
    const driver = new VitestTraceDriver(tracer);
    if (!(await driver.onFileStart())) return;

    await driver.onTestStart(`${import.meta.dir}/a.test.ts`);
    driverBurn(300);
    // Next file begins WITHOUT an onFileEnd (reused worker) — the pending
    // window must fold into a.test before the context flips.
    await driver.onTestStart(`${import.meta.dir}/b.test.ts`);
    expect(tracer.coverageContext).toBe("b.test");

    const rows = cov.drain();
    const aRows = rows.filter((r) => r.test === "a.test");
    expect(aRows.some((r) => r.entity.includes("driver"))).toBe(true);
    expect(rows.filter((r) => r.test === "b.test" && r.entity.includes("driverBurn")).length).toBe(0);

    await driver.onFileEnd();
    expect(tracer.isInstalled).toBe(false);
  }, 30000);
});
