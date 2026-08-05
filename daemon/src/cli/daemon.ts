/**
 * `hayven daemon <start|stop|status>` — daemon control.
 *
 * `start` DETACHES by default: it re-execs this CLI as a background child
 * (`--foreground` internally), redirects stdio to the daemon log, unrefs the
 * child so it survives the launching shell/session, waits for the health
 * endpoint, and exits 0. When a healthy hayven daemon already owns the port
 * (started from another repo), `start` registers this project with it instead
 * of failing with EADDRINUSE. `--foreground` keeps the classic in-terminal
 * server for CI, tests, and external supervisors. `stop` sends SIGTERM to the
 * PID recorded in the project's pidfile. `status` reports the current state.
 */
import {
  buildMultiProjectApp,
  wireBranchAwareDb,
  type DbRef,
  type IngestHealth,
  type ProjectAddResult,
  type ServerDependencies,
} from "../daemon/server.ts";
import {
  daemonStatus,
  installShutdownHandlers,
  isAlive,
  readPidFile,
  removePidFile,
  verifyDaemonIdentity,
  writePidFile,
} from "../daemon/lifecycle.ts";
import type { IngestController } from "../daemon/routes/ingest.ts";
import { CrdtState } from "../crdt/state.ts";
import { reresolveAllEdges, runIngest as drainIngest, type IngestResult } from "../graph/ingest.ts";
import { locateNativeBinary, tryLocateNativeBinary } from "../native/locate.ts";
import { startParse } from "../native/process.ts";
import {
  defaultTypecheck,
  nativeParseRunner,
  verifyMerge,
} from "../conflict/verify.ts";
import { startWatch, type WatchEvent, type WatchStats, type WatchSupervisor } from "../native/watcher.ts";
import { emitCodeChanged } from "../spine.ts";
import { LOG_MAX_BYTES, rootLogger, rotateLogFile } from "../util/log.ts";
import type { ParsedArgs } from "../cli.ts";
import { Db } from "../db/queries.ts";
import { SchemaTooNewError } from "../db/migrations.ts";
import { activeBranchKey, resolveWriteIndex, resolveWriteIndexForKey } from "../db/branch_index.ts";
import type { HayvenConfig } from "../config/defaults.ts";
import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  buildDetachedCommand,
  probeDaemon,
  waitForDaemon,
  DETACH_HEALTH_TIMEOUT_MS,
  type HayvenHealth,
} from "../daemon/detach.ts";
import { canonicalRoot, globalLogsDir, hayvenPathsFor, type HayvenPaths } from "../util/paths.ts";
import type { Logger } from "../util/log.ts";
import { loadConfig } from "../config/load.ts";
import {
  readRegistry,
  pruneStaleProjects,
  registerProject,
  sameProjectRoot,
  unregisterProjectDetailed,
  type ProjectEntry,
} from "../daemon/registry.ts";
import { parseMaxFiles, refuseIfOverCeiling } from "./init.ts";
import { hotAddToRunningDaemon, requireProject } from "./_shared.ts";
import { VERSION } from "../version.ts";

/** Hard cap on repos one daemon serves live — a DoS backstop for the add endpoint
 *  (each project opens a Db + native watcher + branch poller). */
const MAX_LIVE_PROJECTS = 64;
/** Grace window before a live-removed project's Db is closed, so a request that
 *  selected it just before removal finishes reading instead of hitting a closed
 *  handle. Bounded — a long in-flight query beyond this still races (rare; a
 *  closed-Db read throws → a clean 500, never corruption). */
const REMOVE_GRACE_MS = 250;

/**
 * Watcher-path equivalent of `cli/ingest.ts`'s `INCREMENTAL_FILE_CAP`.
 *
 * The CLI has always fallen back to a full ingest above 2000 touched files; the
 * WATCHER path had no such bound, which is how the incident's 3,078- and
 * 4,453-file "incremental" batches went straight through — each one a per-file
 * delete loop plus a parse of thousands of files, dispatched every 200 ms. Above
 * this we do ONE coalesced full rebuild instead, which is both faster and more
 * correct (it re-derives call sites and sweeps orphans).
 */
export const WATCH_INCREMENTAL_FILE_CAP = 2000;

/**
 * How a watcher batch of `touched` files should be ingested.
 *
 * Extracted so the THRESHOLD is directly testable — the call site lives inside
 * `startForegroundDaemon`'s `onBatch` closure, which cannot be reached without
 * binding a port. Mirrors `cli/ingest.ts`'s identically-named cap.
 */
export function watchBatchStrategy(
  touched: number,
  cap: number = WATCH_INCREMENTAL_FILE_CAP,
): "incremental" | "full" {
  return touched > cap ? "full" : "incremental";
}

/**
 * Consecutive AUTOMATIC ingest failures before a project's breaker trips and
 * automatic re-ingest STOPS.
 *
 * The incident ran 11,600 ingest cycles. Nothing counted failures, nothing ever
 * gave up, and every attempt wrote another line into an unrotated log. Five in a
 * row is well past "a transient parse timeout" and squarely in "this will not
 * succeed by being retried".
 */
const INGEST_BREAKER_THRESHOLD = 5;

/**
 * Minimum wall time between AUTOMATIC whole-repo re-ingests for one project.
 *
 * This is the bound that actually stops the incident. An overflow record means
 * "events were lost, re-scan"; it does not mean "re-scan RIGHT NOW", and the
 * native watcher can re-emit that condition every 500 ms indefinitely when the
 * OS watch-registration limit is exceeded. Waiting between rescans costs a
 * bounded amount of index staleness and removes an unbounded amount of work.
 */
const AUTO_INGEST_MIN_INTERVAL_MS = 30_000;
/** Operator/test override for {@link AUTO_INGEST_MIN_INTERVAL_MS}. */
function autoIngestMinIntervalMs(): number {
  const raw = process.env["HAYVEN_AUTO_INGEST_MIN_INTERVAL_MS"];
  if (raw === undefined) return AUTO_INGEST_MIN_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : AUTO_INGEST_MIN_INTERVAL_MS;
}
/** Automatic whole-repo re-ingests allowed inside {@link AUTO_INGEST_RATE_WINDOW_MS}. */
const AUTO_INGEST_MAX_PER_WINDOW = 30;
/** Window for the work-rate trip. */
const AUTO_INGEST_RATE_WINDOW_MS = 60 * 60_000;

/** Wall-clock ceiling on ONE Layer B typecheck spawned from the watcher path. */
const VERIFY_TYPECHECK_TIMEOUT_MS = 60_000;

/** First retry delay after a branch re-point aborts, doubling per failure. */
const REPOINT_RETRY_BASE_MS = 5_000;
/** Ceiling on the branch re-point retry backoff. */
const REPOINT_RETRY_MAX_MS = 5 * 60_000;

/**
 * Total budget for shutting EVERY project down, enforced across the parallel
 * shutdown. Must stay below {@link STOP_WAIT_MS} so `daemon stop` reports a
 * clean stop rather than timing out on a daemon that is behaving correctly.
 */
export const SHUTDOWN_TOTAL_MS = 8_000;

/** Daemon-wide automatic-ingest concurrency, overridable for big machines. */
function maxConcurrentAutoIngests(): number {
  const raw = process.env["HAYVEN_MAX_CONCURRENT_INGESTS"];
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * How often the daemon polls `.git/HEAD` (via {@link activeBranchKey}) to detect
 * a `git checkout` and re-point its served index to the new branch. The native
 * file watcher does NOT reliably observe `.git/HEAD`, so branch changes are
 * found by polling, not by the watcher. 2s is responsive without being chatty
 * (it is a cheap fs read of one small file).
 */
export const BRANCH_POLL_INTERVAL_MS = 2000;

/** How long shutdown waits for an in-flight ingest/re-point to settle before
 *  closing the db. Bounded so a stuck ingest can't hang shutdown forever. */
export const SHUTDOWN_DRAIN_MS = 5000;

/**
 * Await an in-flight ingest/re-point (the serialized `ingestChain`) before we
 * close the db on shutdown — otherwise `db.close()` can fire while a `drainIngest`
 * is mid-write, and the write throws "Database was closed" (use-after-close). The
 * wait is BOUNDED: if the chain hasn't settled in `timeoutMs` we proceed anyway
 * so a wedged ingest can't block process exit. Resolves regardless of whether the
 * chain fulfilled or rejected (we only care that it's no longer writing).
 */
export async function drainIngestChain(
  chain: Promise<unknown>,
  timeoutMs: number,
): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const drained = chain.then(
    () => "drained" as const,
    () => "drained" as const,
  );
  const result = await Promise.race([drained, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * Daemon-wide ceiling on CONCURRENT automatic whole-repo ingests.
 *
 * Every bound in {@link createIngestGuard} is PER PROJECT — the guard, the
 * ingest chain and the watcher are all created inside `initProject`. With
 * `parse_jobs` defaulting to 0 (rayon takes every core), 64 served projects each
 * doing one full re-ingest means 64 simultaneous all-core parses plus 64 `tsc`
 * runs. One at a time is the conservative default: a full rescan is throughput
 * work, not latency work, and serializing it across projects costs nothing a
 * user notices while removing the fork-bomb entirely.
 */
const DEFAULT_MAX_CONCURRENT_AUTO_INGESTS = 1;

/** A counting semaphore for daemon-wide work. */
export interface WorkLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  active(): number;
  waiting(): number;
}

export function createWorkLimiter(
  maxConcurrent: number = DEFAULT_MAX_CONCURRENT_AUTO_INGESTS,
): WorkLimiter {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    active: () => active,
    waiting: () => waiters.length,
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
      // A `while`, not an `if`: on release we wake ONE waiter, but a brand-new
      // caller can win the slot before that waiter resumes. Re-checking on wake
      // makes over-admission impossible.
      while (active >= limit) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        waiters.shift()?.();
      }
    },
  };
}

/** Why a project's automatic ingest is stopped. */
export type IngestTripReason = "failures" | "rate";

