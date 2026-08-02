/**
 * E1 — the daemon half of the runaway-ingest loop: `createIngestGuard`.
 *
 * `runIngestExclusive` appends to the ingest chain UNCONDITIONALLY, and the
 * overflow handler called it once per overflow record with nothing merging the
 * work and nothing counting failures. Measured before the fix: 50 overflow
 * events → 50 sequential FULL repo re-ingests. The incident's real log shows
 * 11,600 ingest cycles and 10 parse timeouts, with no attempt ever abandoned.
 *
 * The guard adds the two missing bounds — COALESCING and a FAILURE BREAKER —
 * plus the health payload that makes the backlog visible at all.
 */
import { describe, expect, it } from "bun:test";

import {
  createIngestGuard,
  createWorkLimiter,
  watchBatchStrategy,
  WATCH_INCREMENTAL_FILE_CAP,
  type IngestGuard,
  type IngestGuardDeps,
} from "../src/cli/daemon.ts";
import { createLogger } from "../src/util/log.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for the project's serialized ingest chain, with the SAME
 * append-unconditionally semantics as `runIngestExclusive`, so a missing
 * coalescer really does produce N sequential runs here.
 */
function makeHarness(
  fullIngest: () => Promise<unknown>,
  over: Partial<{
    threshold: number;
    minIntervalMs: number;
    maxRunsPerWindow: number;
    rateWindowMs: number;
  }> = {},
) {
  let chain: Promise<void> = Promise.resolve();
  const runExclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const guard: IngestGuard = createIngestGuard({
    alias: "proj",
    logger: createLogger({ toFile: false, toStderr: false }),
    runExclusive,
    fullIngest,
    // Most tests are about coalescing/failures, not the clock — default the
    // cooldown off so they stay fast. The rate-limit tests set it explicitly.
    minIntervalMs: 0,
    ...over,
  });
  return { guard, settle: (): Promise<void> => chain };
}

describe("E1: full re-ingest coalescing", () => {
  it("collapses 50 overflow-driven requests into 2 runs, not 50", async () => {
    let runs = 0;
    const { guard, settle } = makeHarness(async () => {
      runs += 1;
      await sleep(20);
    });

    // Fire them the way the overflow handler did: as fast as they arrive.
    const requests = Array.from({ length: 50 }, (_, i) => guard.requestFull(`overflow ${i}`));
    await Promise.all(requests);
    await settle();

    // At most one running + one queued. Pre-fix this was exactly 50.
    expect(runs).toBeLessThanOrEqual(2);
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(guard.health().fullIngestsCoalesced).toBeGreaterThanOrEqual(48);
  });

  it("does NOT swallow a request that arrives after the queued run STARTED", async () => {
    // The subtle half: the coalescing slot must clear when a run BEGINS, not
    // when it ends. Clearing on completion would silently drop every change made
    // while the run was in flight — a wrong index with no error.
    let runs = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => {
      started = r;
    });
    const { guard, settle } = makeHarness(async () => {
      runs += 1;
      started();
      await sleep(40);
    });

    void guard.requestFull("first");
    await firstStarted;
    await sleep(5);
    await guard.requestFull("arrived mid-run");
    await settle();

    expect(runs).toBe(2);
  });

  it("reports the queued run in health so the backlog is visible", async () => {
    const { guard, settle } = makeHarness(async () => {
      await sleep(30);
    });
    void guard.requestFull("one");
    void guard.requestFull("two");
    expect(guard.health().fullIngestQueued).toBe(true);
    expect(guard.health().fullIngestsCoalesced).toBe(1);
    await settle();
    await sleep(5);
    expect(guard.health().fullIngestQueued).toBe(false);
  });
});

