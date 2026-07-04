/**
 * V8 CPU-profiler session driver (the capture path).
 *
 * Uses Node's built-in `node:inspector` `Session` to drive the in-process V8
 * CPU profiler: `Profiler.enable` -> `Profiler.start` ... `Profiler.stop`.
 * `Profiler.stop` returns a {@link CpuProfile} call tree; we derive
 * caller->callee edges from it ({@link deriveEdges}) and feed them to the
 * aggregator with the honest `observed = weight = summed sample count` mapping.
 *
 * ## Bun support (verified empirically, Bun 1.3.13)
 *
 * Bun implements the `node:inspector` `Session` CPU-profiler path: a
 * `Session().connect()` + `Profiler.enable/start/stop` round-trip returns a
 * real V8 call tree with populated `hitCount`s and `children`. The collector
 * uses it directly. If a runtime ever lacks it, `start()` records the failure
 * on `lastError` and no-ops rather than throwing (graceful degradation).
 *
 * ## Why a periodic re-profile rather than one always-on profile
 *
 * The CPU profiler accumulates into a single tree until `stop`. To flush on an
 * interval we run a profile per flush window: `stop` (collect + derive), then
 * immediately `start` again. Each window's tree contributes its sample counts;
 * the aggregator sums windows. This keeps memory bounded and lets `stop()`
 * deliver a final partial window.
 */

import inspector from "node:inspector";

import { Aggregator, CoverageAggregator } from "./aggregator.ts";
import { prewarmCryptoLocks } from "./prewarm.ts";
import { Flusher } from "./flusher.ts";
import { deriveCoverage, deriveEdges, type CpuProfile } from "./profile.ts";
import { makeResolver, type ScopeOptions } from "./names.ts";

export interface TracerConfig {
  daemonUrl: string;
  /** Envelope sample_rate; the CPU-profiler model uses 1. */
  sampleRate: number;
  /** Flush + re-profile cadence in seconds. */
  flushIntervalSeconds: number;
  /** Path / module-prefix scope (see {@link ScopeOptions}). */
  projectPaths: string[];
  /** Keep node_modules / node:/bun: internals. Default false. */
  includeInternal: boolean;
  /**
   * V8 sampling interval in microseconds. Default 1000 (1 ms).
   *
   * Guidance (measured on hono's unit suite): the 1 ms default captures almost
   * nothing on fast unit tests (~3 edges for a whole 32-test file — per-file
   * test time is 10–70 ms); 100 µs is the test-suite tracing sweet spot
   * (3 → 22 edges on the same file) at a measurable but acceptable CPU cost.
   * Exposed via `start({ samplingIntervalUs })` and `HAYVEN_TRACE_SAMPLING_US`.
   */
  samplingIntervalUs: number;
  /** Batch source tag. Default "bun". */
  source: string;
  /**
   * Repo root for path-qualified module hints (see {@link ScopeOptions.moduleRoot}).
   * Default `process.cwd()`. Set "" to disable (bare-basename hints).
   */
  moduleRoot: string;
}

export const DEFAULT_CONFIG: TracerConfig = {
  daemonUrl: "http://localhost:7777",
  sampleRate: 1,
  flushIntervalSeconds: 30,
  projectPaths: [],
  includeInternal: false,
  samplingIntervalUs: 1000,
  source: "bun",
  moduleRoot: process.cwd(),
};