/** Injected dependencies for {@link createIngestGuard}. */
export interface IngestGuardDeps {
  /** Alias of the project this guard protects (used in the trip message). */
  readonly alias: string;
  readonly logger: Logger;
  /** The project's serialized ingest chain (`runIngestExclusive`). */
  readonly runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** A whole-repo re-ingest of the currently served index. */
  readonly fullIngest: () => Promise<unknown>;
  /** Live watcher backlog counters, when a watcher is running. */
  readonly watchStats?: () => WatchStats | undefined;
  /** Daemon-wide concurrency limiter shared by every project. */
  readonly limiter?: WorkLimiter;
  /** Consecutive automatic failures that trip. Default
   *  {@link INGEST_BREAKER_THRESHOLD}. */
  readonly threshold?: number;
  /** Minimum wall time between automatic whole-repo re-ingests. Default
   *  {@link AUTO_INGEST_MIN_INTERVAL_MS}. */
  readonly minIntervalMs?: number;
  /** Automatic whole-repo re-ingests allowed per {@link rateWindowMs} before the
   *  work-rate trip fires. Default {@link AUTO_INGEST_MAX_PER_WINDOW}. */
  readonly maxRunsPerWindow?: number;
  /** Work-rate window. Default {@link AUTO_INGEST_RATE_WINDOW_MS}. */
  readonly rateWindowMs?: number;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
  /** Injectable sleep, for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The bounds the daemon's AUTOMATIC ingest path was missing, and whose absence
 * turned one bad `daemon start` into a six-hour, 98%-CPU, 195 GB-read runaway.
 *
 * THE INCIDENT WAS NOT DEFINED BY FAILURE. Counted from the user's own log:
 * 11,600 ingest cycles and 10 parse timeouts — a 0.09% failure rate, never five
 * in a row. A consecutive-failure breaker would not have tripped once. What
 * actually happened was SUCCESSFUL work at an impossible rate, and there is a
 * trigger that needs no synthetic help: `native/src/watch/mod.rs` maps a watch
 * REGISTRATION limit (Linux `inotify max_user_watches`, and FSEvents
 * `MUST_SCAN_SUBDIRS`) onto an `overflow` record. That is a PERSISTENT
 * condition, re-emitted once per 500 ms loop pass forever — so exceeding the
 * watch limit once makes the daemon full-re-ingest continuously and
 * successfully until it is killed.
 *
 * Hence four bounds, not one:
 *
 * 1. RATE LIMIT ({@link IngestGuardDeps.minIntervalMs}) — the load-bearing one.
 *    A minimum interval between automatic whole-repo re-ingests, waited out
 *    OUTSIDE the ingest chain so a pending rescan never blocks incremental
 *    batches. Requests arriving during the wait coalesce into the one already
 *    pending, so an overflow storm collapses to one run per interval. A probe of
 *    the unfixed code (overflow every 25 ms, always-succeeding 150 ms full
 *    ingest) measured 95.4% duty and extrapolated to ~86,000 full re-ingests
 *    over six hours.
 * 2. WORK-RATE TRIP — more than `maxRunsPerWindow` automatic whole-repo runs
 *    within `rateWindowMs` stops automatic ingest REGARDLESS OF OUTCOME. This is
 *    the backstop that would actually have caught the incident, and it is what
 *    catches a legitimately alternating branch key (`git bisect run`, an
 *    interactive rebase) whose every re-point SUCCEEDS.
 * 3. CONSECUTIVE-FAILURE TRIP — the original breaker, kept for the case it does
 *    cover: work that cannot succeed being retried forever.
 * 4. GLOBAL CONCURRENCY ({@link WorkLimiter}) — every other bound here is
 *    per-project; without this, N projects each obeying their own limits still
 *    add up to N concurrent all-core parses.
 *
 * MANUAL vs AUTOMATIC are accounted SEPARATELY. A manual `POST /api/ingest` is
 * never gated (it is the user's explicit instruction) but it also may not clear
 * an automatic trip: sharing one counter meant any periodic external trigger
 * held the breaker permanently at zero. Clearing a trip requires the explicit
 * reset endpoint.
 */
export interface IngestGuard {
  /** May the daemon start AUTOMATIC ingest work right now? */
  allowed(): boolean;
  /** Record an AUTOMATIC ingest outcome (`null` = success). */
  note(err: Error | null): void;
  /** Record a MANUAL ingest outcome. Never clears an automatic trip. */
  noteManual(err: Error | null): void;
  /**
   * Admit an automatic whole-repo ingest that this guard does not itself run —
   * the branch re-point's freshen. Applies the SAME rate limit, work-rate trip
   * and accounting. Returns false when it must not proceed.
   */
  admitWholeRepoRun(reason: string): boolean;
  /** Run `fn` under the daemon-wide concurrency limiter. */
  withLimiter<T>(fn: () => Promise<T>): Promise<T>;
  /** Queue a coalesced, rate-limited full re-ingest. Never rejects — the
   *  outcome goes through {@link note}. */
  requestFull(reason: string): Promise<void>;
  /** Clear a tripped breaker so automatic re-ingest resumes. */
  reset(): void;
  health(): IngestHealth;
}

export function createIngestGuard(deps: IngestGuardDeps): IngestGuard {
  const threshold = deps.threshold ?? INGEST_BREAKER_THRESHOLD;
  const minIntervalMs = deps.minIntervalMs ?? AUTO_INGEST_MIN_INTERVAL_MS;
  const maxRunsPerWindow = deps.maxRunsPerWindow ?? AUTO_INGEST_MAX_PER_WINDOW;
  const rateWindowMs = deps.rateWindowMs ?? AUTO_INGEST_RATE_WINDOW_MS;
  const limiter = deps.limiter ?? createWorkLimiter();
  const now = deps.now ?? ((): number => Date.now());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const { logger, alias } = deps;

  let consecutiveFailures = 0;
  let trippedAt: number | null = null;
  let tripReason: IngestTripReason | null = null;
  let lastError: string | null = null;
  let lastManualError: string | null = null;
  let coalesced = 0;
  let rateLimitedWaits = 0;
  /** Start times of recent AUTOMATIC whole-repo runs, oldest first. */
  const recentRunStarts: number[] = [];
  let lastRunStartMs = Number.NEGATIVE_INFINITY;

  /** The single QUEUED-or-running full re-ingest. Identified by a NUMBER, never
   *  by promise identity — see `requestFull` for why that matters. */
  let queued: { id: number; promise: Promise<void> } | null = null;
  let runSeq = 0;

  function trip(reason: IngestTripReason, detail: string): void {
    if (trippedAt !== null) return; // announce ONCE, however many attempts follow
    trippedAt = now();
    tripReason = reason;
    logger.error(
      `ingest: CIRCUIT BREAKER TRIPPED (${reason}) — automatic re-ingest is STOPPED for this ` +
        `project. ${detail} Fix the cause, then reset with ` +
        `\`curl -X POST '<daemon>/api/ingest/health/reset?project=${alias}'\`; ` +
        "check state at `GET /api/ingest/health`.",
      { reason, detail },
    );
  }

  const note = (err: Error | null): void => {
    if (err === null) {
      consecutiveFailures = 0;
      // Deliberately does NOT clear a trip. A `rate` trip means the daemon is
      // doing too much work SUCCESSFULLY, so success is not evidence of health;
      // and clearing a `failures` trip on the first success is what let a flaky
      // repo oscillate. Recovery is the explicit reset.
      lastError = null;
      return;
    }
    consecutiveFailures += 1;
    lastError = err.message;
    if (trippedAt !== null) return;
    if (consecutiveFailures >= threshold) {
      trip("failures", `${consecutiveFailures} consecutive automatic ingest failures.`);
      return;
    }
    logger.warn("ingest: automatic run failed", {
      consecutiveFailures,
      tripsAt: threshold,
      error: err.message,
    });
  };

  /**
   * Account for an automatic whole-repo run that is about to START, and decide
   * whether it may. Counts SUCCESSES too — that is the whole point.
   */
  const admitWholeRepoRun = (reason: string): boolean => {
    if (trippedAt !== null) return false;
    const t = now();
    while (recentRunStarts.length > 0 && t - recentRunStarts[0]! > rateWindowMs) {
      recentRunStarts.shift();
    }
    if (recentRunStarts.length >= maxRunsPerWindow) {
      trip(
        "rate",
        `${recentRunStarts.length} automatic whole-repo re-ingests in the last ` +
          `${Math.round(rateWindowMs / 60_000)} minutes (limit ${maxRunsPerWindow}), most recently for: ${reason}. ` +
          "This is the runaway-loop signature: the work was SUCCEEDING, just far too often " +
          "(a persistent watcher-overflow condition, or a branch key that keeps alternating).",
      );
      return false;
    }
    if (t - lastRunStartMs < minIntervalMs) return false;
    recentRunStarts.push(t);
    lastRunStartMs = t;
    return true;
  };

  const clearSlot = (id: number): void => {
    if (queued?.id === id) queued = null;
  };

  async function runFull(id: number, reason: string): Promise<void> {
    if (trippedAt !== null) {
      clearSlot(id);
      return;
    }
    // RATE LIMIT, waited out BEFORE entering the ingest chain: holding the
    // per-project chain for the cooldown would stall incremental batches behind
    // a rescan that is deliberately doing nothing. Every request that arrives
    // during this wait coalesces into THIS one — that is what turns an
    // overflow storm into a single run per interval.
    const wait = minIntervalMs - (now() - lastRunStartMs);
    if (wait > 0 && Number.isFinite(wait)) {
      rateLimitedWaits += 1;
      logger.debug("ingest: full re-ingest rate-limited; waiting", { waitMs: wait, reason });
      await sleep(wait);
    }
    if (trippedAt !== null) {
      clearSlot(id);
      return;
    }
    let ran = false;
    try {
      await deps.runExclusive(async () => {
        // The coalescing slot clears when the run genuinely BEGINS — inside the
        // ingest chain, so callers in the SAME TICK still collapse into it —
        // never when it ends: a change arriving mid-run is not covered by this
        // run and must be able to queue exactly one more.
        clearSlot(id);
        if (!admitWholeRepoRun(reason)) return;
        ran = true;
        logger.info("ingest: full re-ingest starting", { reason });
        await limiter.run(() => deps.fullIngest());
      });
      if (ran) note(null);
    } catch (err) {
      note(err as Error);
    } finally {
      clearSlot(id);
    }
  }

  return {
    allowed: () => trippedAt === null,
    note,
    noteManual: (err: Error | null): void => {
      // Tracked for visibility only. A manual success must not zero the shared
      // automatic counter — with one counter, any periodic external `POST
      // /api/ingest` kept the automatic breaker permanently disarmed.
      lastManualError = err === null ? null : err.message;
    },
    admitWholeRepoRun,
    withLimiter: <T,>(fn: () => Promise<T>): Promise<T> => limiter.run(fn),
    requestFull: (reason: string): Promise<void> => {
      const pending = queued;
      if (pending) {
        coalesced += 1;
        return pending.promise;
      }
      const id = ++runSeq;
      let settle!: () => void;
      const promise = new Promise<void>((resolve) => {
        settle = resolve;
      });
      // Publish the slot BEFORE any work can start. The previous version
      // referenced `p` from inside its own initializer, which was safe only
      // because the real `runExclusive` happens to defer — an injected
      // `runExclusive` that calls back synchronously threw a TDZ ReferenceError.
      queued = { id, promise };
      void runFull(id, reason).then(settle, settle);
      return promise;
    },
    reset: (): void => {
      if (trippedAt !== null) {
        logger.warn("ingest: failure breaker RESET by request — automatic re-ingest resumes", {
          wasTrippedAt: new Date(trippedAt).toISOString(),
          reason: tripReason,
          consecutiveFailures,
        });
      }
      consecutiveFailures = 0;
      trippedAt = null;
      tripReason = null;
      lastError = null;
      recentRunStarts.length = 0;
      lastRunStartMs = Number.NEGATIVE_INFINITY;
    },
    health: (): IngestHealth => {
      const w = deps.watchStats?.();
      const t = now();
      const runsInWindow = recentRunStarts.filter((s) => t - s <= rateWindowMs).length;
      return {
        consecutiveFailures,
        tripped: trippedAt !== null,
        tripReason,
        trippedAt: trippedAt === null ? null : new Date(trippedAt).toISOString(),
        lastError,
        lastManualError,
        autoRunsInWindow: runsInWindow,
        autoRunLimitPerWindow: maxRunsPerWindow,
        rateWindowMs,
        minIntervalMs,
        rateLimitedWaits,
        limiterActive: limiter.active(),
        limiterWaiting: limiter.waiting(),
        fullIngestQueued: queued !== null,
        fullIngestsCoalesced: coalesced,
        pendingWatchEvents: w?.pendingEvents ?? 0,
        watchBatchInFlight: w?.batchInFlight ?? false,
        watchOverflowInFlight: w?.overflowInFlight ?? false,
        watchOverflowsCoalesced: w?.overflowsCoalesced ?? 0,
        // `null` (not `false`/`0`) when there is NO watcher at all, so "the
        // native binary is missing" is distinguishable from "the watcher is up
        // and quiet". Previously neither was visible over HTTP, and a dead
        // watcher read exactly like an idle repo.
        watcherAlive: w === undefined ? null : w.alive,
        watcherRestarts: w === undefined ? null : w.restarts,
        // Real `Date.now()`, NOT the injectable `now()`: `lastRecordAtMs` is
        // stamped by the watcher against the real clock, so a test's virtual
        // clock would produce a nonsense age.
        watcherSilentForMs: w === undefined ? null : Math.max(0, Date.now() - w.lastRecordAtMs),
        watcherHeartbeatStalls: w === undefined ? null : w.heartbeatStalls,
        watcherLastExitCode: w === undefined ? null : w.lastExitCode,
      };
    },
  };
}

/**
 * Dependencies for {@link repointToBranch} — the LIVE branch re-point. Factored
 * out of `startDaemon` so it is deterministically testable WITHOUT a real
 * long-lived HTTP server (the test drives this function directly).
 */
export interface RepointDeps {
  readonly dbRef: DbRef;
  readonly paths: HayvenPaths;
  readonly config: HayvenConfig;
  readonly logger: Logger;
  /**
   * Run `fn` on the SAME serialized ingest chain the watcher/API use, so the
   * swap never races a mid-flight ingest writer (review HIGH: concurrent SQLite
   * writers corrupt the index). The re-point happens INSIDE this exclusion.
   */
  readonly runIngestExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Freshen the NEW branch db (full/incremental ingest) so it reflects the
   * branch's current code before it is served. Receives the new db; it runs
   * INSIDE the same exclusion as the swap. A throw here is non-fatal — the swap
   * still happens (a seeded-but-stale index is better than serving the wrong
   * branch), and the next watcher batch reconciles it.
   */
  readonly freshen: (db: Db) => Promise<void>;
}

/**
 * Result of a re-point: the path now served AND the branch key it corresponds
 * to. The poller sets its `lastBranchKey` to `branchKey` (NOT the key it
 * detected) so the poller's transition tracker, `dbRef.branchKey`, and the
 * served index all agree on the SAME key — no desync if a resolution reconciled
 * to a different key than detected.
 */
export interface RepointResult {
  readonly path: string;
  readonly branchKey: string | null;
  /**
   * True when the re-point gave up and kept serving the OLD index. The poller
   * MUST back off on this: `branchKey` is then the still-served key, so the very
   * next 2 s tick re-detects the same transition and retries — an unbounded
   * full-freshen-ingest loop, the same failure shape as the overflow storm.
   */
  readonly aborted?: boolean;
}

/**
 * Re-point the served db to `newKey`'s branch index, serialized through the
 * ingest chain. Resolves (seeding on first touch) FOR `newKey` specifically —
 * NOT "whatever `.git/HEAD` says at execution time" — then migrates + freshens
 * the new branch index, SWAPS it into `dbRef.current`, and closes the OLD db.
 * Returns the path + branch key now served.
 *
 * (A) Consistency: the swap target is the branch the poller DETECTED (`newKey`).
 * `freshen()` can take seconds; a `git checkout` during that window must not
 * retarget the swap to a different branch than the poller already claimed. We
 * resolve FOR `newKey` (via `resolveWriteIndexForKey`), and the returned
 * `branchKey` is what the poller writes back to `lastBranchKey`, so all three
 * (poller tracker, `dbRef.branchKey`, served index) stay in lockstep.
 *
 * (B) Never serve an EMPTY or BROKEN index. The swap requires either a freshen
 * that actually completed, or an index that demonstrably holds nodes AND passes
 * `checkIndexIntegrity()`. It deliberately does NOT trust `seeded`: that flag
 * only means "we copied a file", never "the file had content", so a copy of an
 * empty/half-written index used to satisfy the guard and get served. On failure
 * we keep serving the OLD index, discard `next`, and warn; a later tick
 * reconciles once the tree yields records.
 *
 * (C) Eviction safety: resolution protects BOTH `newKey` and the currently-
 * served (old) branch key, so the still-open OLD branch dir is never the LRU
 * victim mid-swap.
 *
 * No-op (returns the current path/key) when `newKey` is `null` — outside a git
 * repo or with per-branch caching disabled, `activeBranchKey` is null and
 * behavior is UNCHANGED. The swap runs entirely inside `runIngestExclusive`, so
 * no ingest is mid-write when the db handle is replaced.
 */
export async function repointToBranch(deps: RepointDeps, newKey: string | null): Promise<RepointResult> {
  const { dbRef, paths, config, logger, runIngestExclusive, freshen } = deps;
  if (newKey === null) return { path: dbRef.path, branchKey: dbRef.branchKey };

  return runIngestExclusive(async () => {
    // Resolve FOR the DETECTED key (not a fresh HEAD read), protecting the
    // still-open OLD served branch from eviction while we hold it (C).
    const resolved = resolveWriteIndexForKey(paths, config, newKey, {
      seed: true,
      keepAlsoKey: dbRef.branchKey ?? undefined,
    });
    // If the resolver lands on the SAME file we already serve, there is nothing
    // to swap (already on this branch). Reconcile `dbRef.branchKey` to the
    // resolved key so the served holder + poller agree even in this no-op.
    if (resolved.path === dbRef.path) {
      dbRef.branchKey = resolved.branchKey;
      return { path: dbRef.path, branchKey: resolved.branchKey };
    }

    const next = new Db(resolved.path);
    try {
      next.migrate();
    } catch (err) {
      // A branch index written by a NEWER hayven must not be migrated DOWN.
      // Keep serving the current branch rather than failing the poller loop.
      if (err instanceof SchemaTooNewError) {
        logger.error("watch: branch re-point ABORTED — " + err.message, { branchKey: resolved.branchKey });
        try {
          next.close();
        } catch {
          /* nothing useful to do with a close failure on a db we are discarding */
        }
        return { path: dbRef.path, branchKey: dbRef.branchKey, aborted: true };
      }
      throw err;
    }
    const seeded = resolved.seededFrom !== null;
    let freshenOk = false;
    try {
      await freshen(next);
      freshenOk = true;
    } catch (err) {
      logger.warn("watch: branch re-point freshen failed", {
        branchKey: resolved.branchKey,
        seeded,
        error: (err as Error).message,
      });
    }

    // (B) Only swap when the new index is actually SERVABLE.
    //
    // The old test was `freshenOk || seeded || nodes > 0`, and `seeded` short-
    // circuited it. `seeded` means "we copied a file" — it says nothing about
    // whether the file had content, so a copy of an empty (or half-written)
    // index satisfied the guard and the daemon swapped in and served an EMPTY
    // graph, exactly the premise the comment above it claimed was true. Consult
    // the graph itself instead: a completed freshen, or real nodes backed by an
    // integrity check that catches a wiped/interrupted index.
    const integrity = next.checkIndexIntegrity();
    const hasContent = freshenOk || (integrity.ok && integrity.nodes > 0);
    if (freshenOk && integrity.nodes === 0) {
      // Not an abort — an empty branch is a legitimate (if surprising) state.
      // Say so out loud, because "the daemon serves nothing" otherwise looks
      // identical to "the daemon is broken".
      logger.warn("watch: branch re-point is swapping in an index with ZERO nodes", {
        branchKey: resolved.branchKey,
        path: resolved.path,
        seeded,
      });
    }
    if (!hasContent) {
      logger.warn(
        "watch: branch re-point ABORTED — the new index is empty or unusable; " +
          `keeping the current branch ${dbRef.branchKey ?? "(legacy)"} (${dbRef.path})`,
        {
          detectedKey: newKey,
          seeded,
          freshenOk,
          nodes: integrity.nodes,
          integrity: integrity.reason,
        },
      );
      try {
        next.close();
      } catch (err) {
        logger.warn("watch: closing discarded branch db failed (non-fatal)", {
          error: (err as Error).message,
        });
      }
      // Served index unchanged; report the still-served key so the poller
      // reconciles `lastBranchKey` back to what is ACTUALLY served, and flag the
      // abort so it retries on a BACKOFF instead of every 2 s tick.
      return { path: dbRef.path, branchKey: dbRef.branchKey, aborted: true };
    }

    const old = dbRef.current;
    // SWAP — subsequent requests + ingests resolve through `dbRef.current`.
    dbRef.current = next;
    dbRef.path = resolved.path;
    dbRef.branchKey = resolved.branchKey;
    try {
      old.close();
    } catch (err) {
      logger.warn("watch: closing previous branch db failed (non-fatal)", {
        error: (err as Error).message,
      });
    }

    logger.info(`watch: re-pointed to branch ${resolved.branchKey ?? "(legacy)"} (${resolved.path})`);
    return { path: resolved.path, branchKey: resolved.branchKey };
  });
}

const DAEMON_USAGE = `hayven daemon <subcommand>

  start                    Start the daemon detached (background) and return once
                           it is healthy. Serves the cwd project plus every
                           registered project; if a hayven daemon already owns
                           the port, registers this project with it instead.
                           --foreground runs it in this terminal (CI/supervisors);
                           --port/--host override the primary's bind address.
                           Binds 127.0.0.1 only. A non-loopback --host ALSO
                           requires --allow-remote-access: the daemon has NO
                           authentication and serves your whole code graph.
  stop                     Send SIGTERM to the running daemon (via its pidfile).
  status                   Report whether the daemon is running.
  restart                  Alias for stop + start.
  logs                     Tail the daemon logs.
  register [<path>]        Register a project so the daemon serves it. Defaults
                           to the cwd project. --alias <x> names it. Refuses a
                           tree above --max-files (default 50000; "off" to
                           disable) so a home dir cannot be enrolled.
  projects                 List registered projects (alias → root). --json for JSON.
  unregister <alias|path>  Remove a project from the registry. A BARE NAME is an
                           alias, never a path — pass ./name or an absolute path
                           to remove by location.
`;

export async function runDaemon(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  switch (sub) {
    case "start":
      return startDaemon(args);
    case "stop":
      return stopDaemon();
    case "status":
      return statusDaemon();
    case "register":
      return registerDaemonProject(args);
    case "projects":
      return listDaemonProjects(args);
    case "unregister":
      return unregisterDaemonProject(args);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(DAEMON_USAGE);
      return 0;
    default:
      process.stderr.write(`unknown daemon subcommand: ${sub}\n\n${DAEMON_USAGE}`);
      return 2;
  }
}

/**
 * `hayven daemon register [<path>] [--alias <x>]` — add a project to the
 * multi-project registry so a (re)started daemon serves it. Idempotent by root.
 * With no path arg, registers the cwd project.
 */
async function registerDaemonProject(args: ParsedArgs): Promise<number> {
  const pathArg = args.positionals[1];
  const root = canonicalRoot(pathArg ?? process.cwd());
  const aliasFlag = args.flags["alias"];
  const alias = typeof aliasFlag === "string" && aliasFlag.length > 0 ? aliasFlag : undefined;
  if (aliasFlag === true) {
    process.stderr.write("error: --alias requires a value, e.g. --alias myrepo\n");
    return 2;
  }
  // FILE-COUNT CEILING, before anything is persisted. `register` was the last
  // entry point that could enroll an enormous tree with no pre-walk refusal:
  // `graph/ingest.ts` does cap `files_total`, but only off the native `start`
  // record — i.e. AFTER the walker has already walked the whole tree — so a
  // `$HOME`-sized registration still cost a full traversal and then sat in the
  // registry to be re-opened, re-watched and re-walked on every daemon start.
  // `refuseIfOverCeiling` counts the same population the native walker feeds the
  // parser and stops short once the ceiling is exceeded.
  //
  // `--max-files` is honored here for the same reason `hayven init` honors it:
  // the refusal text ends with "re-run with `<command> --max-files=…`", and a
  // command that printed that while ignoring the flag would send the user in a
  // loop. `parseMaxFiles` refuses a typo rather than falling back to the default,
  // so `--max-files=5O000` cannot silently re-arm the unbounded walk.
  const ceiling = parseMaxFiles(args.flags["max-files"]);
  if (ceiling instanceof Error) {
    process.stderr.write(`error: ${ceiling.message}\n`);
    return 2;
  }
  const verdict = refuseIfOverCeiling(root, ceiling, "hayven daemon register");
  if (verdict !== null) {
    process.stderr.write(verdict);
    return 1;
  }
  let entry: ProjectEntry;
  try {
    entry = registerProject(root, alias);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`registered ${entry.alias} → ${entry.root}\n`);

  // If a daemon is already up, hot-add so the repo appears WITHOUT a restart.
  const cfg = loadConfig(root).config;
  const base = `http://${cfg.daemon_host}:${cfg.daemon_port}`;
  const hot = await hotAddToRunningDaemon(root, base, alias);
  switch (hot.kind) {
    case "added":
      process.stdout.write(`added live to the running daemon (no restart needed)\n`);
      break;
    case "exists":
      process.stdout.write(`already served by the running daemon\n`);
      break;
    case "error":
      process.stderr.write(`note: daemon reachable but did not add it: ${hot.message}\n`);
      break;
    case "foreign-home":
      // The registry write above already landed in OUR home, which is the part
      // that matters. Only the live hot-add was skipped, so this stays a note
      // and the command still exits 0.
      process.stderr.write(`note: skipped the live hot-add.\n${hot.message}\n`);
      break;
    case "no-daemon":
      process.stdout.write(`no running daemon — it will load on the next \`hayven daemon start\`\n`);
      break;
  }
  return 0;
}

/**
 * `hayven daemon projects [--json]` — list the registered projects. Human output
 * is an aligned two-column table; `--json` prints the raw entry array.
 */
function listDaemonProjects(args: ParsedArgs): number {
  const entries = readRegistry();
  if (args.flags["json"] === true || args.flags["json"] === "true") {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write("no registered projects\n");
    return 0;
  }
  const aliasWidth = Math.max(5, ...entries.map((e) => e.alias.length));
  process.stdout.write(`${"ALIAS".padEnd(aliasWidth)}  ROOT\n`);
  for (const e of entries) {
    process.stdout.write(`${e.alias.padEnd(aliasWidth)}  ${e.root}\n`);
  }
  return 0;
}

/**
 * `hayven daemon unregister <alias|path>` — remove a project from the registry.
 *
 * Uses the DETAILED form deliberately. An argument is an ALIAS xor a PATH, never
 * both, and a bare name is never resolved against the cwd — but that rule is
 * invisible to a user who only ever sees `not found: repo`, which reads as "no
 * such project" when the real answer is "that is a path, and I only matched
 * aliases". `unregisterProjectDetailed` returns a message that names which
 * interpretation it used and what exists instead; printing anything else throws
 * that diagnostic away.
 */
function unregisterDaemonProject(args: ParsedArgs): number {
  const arg = args.positionals[1];
  if (!arg) {
    process.stderr.write("error: unregister requires an alias or path\n");
    return 2;
  }
  const outcome = unregisterProjectDetailed(arg);
  process.stdout.write(`${outcome.message}\n`);
  return 0;
}

/** A fully-wired per-project runtime: its request deps + a bounded shutdown. */
interface ProjectRuntime {
  readonly alias: string;
  readonly deps: ServerDependencies;
  readonly shutdown: () => Promise<void>;
}

/**
 * Thrown by `initProject` when a project's index was written by a NEWER hayven.
 * Carries the alias so the loader can name it while skipping it.
 */
class ProjectSchemaTooNew extends Error {
  readonly alias: string;
  constructor(alias: string, schemaError: SchemaTooNewError) {
    super(schemaError.message);
    this.alias = alias;
    this.name = "ProjectSchemaTooNew";
  }
}

/**
 * Apply validated `--port`/`--host` overrides onto a copy of `config`.
 * Returns the effective config, or an exit code (2) after printing a usage
 * error. Shared by the detached parent (to know where to probe/poll) and the
 * foreground server (to know where to bind) so the two can never disagree.
 */
function applyBindOverrides(
  args: ParsedArgs,
  config: HayvenConfig,
): { config: HayvenConfig } | { exitCode: number } {
  const effective = { ...config };

  const hostFlag = args.flags["host"];
  if (typeof hostFlag === "string" && hostFlag.length > 0) {
    effective.daemon_host = hostFlag;
  } else if (hostFlag === true) {
    process.stderr.write("error: --host requires a value, e.g. --host 127.0.0.1\n");
    return { exitCode: 2 };
  }

  const portFlag = args.flags["port"];
  if (portFlag !== undefined && portFlag !== false) {
    if (portFlag === true) {
      process.stderr.write("error: --port requires a value, e.g. --port 7878\n");
      return { exitCode: 2 };
    }
    const port = Number(portFlag);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`error: --port must be an integer in 1..65535 (got ${portFlag})\n`);
      return { exitCode: 2 };
    }
    effective.daemon_port = port;
  }

  // NETWORK EXPOSURE GATE.
  //
  // The daemon has NO authentication of any kind — no bearer token, no Origin
  // check, nothing — and it serves the entire code graph, file contents via
  // `/api/context`, fleet memory, claims, and MUTATING POST/DELETE routes for
  // EVERY registered project. Before this, `--host` (and `HAYVEN_HOST`, and
  // `daemon_host` in config.json) was taken verbatim into `app.listen`, so
  // `--host 0.0.0.0` silently published all of that to the LAN with no warning
  // whatsoever — and the flag's own usage hint used to suggest exactly that
  // value. A binary that ships an unauthenticated service must not make
  // exposing it a one-word change.
  //
  // So a non-loopback bind now needs a SECOND, unambiguous opt-in. Requiring an
  // extra flag rather than just warning is deliberate: a warning printed by a
  // process that then keeps running is not a decision point, and this one is
  // irreversible in the sense that matters (the data is already reachable).
  if (!isLoopbackHost(effective.daemon_host)) {
    if (!remoteAccessAllowed(args)) {
      process.stderr.write(
        `error: refusing to bind ${effective.daemon_host} — that is not a loopback address, and\n` +
          "the hayven daemon has NO authentication. Binding it publishes, to anyone who can\n" +
          "reach this machine:\n" +
          "  - the full code graph and file contents of EVERY registered project\n" +
          "  - fleet memory, claims and traces\n" +
          "  - mutating endpoints (ingest, claims, project add/remove)\n" +
          "If you genuinely intend that, re-run with --allow-remote-access (or set\n" +
          "HAYVEN_ALLOW_REMOTE_ACCESS=1), and put it behind something that authenticates.\n" +
          "Otherwise drop --host/HAYVEN_HOST/daemon_host and it will bind 127.0.0.1.\n",
      );
      return { exitCode: 2 };
    }
    process.stderr.write(
      "\n" +
        "  ****************************************************************\n" +
        `  *  WARNING: binding ${effective.daemon_host}:${effective.daemon_port} — NOT loopback.\n` +
        "  *  This daemon has NO AUTHENTICATION. Anyone who can reach this\n" +
        "  *  address can read every registered project's source graph and\n" +
        "  *  file contents, and can mutate them.\n" +
        "  ****************************************************************\n\n",
    );
  }
  return { config: effective };
}

