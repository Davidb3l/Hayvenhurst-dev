// Supervisor for `hayven-native watch`. ARCHITECTURE.md §16.
//
// Long-lived companion process for the daemon. Responsibilities:
//   - Spawn the watcher; assert Q5 version handshake on its first record.
//   - Read NDJSON line-by-line and route records to a handler callback.
//   - Debounce `change` events (default 200 ms QUIET PERIOD, bounded by
//     `maxDebounceMs`) into batched re-ingest callbacks so noisy filesystems
//     (a webpack build dropping 500 files in 50 ms) trigger one parse run,
//     not 500.
//   - Apply BACKPRESSURE: never dispatch a batch while the previous handler
//     is still running. Events keep coalescing in the pending map instead.
//   - On `overflow`, drop pending debounce state and fire the full-rescan
//     callback (§16.5 — don't trust a saturated event queue), COALESCING
//     concurrent overflows down to at most one queued rescan.
//   - On fatal/exit/heartbeat-stall: restart the child with exponential
//     backoff (capped at 30 s) so a transient OS hiccup doesn't take down
//     incremental ingest — reset after a sustained healthy run. The
//     heartbeat-stall half of that claim was documentation only until
//     `heartbeatStallMs` was implemented: `lastHeartbeatMs` was recorded and
//     compared against nothing, so a wedged backend read as an idle repo.
//   - Spawn the child with the SAME `--include-vendored` / `--include-fixtures`
//     scope the daemon ingests with. `hayven-native watch` consults the shared
//     `ScopeFilter`, so a mismatch here makes the watch and ingest paths
//     disagree about which files belong in the graph.
//
// The three bounds above exist because their absence is what turned a single
// bad `daemon start` into a 6-hour, 98%-CPU, 195 GB-read runaway: the old fixed
// 200 ms window dispatched a new batch every 200 ms REGARDLESS of whether the
// previous handler had returned (probe: 8 concurrent `onBatch` calls over 2.1 s
// of continuous change), and every overflow record fired its own full re-ingest
// (probe: 50 overflows → 50 sequential full repo re-ingests, none merged).
//
// The supervisor does NOT itself talk to SQLite or the CRDT layer — it
// hands the daemon a list of changed paths and the daemon decides what to
// do with them. Keeps this module pure & easy to unit-test.

import type { Logger } from "../util/log.ts";
import {
  assertVersionCompatible,
  NdjsonLineReader,
  parseLine,
  ProtocolSkewError,
  VersionSkewError,
  type ChangeRecord,
  type NativeRecord,
} from "./protocol.ts";

interface SpawnLike {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | string): void;
}

type SpawnFn = (opts: {
  cmd: string[];
  stdin?: "ignore" | "pipe" | "inherit";
  stdout?: "ignore" | "pipe" | "inherit";
  stderr?: "ignore" | "pipe" | "inherit";
}) => SpawnLike;

export interface WatchEvent {
  /** Repo-relative path. */
  file: string;
  kind: ChangeRecord["kind"];
  /** Source path of a rename (only when `kind === "rename"` and the
   *  backend reported both endpoints). */
  from?: string;
  /** Milliseconds when the OS noticed the event. */
  tsMs: number;
}