describe("E1: consecutive-failure circuit breaker", () => {
  it("stops automatic re-ingest after N consecutive failures", async () => {
    let attempts = 0;
    const { guard, settle } = makeHarness(async () => {
      attempts += 1;
      throw new Error("parse timed out");
    }, { threshold: 3 });

    // Drive failures one at a time (each awaited), the way the watcher does.
    for (let i = 0; i < 10; i++) {
      if (!guard.allowed()) break;
      await guard.requestFull(`attempt ${i}`);
    }
    await settle();

    expect(guard.allowed()).toBe(false);
    expect(guard.health().tripped).toBe(true);
    expect(guard.health().consecutiveFailures).toBe(3);
    expect(guard.health().lastError).toBe("parse timed out");
    expect(guard.health().trippedAt).not.toBeNull();
    // THE property: it gave up. Pre-fix this loop ran all 10 (and in production,
    // 11,600) times.
    expect(attempts).toBe(3);
  });

  it("a success clears the consecutive-failure COUNT but never an existing trip", async () => {
    // This test previously asserted that alternating success/failure could run
    // forever without tripping, and called that the desired behaviour. It was
    // pinning the wrong decision: `note(null)` unconditionally zeroing every
    // piece of breaker state is exactly why a 0.09%-failure-rate runaway (the
    // real incident: 11,600 cycles, 10 timeouts) could never be stopped by it.
    // A success now clears the COUNTER, so genuinely flaky work is not punished,
    // but it does NOT un-trip a breaker — recovery is the explicit reset.
    let failNext = true;
    const { guard, settle } = makeHarness(async () => {
      const shouldFail = failNext;
      failNext = !failNext;
      if (shouldFail) throw new Error("flaky");
    }, { threshold: 3 });

    for (let i = 0; i < 12; i++) await guard.requestFull(`attempt ${i}`);
    await settle();

    // Alternating outcomes still do not reach 3 IN A ROW.
    expect(guard.allowed()).toBe(true);
    expect(guard.health().consecutiveFailures).toBe(0);

    // But once tripped, a later success does not silently re-arm it.
    guard.note(new Error("x"));
    guard.note(new Error("x"));
    guard.note(new Error("x"));
    expect(guard.allowed()).toBe(false);
    guard.note(null);
    expect(guard.allowed()).toBe(false);
    expect(guard.health().tripped).toBe(true);
  });

  it("logs the trip exactly ONCE, not once per attempt", async () => {
    // The incident's 576 MB log was mostly doomed attempts announcing themselves.
    const errors: string[] = [];
    let chain: Promise<void> = Promise.resolve();
    const guard = createIngestGuard({
      alias: "proj",
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg: string) => errors.push(msg),
        child: function () {
          return this;
        },
      },
      runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn);
        chain = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      fullIngest: async () => {
        throw new Error("boom");
      },
      threshold: 2,
    });

    // Keep reporting failures well past the trip point.
    for (let i = 0; i < 20; i++) guard.note(new Error("boom"));

    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("CIRCUIT BREAKER TRIPPED");
    // …and it tells the user how to get out of it.
    expect(errors[0]).toContain("/api/ingest/health");
  });

  it("reset() re-arms automatic ingest", async () => {
    const { guard } = makeHarness(async () => {
      throw new Error("boom");
    }, { threshold: 2 });
    guard.note(new Error("boom"));
    guard.note(new Error("boom"));
    expect(guard.allowed()).toBe(false);

    guard.reset();

    expect(guard.allowed()).toBe(true);
    expect(guard.health().tripped).toBe(false);
    expect(guard.health().consecutiveFailures).toBe(0);
    expect(guard.health().trippedAt).toBeNull();
  });

  it("surfaces watcher backlog counters in health", () => {
    let chain: Promise<void> = Promise.resolve();
    const guard = createIngestGuard({
      alias: "proj",
      logger: createLogger({ toFile: false, toStderr: false }),
      runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn);
        chain = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      fullIngest: async () => {},
      watchStats: () => ({
        startedAtMs: 0,
        restarts: 0,
        changeEvents: 9,
        batchesEmitted: 2,
        overflowsSeen: 7,
        lastHeartbeatMs: 0,
        pendingEvents: 4453, // the incident's real batch size
        batchInFlight: true,
        overflowInFlight: false,
        overflowsCoalesced: 6,
        batchesDeferred: 3,
        pendingOverflows: 0,
      }),
    });

    const h = guard.health();
    expect(h.pendingWatchEvents).toBe(4453);
    expect(h.watchBatchInFlight).toBe(true);
    expect(h.watchOverflowsCoalesced).toBe(6);
  });
});

describe("E2: the watcher path has a file-count cap", () => {
  // `cli/ingest.ts` has always capped its incremental path at 2000 touched files
  // and fallen back to a full ingest above it. The WATCHER path had no such
  // bound — that constant appeared in exactly one file — which is how the
  // incident's 3,078- and 4,453-file batches went through as "incremental" work:
  // a per-file delete loop plus a parse of thousands of files, re-dispatched
  // every 200 ms.
  it("matches cli/ingest.ts's cap of 2000", () => {
    expect(WATCH_INCREMENTAL_FILE_CAP).toBe(2000);
  });

  it("stays incremental at and below the cap", () => {
    expect(watchBatchStrategy(0)).toBe("incremental");
    expect(watchBatchStrategy(1)).toBe("incremental");
    expect(watchBatchStrategy(1999)).toBe("incremental");
    expect(watchBatchStrategy(2000)).toBe("incremental");
  });

  it("falls back to a full rebuild above the cap", () => {
    expect(watchBatchStrategy(2001)).toBe("full");
    // The incident's two real batch sizes.
    expect(watchBatchStrategy(3078)).toBe("full");
    expect(watchBatchStrategy(4453)).toBe("full");
  });
});