/** True for addresses that are only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1") return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The explicit second opt-in required to publish an unauthenticated daemon. */
function remoteAccessAllowed(args: ParsedArgs): boolean {
  const flag = args.flags["allow-remote-access"];
  if (flag === true || flag === "true") return true;
  const env = process.env["HAYVEN_ALLOW_REMOTE_ACCESS"];
  return env === "1" || env === "true";
}

/** Render the "serving N project(s): a, b" line from a health payload. */
function renderServing(health: HayvenHealth): string {
  const aliases = (health.projects ?? []).map((p) => p.alias);
  if (aliases.length === 0) return "";
  return `serving ${aliases.length} project(s): ${aliases.join(", ")}\n`;
}

/**
 * DEFAULT `hayven daemon start`: spawn the daemon as a DETACHED background
 * process and return once it is healthy.
 *
 * Why: the foreground server dies with the shell/session that launched it —
 * clear a Claude Code session (or close the terminal) and every other repo's
 * tools start failing with "could not reach daemon". Detaching (own process
 * group via `detached: true`, stdio redirected to the daemon log, `unref()` so
 * the parent exits freely) makes the daemon survive its launcher.
 *
 * Shared-daemon path: when a HEALTHY hayven daemon already owns the port
 * (started from another repo — one daemon serves N projects), we do NOT fail
 * with EADDRINUSE: we verify it via `/api/health`, ensure THIS project is
 * registered with it (live hot-add), and exit 0. A port held by something that
 * is not a hayven daemon stays a clear error.
 */