export interface StartWatchOptions {
  /** Absolute path to the `hayven-native` binary. */
  binary: string;
  /** Repo root to watch. */
  root: string;
  /** QUIET PERIOD in milliseconds (default 200): the batch flushes only once the
   *  filesystem has been silent this long, not every N ms while it churns. */
  debounceMs?: number;
  /**
   * Hard ceiling on how long the FIRST pending event waits, so a tree that never
   * goes quiet (a long build, a `git checkout` of a huge branch) still gets
   * batches instead of starving forever behind the quiet period.
   * Default `max(debounceMs * 10, 2000)`.
   */
  maxDebounceMs?: number;
  /**
   * Called when the debounce window elapses with the coalesced batch. AWAITED:
   * the supervisor will not dispatch another batch (or an overflow rescan)
   * until this settles. Reject/throw is logged, never fatal.
   */
  onBatch: (events: WatchEvent[]) => void | Promise<void>;
  /** Called when the OS event queue saturates — caller should full-rescan.
   *  AWAITED and COALESCED: overflows arriving during a rescan collapse into at
   *  most ONE follow-up rescan. */
  onOverflow: (info: { dropped: number; sinceMs: number }) => void | Promise<void>;
  /** Optional injected spawn for tests. */
  spawn?: SpawnFn;
  /** Optional logger. */
  logger?: Logger;
  /** Restart cap. Default 30 000 ms. */
  maxRestartBackoffMs?: number;
  /**
   * Hard cap on buffered events. Past this the buffer is DROPPED and one
   * synthetic overflow is raised instead (a full rescan supersedes the batch
   * anyway). Default {@link DEFAULT_MAX_PENDING_EVENTS}.
   */
  maxPendingEvents?: number;
  /** A child that stayed up at least this long is not in a crash loop, so its
   *  next restart starts from the initial backoff again. Default 60 000 ms. */
  healthyRunMs?: number;
  /**
   * SCOPE PARITY with the ingest path. `hayven-native watch` applies the SAME
   * `ScopeFilter` the walker and `--files-stdin` use, so if the daemon ingests
   * with `--include-vendored` but the watcher is spawned without it, a change to
   * `vendor/x.ts` is never reported and the file's rows silently rot: the full
   * ingest puts them in, and nothing ever updates or removes them again. Worse,
   * the reverse (watcher wide, ingest narrow) makes the incremental path ADD
   * nodes the next full ingest deletes, so the graph oscillates with whichever
   * path ran last. Must always be passed the project's `index.includeVendored`
   * / `index.includeFixtures`, identical to every `startParse` call for the
   * same project.
   */
  includeVendored?: boolean;
  /** See {@link StartWatchOptions.includeVendored}. */
  includeFixtures?: boolean;
  /**
   * Restart the child when NOTHING has arrived on its stdout for this long.
   * `hayven-native watch` emits a `heartbeat` every 15 s, so silence past a few
   * intervals means the backend wedged (a hung FSEvents/inotify thread) — which
   * previously looked EXACTLY like an idle repo: no exit, no error, just an
   * index that quietly stopped tracking the tree. Default
   * {@link DEFAULT_HEARTBEAT_STALL_MS}. Set to 0 to disable.
   */
  heartbeatStallMs?: number;
}

export interface WatchSupervisor {
  /** Stop the supervisor, kill the child, await its exit. */
  stop(): Promise<void>;
  /** True if a child is currently alive. */
  isRunning(): boolean;
  /** Diagnostic counts. */
  stats(): WatchStats;
}

