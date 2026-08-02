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
//     incremental ingest — reset after a sustained healthy run.
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

export function startWatch(opts: StartWatchOptions): WatchSupervisor {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxDebounceMs = opts.maxDebounceMs ?? Math.max(debounceMs * 10, 2_000);
  const maxBackoffMs = opts.maxRestartBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxPendingEvents = opts.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
  const healthyRunMs = opts.healthyRunMs ?? DEFAULT_HEALTHY_RUN_MS;
  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);

  const counters = {
    startedAtMs: Date.now(),
    restarts: 0,
    changeEvents: 0,
    batchesEmitted: 0,
    overflowsSeen: 0,
    lastHeartbeatMs: Date.now(),
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

  async function runOnce(): Promise<number> {
    const child = spawnFn({
      cmd: [opts.binary, "watch", "--root", opts.root],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    currentChild = child;

    const stdoutReader = new NdjsonLineReader();
    const stderrReader = new NdjsonLineReader();

    // Drain stderr at debug level — we don't expect anything important here.
    void (async () => {
      try {
        const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            stderrReader.push(value);
            for (const line of stderrReader.drain()) {
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

    return child.exited;
  }

  // Supervisor loop: keep restarting the child until `stopped` is set.
  void (async () => {
    let backoffMs = INITIAL_BACKOFF_MS;
    while (!stopped) {
      const childStartedAt = Date.now();
      try {
        const code = await runOnce();
        if (stopped) return;
        opts.logger?.warn("watcher child exited; restarting", {
          exitCode: code,
          restart: counters.restarts + 1,
          backoffMs,
        });
      } catch (err) {
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
    }),
    stop: async () => {
      stopped = true;
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
