/**
 * E1 — the watcher half of the runaway-ingest loop.
 *
 * The incident: a `hayven daemon` indexed a whole home directory for six hours
 * at 98% CPU. Three properties of `native/watcher.ts` made that possible, and
 * each gets a test here:
 *
 *   1. `scheduleFlush` used a FIXED 200 ms window and did NOT await `onBatch` —
 *      it only attached a `.catch` for logging. A probe over 2,102 ms of
 *      continuous change with a 400 ms handler dispatched 36 batches with up to
 *      8 running CONCURRENTLY, each one a parse + SQLite ingest.
 *   2. Every `overflow` record fired its own full rescan unconditionally: 50
 *      overflow events → 50 sequential FULL repo re-ingests, none merged.
 *   3. The restart backoff only ever grew and never reset, so one bad stretch
 *      left every later restart waiting the 30 s cap for the daemon's lifetime.
 */
import { describe, expect, test } from "bun:test";

import { startWatch, type WatchEvent } from "../src/native/watcher.ts";

/** A fake child whose stdout we can push lines into over time. */
interface Pushable {
  child: {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill(): void;
  };
  push(line: string): void;
  end(code?: number): void;
}

function pushableChild(): Pushable {
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let exitResolve!: (code: number) => void;
  let closed = false;
  const exited = new Promise<number>((resolve) => {
    exitResolve = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      ctrl = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const end = (code = 0): void => {
    if (closed) return;
    closed = true;
    try {
      ctrl.close();
    } catch {
      /* already closed */
    }
    exitResolve(code);
  };
  return {
    child: { stdout, stderr, exited, kill: () => end(143) },
    push: (line: string) => {
      if (!closed) ctrl.enqueue(encoder.encode(line + "\n"));
    },
    end,
  };
}

const versionLine = (): string =>
  JSON.stringify({ type: "version", major: 0, minor: 0, patch: 1, protocol: 2 });
const readyLine = (): string =>
  JSON.stringify({ type: "ready", platform: "darwin", backend: "fsevents" });
const changeLine = (file: string): string =>
  JSON.stringify({ type: "change", file, kind: "modify", ts_ms: Date.now() });
const overflowLine = (dropped: number): string =>
  JSON.stringify({ type: "overflow", dropped, since_ms: 1700000000000 });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("E1: watcher backpressure", () => {
  test("NEVER runs two onBatch handlers concurrently, however fast changes arrive", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let handled = 0;
    const p = pushableChild();
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 20,
      maxDebounceMs: 60,
      onBatch: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        handled += 1;
        // A real handler is a parse + ingest — far slower than the window.
        await sleep(80);
        concurrent -= 1;
      },
      onOverflow: () => {},
      spawn: () => p.child as never,
    });
    p.push(versionLine());
    p.push(readyLine());
    // Continuous change for ~600 ms, much faster than the handler.
    for (let i = 0; i < 60; i++) {
      p.push(changeLine(`src/f${i}.ts`));
      await sleep(10);
    }
    await sleep(200);
    await sup.stop();

    // THE property: handlers are serialized. Pre-fix this reached 8.
    expect(maxConcurrent).toBe(1);
    expect(handled).toBeGreaterThan(0);
  });

  test("a quiet-period debounce emits ONE batch for a continuous burst", async () => {
    const batches: WatchEvent[][] = [];
    const p = pushableChild();
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 100,
      maxDebounceMs: 100_000, // effectively unlimited: isolate the quiet period
      onBatch: (b) => {
        batches.push(b);
      },
      onOverflow: () => {},
      spawn: () => p.child as never,
    });
    p.push(versionLine());
    p.push(readyLine());
    // 300 ms of change at 20 ms intervals. A FIXED 100 ms window fires roughly
    // every 100 ms → ~3 batches. A quiet period waits for the tree to settle → 1.
    for (let i = 0; i < 15; i++) {
      p.push(changeLine(`src/f${i}.ts`));
      await sleep(20);
    }
    await sleep(250);
    await sup.stop();

    expect(batches.length).toBe(1);
    expect(batches[0]!.length).toBe(15);
  });

  test("maxDebounceMs stops a never-quiet tree from starving the batch forever", async () => {
    // NOTE ON THIS TEST'S SHAPE. The first version used debounceMs:100 /
    // maxDebounceMs:150 and asserted `batches >= 2`, which PASSED against a
    // fully-reverted watcher: `maxDebounceMs` does not exist at baseline, the
    // option is silently ignored, and the baseline's fixed 100 ms window emits
    // >= 2 batches over that span anyway. It proved nothing.
    //
    // The shape below cannot be satisfied by accident: the quiet period is 5 s
    // and changes never stop for 1 s, so ONLY an honoured `maxDebounceMs` can
    // produce a batch at all inside the assertion window. Baseline (fixed 5 s
    // window, option ignored) emits zero.
    const batches: WatchEvent[][] = [];
    const firstBatchAt: number[] = [];
    const p = pushableChild();
    const started = Date.now();
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 5_000,
      maxDebounceMs: 300,
      onBatch: (b) => {
        batches.push(b);
        firstBatchAt.push(Date.now() - started);
      },
      onOverflow: () => {},
      spawn: () => p.child as never,
    });
    p.push(versionLine());
    p.push(readyLine());
    for (let i = 0; i < 20; i++) {
      p.push(changeLine(`src/f${i}.ts`));
      await sleep(50); // never quiet for anything like 5 s
    }
    await sup.stop();

    expect(batches.length).toBeGreaterThanOrEqual(1);
    // The cap, not the quiet period, released it.
    expect(firstBatchAt[0]!).toBeLessThan(900);
  });
});

