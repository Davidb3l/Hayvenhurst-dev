// Supervisor for `hayven-native watch`. ARCHITECTURE.md §16.
//
// Long-lived companion process for the daemon. Responsibilities:
//   - Spawn the watcher; assert Q5 version handshake on its first record.
//   - Read NDJSON line-by-line and route records to a handler callback.
//   - Debounce `change` events (default 200 ms) into batched re-ingest
//     callbacks so noisy filesystems (a webpack build dropping 500 files
//     in 50 ms) trigger one parse run, not 500.
//   - On `overflow`, drop pending debounce state and fire the full-rescan
//     callback (§16.5 — don't trust a saturated event queue).
//   - On fatal/exit/heartbeat-stall: restart the child with exponential
//     backoff (capped at 30 s) so a transient OS hiccup doesn't take down
//     incremental ingest.
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
  /** Debounce window in milliseconds (default 200). */
  debounceMs?: number;
  /** Called when the debounce window elapses with the coalesced batch. */
  onBatch: (events: WatchEvent[]) => void | Promise<void>;
  /** Called when the OS event queue saturates — caller should full-rescan. */
  onOverflow: (info: { dropped: number; sinceMs: number }) => void | Promise<void>;
  /** Optional injected spawn for tests. */
  spawn?: SpawnFn;
  /** Optional logger. */
  logger?: Logger;
  /** Restart cap. Default 30 000 ms. */
  maxRestartBackoffMs?: number;
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
}

const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Initial restart backoff. Doubles each consecutive failure. */
const INITIAL_BACKOFF_MS = 250;

export function startWatch(opts: StartWatchOptions): WatchSupervisor {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxBackoffMs = opts.maxRestartBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);

  const stats: WatchStats = {
    startedAtMs: Date.now(),
    restarts: 0,
    changeEvents: 0,
    batchesEmitted: 0,
    overflowsSeen: 0,
    lastHeartbeatMs: Date.now(),
  };

  // Debounce buffer keyed by file path so multiple modifies to the same file
  // within the window collapse to one entry. The OS sometimes emits create
  // → modify → modify on a save; we want one parse, not three.
  let pending = new Map<string, WatchEvent>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let currentChild: SpawnLike | null = null;

  function scheduleFlush(): void {
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (pending.size === 0) return;
      const batch = [...pending.values()];
      pending = new Map();
      stats.batchesEmitted += 1;
      try {
        const result = opts.onBatch(batch);
        if (result instanceof Promise) {
          result.catch((err) => {
            opts.logger?.warn("watch onBatch handler rejected", {
              error: (err as Error).message,
              batchSize: batch.length,
            });
          });
        }
      } catch (err) {
        opts.logger?.warn("watch onBatch handler threw", {
          error: (err as Error).message,
          batchSize: batch.length,
        });
      }
    }, debounceMs);
  }

  function clearPending(): void {
    pending = new Map();
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
        stats.changeEvents += 1;
        const event: WatchEvent = {
          file: rec.file,
          kind: rec.kind,
          tsMs: rec.ts_ms,
        };
        if (rec.from !== undefined) event.from = rec.from;
        pending.set(rec.file, event);
        scheduleFlush();
        return;
      }
      case "overflow": {
        stats.overflowsSeen += 1;
        opts.logger?.warn("watcher overflow — dropping pending batch and triggering full rescan", {
          dropped: rec.dropped,
          since_ms: rec.since_ms,
        });
        clearPending();
        try {
          const result = opts.onOverflow({ dropped: rec.dropped, sinceMs: rec.since_ms });
          if (result instanceof Promise) {
            result.catch((err) =>
              opts.logger?.warn("watch onOverflow handler rejected", {
                error: (err as Error).message,
              }),
            );
          }
        } catch (err) {
          opts.logger?.warn("watch onOverflow handler threw", {
            error: (err as Error).message,
          });
        }
        return;
      }
      case "heartbeat":
        stats.lastHeartbeatMs = rec.ts_ms;
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
      try {
        const code = await runOnce();
        if (stopped) return;
        opts.logger?.warn("watcher child exited; restarting", {
          exitCode: code,
          restart: stats.restarts + 1,
          backoffMs,
        });
      } catch (err) {
        if (stopped) return;
        opts.logger?.warn("watcher child crashed; restarting", {
          error: (err as Error).message,
          backoffMs,
        });
      }
      stats.restarts += 1;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  })();

  return {
    isRunning: () => currentChild !== null && !stopped,
    stats: () => ({ ...stats }),
    stop: async () => {
      stopped = true;
      clearPending();
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