export interface WatchStats {
  startedAtMs: number;
  restarts: number;
  changeEvents: number;
  batchesEmitted: number;
  overflowsSeen: number;
  /** Wall-clock ms of the last heartbeat received. */
  lastHeartbeatMs: number;
  /**
   * Wall-clock ms (OUR clock) of the last record of ANY kind read off the
   * child's stdout. `lastHeartbeatMs` carries the CHILD's timestamp, so it is
   * useless for liveness if the child's clock is off; this is the value the
   * stall detector compares against.
   */
  lastRecordAtMs: number;
  /** True iff a child process is currently alive AND we are not stopped. */
  alive: boolean;
  /** Exit code of the most recent child exit, or null while the first is up. */
  lastExitCode: number | null;
  /** Times the child was killed for going silent past `heartbeatStallMs`. */
  heartbeatStalls: number;
  /** BACKLOG: events buffered right now, waiting for the quiet period or for
   *  the in-flight handler to finish. The incident had no way to see this. */
  pendingEvents: number;
  /** True while an `onBatch` handler is running (backpressure is engaged). */
  batchInFlight: boolean;
  /** True while an `onOverflow` full rescan is running. */
  overflowInFlight: boolean;
  /** Overflow records that collapsed into an already-running/queued rescan
   *  instead of each starting their own. */
  overflowsCoalesced: number;
  /** Batch flushes deferred because a handler was still running. */
  batchesDeferred: number;
  /** Times the pending buffer hit its cap and was escalated to a full rescan. */
  pendingOverflows: number;
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Initial restart backoff. Doubles each consecutive failure. */
const INITIAL_BACKOFF_MS = 250;
/** Default sustained-uptime threshold that resets the restart backoff. */
const DEFAULT_HEALTHY_RUN_MS = 60_000;
/**
 * Default ceiling on buffered events.
 *
 * Backpressure without this is an unbounded-MEMORY bug wearing an
 * unbounded-CPU bug's clothes: while one `onBatch` runs, every new change
 * coalesces into `pending`, which is bounded only by the number of DISTINCT
 * paths in the watched tree — millions for a home directory. A probe with one
 * slow handler in flight reached 300,000 buffered events / ~199 MB RSS and was
 * still climbing. It bites precisely when the OS queue does NOT saturate, so
 * the `overflow` path never fires to clear it.
 *
 * 20,000 is far above any real batch (the incident's largest was 4,453) and far
 * below anything that threatens the heap.
 */
const DEFAULT_MAX_PENDING_EVENTS = 20_000;
/**
 * Default silence budget before the child is presumed wedged and restarted.
 *
 * `hayven-native watch` heartbeats every 15 s (native/src/watch/mod.rs
 * `HEARTBEAT_INTERVAL`), so this is four missed beats — loose enough that a
 * loaded machine never trips it, tight enough that a wedged backend is
 * recovered in a minute instead of never. The header of this module has claimed
 * "heartbeat-stall restart" since the file was written; until now
 * `lastHeartbeatMs` was recorded and compared against NOTHING, so a hung backend
 * was indistinguishable from an idle repo — silent staleness, the exact shape of
 * the incident.
 */
export const DEFAULT_HEARTBEAT_STALL_MS = 60_000;
/** How often the stall detector wakes. Bounded fraction of the stall budget. */
const STALL_CHECK_DIVISOR = 4;
/** Grace between the stall SIGTERM and the SIGKILL that follows it. Matches the
 *  escalation `stop()` already uses, so a wedged child cannot be immortal. */
const STALL_KILL_GRACE_MS = 2_000;
/** Child stderr lines retained for the exit diagnostic. */
const STDERR_TAIL_LINES = 10;
/**
 * A child that emitted NOTHING and died within this long was almost certainly
 * rejected at argv parsing (clap exits before any record). Past it, "emitted
 * nothing" means the process came up and then hung, which is a different fault
 * with a different remedy.
 */
const ARGV_REJECTION_WINDOW_MS = 5_000;

export function startWatch(opts: StartWatchOptions): WatchSupervisor {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxDebounceMs = opts.maxDebounceMs ?? Math.max(debounceMs * 10, 2_000);
  const maxBackoffMs = opts.maxRestartBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxPendingEvents = opts.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
  const healthyRunMs = opts.healthyRunMs ?? DEFAULT_HEALTHY_RUN_MS;
  const heartbeatStallMs = opts.heartbeatStallMs ?? DEFAULT_HEARTBEAT_STALL_MS;
  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);

  const counters = {
    startedAtMs: Date.now(),
    restarts: 0,
    changeEvents: 0,
    batchesEmitted: 0,
    overflowsSeen: 0,
    lastHeartbeatMs: Date.now(),
    lastRecordAtMs: Date.now(),
    lastExitCode: null as number | null,
    heartbeatStalls: 0,
    overflowsCoalesced: 0,
    batchesDeferred: 0,
    pendingOverflows: 0,
  };

  // Debounce buffer keyed by file path so multiple modifies to the same file
  // within the window collapse to one entry. The OS sometimes emits create
  // → modify → modify on a save; we want one parse, not three.
  let pending = new Map<string, WatchEvent>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let firstPendingAtMs = 0;
  let stopped = false;
  let currentChild: SpawnLike | null = null;

  // BACKPRESSURE state. A handler is a full parse + SQLite ingest; overlapping
  // them is what let one noisy tree pin the CPU and interleave writers.
  let batchInFlight = false;
  let overflowInFlight = false;
  let overflowPending: { dropped: number; sinceMs: number } | null = null;

