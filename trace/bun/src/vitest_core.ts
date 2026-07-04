/**
 * The vitest-integration DRIVER surface — everything the setup adapter
 * (`vitest.ts`) does except touching vitest itself. The MECHANICS (install
 * window, harvest-on-context-change coverage attribution, suite-tuned config)
 * now live in the runner-agnostic `src/test_driver.ts`, shared verbatim with
 * the bun:test adapter (`bun-test.ts`); this module keeps the vitest names and
 * the vitest-specific rationale.
 *
 * ## What the vitest integration is for (bench/affected-tests-typescript-RESULTS.md)
 *
 * 1. **Fork safety (the P0 wedge).** Running the collector "always-on" inside
 *    vitest's DEFAULT parallel forks pool reproducibly wedged the suite: after
 *    a worker finished its file, the V8 CPU profiler stayed ARMED (the old
 *    harvest loop re-starts a window after every stop), so pooled forks sat
 *    "idle" with the profiler's SIGPROF signal handler still firing — 8–10%
 *    CPU forever, vitest waiting on them, zombie forks. The fix is a strict
 *    per-test-file profiler LIFECYCLE: install (connect session + start
 *    profiler) when a file begins, and **fully uninstall — Profiler.stop +
 *    Profiler.disable + session.disconnect + final flush — when the file
 *    ends**, so an idle pooled fork NEVER has a live profiler or inspector
 *    session. Nothing is armed between files or after the last one.
 *
 *    (This per-FILE window is vitest-specific: bun:test runs single-process
 *    with run-scoped preload hooks, so its adapter holds ONE window for the
 *    whole run — see test_driver.ts for the comparison.)
 *
 * 2. **Per-test coverage attribution (the OBSERVED-tier feature).** While a
 *    file's tests run, the tracer's coverage CONTEXT is set to that test
 *    file's path-qualified module id (`src/utils/body.test`); every harvested
 *    profile window attributes the entities it executed to that context and
 *    ships them as the daemon's additive `test_coverage` rows — the exact
 *    wire shape trace/python's pytest plugin emits. Attribution is by WINDOW
 *    BOUNDARY, not stack frame, so it works even though `it()` callbacks are
 *    anonymous frames the profiler cannot name.
 *
 *    Granularity is the TEST FILE, deliberately: vitest selects/runs by file
 *    (a test-file module node IS the daemon's vitest runnable — see
 *    db/test_nodes.ts), and individual `it()` blocks have no graph node the
 *    daemon could resolve a finer-grained name to. File-level attribution is
 *    exactly the granularity `affected-tests` can act on.
 *
 * 3. **Sampling density.** Fast unit tests need a denser sampler than the
 *    library default (measured: 3 → 22 edges on the same hono file at
 *    100 µs vs 1 ms), so the integration defaults `samplingIntervalUs` to
 *    {@link VITEST_DEFAULT_SAMPLING_US}; `HAYVEN_TRACE_SAMPLING_US` overrides.
 */

export {
  /** The shared driver under its historical vitest name (same class). */
  TestTraceDriver as VitestTraceDriver,
  testFileContext,
  /** Suite-tuned sampling default under its historical vitest name. */
  TEST_SUITE_DEFAULT_SAMPLING_US as VITEST_DEFAULT_SAMPLING_US,
  /** Env-over-suite-defaults config builder under its historical vitest name. */
  testSuiteConfigFromEnv as vitestConfigFromEnv,
} from "./test_driver.ts";