describe("E1 (corrected): the trip that would have caught the REAL incident", () => {
  // Counted from the user's own log: 11,600 ingest cycles, 10 parse timeouts.
  // A 0.09% failure rate, never five in a row — a consecutive-failure breaker
  // would not have tripped ONCE. The incident was not failure; it was
  // successful work at an impossible rate, and `native/src/watch/mod.rs` maps a
  // watch-REGISTRATION limit onto an `overflow` record, which is a PERSISTENT
  // condition re-emitted every ~500 ms forever.

  /** A clock the test drives, so rate windows are exact and instant. */
  function clockHarness(over: Partial<IngestGuardDeps> = {}) {
    let t = 1_000_000;
    let chain: Promise<void> = Promise.resolve();
    let runs = 0;
    const guard = createIngestGuard({
      alias: "proj",
      logger: createLogger({ toFile: false, toStderr: false }),
      runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn);
        chain = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
      fullIngest: async () => {
        runs += 1; // ALWAYS SUCCEEDS — the incident's actual shape
      },
      now: () => t,
      // Resolves immediately and does NOT move the clock: the TEST owns time.
      // The cooldown is still enforced, because `admitWholeRepoRun` re-checks
      // the interval against `now()` after the wait — so a run that woke too
      // early is skipped rather than executed.
      sleep: async () => {},
      ...over,
    });
    return {
      guard,
      runs: () => runs,
      advance: (ms: number) => {
        t += ms;
      },
      settle: (): Promise<void> => chain,
    };
  }

  it("TRIPS on sustained SUCCESSFUL work — the case the failure breaker cannot see", async () => {
    const h = clockHarness({ minIntervalMs: 0, maxRunsPerWindow: 10, rateWindowMs: 60 * 60_000 });

    // 200 overflow records, every one of which succeeds.
    for (let i = 0; i < 200; i++) {
      await h.guard.requestFull(`overflow ${i}`);
      await h.settle();
    }

    expect(h.guard.allowed()).toBe(false);
    expect(h.guard.health().tripped).toBe(true);
    // The DISTINGUISHING property: it tripped on RATE, with zero failures.
    expect(h.guard.health().tripReason).toBe("rate");
    expect(h.guard.health().consecutiveFailures).toBe(0);
    expect(h.guard.health().lastError).toBeNull();
    expect(h.runs()).toBe(10); // stopped at the limit, not 200
  });

  it("rate-limits a 25ms overflow storm down to one run per interval", async () => {
    // The reviewer's probe of the unfixed code: overflow every 25 ms with an
    // always-succeeding 150 ms full ingest gave duty=95.4%, extrapolating to
    // ~86,000 full re-ingests over six hours.
    const h = clockHarness({ minIntervalMs: 30_000, maxRunsPerWindow: 1_000_000 });

    // Each request is fully resolved before the next, so coalescing CANNOT be
    // what bounds this — the rate limit has to do the work on its own.
    for (let i = 0; i < 400; i++) {
      await h.guard.requestFull(`overflow ${i}`);
      await h.settle();
      h.advance(25); // 400 x 25 ms = 10 s of continuous overflow
    }

    // 10 s of storm at a 30 s minimum interval = ONE rescan. Pre-fix: 400,
    // at 95.4% duty.
    expect(h.runs()).toBe(1);
    expect(h.guard.health().rateLimitedWaits).toBeGreaterThan(0);
    // …and it did NOT trip: rate-limiting is the normal path, tripping is the
    // backstop for load that survives the rate limit.
    expect(h.guard.allowed()).toBe(true);

    // Once real time genuinely passes, work resumes — this is a rate limit, not
    // a mute button.
    h.advance(30_000);
    await h.guard.requestFull("much later");
    await h.settle();
    expect(h.runs()).toBe(2);
  });

  it("lets the rate window roll off, so a quiet daemon is never permanently limited", async () => {
    const h = clockHarness({ minIntervalMs: 0, maxRunsPerWindow: 5, rateWindowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      await h.guard.requestFull(`run ${i}`);
      await h.settle();
    }
    expect(h.runs()).toBe(5);
    expect(h.guard.allowed()).toBe(true);

    h.advance(120_000); // two windows later
    await h.guard.requestFull("much later");
    await h.settle();

    expect(h.runs()).toBe(6);
    expect(h.guard.allowed()).toBe(true);
  });

  it("admitWholeRepoRun applies the same limits to the branch re-point", async () => {
    // A re-point is a `clearGraph()` + whole-repo freshen, so an alternating
    // branch key (`git bisect run`, an interactive rebase) is the same runaway
    // with a different trigger — and every one of its rebuilds SUCCEEDS.
    const h = clockHarness({ minIntervalMs: 30_000, maxRunsPerWindow: 3, rateWindowMs: 60 * 60_000 });

    let admitted = 0;
    for (let i = 0; i < 100; i++) {
      if (h.guard.admitWholeRepoRun(`branch re-point ${i}`)) admitted += 1;
      h.advance(2_000); // the branch poller's real 2 s interval
    }

    // 200 s of alternating branches: the 30 s interval allows ~7 attempts, and
    // the work-rate trip stops it at 3. Pre-fix: 100 full rebuilds.
    expect(admitted).toBe(3);
    expect(h.guard.allowed()).toBe(false);
    expect(h.guard.health().tripReason).toBe("rate");
  });

  it("a MANUAL ingest cannot disarm the automatic breaker", async () => {
    const h = clockHarness({ minIntervalMs: 0, threshold: 2 });
    h.guard.note(new Error("boom"));
    h.guard.note(new Error("boom"));
    expect(h.guard.allowed()).toBe(false);

    // Any periodic external `POST /api/ingest` used to zero the SHARED counter,
    // holding the automatic breaker permanently at zero.
    for (let i = 0; i < 50; i++) h.guard.noteManual(null);

    expect(h.guard.allowed()).toBe(false);
    expect(h.guard.health().tripped).toBe(true);
    expect(h.guard.health().consecutiveFailures).toBe(2);
    // Manual outcomes are still visible, just kept apart.
    h.guard.noteManual(new Error("manual boom"));
    expect(h.guard.health().lastManualError).toBe("manual boom");
    expect(h.guard.health().lastError).toBe("boom");
  });

  it("survives a runExclusive that calls back SYNCHRONOUSLY (no TDZ)", async () => {
    // `requestFull` used to reference `p` from inside its own initializer, which
    // only worked because the real chain defers. `runExclusive` is an injected
    // dependency, so a synchronous one is a legal caller — it threw ReferenceError.
    let ran = 0;
    const guard = createIngestGuard({
      alias: "proj",
      logger: createLogger({ toFile: false, toStderr: false }),
      runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => fn(), // NO deferral
      fullIngest: async () => {
        ran += 1;
      },
      minIntervalMs: 0,
    });

    await guard.requestFull("sync");
    expect(ran).toBe(1);
  });
});