  function scheduleFlush(): void {
    if (firstPendingAtMs === 0) firstPendingAtMs = Date.now();
    // QUIET PERIOD, not a fixed window: each new event pushes the deadline out,
    // so a burst produces ONE batch when the tree settles. `maxDebounceMs` caps
    // the total wait so continuous churn cannot starve the batch forever.
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    const waited = Date.now() - firstPendingAtMs;
    const delay = Math.max(0, Math.min(debounceMs, maxDebounceMs - waited));
    debounceTimer = setTimeout(() => void flush(), delay);
  }

  /** Re-arm the debounce if work accumulated while a handler was running. */
  function rearmIfPending(): void {
    if (!stopped && pending.size > 0 && debounceTimer === null) scheduleFlush();
  }

  async function flush(): Promise<void> {
    debounceTimer = null;
    if (stopped) return;
    // Never overlap handlers, and never race a full rescan (which supersedes
    // any incremental batch anyway). The events stay in `pending` and coalesce.
    if (batchInFlight || overflowInFlight) {
      counters.batchesDeferred += 1;
      return;
    }
    if (pending.size === 0) {
      firstPendingAtMs = 0;
      return;
    }
    const batch = [...pending.values()];
    pending = new Map();
    firstPendingAtMs = 0;
    counters.batchesEmitted += 1;
    batchInFlight = true;
    try {
      await opts.onBatch(batch);
    } catch (err) {
      opts.logger?.warn("watch onBatch handler failed", {
        error: (err as Error).message,
        batchSize: batch.length,
      });
    } finally {
      batchInFlight = false;
      rearmIfPending();
    }
  }

  /**
   * Run the full-rescan callback, absorbing overflows that arrive while it runs
   * into at most ONE follow-up run. A rescan re-reads the whole tree, so N
   * queued rescans and 1 rescan produce the same end state — the only
   * difference is N-1 wasted full re-ingests.
   */
  async function runOverflow(first: { dropped: number; sinceMs: number }): Promise<void> {
    overflowInFlight = true;
    let info: { dropped: number; sinceMs: number } | null = first;
    try {
      while (info !== null && !stopped) {
        overflowPending = null;
        try {
          await opts.onOverflow(info);
        } catch (err) {
          opts.logger?.warn("watch onOverflow handler failed", {
            error: (err as Error).message,
          });
        }
        info = overflowPending;
      }
    } finally {
      overflowInFlight = false;
      overflowPending = null;
      rearmIfPending();
    }
  }

