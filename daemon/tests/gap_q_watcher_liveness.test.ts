/**
 * GAP Q4 — the watcher could die quietly.
 *
 * Three separate holes, all with the same consequence: a dead or wedged watcher
 * was INDISTINGUISHABLE from an idle one, so incremental ingest stopped, the
 * index silently went stale, and nothing anywhere said so.
 *
 *   a) `lastHeartbeatMs` was WRITTEN and never compared to anything, despite the
 *      module header promising "on fatal/exit/heartbeat-stall: restart". A child
 *      whose backend thread wedged never exited, never errored and never emitted
 *      — and was never restarted.
 *   b) All child stderr went to `logger.debug` (off by default) and the exit log
 *      carried only `exitCode`, so a crash loop was undiagnosable.
 *   c) `/api/ingest/health` exposed no liveness at all.
 */
import { describe, expect, test } from "bun:test";

import { createIngestGuard } from "../src/cli/daemon.ts";
import { startWatch, type WatchStats } from "../src/native/watcher.ts";
import { createLogger, type Logger } from "../src/util/log.ts";

/** A child we control: stdout stays OPEN (the wedged-backend shape) until we
 *  end it, so the supervisor cannot notice anything via an exit. */
function silentChild(onKill: () => void) {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let errCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;
  let closed = false;
  const exited = new Promise<number>((r) => {
    exitResolve = r;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      errCtrl = c;
    },
  });
  const end = (code = 143): void => {
    if (closed) return;
    closed = true;
    try {
      ctrl.close();
    } catch {
      /* already closed */
    }
    try {
      errCtrl.close();
    } catch {
      /* already closed */
    }
    exitResolve(code);
  };
  return {
    child: {
      stdout,
      stderr,
      exited,
      kill: () => {
        onKill();
        end();
      },
    },
    pushOut: (line: string) => {
      if (!closed) ctrl.enqueue(encoder.encode(line + "\n"));
    },
    pushErr: (line: string) => {
      if (!closed) errCtrl.enqueue(encoder.encode(line + "\n"));
    },
    end,
  };
}

const versionLine = JSON.stringify({
  type: "version",
  major: 0,
  minor: 0,
  patch: 1,
  protocol: 2,
});
const heartbeatLine = (): string => JSON.stringify({ type: "heartbeat", ts_ms: Date.now() });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Collects every record the logger is handed, so we can assert on diagnostics. */
function recordingLogger(sink: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>): Logger {
  const make = (): Logger => ({
    debug: (msg, fields) => void sink.push({ level: "debug", msg, ...(fields ? { fields } : {}) }),
    info: (msg, fields) => void sink.push({ level: "info", msg, ...(fields ? { fields } : {}) }),
    warn: (msg, fields) => void sink.push({ level: "warn", msg, ...(fields ? { fields } : {}) }),
    error: (msg, fields) => void sink.push({ level: "error", msg, ...(fields ? { fields } : {}) }),
    child: () => make(),
  });
  return make();
}