async function startDetachedDaemon(args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const bind = applyBindOverrides(args, ctx.config);
  if ("exitCode" in bind) return bind.exitCode;
  const config = bind.config;
  const base = `http://${config.daemon_host}:${config.daemon_port}`;

  // Is something already answering on the target address?
  const probe = await probeDaemon(base);
  if (probe.kind === "foreign") {
    // `foreign` covers BOTH "not a hayven daemon at all" and "a hayven daemon we
    // are version-incompatible with". Only the former can be fixed by picking a
    // free port, so when the probe supplies a specific reason, print THAT — the
    // generic advice is actively wrong (and harmful) for the version case.
    process.stderr.write(
      probe.reason !== undefined
        ? `error: ${probe.reason}\n`
        : `error: ${config.daemon_host}:${config.daemon_port} is in use by something that is NOT a hayven daemon.\n` +
            "Stop it, or start with a free port (`hayven daemon start --port <N>`).\n",
    );
    return 1;
  }
  if (probe.kind === "hayven") {
    return ensureServedByRunningDaemon(base, probe.health, ctx.paths.repoRoot);
  }

  // Nothing listening. If the pidfile claims a LIVE pid, the daemon is probably
  // bound elsewhere (config/port drift) — refuse rather than start a duplicate.
  const existing = daemonStatus(ctx.paths.pidFile);
  if (existing.state === "running") {
    // SELF-HEAL before refusing. `daemonStatus` already downgrades a verifiably-
    // foreign pid to `stale`, so reaching here means the pid is alive AND either
    // provably ours or unverifiable. Only the provably-ours case is a real
    // wedge; an unverifiable one (no sidecar — a pre-upgrade daemon, or a
    // pidfile that outlived a reboot) used to lock `daemon start` out FOREVER
    // with no recovery path. That is the `pid 1800` wedge from the autostart log.
    const verdict = verifyDaemonIdentity(ctx.paths.pidFile, existing.pid);
    if (verdict === "ours") {
      process.stderr.write(
        `error: pidfile reports a live daemon (pid ${existing.pid}) but ${base} is unreachable — ` +
          "it may be bound to a different host/port.\n" +
          "Stop it first (`hayven daemon stop`) or check `hayven config daemon_port`.\n",
      );
      return 1;
    }
    process.stderr.write(
      `note: pidfile named pid ${existing.pid}, which is alive but cannot be confirmed as this ` +
        `daemon and is not answering at ${base} — treating the pidfile as stale and starting.\n`,
    );
    removePidFile(ctx.paths.pidFile);
  }
  if (existing.state === "stale") {
    removePidFile(ctx.paths.pidFile); // dead pid — clean and proceed
  }

  // Re-exec ourselves as the detached child, stdio → the daemon out-log.
  const extraArgs: string[] = [];
  if (typeof args.flags["host"] === "string") extraArgs.push("--host", args.flags["host"]);
  if (typeof args.flags["port"] === "string") extraArgs.push("--port", args.flags["port"]);
  // The child re-runs `applyBindOverrides`, so the exposure opt-in must travel
  // with it — otherwise a deliberate remote bind fails in the background with
  // the parent reporting only "did not become healthy".
  if (remoteAccessAllowed(args)) extraArgs.push("--allow-remote-access");
  const cmd = buildDetachedCommand({
    execPath: process.execPath,
    entryScript: process.argv[1],
    extraArgs,
  });

  const logPath = join(globalLogsDir(), "daemon.out.log");
  let child;
  try {
    mkdirSync(globalLogsDir(), { recursive: true });
    // The fd below is handed to the detached child as BOTH stdout and stderr for
    // its entire lifetime, so nothing can rotate this file underneath it. Spawn
    // time is therefore the only place the size can be bounded — the incident
    // left a 576 MB `daemon.out.log` that nothing would ever have truncated.
    rotateLogFile(logPath);
    // `~/.hayven/logs/autostart.log` is APPENDED TO by `plugin/scripts/
    // ensure-daemon.sh` on every hook-driven session start (`>>autostart.log`)
    // and had NOTHING that ever rotated it — an append-only file growing for the
    // life of the install, the same unbounded-log shape as daemon.out.log. The
    // shell script cannot rotate it (it holds the append fd for its own
    // lifetime), but the `hayven daemon start` it invokes runs right here, so
    // this is the natural rotation point. The redirect is O_APPEND onto an
    // inode: after a rotation THIS invocation's remaining output follows the
    // inode into `autostart.log.1` and the next session starts a fresh file,
    // which is correct — nothing is lost, it is just split at the boundary.
    rotateLogFile(join(globalLogsDir(), "autostart.log"));
    const fd = openSync(logPath, "a");
    try {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: ctx.paths.repoRoot,
        detached: true, // own process group/session — survives the parent's terminal
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(`error: failed to spawn the daemon: ${(err as Error).message}\n`);
    return 1;
  }
  child.unref(); // let THIS process exit without waiting on the child

  const health = await waitForDaemon(base, { timeoutMs: DETACH_HEALTH_TIMEOUT_MS });
  if (health === null) {
    process.stderr.write(
      `error: daemon did not become healthy at ${base} within ${Math.round(DETACH_HEALTH_TIMEOUT_MS / 1000)}s.\n` +
        `Check the log: ${logPath}\n` +
        "(or run it in this terminal: `hayven daemon start --foreground`)\n",
    );
    return 1;
  }

  // TOCTOU guard: between our `unreachable` probe and the child's bind, ANOTHER
  // daemon (e.g. a concurrent `daemon start` from a different repo) may have won
  // the port — our child then died on EADDRINUSE while a hayven daemon still
  // answers. Verify the answering daemon serves THIS repo before declaring
  // success; if not, fall into the same register-with-it path as the pre-spawn
  // probe instead of printing a false "started".
  const ours = canonicalRoot(ctx.paths.repoRoot);
  const servesUs =
    (health.projects ?? []).some((p) => canonicalRoot(p.root) === ours) ||
    (typeof health.root === "string" && canonicalRoot(health.root) === ours);
  if (!servesUs) {
    return ensureServedByRunningDaemon(base, health, ctx.paths.repoRoot);
  }

  const pid = readPidFile(ctx.paths.pidFile) ?? child.pid;
  process.stdout.write(
    `hayven daemon started (pid ${pid}) — listening on ${base}/\n` +
      renderServing(health) +
      "It runs detached from this shell; stop it with `hayven daemon stop`.\n",
  );
  return 0;
}

/**
 * `daemon start` found a healthy hayven daemon already on the port: make sure
 * it serves THIS project (registering it live when it doesn't) and exit 0 —
 * one long-lived daemon serves every registered repo; a second `start` from a
 * new repo should join it, not crash on EADDRINUSE.
 */
async function ensureServedByRunningDaemon(
  base: string,
  health: HayvenHealth,
  repoRoot: string,
): Promise<number> {
  const ours = canonicalRoot(repoRoot);
  const served = (health.projects ?? []).find((p) => canonicalRoot(p.root) === ours);
  if (served) {
    process.stdout.write(
      `daemon already running at ${base}/ — serving this project as '${served.alias}'.\n` + renderServing(health),
    );
    return 0;
  }
  // Legacy/single-project daemon whose primary root IS this repo.
  if (typeof health.root === "string" && canonicalRoot(health.root) === ours) {
    process.stdout.write(`daemon already running at ${base}/ — serving this project.\n`);
    return 0;
  }
  const hot = await hotAddToRunningDaemon(repoRoot, base);
  if ((hot.kind === "added" || hot.kind === "exists") && hot.alias.length > 0) {
    process.stdout.write(`daemon already running at ${base}/ — now serving '${hot.alias}'.\n`);
    return 0;
  }
  // A foreign-home daemon is a REAL blocker here, unlike in `init`/`register`:
  // the port we wanted is occupied by a daemon we must not write to, so there is
  // no way to serve this project without freeing it. Say which boundary it is,
  // so the user does not read this as a version problem.
  const detail =
    hot.kind === "error"
      ? hot.message
      : hot.kind === "foreign-home"
        ? `it anchors its global state to ${hot.daemonHome} while this process uses ${hot.ourHome}`
        : "it does not support live project registration (old version?)";
  process.stderr.write(
    `error: a hayven daemon is running at ${base} but this project could not be registered with it: ${detail}\n` +
      "Restart it from this repo (`hayven daemon stop && hayven daemon start`).\n",
  );
  return 1;
}

async function startDaemon(args: ParsedArgs): Promise<number> {
  // Detach by default; `--foreground` keeps the in-terminal server (CI, tests,
  // supervisors, and the re-exec'd detached child itself).
  const foreground = args.flags["foreground"] === true || args.flags["foreground"] === "true";
  return foreground ? startForegroundDaemon(args) : startDetachedDaemon(args);
}

async function startForegroundDaemon(args: ParsedArgs): Promise<number> {
  const logger = rootLogger().child("daemon");
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const primaryPaths = ctx.paths;

  // Fix: honor `--port`/`--host` overrides (previously silently ignored — the
  // daemon always bound config.daemon_port/daemon_host). Build the effective
  // bind config from the PRIMARY project config, then apply validated overrides.
  // The daemon binds ONE port, so only the primary's bind config matters.
  const bind = applyBindOverrides(args, ctx.config);
  if ("exitCode" in bind) return bind.exitCode;
  const primaryConfig = bind.config;

  // Refuse to start twice (checked on the PRIMARY's pidfile — the one this
  // process writes and `hayven daemon stop` reads).
  const existing = daemonStatus(primaryPaths.pidFile);
  if (existing.state === "running") {
    process.stderr.write(`daemon already running (pid ${existing.pid})\n`);
    return 1;
  }
  if (existing.state === "stale") {
    logger.warn("stale pidfile detected; removing", { pid: existing.pid });
    removePidFile(primaryPaths.pidFile);
  }

  /**
   * Build the full per-project runtime — everything that is scoped to ONE
   * project: the branch-resolved served db (behind a swappable {@link DbRef}),
   * migration, CRDT state, the serialized ingest chain, the native file watcher
   * with its incremental re-ingest (+ Layer B verify gate + cross-file edge
   * re-resolution), and the live branch-re-point poller. Returns the wired
   * {@link ServerDependencies} for this project plus a bounded `shutdown`.
   *
   * Does NOT build an Elysia app: the daemon builds ONE app over ALL projects.
   */
  // ONE limiter for the whole daemon. Every other bound is per-project, so
  // without this N projects each obeying their own limits still add up to N
  // concurrent all-core parses (plus N `tsc` runs from the verify gate).
  const autoIngestLimiter = createWorkLimiter(maxConcurrentAutoIngests());

  function initProject(alias: string, paths: HayvenPaths, config: HayvenConfig): ProjectRuntime {
    const plog = logger.child(alias);

    // Open the BRANCH-RESOLVED index — the SAME index `init`/reindex write to and
    // `openProjectDb` (the daemonless read path) reads from for the current branch.
    // `resolveWriteIndex` mirrors `resolveReadIndex`'s branch resolution (via
    // `activeBranchKey`), so trace coverage + graph nodes co-locate. Outside a git
    // repo, or when per-branch caching is disabled, this returns the legacy index.
    const resolvedIndex = resolveWriteIndex(paths, config);
    plog.info("index resolved", {
      path: resolvedIndex.path,
      branchKey: resolvedIndex.branchKey,
      usedFallback: resolvedIndex.usedFallback,
    });

    // The served db lives behind a mutable holder so LIVE branch re-pointing can
    // SWAP it (the daemon following a `git checkout`). The facade rewires the
    // route `db` to read `dbRef.current` at request time; the ingest closures
    // read `dbRef.current` too, so post-swap ingests write the new branch's index.
    const dbRef: DbRef = {
      current: new Db(resolvedIndex.path),
      path: resolvedIndex.path,
      branchKey: resolvedIndex.branchKey,
    };
    let lastBranchKey: string | null = resolvedIndex.branchKey;
    let migration;
    try {
      migration = dbRef.current.migrate();
    } catch (err) {
      // An index written by a NEWER hayven must not be migrated DOWN. Close the
      // handle we just opened and let the loader decide: ONE unreadable project
      // must not take the whole daemon (and every OTHER repo it serves) down.
      try {
        dbRef.current.close();
      } catch {
        /* discarding this handle either way */
      }
      if (err instanceof SchemaTooNewError) throw new ProjectSchemaTooNew(alias, err);
      throw err;
    }
    if (migration.crdtCutover) {
      plog.warn(
        `crdt_migration: dropped legacy v0.0.1 SQL state (traces=${migration.crdtCutover.droppedObservations}, claims=${migration.crdtCutover.droppedClaims}) — pre-MVP, intentional per ARCHITECTURE.md §13.4`,
      );
    }

    // Shared CRDT state: writer ID + HLC + in-memory CRDTs + op-log,
    // hydrated from .hayven/crdt/ on construction.
    const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile });
    plog.info("crdt hydrated", {
      lww: crdt.lww.size,
      gset: crdt.gset.size,
      orset: crdt.orset.active().length,
      diskBytes: crdt.oplog.diskUsage(),
    });

    // Serialize ALL ingest work — API-triggered full ingests, the watcher's
    // incremental re-ingests, and overflow full re-scans — through a single
    // chain. Concurrent runs would otherwise interleave SQLite writers and
    // corrupt the index (review HIGH). `inFlight` is the status marker the
    // /api/ingest route reports via current().
    let inFlight: { startedAt: number } | null = null;
    let ingestChain: Promise<void> = Promise.resolve();
    function runIngestExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const next = ingestChain.then(async () => {
        inFlight = { startedAt: Date.now() };
        try {
          return await fn();
        } finally {
          inFlight = null;
        }
      });
      // Keep the chain alive even if one run rejects.
      ingestChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    /**
     * The scope flags EVERY native invocation for this project must agree on:
     * the full walk, the watcher, the watcher's incremental `--files-stdin`
     * re-parse and the Layer B verify gate.
     *
     * ONE object, spread into all four call sites, because they diverged the
     * moment they were written out longhand. `--include-vendored` /
     * `--include-fixtures` used to be a genuine no-op on the incremental path,
     * so nothing could disagree; once the native side started applying the
     * shared `ScopeFilter` everywhere, a project with `index.includeVendored:
     * true` got its vendored files on a full ingest and SILENTLY LOST them on
     * every watcher re-ingest — the graph then oscillated with whichever path
     * ran last. Adding the flags to only some of these sites is worse than
     * adding them to none: the watcher's per-file `deleteNodesByFile` purge runs
     * BEFORE the parse, so a narrow re-parse of a `vendor/` change deletes the
     * rows and never restores them.
     */
    const scope = {
      includeVendored: config.index?.includeVendored ?? false,
      includeFixtures: config.index?.includeFixtures ?? false,
    } as const;

    async function fullIngest(): Promise<IngestResult> {
      const binary = locateNativeBinary({ repoRoot: paths.repoRoot });
      const run = startParse({
        binary,
        root: paths.repoRoot,
        languages: config.parse_languages,
        jobs: config.parse_jobs,
        timeoutMs: config.ingest_timeout_seconds * 1000,
        logger: plog,
        ...scope,
      });
      // Read the CURRENT served db so a post-swap ingest writes the new branch's
      // index, not the one captured at startup.
      const db = dbRef.current;
      // IDEMPOTENCE. A whole-repo re-parse must clear the graph first, exactly as
      // `cli/ingest.ts` has always done. Without it a long-lived daemon's repeated
      // full re-ingests left DELETED symbols in the index forever (nothing else
      // ever removes a node whose file the parse no longer reports), so the served
      // graph drifted further from truth the longer the daemon ran.
      //
      // Ordered AFTER `startParse` on purpose: locating/spawning the native binary
      // is the most likely failure, and clearing first would leave the index empty
      // for a run that never even started. The parse streams into a buffer, so
      // nothing is written between here and `drainIngest`. `clearGraph()` also
      // stamps the in-progress marker, which `drainIngest` clears on success — so
      // a crash in between leaves the index flagged BROKEN rather than silently
      // empty, which is the outcome we want.
      db.clearGraph();
      return drainIngest({
        db,
        nodesDir: paths.nodesDir,
        run,
        logger: plog,
        repoRoot: paths.repoRoot,
        // This run's output IS the complete graph, so the O(1) call-site clear
        // and the orphan-markdown sweep are safe (and necessary — otherwise the
        // deleted files' markdown accumulates forever).
        fullRebuild: true,
      });
    }

    // The failure breaker + full-re-ingest coalescer for this project. See
    // {@link createIngestGuard} for why both exist.
    const guard = createIngestGuard({
      alias,
      logger: plog,
      runExclusive: runIngestExclusive,
      fullIngest,
      watchStats: () => watcher?.stats(),
      limiter: autoIngestLimiter,
      minIntervalMs: autoIngestMinIntervalMs(),
    });

    const ingest: IngestController = {
      current: () => inFlight,
      // Queues behind any in-flight ingest rather than throwing — callers get
      // serialized execution, not a "already running" error. A MANUAL ingest is
      // never gated by the breaker (it is the user's explicit instruction) and a
      // successful one resets it.
      // A MANUAL ingest is never gated by the breaker (it is the user's explicit
      // instruction) and its outcome is recorded SEPARATELY: letting a manual
      // success zero the automatic counter meant any periodic external trigger
      // held the automatic breaker permanently disarmed. It still runs under the
      // daemon-wide limiter so it cannot stack with automatic work.
      start: (_options): Promise<IngestResult> =>
        runIngestExclusive(() => guard.withLimiter(fullIngest)).then(
          (result) => {
            guard.noteManual(null);
            return result;
          },
          (err) => {
            guard.noteManual(err as Error);
            throw err;
          },
        ),
    };

    // Start the long-lived native file watcher (ARCHITECTURE.md §16). Skipped
    // if the binary isn't installed yet — the daemon still works without
    // incremental re-ingest, you just have to `hayven ingest` by hand.
    let watcher: WatchSupervisor | null = null;
    const watcherBinary = tryLocateNativeBinary({ repoRoot: paths.repoRoot });
    if (watcherBinary) {
      watcher = startWatch({
        binary: watcherBinary,
        root: paths.repoRoot,
        debounceMs: 200,
        logger: plog.child("watch"),
        // Same scope as every parse below — see `scope`.
        ...scope,
        onBatch: async (events: WatchEvent[]) => {
          // Classify by kind so we reconcile deletes + renames, not just
          // re-parse (review HIGH H3: deleted files used to linger in the index
          // forever). A rename's `from` path is treated as a delete.
          const changed = new Set<string>();
          const deleted = new Set<string>();
          for (const e of events) {
            if (e.kind === "delete") {
              deleted.add(e.file);
            } else if (e.kind === "rename") {
              changed.add(e.file);
              if (e.from) deleted.add(e.from);
            } else {
              changed.add(e.file);
            }
          }
          for (const f of changed) deleted.delete(f); // changed wins over a stale delete

          if (!guard.allowed()) {
            // Breaker tripped. Drop the batch rather than queue work that will
            // fail again — and do NOT log per attempt (the trip was announced
            // once, loudly; `GET /api/ingest/health` is the live state).
            plog.debug("watch: batch dropped — ingest breaker tripped", {
              changed: changed.size,
              deleted: deleted.size,
            });
            return;
          }

          // E2: bound the INCREMENTAL path, mirroring `cli/ingest.ts`'s
          // INCREMENTAL_FILE_CAP. The incident's 3,078- and 4,453-file batches
          // went through here as "incremental" work; above the cap a single
          // coalesced full rebuild is both cheaper and more correct.
          const touched = changed.size + deleted.size;
          if (watchBatchStrategy(touched) === "full") {
            plog.warn("watch: batch exceeds the incremental cap — doing ONE full re-ingest instead", {
              touched,
              cap: WATCH_INCREMENTAL_FILE_CAP,
            });
            await guard.requestFull(`watch batch of ${touched} files`);
            return;
          }

          plog.info("watch: incremental re-ingest", { changed: changed.size, deleted: deleted.size });
          // The batch RETURNS its failure rather than only logging it, so
          // repeated failures reach the breaker instead of retrying forever.
          const batchError = await runIngestExclusive(async (): Promise<Error | null> => {
            // Snapshot the CURRENT served db. The swap is serialized through this
            // same chain, so within one batch the db never changes underfoot; a
            // post-swap batch writes the new branch's index.
            const db = dbRef.current;
            // Purge stale rows for every affected file FIRST, so the re-parse is
            // a true reconcile (handles entities removed from a modified file
            // and files deleted outright), not an additive upsert. Also clear any
            // prior Layer B verify-gate state for the affected files so a file
            // that now passes loses its stale `merge_rejected` flag (§17.2).
            for (const f of deleted) db.deleteNodesByFile(f);
            for (const f of changed) db.deleteNodesByFile(f);
            db.clearMergeState([...changed, ...deleted]);

            // Suite spine PRODUCER (SUITE_CONTRACTS §2): after this batch is
            // durable, append one `code.changed` event. Best-effort — the emitter
            // itself never throws; this guard only covers the symbol query.
            // `files` = sorted union of changed+deleted (a delete still shows up
            // though its nodes are already gone); `symbols` = the surviving node
            // ids of the changed files.
            const emitSpine = () => {
              if (changed.size === 0 && deleted.size === 0) return;
              try {
                const files = [...new Set([...changed, ...deleted])].sort();
                const symbols: string[] = [];
                const q = db.handle.query<{ id: string }, [string]>(
                  "SELECT id FROM nodes WHERE file = ? AND kind != 'module'",
                );
                for (const f of changed) {
                  for (const r of q.all(f)) symbols.push(r.id);
                }
                emitCodeChanged({ repoRoot: paths.repoRoot, files, symbols });
              } catch (spineErr) {
                plog.warn("watch: spine code.changed emit failed (non-fatal)", {
                  error: (spineErr as Error).message,
                });
              }
            };

            if (changed.size === 0) {
              // Delete-only batch: nodes already purged above and durable, so the
              // deletion is real — emit before returning (no re-parse).
              emitSpine();
              return null;
            }
            // Set when the Layer B gate itself fails (a killed/hung typecheck),
            // as opposed to the files failing to typecheck.
            let verifyError: Error | null = null;
            try {
              const run = startParse({
                binary: watcherBinary,
                root: paths.repoRoot,
                languages: config.parse_languages,
                jobs: config.parse_jobs,
                timeoutMs: config.ingest_timeout_seconds * 1000,
                logger: plog.child("watch.parse"),
                // MUST match the full-ingest scope. The rows for every file in
                // `changed` were purged above; a narrower scope here means the
                // native side filters the file out, emits nothing for it, and
                // the purge is never undone.
                ...scope,
                files: [...changed],
              });
              await drainIngest({ db, nodesDir: paths.nodesDir, run, logger: plog.child("watch.ingest"), repoRoot: paths.repoRoot });

              // BL-10 (ARCHITECTURE.md §7 / §10 Q4): an incremental batch only
              // resolves edges within the changed file set, so a caller in an
              // UNCHANGED file that referenced a now-renamed/moved entity keeps a
              // stale `?:<name>` edge. Re-run the §7 resolver against the WHOLE
              // node set — a cheap in-memory pass — so cross-file callers pick up
              // the new id immediately instead of waiting for the next full
              // ingest. Idempotent and additive (it only rewrites `?:` edges).
              try {
                const fixed = reresolveAllEdges(db, paths.repoRoot);
                if (fixed > 0) {
                  plog.info("watch: re-resolved cross-file edges", { fixed });
                }
              } catch (rerr) {
                plog.warn("watch: cross-file edge re-resolution failed (non-fatal)", {
                  error: (rerr as Error).message,
                });
              }

              // Layer B (ARCHITECTURE.md §17.2): re-validate the affected files
              // AFTER the merge is materialized into the read cache. This is
              // advisory — the CRDT/op-log is never rolled back; a failure only
              // raises a `merge_rejected` record and flags the rows so an agent
              // can re-base. Hooked here (not before storage) because this is the
              // narrowest point where an accepted merge has a known affected-file
              // set; the API full-ingest path re-walks the whole repo and has no
              // "merge" semantics, so it is deliberately not gated.
              try {
                const verify = await guard.withLimiter(() =>
                  verifyMerge([...changed], {
                  root: paths.repoRoot,
                  native: nativeParseRunner({
                    binary: watcherBinary,
                    root: paths.repoRoot,
                    languages: config.parse_languages,
                    jobs: config.parse_jobs,
                    timeoutMs: config.ingest_timeout_seconds * 1000,
                    logger: plog.child("verify.parse"),
                    // Same scope again: the gate compares its own re-parse
                    // against the rows the ingest just wrote, so a mismatch
                    // reads as "the merge dropped every entity in this file".
                    ...scope,
                  }),
                  typecheck: defaultTypecheck({
                    root: paths.repoRoot,
                    logger: plog.child("verify.type"),
                    // Bounded + killed. `tsc --noEmit` is a whole-project check
                    // on the watcher's hot path; unbounded it wedges the ingest
                    // chain and the shutdown drain closes the Db under it.
                    timeoutMs: VERIFY_TYPECHECK_TIMEOUT_MS,
                  }),
                  logger: plog.child("verify"),
                  }),
                );
                if (!verify.ok) {
                  db.recordMergeRejections(
                    verify.failures.map((f) => ({
                      file: f.file,
                      phase: f.phase,
                      language: f.language,
                      reason: f.reason,
                      detected_at: f.detectedAt,
                    })),
                  );
                  plog.warn("verify: merge_rejected — flagged in read cache (CRDT NOT rolled back)", {
                    failures: verify.failures.length,
                    files: [...new Set(verify.failures.map((f) => f.file))],
                  });
                }
              } catch (verr) {
                // The gate is ADVISORY for the merge — it never rolls the CRDT
                // back — but it is NOT free, so its failures must reach the
                // breaker. This block spawns a whole-PROJECT `tsc`/`mypy`/`cargo
                // check`; swallowing every error here meant a typecheck that
                // hung or was killed never reached `guard.note()` and so could
                // never trip anything, however often it recurred.
                plog.warn("verify: gate errored — flagged to the ingest breaker", {
                  error: (verr as Error).message,
                });
                verifyError = verr as Error;
              }

              // Re-ingest is durable (drainIngest returned) — emit the spine
              // event. Inside the try so a failed re-ingest (caught below) never
              // emits a `code.changed` for a change that didn't land.
              emitSpine();
            } catch (err) {
              return err as Error;
            }
            return verifyError;
          });
          guard.note(batchError);
          if (batchError !== null) {
            plog.warn("watch: incremental re-ingest failed", { error: batchError.message });
          }
        },
        onOverflow: async ({ dropped, sinceMs }) => {
          if (!guard.allowed()) {
            plog.debug("watch: overflow ignored — ingest breaker tripped", { dropped, sinceMs });
            return;
          }
          plog.warn("watch: overflow — full re-ingest", { dropped, sinceMs });
          // COALESCED: `guard.requestFull` collapses concurrent requests into a
          // single queued run, and the supervisor already awaits this callback,
          // so overflows cannot stack up into N sequential full re-ingests.
          // Never rejects (it records the outcome through `guard.note`).
          await guard.requestFull(`watch overflow (${dropped} dropped)`);
        },
      });
    } else {
      plog.warn("hayven-native binary not found — file watcher disabled");
    }

    // LIVE branch re-pointing poller. The native watcher does NOT reliably see
    // `.git/HEAD`, so detect a `git checkout` by POLLING the active branch key.
    // When it changes, re-point the served db to the new branch's index (seeded +
    // freshened), serialized through the SAME ingest chain so no ingest is
    // mid-write during the swap. Outside a git repo / with per-branch caching
    // disabled, `activeBranchKey` is null and nothing re-points (UNCHANGED).
    const repointDeps: RepointDeps = {
      dbRef,
      paths,
      config,
      logger: plog,
      runIngestExclusive,
      // Freshen the NEW branch db with a full reconcile so it reflects the
      // branch's current code. Reuses the existing parse→drainIngest path against
      // the passed (new) db. We are already inside `runIngestExclusive`, so this
      // calls `drainIngest` directly rather than re-entering the chain.
      freshen: async (freshDb: Db) => {
        const binary = locateNativeBinary({ repoRoot: paths.repoRoot });
        const run = startParse({
          binary,
          root: paths.repoRoot,
          languages: config.parse_languages,
          jobs: config.parse_jobs,
          timeoutMs: config.ingest_timeout_seconds * 1000,
          logger: plog.child("watch.repoint"),
          ...scope,
        });
        // Same idempotence requirement as `fullIngest`: this is a whole-repo
        // re-parse, and the target index was very likely SEEDED by copying a
        // sibling branch's index — so without a clear it carries that branch's
        // deleted-elsewhere nodes forever. Clearing after `startParse` for the
        // same reason (don't empty an index for a run that never started); if the
        // freshen then fails, guard (B) refuses to swap it in.
        freshDb.clearGraph();
        await guard.withLimiter(() =>
          drainIngest({
            db: freshDb,
            nodesDir: paths.nodesDir,
            run,
            logger: plog.child("watch.repoint"),
            repoRoot: paths.repoRoot,
            fullRebuild: true,
          }),
        );
      },
    };
    let repointing = false;
    /**
     * RETRY BACKOFF for a re-point that gave up. Guard (B) reports the
     * still-served key, so the very next tick re-detects the same transition —
     * an unbounded "full freshen ingest every 2 seconds" loop, the same shape as
     * the overflow storm. Keyed by the branch we failed to reach, so an actual
     * checkout to a DIFFERENT branch is never delayed.
     */
    let repointFailKey: string | null = null;
    let repointFailures = 0;
    let repointRetryAfterMs = 0;
    const branchPoll = setInterval(() => {
      // Skip while a prior re-point is still resolving (poll faster than a full
      // freshen ingest takes). `activeBranchKey` is a cheap one-file fs read.
      if (repointing) return;
      let currentKey: string | null;
      try {
        currentKey = activeBranchKey(paths, config);
      } catch (err) {
        plog.warn("watch: branch poll failed (non-fatal)", { error: (err as Error).message });
        return;
      }
      if (currentKey === lastBranchKey) return;
      if (currentKey === repointFailKey && Date.now() < repointRetryAfterMs) return;
      // A re-point IS a whole-repo ingest — it does a `clearGraph()` plus a full
      // freshen — so it must obey the SAME rate limit, work-rate trip and
      // accounting as any other automatic full run. Without this, a
      // legitimately alternating branch key (`git bisect run`, an interactive
      // rebase, a script checking out branches in a loop) produced one full
      // rebuild every 2 s indefinitely and NOTHING noticed, because every single
      // one of them SUCCEEDED. The existing `repointRetryAfterMs` backoff only
      // ever applied to FAILED attempts, which is exactly the wrong half.
      //
      // Checked BEFORE `lastBranchKey` is claimed, so a rate-limited tick is a
      // true no-op and the transition is simply re-detected once admitted.
      if (!guard.admitWholeRepoRun(`branch re-point to ${currentKey ?? "(legacy)"}`)) return;
      const from = lastBranchKey;
      lastBranchKey = currentKey; // claim the transition so we don't double-fire
      repointing = true;
      plog.info("watch: branch change detected", { from, to: currentKey });
      const attemptedKey = currentKey;
      void repointToBranch(repointDeps, currentKey)
        .then((result) => {
          // (A) Reconcile `lastBranchKey` to the key that was ACTUALLY swapped in
          // (or is still served, if the swap was aborted/no-op), so the poller's
          // transition tracker, `dbRef.branchKey`, and the served index all agree
          // on ONE key. Prevents desync / flip-flop when the resolved-or-served
          // key differs from the detected one.
          lastBranchKey = result.branchKey;
          if (result.aborted === true) {
            noteRepointFailure(attemptedKey);
            // An abort is a failed automatic ingest — route it to the breaker so
            // a branch that can never be freshened eventually stops being tried.
            guard.note(new Error(`branch re-point to ${attemptedKey ?? "(legacy)"} aborted`));
          } else {
            clearRepointFailure();
            guard.note(null);
          }
        })
        .catch((err) => {
          plog.warn("watch: branch re-point failed", { error: (err as Error).message });
          noteRepointFailure(attemptedKey);
          guard.note(err as Error);
        })
        .finally(() => {
          repointing = false;
        });
    }, BRANCH_POLL_INTERVAL_MS);

    function noteRepointFailure(key: string | null): void {
      repointFailures = key === repointFailKey ? repointFailures + 1 : 1;
      repointFailKey = key;
      const delay = Math.min(REPOINT_RETRY_BASE_MS * 2 ** (repointFailures - 1), REPOINT_RETRY_MAX_MS);
      repointRetryAfterMs = Date.now() + delay;
      plog.warn("watch: branch re-point backing off before the next attempt", {
        branchKey: key,
        consecutiveFailures: repointFailures,
        retryInMs: delay,
      });
    }

    function clearRepointFailure(): void {
      repointFailKey = null;
      repointFailures = 0;
      repointRetryAfterMs = 0;
    }
    // Don't let the poll timer keep the event loop alive on its own.
    if (typeof branchPoll.unref === "function") branchPoll.unref();

    // Build this project's request deps and rewire `deps.db` → `dbRef.current`
    // at request time. buildMultiProjectApp passes branchAwareDb:false, so it
    // will NOT wire this for us — we must call wireBranchAwareDb ourselves.
    const deps: ServerDependencies = {
      db: dbRef.current,
      dbRef,
      config,
      paths,
      logger: plog,
      ingest,
      crdt,
      daemonVersion: VERSION,
      // Native version is populated on first `ingest` from the `start` record;
      // until then we just surface whether the binary was located.
      nativeVersion: tryLocateNativeBinary({ repoRoot: paths.repoRoot }) ? "present" : undefined,
      // Backlog + breaker state over HTTP (`GET /api/ingest/health`). The
      // incident's runaway loop was invisible to every interface the user had.
      ingestHealth: guard.health,
      resetIngestBreaker: guard.reset,
    };
    wireBranchAwareDb(deps);

    const shutdown = async (): Promise<void> => {
      clearInterval(branchPoll);
      if (watcher) await watcher.stop();
      // Let any in-flight ingest/re-point finish writing before we close the db
      // (bounded) — closing under a live write is a use-after-close.
      const drain = await drainIngestChain(ingestChain, SHUTDOWN_DRAIN_MS);
      if (drain === "timeout") {
        plog.warn("shutdown: ingest still in flight after drain timeout; closing anyway");
      }
      crdt.close();
      dbRef.current.close();
    };

    return { alias, deps, shutdown };
  }

  // Drop registry entries whose root has been deleted (ephemeral test dirs,
  // moved checkouts) BEFORE deciding what to serve — they cost a failed open
  // on every start and otherwise accumulate without bound.
  try {
    const stale = pruneStaleProjects();
    if (stale.length > 0) {
      // Name every root. A bare count leaves the user unable to tell WHAT was
      // dropped or re-add it — and this removes real registrations (a checkout
      // gone for over a week), so it must never be silent.
      process.stdout.write(`pruned ${stale.length} registered project(s):\n`);
      for (const e of stale) process.stdout.write(`  ${e.alias} -> ${e.root}\n`);
      process.stdout.write("re-add any of these with `hayven daemon register <path>`.\n");
    }
  } catch {
    /* non-fatal — pruning is hygiene, never a reason to fail a daemon start */
  }

  // Auto-register the cwd project so it's in the registry, and capture its alias
  // as the primary. Every project defaults to the same port, so the primary is
  // the one this process binds + writes a pidfile for.
  //
  // Refuses `$HOME` (see `assertRegistrableRoot`): starting here from the home
  // dir used to register the user's whole tree as one project and index it.
  let primaryAlias: string;
  try {
    primaryAlias = registerProject(primaryPaths.repoRoot).alias;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Build a de-duplicated, ordered project list: primary first, then each
  // registry entry naming a DIFFERENT repo.
  //
  // The dedupe compares CANONICAL roots, never raw strings. `registerProject`
  // stores the realpath'd spelling while `detectRepoRoot` returns a `resolve`d
  // but NOT realpath'd one, so for one repo under a symlinked path component
  // (`/tmp` → `/private/tmp`, autofs/NFS homes — i.e. macOS by default) the two
  // strings DIFFER. A raw `===` misses, the repo lands in `toLoad` twice, and
  // `initProject` runs twice on it: two `Db` handles and two `hayven-native
  // watch` children on ONE `.hayven/index.sqlite` WAL, with the first runtime
  // orphaned in the map. `util/paths.ts` states the stakes — two writers on one
  // WAL is corruption — and this is the exact bug class that passes on Linux CI
  // and destroys data on a developer's Mac.
  const toLoad: Array<{ alias: string; paths: HayvenPaths; config: HayvenConfig }> = [
    { alias: primaryAlias, paths: primaryPaths, config: primaryConfig },
  ];
  for (const entry of readRegistry()) {
    // Guard against a duplicate spelling ANYWHERE in the list, not just against
    // the primary: two registry entries could also name one repo differently.
    if (toLoad.some((p) => sameProjectRoot(p.paths.repoRoot, entry.root))) continue;
    toLoad.push({ alias: entry.alias, paths: hayvenPathsFor(entry.root), config: loadConfig(entry.root).config });
  }

  // Init each project. A broken registry entry (missing `.hayven/` or a throwing
  // initProject) must NOT crash startup — log a warning and skip it.
  const runtimes = new Map<string, ProjectRuntime>();
  const overCap: string[] = [];
  for (const p of toLoad) {
    if (!existsSync(p.paths.hayvenDir)) {
      logger.warn("skipping project — no .hayven/ directory", { alias: p.alias, root: p.paths.repoRoot });
      continue;
    }
    // MAX_LIVE_PROJECTS was enforced only on hot-add; the startup loader walked
    // the whole registry with no bound. Every project opens a Db, spawns a
    // long-lived `hayven-native watch` child and installs a 2 s branch poller,
    // and the registry only ever grows — so a dev who once started a daemon in
    // 200 repos got 200 watcher processes on the next start, with no warning.
    // The primary is first in `toLoad`, so it is never the one dropped.
    if (runtimes.size >= MAX_LIVE_PROJECTS) {
      overCap.push(`${p.alias} -> ${p.paths.repoRoot}`);
      continue;
    }
    // Same corruption guard as `addProjectLive`, for the STARTUP loader: two
    // registry entries sharing an alias (a hand-edited projects.json, or a file
    // that lost a write) would otherwise open a second Db and a second
    // `hayven-native watch` child on the first project's WAL, with the first
    // runtime orphaned in the map and never shut down.
    if (runtimes.has(p.alias)) {
      logger.warn("skipping project — its alias is already served", {
        alias: p.alias,
        root: p.paths.repoRoot,
        servedRoot: runtimes.get(p.alias)!.deps.paths.repoRoot,
      });
      process.stderr.write(
        `warning: registry alias '${p.alias}' names two different repos — serving ` +
          `${runtimes.get(p.alias)!.deps.paths.repoRoot} and SKIPPING ${p.paths.repoRoot}.\n` +
          "Fix it with `hayven daemon unregister` + `hayven daemon register --alias <new>`.\n",
      );
      continue;
    }
    try {
      // The primary's config already carries the loaded config (+ --port/--host);
      // others got theirs from loadConfig when the list was built above.
      runtimes.set(p.alias, initProject(p.alias, p.paths, p.config));
    } catch (err) {
      if (err instanceof ProjectSchemaTooNew) {
        // ONE project's too-new index must not take the daemon (and every OTHER
        // repo it serves) down — skip it loudly and keep going. The primary is
        // handled separately below: if IT is the one that failed, the daemon
        // refuses to start, because there would be nothing to be primary.
        logger.error("skipping project — its index was written by a NEWER hayven", {
          alias: p.alias,
          root: p.paths.repoRoot,
        });
        process.stderr.write(`error: cannot serve ${p.alias} (${p.paths.repoRoot}):\n${err.message}\n`);
        continue;
      }
      logger.warn("skipping project — initProject failed", {
        alias: p.alias,
        root: p.paths.repoRoot,
        error: (err as Error).message,
      });
    }
  }
  if (overCap.length > 0) {
    // Never silent: these repos will NOT be served, and the only way a user can
    // tell is if we say so and name them.
    process.stderr.write(
      `warning: ${overCap.length} registered project(s) were NOT loaded — the live cap of ` +
        `${MAX_LIVE_PROJECTS} is already reached:\n` +
        overCap.map((e) => `  ${e}\n`).join("") +
        "Drop projects you no longer need with `hayven daemon unregister <alias>`.\n",
    );
    logger.warn("project cap reached at startup — projects skipped", {
      cap: MAX_LIVE_PROJECTS,
      skipped: overCap.length,
    });
  }

  // The primary MUST have loaded (requireProject already proved its .hayven/
  // exists), but guard defensively so we never bind an app with no primary.
  if (!runtimes.has(primaryAlias)) {
    process.stderr.write(`error: failed to load the primary project (${primaryAlias})\n`);
    for (const rt of runtimes.values()) await rt.shutdown();
    return 1;
  }

  const primaryRuntime = runtimes.get(primaryAlias)!;

  /**
   * Pidfiles this process owns — ONE PER SERVED PROJECT, not just the primary.
   *
   * `hayven daemon stop`/`status` read the CWD project's `.hayven/daemon.pid`.
   * Writing only the primary's meant that from any OTHER served repo, `stop`
   * printed "daemon is not running" and exited 0 while the daemon was actively
   * serving that repo, `status` said `stopped` and exited 1, and the
   * duplicate-spawn guard at `startDetachedDaemon` was permanently dead there
   * (its `daemonStatus` was always `stopped`). Verified live: of the running
   * daemon's 5 served projects, only 2 had a pidfile at all.
   */
  const ownedPidFiles = new Set<string>();
  const claimPidFile = (file: string): void => {
    const existing = daemonStatus(file);
    if (existing.state === "running" && existing.pid !== process.pid) {
      // Another live daemon already owns this repo. Overwriting would point its
      // `stop` at US and leave that daemon unstoppable.
      logger.warn("not claiming pidfile — another live daemon owns it", { file, pid: existing.pid });
      return;
    }
    try {
      writePidFile(file);
      ownedPidFiles.add(file);
    } catch (err) {
      // A read-only/missing `.hayven/` must not stop the daemon serving the repo.
      logger.warn("could not write pidfile (stop/status will not work from that repo)", {
        file,
        error: (err as Error).message,
      });
    }
  };
  const releasePidFile = (file: string): void => {
    if (!ownedPidFiles.delete(file)) return;
    removePidFile(file);
  };

  // The LIVE served-projects map — the SAME Map object the multi-project facade
  // reads on every request (routing + `/api/health` listing), so mutating it here
  // is picked up with NO restart. Kept in lockstep with `runtimes` (which owns
  // each project's `shutdown`).
  const servedProjects = new Map<string, ServerDependencies>([...runtimes].map(([a, r]) => [a, r.deps]));

  // SSE subscribers for `/api/projects/stream` — notified after any add/remove so
  // an open viewer updates its switcher with no manual refresh.
  const projectListeners = new Set<() => void>();
  const notifyProjectsChanged = (): void => {
    for (const listener of [...projectListeners]) {
      try {
        listener();
      } catch (err) {
        logger.warn("projects: SSE listener threw (ignored)", { error: (err as Error).message });
      }
    }
  };

  // Serialize add/remove so two concurrent requests can't interleave the map +
  // registry mutations (or double-open the same index). Each op waits its turn;
  // a rejection never breaks the chain for the next op.
  let mutationChain: Promise<unknown> = Promise.resolve();
  const serializeMutation = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn, fn);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const addProjectLive = (rootArg: string, aliasHint?: string): Promise<ProjectAddResult> =>
    serializeMutation(async () => {
      const root = canonicalRoot(rootArg);
      // Idempotent by CANONICAL (symlink-resolved) root: if we already serve this
      // repo, return it untouched — never double-open the same index.
      const already = [...runtimes.values()].find((rt) => canonicalRoot(rt.deps.paths.repoRoot) === root);
      if (already) return { alias: already.alias, root, added: false };

      if (runtimes.size >= MAX_LIVE_PROJECTS) {
        throw new Error(`project cap reached (${MAX_LIVE_PROJECTS} served) — remove one before adding another`);
      }
      const paths = hayvenPathsFor(root);
      if (!existsSync(paths.hayvenDir)) {
        throw new Error(`no .hayven/ directory at ${root} — run \`hayven init\` there first`);
      }
      // NO FILE-COUNT CEILING HERE, deliberately. `hayven daemon register` has
      // one, but this door must not: `countIndexableFiles` is fully SYNCHRONOUS
      // with a 10 s budget, so calling it here stalls the entire daemon — every
      // HTTP request, the watcher stdout drain, both branch pollers, every timer
      // — for up to ten seconds, reachable from an unauthenticated local `POST
      // /api/projects`. It also fails CLOSED when the scan does not finish, and
      // this route has no way to accept a `--max-files` override, so a large or
      // network-mounted repo would be refused here forever; `_shared.ts` turns a
      // hot-add failure into a hard `ok:false`, which would then abort
      // `claim`/`release`/`node body`/`sync` in that repo with a message naming
      // a flag this route cannot take. The pre-walk refusal belongs on the
      // user-driven command, where a stall costs one CLI process and the flag
      // exists.
      //
      // Persist first (this is what derives the alias), then check it against
      // the LIVE map before opening anything.
      const entry = registerProject(root, aliasHint);
      // ALIAS COLLISION. `deriveAlias` only guarantees uniqueness against the
      // REGISTRY on disk, and the live `runtimes` map drifts from it: `hayven
      // daemon unregister` removes a registry entry without touching a running
      // daemon, so the next `registerProject` is free to hand back an alias this
      // process is already serving. A bare `runtimes.set` would then orphan the
      // first runtime — its Db handle and its `hayven-native watch` child stay
      // alive with nothing referencing them, so TWO watchers and TWO writers end
      // up on ONE `.hayven/index.sqlite` WAL, which util/paths.ts states is
      // corruption. The canonical-root idempotence check above only catches the
      // SAME repo; this catches a DIFFERENT repo arriving under a taken name.
      //
      // Checked on `entry.alias` — the alias `registerProject` ACTUALLY chose —
      // rather than on a prediction. Re-deriving it here would be wrong in three
      // ways: `registerProject` reads the RAW registry (which holds rows the
      // filtered read hides, so the `-N` suffix can differ), it prefers an
      // existing entry's alias over the hint, and it returns an already-present
      // entry verbatim without consulting `deriveAlias` at all. A prediction that
      // disagrees would both let real collisions through and refuse legitimate
      // adds. The registry write above is idempotent by root, so a refusal here
      // leaves behind at worst a re-assertion of an entry that already existed.
      if (runtimes.has(entry.alias)) {
        const held = runtimes.get(entry.alias)!;
        throw new Error(
          `alias '${entry.alias}' is already served by this daemon (${held.deps.paths.repoRoot}) — ` +
            `refusing to serve ${root} under it. Retry with an explicit \`--alias\`, or restart the daemon.`,
        );
      }
      const cfg = loadConfig(root).config;
      const runtime = initProject(entry.alias, paths, cfg);
      runtimes.set(entry.alias, runtime);
      servedProjects.set(entry.alias, runtime.deps);
      claimPidFile(paths.pidFile); // so `stop`/`status` work from THIS repo too
      logger.info("project added live", { alias: entry.alias, root });
      notifyProjectsChanged();
      return { alias: entry.alias, root, added: true };
    });

  const removeProjectLive = (aliasOrRoot: string): Promise<boolean> =>
    serializeMutation(async () => {
      const abs = canonicalRoot(aliasOrRoot);
      let runtime = runtimes.get(aliasOrRoot);
      if (!runtime) runtime = [...runtimes.values()].find((rt) => canonicalRoot(rt.deps.paths.repoRoot) === abs);
      if (!runtime) return false;
      if (runtime.alias === primaryAlias) {
        throw new Error(`cannot remove the primary project (${primaryAlias}) — it owns the daemon's port`);
      }
      // 1. Stop NEW requests from selecting it (drop from the ROUTING map only).
      servedProjects.delete(runtime.alias);
      // 2. Give a request that selected it just before step 1 a bounded window to
      //    finish before its Db is closed.
      await new Promise((r) => setTimeout(r, REMOVE_GRACE_MS));
      // 3. Shut the runtime down (drains ingest, stops watcher/poller, closes Db).
      let shutdownError: Error | null = null;
      try {
        await runtime.shutdown();
      } catch (err) {
        shutdownError = err as Error;
      }
      // 4. Drop ownership UNCONDITIONALLY, even when the shutdown failed.
      //
      // The old code returned early on a shutdown error, leaving the project in
      // `runtimes` but already gone from `servedProjects`. That is the worst of
      // both: every READ with that alias fell through to the PRIMARY project and
      // answered from a DIFFERENT repo's index with no error at all, while
      // `addProjectLive` (which matches on `runtimes` by canonical root) kept
      // reporting "already served" forever, so the project could not be
      // recovered without restarting the daemon. The comment there claimed this
      // avoided "orphaning a live Db" — but it orphaned it from the ROUTING map,
      // which is the half that produces silent wrong answers. A possibly-leaked
      // Db until the next restart is strictly the lesser failure, and unlike the
      // old behavior it is logged.
      runtimes.delete(runtime.alias);
      releasePidFile(runtime.deps.paths.pidFile);
      notifyProjectsChanged();
      if (shutdownError !== null) {
        logger.error("project removed live but its shutdown FAILED — its Db/watcher may leak until restart", {
          alias: runtime.alias,
          error: shutdownError.message,
        });
        throw new Error(`failed to shut down ${runtime.alias}: ${shutdownError.message}`);
      }
      // NOTE: deliberately NOT `unregisterProject`. `DELETE /api/projects/:alias`
      // is documented as "stop serving it live", and an unauthenticated localhost
      // call permanently FORGETTING a registration is not something it should be
      // able to do. `hayven daemon unregister` remains the explicit way to forget.
      logger.info("project removed live (registration kept)", { alias: runtime.alias });
      return true;
    });

  const subscribeProjects = (listener: () => void): (() => void) => {
    projectListeners.add(listener);
    return () => {
      projectListeners.delete(listener);
    };
  };

  const app = buildMultiProjectApp({
    primary: primaryAlias,
    projects: servedProjects,
    logger,
    daemonVersion: VERSION,
    nativeVersion: primaryRuntime.deps.nativeVersion,
    addProject: addProjectLive,
    removeProject: removeProjectLive,
    subscribeProjects,
  });

  const config = primaryConfig;
  const shutdownAll = async (): Promise<void> => {
    clearInterval(outLogTimer);
    // Let any in-flight add/remove settle first so we snapshot a quiescent map and
    // don't race a mutation that's mid-`initProject`/`shutdown`.
    await mutationChain.catch(() => undefined);
    // PARALLEL, and bounded as a WHOLE. Sequentially, each project could cost
    // SHUTDOWN_DRAIN_MS (5 s) plus the watcher's SIGTERM→SIGKILL escalation
    // (2 s) — ~7 s each, so 5 projects took ~35 s and 64 took ~450 s, against a
    // `daemon stop` that gives up at STOP_WAIT_MS (10 s). The user then saw a
    // failure from a daemon that was shutting down entirely correctly.
    const all = Promise.allSettled(
      [...runtimes.values()].map(async (rt) => {
        try {
          await rt.shutdown();
        } catch (err) {
          logger.warn("shutdown: project shutdown failed (non-fatal)", {
            alias: rt.alias,
            error: (err as Error).message,
          });
        }
      }),
    );
    let budget: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      budget = setTimeout(() => resolve("timeout"), SHUTDOWN_TOTAL_MS);
    });
    const outcome = await Promise.race([all.then(() => "done" as const), timeout]);
    if (budget) clearTimeout(budget);
    if (outcome === "timeout") {
      logger.warn("shutdown: exceeded the total budget; exiting with projects still draining", {
        budgetMs: SHUTDOWN_TOTAL_MS,
        projects: runtimes.size,
      });
    }
  };

  // Bound `daemon.out.log` WITHIN this process's lifetime. The launcher rotates
  // it at spawn time, but the fd is then held for the daemon's whole life — so
  // between two `daemon start`s (a daemon that runs for weeks) nothing capped it
  // at all, and a chatty uncaught write could grow it without limit. Renaming is
  // not an option here: the writer holds the inode, so a rename just carries the
  // growth along under a new name. Truncating IN PLACE is, because the fd is
  // O_APPEND — the next write resumes at offset 0 instead of leaving a
  // sparse-file hole.
  const outLogTimer = setInterval(() => {
    void truncateOwnOutLog(logger);
  }, OUT_LOG_CHECK_INTERVAL_MS);
  if (typeof outLogTimer.unref === "function") outLogTimer.unref();

  // Claim a pidfile for EVERY served project (see `claimPidFile`), not just the
  // primary — that asymmetry is why `stop`/`status` were no-ops in non-primary
  // repos.
  for (const rt of runtimes.values()) claimPidFile(rt.deps.paths.pidFile);
  installShutdownHandlers(
    primaryPaths.pidFile,
    async () => {
      logger.info("shutting down");
      await shutdownAll();
    },
    // Every project's pidfile must be cleaned up, including on the escalated
    // second-signal and watchdog paths inside the handler.
    { extraPidFiles: () => [...ownedPidFiles] },
  );

  // Bind. `app.listen` calls `Bun.serve` synchronously, which THROWS on
  // EADDRINUSE — without this guard a second `daemon start` on a port already
  // bound by another project's daemon would crash with a raw stack trace (or,
  // worse on some platforms, appear to double-bind). Catch it, print a clean
  // message, release our pidfile, shut down all projects, and exit non-zero.
  try {
    app.listen({ hostname: config.daemon_host, port: config.daemon_port });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    for (const file of [...ownedPidFiles]) releasePidFile(file);
    await shutdownAll();
    if (e.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(e.message ?? "")) {
      process.stderr.write(
        `error: ${config.daemon_host}:${config.daemon_port} is already in use — ` +
          "another daemon is bound there.\n" +
          "Stop it (`hayven daemon stop`), or start with a free port (`hayven daemon start --port <N>`).\n",
      );
    } else {
      process.stderr.write(`error: failed to bind ${config.daemon_host}:${config.daemon_port}: ${e.message}\n`);
    }
    return 1;
  }

  // Echo the ACTUAL bound address (may differ from config when overridden).
  const boundHost = app.server?.hostname ?? config.daemon_host;
  const boundPort = app.server?.port ?? config.daemon_port;
  logger.info("listening", { host: boundHost, port: boundPort, projects: runtimes.size });
  const served = [...runtimes.keys()];
  process.stdout.write(
    `hayvend listening on http://${boundHost}:${boundPort}/ (pid ${process.pid})\n` +
      `hayvend: serving ${served.length} project(s): ${served.join(", ")}\n` +
      // Report the ACTUAL bind, not the configured string: if anything ever
      // routes around `applyBindOverrides`, the banner is still truthful about
      // what is reachable.
      (isLoopbackHost(String(boundHost))
        ? ""
        : `hayvend: REACHABLE FROM THE NETWORK on ${boundHost} — NO AUTHENTICATION.\n`) +
      "Press Ctrl-C to stop.\n",
  );

  // Keep the process alive — Elysia's listen returns synchronously.
  await new Promise<void>(() => {
    // Intentionally never resolves; signal handlers will exit.
  });
  return 0;
}