  function clearPending(): void {
    pending = new Map();
    firstPendingAtMs = 0;
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  /** Set by handleRecord when version skew is detected. The runOnce loop
   *  re-checks this and exits without further processing; the supervisor
   *  loop sees `stopped` and won't restart, because a restart would just
   *  fetch the same bad binary's version again. */
  let versionSkewDetected = false;

  function handleRecord(rec: NativeRecord): void {
    // LIVENESS on OUR clock, updated for every record type. A watcher streaming
    // change events is obviously alive even if a heartbeat write was skipped, and
    // `rec.ts_ms` is the CHILD's clock — comparing that to `Date.now()` would
    // make a clock-skewed child look permanently stalled.
    counters.lastRecordAtMs = Date.now();
    switch (rec.type) {
      case "version":
        try {
          assertVersionCompatible(rec, opts.logger);
        } catch (err) {
          if (err instanceof VersionSkewError || err instanceof ProtocolSkewError) {
            opts.logger?.error("watcher version/protocol skew — refusing to run", {
              message: err.message,
            });
            versionSkewDetected = true;
            stopped = true;
            // This path sets `stopped` directly instead of going through
            // `stop()`, so the stall detector would otherwise outlive the
            // supervisor for the life of the process.
            stopStallDetector();
            const child = currentChild;
            if (child) {
              try {
                child.kill("SIGTERM");
              } catch {
                // already gone
              }
            }
            return;
          }
          throw err;
        }
        return;
      case "ready":
        opts.logger?.info("watcher ready", {
          backend: rec.backend,
          platform: rec.platform,
        });
        return;
      case "change": {
        counters.changeEvents += 1;
        const event: WatchEvent = {
          file: rec.file,
          kind: rec.kind,
          tsMs: rec.ts_ms,
        };
        if (rec.from !== undefined) event.from = rec.from;
        pending.set(rec.file, event);
        // MEMORY BOUND. Backpressure means `pending` grows for as long as a
        // handler runs; without this it is limited only by the number of
        // distinct paths in the tree. At the cap we do exactly what a real
        // queue saturation does — drop the buffer and full-rescan — which is
        // both cheaper than an enormous incremental batch and already
        // implemented, coalesced and rate-limited below.
        if (pending.size >= maxPendingEvents) {
          counters.pendingOverflows += 1;
          const dropped = pending.size;
          clearPending();
          opts.logger?.warn(
            "watch: pending-event cap reached — dropping the buffer and escalating to a full rescan",
            { dropped, cap: maxPendingEvents },
          );
          const info = { dropped, sinceMs: Date.now() };
          if (overflowInFlight) {
            counters.overflowsCoalesced += 1;
            overflowPending = info;
          } else {
            void runOverflow(info);
          }
          return;
        }
        // A rescan already in flight will re-read this file anyway; re-arming
        // the debounce now would only queue a redundant incremental batch
        // behind it. `runOverflow`'s finally re-arms if anything is still
        // pending when the rescan completes.
        if (!overflowInFlight) scheduleFlush();
        return;
      }
      case "overflow": {
        counters.overflowsSeen += 1;
        const info = { dropped: rec.dropped, sinceMs: rec.since_ms };
        clearPending();
        if (overflowInFlight) {
          // COALESCE. Every overflow used to launch its own full re-ingest with
          // nothing merging them (probe: 50 overflows → 50 sequential full repo
          // re-ingests). One rescan supersedes all of them.
          counters.overflowsCoalesced += 1;
          overflowPending = info;
          return;
        }
        opts.logger?.warn("watcher overflow — dropping pending batch and triggering full rescan", {
          dropped: rec.dropped,
          since_ms: rec.since_ms,
        });
        void runOverflow(info);
        return;
      }
      case "heartbeat":
        counters.lastHeartbeatMs = rec.ts_ms;
        return;
      case "warn":
        opts.logger?.warn("watcher warn", { message: rec.message });
        return;
      case "fatal":
        opts.logger?.error("watcher fatal", { message: rec.message });
        return;
      default:
        // Other record types (start/node/edge/etc.) shouldn't show up on
        // the watch stream; ignore them rather than crashing.
        return;
    }
  }

  /**
   * Outcome of one child's run: everything the supervisor loop needs to report
   * WHY it ended. Returned rather than stashed in outer `let`s, because a
   * previous child's still-draining stderr task would otherwise keep appending
   * into the variable the NEXT child is using.
   */
  interface RunOutcome {
    exitCode: number;
    stderrTail: string[];
    /** False when the child died without ever emitting a single NDJSON record —
     *  the signature of a binary that rejected our argv before starting. */
    sawAnyRecord: boolean;
  }

  async function runOnce(): Promise<RunOutcome> {
    // SCOPE PARITY: the same `--include-*` flags the daemon ingests this project
    // with. Omitting them here is not a missing optimization, it is a graph
    // divergence — see StartWatchOptions.includeVendored.
    const cmd = [opts.binary, ...cmdArgsFor(opts)];
    const child = spawnFn({
      cmd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    currentChild = child;
    // A fresh child gets a fresh silence budget; otherwise the stall detector
    // would immediately re-kill a child spawned after a long backoff sleep.
    counters.lastRecordAtMs = Date.now();
    // PER-CHILD, not shared: see RunOutcome.
    const stderrTail: string[] = [];
    let sawAnyRecord = false;

    const stdoutReader = new NdjsonLineReader();
    const stderrReader = new NdjsonLineReader();

    // Drain stderr at debug level, but KEEP THE TAIL. Sending it all to
    // `debug` (off by default) meant a child that died with a real diagnostic on
    // stderr was reported as a bare `exitCode` — the operator saw "watcher child
    // exited; restarting" forever with no way to learn why.
    const stderrDrained = (async () => {
      try {
        const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            stderrReader.push(value);
            for (const line of stderrReader.drain()) {
              stderrTail.push(line);
              if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
              opts.logger?.debug("watcher.stderr", { line });
            }
          }
        }
      } catch {
        // Stream closed — child is dying. Nothing to do.
      }
    })();

    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (versionSkewDetected) break;
        if (value) {
          stdoutReader.push(value);
          for (const line of stdoutReader.drain()) {
            if (versionSkewDetected) break;
            try {
              const rec = parseLine(line);
              sawAnyRecord = true;
              handleRecord(rec);
            } catch (err) {
              opts.logger?.warn("invalid NDJSON from watcher", {
                error: (err as Error).message,
                line,
              });
            }
          }
        }
      }
    } catch (err) {
      opts.logger?.warn("watcher stdout read failed", { error: (err as Error).message });
    }