describe("Q4a — heartbeat-stall restart is implemented, not just documented", () => {
  test("a child that goes SILENT (no exit, no error) is killed and restarted", async () => {
    const kills: number[] = [];
    const spawns: Array<ReturnType<typeof silentChild>> = [];
    const logs: Array<{ level: string; msg: string }> = [];

    const w = startWatch({
      binary: "/fake/native",
      root: "/fake/repo",
      logger: recordingLogger(logs),
      onBatch: () => undefined,
      onOverflow: () => undefined,
      // 150 ms budget: the detector wakes every max(1000, 150/4) = 1000 ms, so
      // give the test room for one tick.
      heartbeatStallMs: 150,
      spawn: (() => {
        const c = silentChild(() => kills.push(Date.now()));
        spawns.push(c);
        // The child is well-behaved at first — handshake, then silence.
        queueMicrotask(() => c.pushOut(versionLine));
        return c.child;
      }) as never,
    });

    // The child never exits and never emits again. Before the stall fix this
    // sat here forever with `alive: true` and a frozen index.
    await sleep(1_400);
    expect(kills.length).toBeGreaterThanOrEqual(1);
    expect(w.stats().heartbeatStalls).toBeGreaterThanOrEqual(1);
    expect(logs.some((l) => l.level === "error" && /silent past the heartbeat budget/.test(l.msg))).toBe(
      true,
    );
    await w.stop();
  }, 10_000);

  test("a child that keeps heartbeating is NEVER killed", async () => {
    const kills: number[] = [];
    let live: ReturnType<typeof silentChild> | null = null;
    const w = startWatch({
      binary: "/fake/native",
      root: "/fake/repo",
      onBatch: () => undefined,
      onOverflow: () => undefined,
      heartbeatStallMs: 150,
      spawn: (() => {
        const c = silentChild(() => kills.push(Date.now()));
        live = c;
        queueMicrotask(() => c.pushOut(versionLine));
        return c.child;
      }) as never,
    });
    const beat = setInterval(() => live?.pushOut(heartbeatLine()), 50);
    await sleep(1_400);
    clearInterval(beat);
    expect(kills.length).toBe(0);
    expect(w.stats().heartbeatStalls).toBe(0);
    await w.stop();
  }, 10_000);
});

describe("Q4a2 — a wedged child that IGNORES SIGTERM is SIGKILLed", () => {
  test("escalates rather than re-sending SIGTERM forever", async () => {
    const signals: string[] = [];
    // A child that swallows SIGTERM entirely — the shape of a process blocked in
    // an uninterruptible FSEvents/inotify call. Before the escalation, the
    // detector would re-fire every budget forever while `alive` stayed true and
    // incremental ingest stayed dead.
    const stubborn = () => {
      const encoder = new TextEncoder();
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      let exitResolve!: (c: number) => void;
      const exited = new Promise<number>((r) => {
        exitResolve = r;
      });
      const stdout = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          queueMicrotask(() => c.enqueue(encoder.encode(versionLine + "\n")));
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      });
      return {
        stdout,
        stderr,
        exited,
        kill: (sig?: string | number) => {
          signals.push(String(sig));
          if (String(sig) === "SIGKILL") {
            try {
              ctrl.close();
            } catch {
              /* already closed */
            }
            exitResolve(137);
          }
          // SIGTERM is deliberately ignored.
        },
      };
    };

    const w = startWatch({
      binary: "/fake/native",
      root: "/fake/repo",
      onBatch: () => undefined,
      onOverflow: () => undefined,
      heartbeatStallMs: 150,
      maxRestartBackoffMs: 60_000,
      spawn: stubborn as never,
    });
    // One detector tick (>=1s) + the 2s SIGTERM grace.
    await sleep(4_000);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    await w.stop();
  }, 20_000);
});

describe("Q4b — a dying child's stderr reaches the exit diagnostic", () => {
  test("the exit warning carries the stderr tail, not just an exit code", async () => {
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    let first = true;
    const w = startWatch({
      binary: "/fake/native",
      root: "/fake/repo",
      logger: recordingLogger(logs),
      onBatch: () => undefined,
      onOverflow: () => undefined,
      heartbeatStallMs: 0, // not under test here
      maxRestartBackoffMs: 5_000,
      spawn: (() => {
        const c = silentChild(() => undefined);
        if (first) {
          first = false;
          queueMicrotask(() => {
            c.pushOut(versionLine);
            c.pushErr("watch: FSEvents stream could not be started (EPERM)");
            c.end(1);
          });
        }
        return c.child;
      }) as never,
    });

    await sleep(300);
    const exitLog = logs.find((l) => l.msg === "watcher child exited; restarting");
    expect(exitLog).toBeDefined();
    expect(String(exitLog!.fields?.["stderrTail"] ?? "")).toContain("FSEvents stream could not be started");
    await w.stop();
  }, 10_000);
});

