/**
 * The runner-agnostic TEST-SUITE trace driver — one implementation shared by
 * BOTH test-runner adapters:
 *
 *   - `vitest.ts`  (vitest `setupFiles` entry — see src/vitest_core.ts for the
 *     vitest-specific rationale: fork safety under the parallel forks pool);
 *   - `bun-test.ts` (`bun test --preload` entry for Bun's NATIVE runner).
 *
 * Extracted from vitest_core.ts when the bun:test integration landed: the
 * driver never touched vitest (it was already unit-tested under `bun test`),
 * so the vitest module now re-exports it and this module owns the mechanics.
 *
 * ## The shared model
 *
 * 1. **Install window.** `onFileStart` connects the inspector session and
 *    starts the CPU profiler; `onFileEnd` fully uninstalls (Profiler.stop +
 *    disable + session disconnect + final flush). WHAT a window spans differs
 *    by runner — and that difference is the point:
 *
 *      - vitest: one window per test FILE per worker (`beforeAll`/`afterAll`
 *        run per file). Mandatory for fork safety: an idle pooled fork must
 *        hold NO live profiler (the P0 wedge, vitest_core.ts).
 *      - bun:test: one window per RUN. `bun test` executes every test file
 *        sequentially in a SINGLE process, and preload-registered
 *        `beforeAll`/`afterAll` fire once for the whole run — there are no
 *        pooled idle workers to protect, so one long window is correct and
 *        cheapest (verified empirically on Bun 1.3.13: one pid across files,
 *        run-scoped preload hooks).
 *
 * 2. **Per-test-file coverage attribution — by WINDOW BOUNDARY, not stack
 *    frame.** `onTestStart(filepath)` tags the tracer's coverage context with
 *    the current test FILE's path-qualified module id; on a context CHANGE it
 *    harvests the pending profile window FIRST so samples attribute to the
 *    file that produced them. Under bun:test this harvest-on-change is what
 *    slices the single run-long window into per-file attribution. Works even
 *    though `it()`/`test()` callbacks are anonymous frames the profiler
 *    cannot name.
 *
 *    Granularity is the TEST FILE for both runners, deliberately: vitest and
 *    bun:test both select/re-run by file (a test-file module node IS the
 *    daemon's runnable), and individual `it()` blocks have no graph node the
 *    daemon could resolve a finer name to. For bun:test specifically, per-TEST
 *    granularity is also not reliably reachable: preload `beforeEach` hooks
 *    receive no arguments, no `this`, and Bun 1.3.13 has no
 *    `expect.getState()` — the current test NAME is simply not exposed (probed
 *    empirically). The current test FILE, however, is: `Bun.main` tracks it as
 *    the runner moves through files.
 *
 * 3. **Sampling density.** Fast unit tests need a denser sampler than the
 *    library default (measured: 3 → 22 edges on the same hono file at 100 µs
 *    vs 1 ms), so both adapters default `samplingIntervalUs` to
 *    {@link TEST_SUITE_DEFAULT_SAMPLING_US}; `HAYVEN_TRACE_SAMPLING_US` wins.
 */

import { HayvenTracer, type TracerConfig } from "./tracer.ts";
import { configFromEnv } from "./env.ts";
import { moduleIdOf } from "./names.ts";

/**
 * Test-suite sampling default (µs). 100 µs, not the library-wide 1000 µs:
 * per-file test time on a fast unit suite is 10–70 ms, so 1 ms sampling
 * captures almost nothing (measured on hono). Env still wins.
 */
export const TEST_SUITE_DEFAULT_SAMPLING_US = 100;

/**
 * Build the tracer config for a test-suite run: env vars over the suite-tuned
 * defaults (denser sampling; everything else the standard env surface).
 * `process.cwd()` under both runners is the directory the suite was launched
 * from, so `moduleRoot` defaults to the repo-relative base the daemon's index
 * uses — set `HAYVEN_TRACE_MODULE_ROOT` explicitly when launching from a
 * monorepo SUBDIRECTORY (e.g. `apps/api`) so hints stay repo-root-relative.
 */
export function testSuiteConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): TracerConfig {
  return configFromEnv({ samplingIntervalUs: TEST_SUITE_DEFAULT_SAMPLING_US }, env);
}

/**
 * The coverage-context id for a test file: its path-qualified module id
 * (`/repo/src/utils/body.test.ts` under root -> `src/utils/body.test`), or
 * null when the path is unknown. This is the wire `test` name; the daemon
 * resolves it to the test file's MODULE node (conservatively — an ambiguous
 * stem like hono's 44 `index.test.ts` files stays unresolved and is dropped,
 * never mis-attributed).
 */
export function testFileContext(
  filepath: string | undefined | null,
  moduleRoot: string,
): string | null {
  if (!filepath) return null;
  const id = moduleIdOf(filepath, moduleRoot);
  return id.length > 0 ? id : null;
}

/**
 * Drives one process's tracer through a test runner's lifecycle. The adapters
 * (`vitest.ts`, `bun-test.ts`) wire these to their runner's
 * `beforeAll` / `beforeEach` / `afterAll`; tests drive them directly.
 */
export class TestTraceDriver {
  readonly tracer: HayvenTracer;

  constructor(tracer: HayvenTracer) {
    this.tracer = tracer;
  }

  /**
   * A window begins (vitest: a test file; bun:test: the run): connect the
   * inspector session and start profiling. Idempotent (`install()` no-ops when
   * already installed); re-installs cleanly after a previous window's
   * `onFileEnd()` in a reused (non-isolated) worker. Returns false — without
   * throwing — when the runtime has no CPU profiler.
   */
  async onFileStart(): Promise<boolean> {
    return this.tracer.install();
  }

  /**
   * A test begins: tag the coverage context with the test FILE's module id.
   * On a context CHANGE (a reused vitest worker moving to the next file
   * without an intervening `onFileEnd`, hooks racing, or bun:test crossing a
   * file boundary inside its single run-long window), the pending profile
   * window is harvested FIRST so its samples attribute to the file that
   * produced them — never bled into the new file's context.
   */
  async onTestStart(filepath: string | undefined | null): Promise<void> {
    const ctx = testFileContext(filepath, this.tracer.config.moduleRoot);
    if (ctx === null || ctx === this.tracer.coverageContext) return;
    if (this.tracer.coverageContext !== null) {
      await this.tracer.harvest();
    }
    this.tracer.setCoverageContext(ctx);
  }

  /**
   * The window ends: harvest the final profile (still attributed to the
   * current file's context), STOP + DISABLE the profiler, DISCONNECT the
   * inspector session, and flush everything (observations + coverage) to the
   * daemon. Under vitest this is the fork-safety guarantee: after this
   * resolves the worker holds no live profiler, no inspector session, and no
   * un-flushed data — a pooled idle fork is indistinguishable from an
   * untraced one. Under bun:test it is simply the end-of-run teardown.
   */
  async onFileEnd(): Promise<void> {
    await this.tracer.uninstall();
    this.tracer.setCoverageContext(null);
  }
}
