/**
 * First-class vitest setup entry for the Hayven trace collector — the parity
 * answer to `pytest -p hayven_trace` (trace/python's pytest11 entry point).
 *
 * ## Use
 *
 * ```ts
 * // vitest.config.ts
 * export default defineConfig({
 *   test: {
 *     setupFiles: ["@hayvenhurst/trace-bun/vitest"], // or a path to this file
 *   },
 * });
 * ```
 *
 * Then opt in per run — this module is a **no-op unless `HAYVEN_TRACE` is
 * truthy** (mirrors the pytest plugin):
 *
 * ```sh
 * HAYVEN_TRACE=1 vitest run          # default parallelism is fine
 * ```
 *
 * Env knobs (see src/env.ts): `HAYVEN_TRACE_URL`, `HAYVEN_TRACE_SAMPLING_US`
 * (default here: 100 µs — the test-suite density measured to actually capture
 * fast unit tests), `HAYVEN_TRACE_PROJECT`, `HAYVEN_TRACE_MODULE_ROOT`,
 * `HAYVEN_TRACE_INTERVAL`.
 *
 * ## What it does per worker (see src/vitest_core.ts for the full rationale)
 *
 *  - **Fork-safe lifecycle (P0):** profiler + inspector session live ONLY
 *    while a test file is executing — `beforeAll` installs, `afterAll` fully
 *    uninstalls (stop, disable, disconnect, flush). Idle pooled forks hold no
 *    profiler, which is what un-wedges vitest's default parallel forks pool.
 *  - **Per-test-file coverage:** `beforeEach` tags the tracer's coverage
 *    context with the current test FILE's path-qualified module id; every
 *    harvested window emits daemon `test_coverage` rows (the same additive
 *    wire field trace/python sends), enabling the `observed` tier in
 *    `hayven affected-tests`.
 *
 * This file is deliberately a THIN adapter: it only resolves vitest's hook API
 * (dynamically — vitest is the host runner, never a dependency of this
 * package) and forwards lifecycle events to {@link VitestTraceDriver}. All
 * logic lives in src/vitest_core.ts where `bun test` can reach it.
 */

import { HayvenTracer } from "./src/tracer.ts";
import { isEnabled } from "./src/env.ts";
import { VitestTraceDriver, vitestConfigFromEnv } from "./src/vitest_core.ts";

/** The slice of vitest's hook API this adapter uses. */
interface VitestHooks {
  beforeAll: (fn: () => unknown) => void;
  beforeEach: (fn: (ctx: unknown) => unknown) => void;
  afterAll: (fn: () => unknown) => void;
}

/** The slice of vitest's per-test context we read the file path from. */
interface TestContextish {
  task?: { file?: { filepath?: string } };
}

if (isEnabled()) {
  // Resolve the host runner's hook API. Non-literal specifier: vitest is the
  // environment this setup file runs IN, not a dependency of this package, so
  // the import must resolve against the consumer's project (and stay invisible
  // to this package's own typecheck/bundling).
  const spec = "vitest";
  let hooks: VitestHooks | null = null;
  try {
    hooks = (await import(spec)) as VitestHooks;
  } catch {
    hooks = null; // not running under vitest — stay a silent no-op
  }

  if (hooks) {
    const driver = new VitestTraceDriver(new HayvenTracer(vitestConfigFromEnv()));
    let warned = false;

    hooks.beforeAll(async () => {
      const ok = await driver.onFileStart();
      if (!ok && !warned) {
        warned = true;
        // Loud but non-fatal: tracing silently doing nothing is worse than a
        // stderr note; failing the suite for a missing profiler would be worse
        // than both.
        console.error(
          `hayven-trace: CPU profiler unavailable in this worker — tracing disabled (${driver.tracer.lastError ?? "unknown error"})`,
        );
      }
    });

    hooks.beforeEach(async (ctx) => {
      const filepath = (ctx as TestContextish)?.task?.file?.filepath;
      await driver.onTestStart(filepath);
    });

    hooks.afterAll(async () => {
      await driver.onFileEnd();
    });
  }
}