describe("Q4d — a child that dies before saying anything is named, not just counted", () => {
  test("an argv the binary rejects produces an ERROR naming the flags", async () => {
    // `hayven-native watch --include-vendored` only exists from 0.0.7. An older
    // binary makes clap exit 2 BEFORE the §16.4 `version` record, so the
    // version-skew path (which stops cleanly) never runs and the supervisor
    // restarts forever at the 30 s cap with no explanation anywhere.
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const w = startWatch({
      binary: "/fake/native",
      root: "/fake/repo",
      logger: recordingLogger(logs),
      onBatch: () => undefined,
      onOverflow: () => undefined,
      heartbeatStallMs: 0,
      includeVendored: true,
      spawn: (() => {
        const c = silentChild(() => undefined);
        queueMicrotask(() => {
          c.pushErr("error: unexpected argument '--include-vendored' found");
          c.end(2);
        });
        return c.child;
      }) as never,
    });
    await sleep(300);
    const err = logs.find(
      (l) => l.level === "error" && /died before emitting anything/.test(l.msg),
    );
    expect(err).toBeDefined();
    expect(String(err!.fields?.["args"] ?? "")).toContain("--include-vendored");
    expect(String(err!.fields?.["stderrTail"] ?? "")).toContain("unexpected argument");
    await w.stop();
  }, 10_000);

  test("a child that DID emit records before exiting is not flagged", async () => {
    const logs: Array<{ level: string; msg: string }> = [];
    const w = startWatch({
      binary: "/fake/native",
      root: "/fake/repo",
      logger: recordingLogger(logs),
      onBatch: () => undefined,
      onOverflow: () => undefined,
      heartbeatStallMs: 0,
      spawn: (() => {
        const c = silentChild(() => undefined);
        queueMicrotask(() => {
          c.pushOut(versionLine);
          c.end(1);
        });
        return c.child;
      }) as never,
    });
    await sleep(300);
    expect(logs.some((l) => /died before emitting anything/.test(l.msg))).toBe(false);
    await w.stop();
  }, 10_000);
});

describe("Q4c — liveness is surfaced through /api/ingest/health", () => {
  /** The exact fields `IngestHealth` reports for a watcher. */
  function healthFor(w: WatchStats | undefined) {
    const guard = createIngestGuard({
      alias: "test",
      logger: createLogger({ toFile: false, toStderr: false }),
      runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
      fullIngest: async () => {},
      watchStats: () => w,
    });
    return guard.health();
  }

  function statsWith(over: Partial<WatchStats>): WatchStats {
    return {
      startedAtMs: 0,
      restarts: 0,
      changeEvents: 0,
      batchesEmitted: 0,
      overflowsSeen: 0,
      lastHeartbeatMs: 0,
      lastRecordAtMs: Date.now(),
      alive: true,
      lastExitCode: null,
      heartbeatStalls: 0,
      pendingEvents: 0,
      batchInFlight: false,
      overflowInFlight: false,
      overflowsCoalesced: 0,
      batchesDeferred: 0,
      pendingOverflows: 0,
      ...over,
    };
  }

  test("a DEAD watcher is distinguishable from an idle one", () => {
    const idle = healthFor(statsWith({ alive: true }));
    const dead = healthFor(statsWith({ alive: false, lastExitCode: 1, restarts: 7 }));
    // The pre-fix surface: byte-identical for both.
    expect(idle.pendingWatchEvents).toBe(dead.pendingWatchEvents);
    expect(idle.watchBatchInFlight).toBe(dead.watchBatchInFlight);
    // The signal that was missing.
    expect(idle.watcherAlive).toBe(true);
    expect(dead.watcherAlive).toBe(false);
    expect(dead.watcherLastExitCode).toBe(1);
    expect(dead.watcherRestarts).toBe(7);
  });

  test("silence and stall counts are reported", () => {
    const h = healthFor(statsWith({ lastRecordAtMs: Date.now() - 90_000, heartbeatStalls: 3 }));
    expect(h.watcherSilentForMs).toBeGreaterThanOrEqual(89_000);
    expect(h.watcherHeartbeatStalls).toBe(3);
  });

  test("NO watcher at all reports null, not a fabricated 'alive: false'", () => {
    const h = healthFor(undefined);
    expect(h.watcherAlive).toBeNull();
    expect(h.watcherRestarts).toBeNull();
    expect(h.watcherSilentForMs).toBeNull();
  });
});