    const exitCode = await child.exited;
    // The child is GONE — stop advertising it as alive and stop the stall
    // detector from SIGTERM-ing a corpse (which would log a phantom restart and
    // inflate `heartbeatStalls`) during the drain await below.
    if (currentChild === child) currentChild = null;
    // AWAIT the stderr drain before reporting. `runOnce` used to return the
    // moment STDOUT closed, so the exit log read a tail whose final `read()`
    // had not resolved — empty in exactly the crash case it exists for. Bounded
    // because the stream is closed once the child is gone.
    await stderrDrained;
    return { exitCode, stderrTail, sawAnyRecord };
  }

  /**
   * HEARTBEAT-STALL RESTART. The module header promised this from day one and
   * nothing implemented it: `lastHeartbeatMs` was written and never read, so a
   * child whose backend thread wedged (no exit, no error, no events) left the
   * index silently frozen and looked exactly like an idle repo. Killing the
   * child hands it to the supervisor loop below, which restarts it with the
   * normal backoff.
   */
  const stallTimer =
    heartbeatStallMs > 0
      ? setInterval(
          () => {
            if (stopped) return;
            const child = currentChild;
            if (child === null) return; // between children (backoff sleep)
            if (Date.now() - counters.lastRecordAtMs < heartbeatStallMs) return;
            counters.heartbeatStalls += 1;
            opts.logger?.error("watcher went silent past the heartbeat budget — restarting it", {
              silentForMs: Date.now() - counters.lastRecordAtMs,
              budgetMs: heartbeatStallMs,
              stalls: counters.heartbeatStalls,
            });
            // Reset the budget so a child that takes a moment to die is not
            // re-killed (and re-counted) on the very next tick.
            counters.lastRecordAtMs = Date.now();
            try {
              child.kill("SIGTERM");
            } catch {
              // Already gone; the supervisor loop will notice.
            }
            // ESCALATE. A child wedged hard enough to stop heart-beating is
            // precisely the child most likely to ignore SIGTERM (blocked in an
            // uninterruptible FSEvents/inotify call, or with its signal handler
            // stuck). Without this the detector would re-fire every budget
            // forever, sending futile SIGTERMs while `alive` stayed true,
            // `restarts` never moved and incremental ingest stayed dead — the
            // feature would only ever have recovered children that die politely.
            const escalate = setTimeout(() => {
              if (currentChild !== child) return; // it exited; nothing to kill
              opts.logger?.error("watcher ignored SIGTERM after a stall — SIGKILL", {
                graceMs: STALL_KILL_GRACE_MS,
              });
              try {
                child.kill("SIGKILL");
              } catch {
                // Already gone.
              }
            }, STALL_KILL_GRACE_MS);
            if (typeof escalate.unref === "function") escalate.unref();
          },
          Math.max(1_000, Math.floor(heartbeatStallMs / STALL_CHECK_DIVISOR)),
        )
      : null;
  // Never hold the process open on the detector alone.
  if (stallTimer && typeof stallTimer.unref === "function") stallTimer.unref();

  function stopStallDetector(): void {
    if (stallTimer !== null) clearInterval(stallTimer);
  }

  // Supervisor loop: keep restarting the child until `stopped` is set.
  void (async () => {
    let backoffMs = INITIAL_BACKOFF_MS;
    while (!stopped) {
      const childStartedAt = Date.now();
      try {
        const outcome = await runOnce();
        counters.lastExitCode = outcome.exitCode;
        currentChild = null; // between children — the stall detector must idle
        if (stopped) return;
        // A child that exited non-zero WITHOUT emitting a single record never
        // got as far as the §16.4 `version` handshake, so the version-skew path
        // (which stops cleanly with a clear message) cannot fire. The usual
        // cause is an argv this binary does not understand — `watch
        // --include-vendored` only exists from 0.0.7 — and the symptom is an
        // invisible restart loop at the 30 s cap. Say so once per restart, at
        // ERROR, naming the flags we passed.
        // ...and only when it died FAST. A child that came up, hung, and was
        // SIGKILLed by the stall detector 60 s later also has `sawAnyRecord:
        // false` and a non-zero exit, but its problem is a wedged backend, not
        // our argv — telling that operator to upgrade the binary or unset
        // `index.includeVendored` sends them somewhere useless.
        const livedMs = Date.now() - childStartedAt;
        if (!outcome.sawAnyRecord && outcome.exitCode !== 0 && livedMs < ARGV_REJECTION_WINDOW_MS) {
          opts.logger?.error(
            "watcher child died before emitting anything — the native binary may not accept these flags",
            {
              exitCode: outcome.exitCode,
              args: cmdArgsFor(opts),
              stderrTail: outcome.stderrTail.join("\n"),
              hint: "upgrade `hayven-native` (or unset index.includeVendored / index.includeFixtures)",
            },
          );
        }
        opts.logger?.warn("watcher child exited; restarting", {
          exitCode: outcome.exitCode,
          restart: counters.restarts + 1,
          backoffMs,
          // The tail is the difference between a diagnosable crash loop and
          // "exitCode: 1" repeated for six hours.
          stderrTail: outcome.stderrTail.join("\n"),
        });
      } catch (err) {
        currentChild = null;
        if (stopped) return;
        opts.logger?.warn("watcher child crashed; restarting", {
          error: (err as Error).message,
          backoffMs,
        });
      }
      counters.restarts += 1;
      // The backoff only ever GREW before, so one bad hour left every later
      // restart — for the rest of the daemon's life — waiting the 30 s cap. A
      // child that stayed up for a sustained healthy period is not crash-looping.
      if (Date.now() - childStartedAt >= healthyRunMs) backoffMs = INITIAL_BACKOFF_MS;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  })();

  return {
    isRunning: () => currentChild !== null && !stopped,
    stats: () => ({
      ...counters,
      pendingEvents: pending.size,
      batchInFlight,
      overflowInFlight,
      alive: currentChild !== null && !stopped,
    }),
    stop: async () => {
      stopped = true;
      stopStallDetector();
      clearPending();
      overflowPending = null;
      const child = currentChild;
      if (child) {
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
        const killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, 2000);
        try {
          await child.exited;
        } finally {
          clearTimeout(killTimer);
        }
      }
      currentChild = null;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The argv (after the binary path) for one `watch` child. Factored out so the
 * crash diagnostic can name the exact flags that may have been rejected — a
 * `hayven-native` older than 0.0.7 has no `watch --include-vendored`, and clap
 * rejects an unknown flag BEFORE any record is emitted, so the version handshake
 * never runs and the failure otherwise looks like an anonymous restart loop.
 */
function cmdArgsFor(opts: StartWatchOptions): string[] {
  const args = ["watch", "--root", opts.root];
  if (opts.includeVendored) args.push("--include-vendored");
  if (opts.includeFixtures) args.push("--include-fixtures");
  return args;
}