/** How often the running daemon checks its own inherited out-log size. */
export const OUT_LOG_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Truncate `~/.hayven/logs/daemon.out.log` in place when it has grown past
 * {@link LOG_MAX_BYTES} **and** it is genuinely the file this process's stdout
 * is attached to.
 *
 * The inode comparison is the whole safety argument. A `--foreground` daemon
 * started by hand has stdout on a terminal and must not touch the file; a
 * DETACHED daemon inherited an append-mode fd on exactly this inode and is the
 * only process that can bound it (rename-based rotation cannot — the writer
 * keeps the inode, so the growth just follows it to the new name).
 *
 * Never throws: a bounded log is hygiene, never a reason to disturb the daemon.
 */
export function truncateOwnOutLog(
  logger: Logger,
  opts: { maxBytes?: number; logPath?: string; stdoutFd?: number } = {},
): boolean {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const logPath = opts.logPath ?? join(globalLogsDir(), "daemon.out.log");
  // fd 1 is stdout in production; injectable so a test can stand in a real file
  // descriptor instead of the runner's pipe.
  const stdoutFd = opts.stdoutFd ?? 1;
  try {
    const onDisk = statSync(logPath);
    if (onDisk.size < maxBytes) return false;
    // If stdout is not this exact file (a TTY, a pipe, some other redirect), we
    // are not the writer and must leave the file alone.
    const mine = fstatSync(stdoutFd);
    if (mine.ino !== onDisk.ino || mine.dev !== onDisk.dev) return false;
    // Truncate the FD, not the path. The inode identity was proven on the fd, so
    // truncating by name would hit whatever `daemon.out.log` refers to NOW — and
    // a concurrent `daemon start` rotates the old inode to `.1` and creates a
    // fresh file under that name. Narrow, but `ftruncateSync` closes it outright.
    ftruncateSync(stdoutFd, 0);
    logger.warn("daemon.out.log exceeded its cap and was truncated in place", {
      path: logPath,
      wasBytes: onDisk.size,
      maxBytes,
    });
    return true;
  } catch {
    return false;
  }
}

