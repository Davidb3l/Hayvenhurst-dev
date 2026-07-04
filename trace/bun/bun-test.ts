/**
 * First-class `bun test` preload entry for the Hayven trace collector — the
 * bun:test sibling of `vitest.ts` (which answers `pytest -p hayven_trace`).
 *
 * ## Use
 *
 * ```sh
 * # opt in per run — this module is a no-op unless HAYVEN_TRACE is truthy:
 * HAYVEN_TRACE=1 bun test --preload @hayvenhurst/trace-bun/bun-test
 * # or a path:  HAYVEN_TRACE=1 bun test --preload /path/to/trace/bun/bun-test.ts
 * ```
 *
 * Or persistently, in the consumer's `bunfig.toml` (still gated on the env):
 *
 * ```toml
 * [test]
 * preload = ["@hayvenhurst/trace-bun/bun-test"]
 * ```
 *
 * Env knobs (see src/env.ts): `HAYVEN_TRACE_URL`, `HAYVEN_TRACE_SAMPLING_US`
 * (default here: 100 µs — the test-suite density), `HAYVEN_TRACE_PROJECT`,
 * `HAYVEN_TRACE_MODULE_ROOT` (set it to the REPO ROOT when running from a
 * monorepo subdirectory, so coverage hints stay repo-root-relative),
 * `HAYVEN_TRACE_INTERVAL`.
 *
 * ## Process model (probed empirically on Bun 1.3.13 — vs the vitest wedge)
 *
 * `bun test` executes every test file SEQUENTIALLY in a SINGLE process, and
 * hooks registered in a --preload script are RUN-scoped: `beforeAll` fires
 * once before the first file, `afterAll` once after the last, `beforeEach` /
 * `afterEach` around every test in every file. So unlike vitest's parallel
 * forks pool there are no pooled idle workers that could sit wedged with an
 * armed profiler (the vitest P0), and the adapter holds ONE profiler window
 * for the whole run. The OpenSSL prewarm still runs before `Profiler.start`
 * (inside `tracer.install()`): the Node-25 namemap/CA-loader deadlock it
 * defuses is Node-specific (Bun's crypto is BoringSSL-backed, no lazy
 * background CA loader in that shape), but the prewarm is idempotent,
 * guarded per-probe, and costs ~ms — cheap defense-in-depth on a runtime
 * whose internals move fast.
 *
 * ## What it does (see src/test_driver.ts for the shared mechanics)
 *
 *  - **Run-scoped lifecycle:** `beforeAll` installs the profiler + inspector
 *    session; `afterAll` fully uninstalls (stop, disable, disconnect, final
 *    flush). Nothing is armed after the run.
 *  - **Per-test-FILE coverage:** `beforeEach` tags the tracer's coverage
 *    context with the current test file's path-qualified module id — the
 *    current file is `Bun.main`, which bun:test re-points at each file as the
 *    run advances. A context CHANGE harvests the pending profile window first,
 *    so samples attribute to the file that produced them. Every harvested
 *    window emits daemon `test_coverage` rows (the same additive wire field
 *    trace/python and the vitest entry send), enabling the `observed` tier in
 *    `hayven affected-tests`.
 *  - **Granularity is the test FILE**, matching the vitest entry. Per-TEST
 *    attribution is not reliably reachable under bun:test: preload
 *    `beforeEach` hooks receive no arguments/`this` and Bun has no
 *    `expect.getState()`, so the current test NAME is never exposed — and a
 *    per-`it()` context would have no graph node for the daemon to resolve
 *    anyway (file selection is also bun test's own re-run granularity).
 *
 * This file is deliberately a THIN adapter: it only resolves bun:test's hook
 * API (dynamically — so importing this module outside `bun test`, or under a
 * non-Bun runtime, stays a silent no-op) and forwards lifecycle events to
 * {@link TestTraceDriver}. All logic lives in src/test_driver.ts where the
 * package's own unit tests reach it.
 */

import { HayvenTracer } from "./src/tracer.ts";
import { isEnabled } from "./src/env.ts";
import { TestTraceDriver, testSuiteConfigFromEnv } from "./src/test_driver.ts";

/** The slice of bun:test's hook API this adapter uses. */
interface BunTestHooks {
  beforeAll: (fn: () => unknown) => void;
  beforeEach: (fn: () => unknown) => void;
  afterAll: (fn: () => unknown) => void;
}

if (isEnabled()) {
  // Resolve the host runner's hook API. Non-literal specifier: `bun:test` is
  // the environment this preload runs IN, not a dependency of this module's
  // consumers — the dynamic import keeps the entry importable (as a no-op)
  // under Node or outside the test runner instead of failing at load time.
  const spec = "bun:test";
  let hooks: BunTestHooks | null = null;
  try {
    hooks = (await import(spec)) as BunTestHooks;
  } catch {
    hooks = null; // not running under bun test — stay a silent no-op
  }

  if (hooks && typeof hooks.beforeAll === "function") {
    const driver = new TestTraceDriver(new HayvenTracer(testSuiteConfigFromEnv()));
    let warned = false;

    hooks.beforeAll(async () => {
      const ok = await driver.onFileStart();
      if (!ok && !warned) {
        warned = true;
        // Loud but non-fatal: tracing silently doing nothing is worse than a
        // stderr note; failing the suite for a missing profiler would be worse
        // than both.
        console.error(
          `hayven-trace: CPU profiler unavailable in this process — tracing disabled (${driver.tracer.lastError ?? "unknown error"})`,
        );
      }
    });

    hooks.beforeEach(async () => {
      // Bun.main is the CURRENT test file while `bun test` walks its files
      // sequentially (probed on 1.3.13); preload hooks get no other signal.
      const filepath = typeof Bun !== "undefined" ? Bun.main : undefined;
      await driver.onTestStart(filepath);
    });

    hooks.afterAll(async () => {
      await driver.onFileEnd();
    });
  }
}