type Post = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export class HayvenTracer {
  readonly config: TracerConfig;
  readonly aggregator: Aggregator;
  /** Per-test coverage cells, drained by the flusher beside the edge aggregate. */
  readonly coverage: CoverageAggregator;
  readonly flusher: Flusher;

  private session: inspector.Session | null = null;
  private post: Post | null = null;
  private resolver = makeResolver();
  private reprofileTimer: ReturnType<typeof setInterval> | null = null;
  private installed = false;
  private _lastError: string | null = null;
  private _coverageContext: string | null = null;

  constructor(
    config: TracerConfig,
    aggregator?: Aggregator,
    flusher?: Flusher,
    coverage?: CoverageAggregator,
  ) {
    this.config = config;
    this.aggregator = aggregator ?? new Aggregator();
    this.coverage = coverage ?? new CoverageAggregator();
    this.flusher =
      flusher ??
      new Flusher(this.aggregator, {
        daemonUrl: config.daemonUrl,
        intervalSeconds: config.flushIntervalSeconds,
        sampleRate: config.sampleRate,
        source: config.source,
        coverage: this.coverage,
      });
    const scope: ScopeOptions = {
      projectPaths: config.projectPaths,
      includeInternal: config.includeInternal,
      ...(config.moduleRoot ? { moduleRoot: config.moduleRoot } : {}),
    };
    this.resolver = makeResolver(scope);
  }

  get isInstalled(): boolean {
    return this.installed;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  observedEdges(): number {
    return this.aggregator.size();
  }

  /**
   * The active per-test attribution context, or null (no attribution).
   *
   * While set, every harvested profile window ALSO records, per entity the
   * window executed, a (context, entity) coverage cell — the wire's
   * `test_coverage` rows. The test-runner integration (vitest.ts) sets this to
   * the current TEST FILE's path-qualified module id at test start and clears
   * it after the file's final harvest; attribution is therefore by WINDOW
   * BOUNDARY, not stack frame, which is what makes it work for anonymous
   * `it()` callbacks the profiler cannot name. The GLOBAL edge graph is
   * unchanged by the context (mirrors the Python collector, where coverage is
   * additive beside the edge aggregate).
   */
  get coverageContext(): string | null {
    return this._coverageContext;
  }
  setCoverageContext(context: string | null): void {
    this._coverageContext = context && context.length > 0 ? context : null;
  }

  /**
   * Connect the inspector session, start the CPU profiler, and launch the
   * background flusher + re-profile loop. Returns true on success. On any
   * failure (e.g. a runtime without the CPU profiler) it records `lastError`
   * and returns false WITHOUT throwing.
   */
  async install(): Promise<boolean> {
    if (this.installed) return true;
    // Fork-safety: warm OpenSSL's lock-guarded caches BEFORE any profiler
    // signal can fire. First-use crypto under a live 100 µs SIGPROF storm
    // deadlocks Node 25's namemap writer against its background CA-cert
    // loader's recursive read (see src/prewarm.ts for the full post-mortem).
    prewarmCryptoLocks();
    try {
      const session = new inspector.Session();
      session.connect();
      const post: Post = (method, params) =>
        new Promise((resolve, reject) => {
          session.post(method, params ?? {}, (err: Error | null, res: unknown) => {
            if (err) reject(err);
            else resolve(res);
          });
        });
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", { interval: this.config.samplingIntervalUs });
      await post("Profiler.start");
      this.session = session;
      this.post = post;
      this.installed = true;
      this._lastError = null;
    } catch (e) {
      this._lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.installed = false;
      return false;
    }

    this.flusher.start();
    // Re-profile each flush window so the tree (and memory) stays bounded and
    // each window's samples are harvested. Aligned to the flush cadence.
    this.reprofileTimer = setInterval(() => {
      void this.harvest();
    }, Math.max(1, this.config.flushIntervalSeconds) * 1000);
    (this.reprofileTimer as { unref?: () => void }).unref?.();
    return true;
  }

  /**
   * Stop the current profile, derive edges into the aggregator, and start a
   * fresh profile. Safe to call repeatedly. Errors are recorded, not thrown.
   */
  async harvest(): Promise<number> {
    if (!this.installed || !this.post) return 0;
    try {
      const res = (await this.post("Profiler.stop")) as { profile?: CpuProfile };
      const added = this.absorbWindow(res?.profile);
      // Re-arm a fresh profile window.
      await this.post("Profiler.start");
      return added;
    } catch (e) {
      this._lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return 0;
    }
  }

  /**
   * Fold one profile window into the aggregates: caller->callee edges into the
   * GLOBAL edge aggregate (unchanged behavior), and — when a coverage context
   * is set — every entity the window executed into the per-test coverage
   * aggregate, attributed to that context. Returns the number of edges added.
   */
  private absorbWindow(profile: CpuProfile | undefined): number {
    if (!profile) return 0;
    let added = 0;
    for (const e of deriveEdges(profile, this.resolver)) {
      this.aggregator.add(e.src, e.dst, "call", e.observed);
      added++;
    }
    const context = this._coverageContext;
    if (context !== null) {
      for (const c of deriveCoverage(profile, this.resolver)) {
        this.coverage.add(context, c.name, c.observed);
      }
    }
    return added;
  }

  /**
   * Harvest the final profile window, stop the profiler, disconnect the
   * session, and flush the final batch. Never throws.
   */
  async uninstall(): Promise<void> {
    if (this.reprofileTimer !== null) {
      clearInterval(this.reprofileTimer);
      this.reprofileTimer = null;
    }
    // Final harvest: stop the profiler and derive its last window WITHOUT
    // re-arming. We call Profiler.stop directly (harvest() would restart it).
    if (this.installed && this.post) {
      try {
        const res = (await this.post("Profiler.stop")) as { profile?: CpuProfile };
        this.absorbWindow(res?.profile);
        await this.post("Profiler.disable").catch(() => {});
      } catch (e) {
        this._lastError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
    }
    try {
      this.session?.disconnect();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.post = null;
    this.installed = false;
    await this.flusher.stop(true);
  }
}