describe("E1 (corrected): daemon-wide concurrency limit", () => {
  it("never runs more automatic ingests at once than the limit, across projects", async () => {
    // Every other bound is per-project: 64 projects each obeying their own
    // limits still meant 64 concurrent all-core parses (parse_jobs defaults to
    // 0 → rayon takes every core) plus 64 `tsc` runs.
    const limiter = createWorkLimiter(1);
    let concurrent = 0;
    let maxConcurrent = 0;

    const projects = Array.from({ length: 20 }, () => {
      let chain: Promise<void> = Promise.resolve();
      return createIngestGuard({
        alias: "p",
        logger: createLogger({ toFile: false, toStderr: false }),
        runExclusive: <T,>(fn: () => Promise<T>): Promise<T> => {
          const next = chain.then(fn);
          chain = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        },
        fullIngest: async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(5);
          concurrent -= 1;
        },
        limiter,
        minIntervalMs: 0,
      });
    });

    await Promise.all(projects.map((g, i) => g.requestFull(`project ${i}`)));

    expect(maxConcurrent).toBe(1);
    expect(limiter.active()).toBe(0);
  });

  it("admits exactly `maxConcurrent` and never over-admits on release", async () => {
    const limiter = createWorkLimiter(3);
    let concurrent = 0;
    let maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 40 }, () =>
        limiter.run(async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await sleep(2);
          concurrent -= 1;
        }),
      ),
    );
    expect(maxConcurrent).toBe(3);
    expect(limiter.active()).toBe(0);
    expect(limiter.waiting()).toBe(0);
  });

  it("releases its slot even when the work throws", async () => {
    const limiter = createWorkLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(limiter.active()).toBe(0);
    // The next caller is not deadlocked behind the failed one.
    await limiter.run(async () => {});
    expect(limiter.active()).toBe(0);
  });
});