/** How long `daemon stop` waits for the signaled pid to actually exit. The
 *  daemon's own shutdown drain is bounded (SHUTDOWN_DRAIN_MS per project), so a
 *  healthy daemon dies well within this. */
export const STOP_WAIT_MS = 10_000;

async function stopDaemon(): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const pid = readPidFile(ctx.paths.pidFile);
  if (pid === null) {
    process.stdout.write("daemon is not running\n");
    return 0;
  }
  if (!isAlive(pid)) {
    removePidFile(ctx.paths.pidFile);
    process.stdout.write("stale pidfile removed; daemon is not running\n");
    return 0;
  }
  // NEVER signal a pid we can prove is not ours. Pids recycle: the live daemon
  // on this machine is 72718 while one served repo's pidfile still named 29264,
  // a DEAD pid — had the OS handed 29264 to something else, `hayven daemon stop`
  // would have SIGTERM'd an unrelated process. `unknown` (no sidecar, e.g. a
  // pre-upgrade daemon) keeps the old behavior rather than refusing to stop.
  if (verifyDaemonIdentity(ctx.paths.pidFile, pid) === "foreign") {
    removePidFile(ctx.paths.pidFile);
    process.stdout.write(
      `stale pidfile removed — pid ${pid} is alive but is NOT this daemon (recycled pid); ` +
        "refusing to signal it. The daemon is not running.\n",
    );
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`SIGTERM sent to daemon (pid ${pid})\n`);
  } catch (err) {
    process.stderr.write(`failed to signal pid ${pid}: ${(err as Error).message}\n`);
    return 1;
  }
  // WAIT for the process to actually exit. The daemon keeps answering
  // `/api/health` while its shutdown drains project runtimes, so returning
  // immediately would let a follow-up `daemon start` (the sequence our own
  // error messages recommend) probe the DYING daemon, report "already
  // running", exit 0 — and moments later nothing is running.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      process.stdout.write(`daemon stopped (pid ${pid})\n`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stderr.write(
    `error: daemon (pid ${pid}) is still shutting down after ${Math.round(STOP_WAIT_MS / 1000)}s — ` +
      "check `hayven daemon status` before restarting.\n",
  );
  return 1;
}

function statusDaemon(): number {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const status = daemonStatus(ctx.paths.pidFile);
  switch (status.state) {
    case "running":
      process.stdout.write(`running (pid ${status.pid})\n`);
      return 0;
    case "stale":
      process.stdout.write(`stale pidfile (pid ${status.pid} is not alive)\n`);
      return 1;
    case "stopped":
      process.stdout.write("stopped\n");
      return 1;
  }
}