describe("E1: watcher overflow coalescing", () => {
  test("50 overflow records collapse into at most 2 full rescans, not 50", async () => {
    let rescans = 0;
    const p = pushableChild();
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 20,
      onBatch: () => {},
      onOverflow: async () => {
        rescans += 1;
        await sleep(60); // a full repo re-ingest is slow
      },
      spawn: () => p.child as never,
    });
    p.push(versionLine());
    p.push(readyLine());
    for (let i = 0; i < 50; i++) p.push(overflowLine(i + 1));
    await sleep(300);
    await sup.stop();

    // One running + at most one queued follow-up. Pre-fix: 50.
    expect(rescans).toBeLessThanOrEqual(2);
    expect(rescans).toBeGreaterThanOrEqual(1);
    expect(sup.stats().overflowsSeen).toBe(50);
    expect(sup.stats().overflowsCoalesced).toBeGreaterThanOrEqual(48);
  });

  test("an overflow rescan is not raced by an incremental batch", async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const p = pushableChild();
    const enter = (tag: string): void => {
      order.push(tag);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
    };
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 20,
      onBatch: async () => {
        enter("batch");
        await sleep(50);
        concurrent -= 1;
      },
      onOverflow: async () => {
        enter("overflow");
        await sleep(80);
        concurrent -= 1;
      },
      spawn: () => p.child as never,
    });
    p.push(versionLine());
    p.push(readyLine());
    p.push(overflowLine(9));
    await sleep(10);
    for (let i = 0; i < 5; i++) p.push(changeLine(`src/f${i}.ts`));
    await sleep(300);
    await sup.stop();

    expect(maxConcurrent).toBe(1);
    expect(order[0]).toBe("overflow");
  });
});

describe("E1: watcher restart backoff", () => {
  test("resets after a sustained healthy run instead of only ever growing", async () => {
    let spawns = 0;
    const started = Date.now();
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 20,
      onBatch: () => {},
      onOverflow: () => {},
      // A child that stays up 60 ms counts as healthy at this threshold, so
      // every restart should start from the INITIAL 250 ms backoff again.
      healthyRunMs: 30,
      maxRestartBackoffMs: 30_000,
      spawn: () => {
        spawns += 1;
        const p = pushableChild();
        p.push(versionLine());
        p.push(readyLine());
        setTimeout(() => p.end(1), 60);
        return p.child as never;
      },
    });
    // `restarts` is incremented BEFORE the backoff sleep, so reaching restart N
    // means N-1 backoffs have elapsed. Waiting for 5 gives 4 backoffs:
    //   with the reset   → 250 x 4          = 1.0 s  (+ ~0.3 s of child uptime)
    //   without it       → 250+500+1000+2000 = 3.75 s
    // The 2.5 s ceiling sits cleanly between them. (Earlier this test waited for
    // only 4 restarts, which needed just 1.75 s of doubling backoff and so
    // PASSED with the fix reverted — a vacuous test.)
    while (sup.stats().restarts < 5 && Date.now() - started < 8000) {
      await sleep(25);
    }
    const elapsed = Date.now() - started;
    await sup.stop();

    expect(sup.stats().restarts).toBeGreaterThanOrEqual(5);
    expect(spawns).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeLessThan(2500);
  });
});

describe("E1: the pending buffer is bounded", () => {
  test("caps buffered events and escalates to ONE full rescan", async () => {
    // Backpressure alone converted an unbounded-CPU bug into an unbounded-MEMORY
    // one: while a handler runs, every change coalesces into `pending`, bounded
    // only by the number of distinct paths in the tree. A probe with one slow
    // handler in flight reached 300,000 buffered events / ~199 MB RSS and was
    // still climbing. It bites precisely when the OS queue does NOT saturate,
    // so the `overflow` path never fires to clear it.
    let rescans = 0;
    let releaseBatch!: () => void;
    const batchBlocked = new Promise<void>((r) => {
      releaseBatch = r;
    });
    const p = pushableChild();
    const sup = startWatch({
      binary: "/fake/hayven-native",
      root: "/repo",
      debounceMs: 10,
      maxPendingEvents: 500,
      onBatch: async () => {
        await batchBlocked; // hold the handler so `pending` accumulates
      },
      onOverflow: async () => {
        rescans += 1;
        // A real rescan is a whole-repo parse + ingest, i.e. seconds. Modelling
        // it as instant would make the coalescing assertion below meaningless.
        await sleep(120);
      },
      spawn: () => p.child as never,
    });
    p.push(versionLine());
    p.push(readyLine());
    p.push(changeLine("src/first.ts"));
    await sleep(40); // let the blocking batch start

    // Now flood far past the cap with DISTINCT paths (coalescing cannot help).
    for (let i = 0; i < 5000; i++) p.push(changeLine(`src/f${i}.ts`));
    await sleep(60);

    const stats = sup.stats();
    // THE property: the buffer is bounded. Pre-fix it simply grew to 5000.
    expect(stats.pendingEvents).toBeLessThanOrEqual(500);
    expect(stats.pendingOverflows).toBeGreaterThanOrEqual(1);

    releaseBatch();
    await sleep(120);
    await sup.stop();

    // …and the escalations COALESCE while a rescan is in flight: 5000 events
    // over the cap must not become ten concurrent full rescans. (Rescan RATE
    // over time is bounded separately, by the ingest guard — see
    // fix_e_ingest_guard.test.ts.)
    expect(rescans).toBeLessThanOrEqual(2);
    expect(rescans).toBeGreaterThanOrEqual(1);
  });
});
