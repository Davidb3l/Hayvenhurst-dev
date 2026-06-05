/**
 * Unit tests for FAIL-FAST test-case prioritization (`daemon/src/db/test_prioritization.ts`).
 *
 * Hermetic + pure: no daemon, no native binary, no filesystem. Every test feeds
 * plain {@link PrioritizableTest} input and an INJECTED `now`, so the recency
 * decay (and therefore the whole ordering) is fully deterministic.
 *
 * What we PROVE:
 *   - EVIDENCE is a hard partition: every `trace` test precedes every `static`
 *     one, even when the static test has an overwhelmingly better score.
 *   - within a partition, a recently-failed test outranks an old/never-failed one.
 *   - closer depth + heavier weight rank earlier.
 *   - a cheaper duration wins a near-tie; unknown duration sorts as average.
 *   - determinism: same input → same output; `id` breaks exact ties stably; the
 *     input array is never mutated.
 *   - `apfd`: a hand-computed textbook value is reproduced EXACTLY, and the
 *     prioritized order scores APFD ≥ a deliberately-bad reverse order — the
 *     measured fail-fast win.
 */
import { describe, expect, it } from "bun:test";

import {
  apfd,
  prioritize,
  type PrioritizableTest,
} from "../src/db/test_prioritization.ts";

/** A fixed "now" so recency decay is deterministic across the suite. */
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Build a test with sane defaults; override only what a case cares about. */
function mk(over: Partial<PrioritizableTest> & { id: string }): PrioritizableTest {
  return {
    evidence: "static",
    depth: 1,
    weight: 1,
    ...over,
  };
}

/** Convenience: the ordered ids out of `prioritize`. */
function order(tests: PrioritizableTest[], now: number | undefined = NOW): string[] {
  return prioritize(tests, { now }).map((t) => t.id);
}

describe("prioritize — evidence is a hard partition (trace before static)", () => {
  it("puts a trace test before a static test even when the static test's score is far higher", () => {
    // The static test is rigged to dominate on EVERY composite term: just-failed,
    // depth 1, huge weight. The trace test is the weakest possible: never failed,
    // far away, tiny weight. Evidence must STILL win — trace precedes static.
    const trace = mk({
      id: "trace-weak",
      evidence: "trace",
      depth: 99,
      weight: 0.01,
      // no lastFailedAt → 0 recency
    });
    const staticStrong = mk({
      id: "static-strong",
      evidence: "static",
      depth: 1,
      weight: 1_000_000,
      lastFailedAt: NOW, // maximal recency boost
    });

    expect(order([staticStrong, trace])).toEqual(["trace-weak", "static-strong"]);
  });

  it("keeps ALL trace tests ahead of ALL static tests regardless of interleaving", () => {
    const tests = [
      mk({ id: "s1", evidence: "static", depth: 1, weight: 100, lastFailedAt: NOW }),
      mk({ id: "t1", evidence: "trace", depth: 50, weight: 0.1 }),
      mk({ id: "s2", evidence: "static", depth: 1, weight: 100 }),
      mk({ id: "t2", evidence: "trace", depth: 50, weight: 0.1 }),
    ];
    const ids = order(tests);
    const firstStatic = Math.min(ids.indexOf("s1"), ids.indexOf("s2"));
    const lastTrace = Math.max(ids.indexOf("t1"), ids.indexOf("t2"));
    expect(lastTrace).toBeLessThan(firstStatic);
  });
});

describe("prioritize — recency outranks within a partition", () => {
  it("a recently-failed test outranks an old-failed one (now injected)", () => {
    const recent = mk({ id: "recent", evidence: "trace", lastFailedAt: NOW - 1 * DAY });
    const old = mk({ id: "old", evidence: "trace", lastFailedAt: NOW - 90 * DAY });
    expect(order([old, recent])).toEqual(["recent", "old"]);
  });

  it("a recently-failed test outranks a never-failed one", () => {
    const recent = mk({ id: "recent", evidence: "trace", lastFailedAt: NOW - 1 * DAY });
    const never = mk({ id: "never", evidence: "trace" }); // no lastFailedAt
    expect(order([never, recent])).toEqual(["recent", "never"]);
  });

  it("without an injected `now`, recency contributes nothing (other signals decide)", () => {
    // Same evidence; the only difference is lastFailedAt, which is INERT when
    // `now` is absent. With everything else equal it falls to id-asc tiebreak.
    const a = mk({ id: "a", evidence: "trace", lastFailedAt: 10 });
    const b = mk({ id: "b", evidence: "trace", lastFailedAt: 999_999_999_999 });
    expect(order([b, a], /* now */ undefined)).toEqual(["a", "b"]);
  });
});

describe("prioritize — proximity and intensity", () => {
  it("a closer (smaller-depth) test ranks earlier when other signals are equal", () => {
    const near = mk({ id: "near", evidence: "trace", depth: 1 });
    const far = mk({ id: "far", evidence: "trace", depth: 5 });
    expect(order([far, near])).toEqual(["near", "far"]);
  });

  it("a heavier-weight test ranks earlier when other signals are equal", () => {
    const heavy = mk({ id: "heavy", evidence: "trace", weight: 100 });
    const light = mk({ id: "light", evidence: "trace", weight: 1 });
    expect(order([light, heavy])).toEqual(["heavy", "light"]);
  });

  it("proximity outweighs intensity (a direct caller beats a distant heavy test)", () => {
    // direct/light vs distant/heavy: W_PROXIMITY (0.6) on 1/1=1 vs the saturating
    // intensity must keep the direct caller first.
    const directLight = mk({ id: "direct", evidence: "trace", depth: 1, weight: 1 });
    const distantHeavy = mk({ id: "distant", evidence: "trace", depth: 10, weight: 10_000 });
    expect(order([distantHeavy, directLight])).toEqual(["direct", "distant"]);
  });
});

describe("prioritize — cheapness tiebreak", () => {
  it("the cheaper test wins a near-tie (equal score, lower duration first)", () => {
    // Identical scoring signals → scores tie → cheaper duration decides.
    const cheap = mk({ id: "cheap", evidence: "trace", lastDurationMs: 5 });
    const slow = mk({ id: "slow", evidence: "trace", lastDurationMs: 5_000 });
    expect(order([slow, cheap])).toEqual(["cheap", "slow"]);
  });

  it("unknown duration sorts as AVERAGE: behind a known-fast, ahead of a known-slow", () => {
    const fast = mk({ id: "a-fast", evidence: "trace", lastDurationMs: 1 });
    const unknown = mk({ id: "b-unknown", evidence: "trace" }); // no duration
    const slow = mk({ id: "c-slow", evidence: "trace", lastDurationMs: 10_000 });
    // All score-equal; cheapness orders them: fast < unknown(avg) < slow.
    expect(order([slow, unknown, fast])).toEqual(["a-fast", "b-unknown", "c-slow"]);
  });

  it("score still dominates duration: a better-scoring slow test beats a cheap weak one", () => {
    const slowButClose = mk({ id: "close", evidence: "trace", depth: 1, lastDurationMs: 9_999 });
    const cheapButFar = mk({ id: "far", evidence: "trace", depth: 9, lastDurationMs: 1 });
    expect(order([cheapButFar, slowButClose])).toEqual(["close", "far"]);
  });
});

describe("prioritize — determinism, stability, purity", () => {
  it("is deterministic: same input → identical output across runs", () => {
    const tests = [
      mk({ id: "t-b", evidence: "trace", depth: 2, weight: 3, lastFailedAt: NOW - DAY }),
      mk({ id: "s-a", evidence: "static", depth: 1, weight: 9 }),
      mk({ id: "t-a", evidence: "trace", depth: 2, weight: 3, lastFailedAt: NOW - DAY }),
    ];
    expect(order(tests)).toEqual(order(tests));
  });

  it("breaks an EXACT tie by id ascending (stable)", () => {
    // Two tests identical in every ranked signal → id decides, ascending.
    const z = mk({ id: "z", evidence: "trace", depth: 1, weight: 1, lastDurationMs: 1 });
    const a = mk({ id: "a", evidence: "trace", depth: 1, weight: 1, lastDurationMs: 1 });
    expect(order([z, a])).toEqual(["a", "z"]);
  });

  it("does NOT mutate the input array or its elements", () => {
    const tests = [
      mk({ id: "second", evidence: "static" }),
      mk({ id: "first", evidence: "trace" }),
    ];
    const snapshotIds = tests.map((t) => t.id);
    const snapshotFirst = { ...tests[0]! };
    prioritize(tests, { now: NOW });
    // Original order + element contents untouched.
    expect(tests.map((t) => t.id)).toEqual(snapshotIds);
    expect(tests[0]).toEqual(snapshotFirst);
  });

  it("exposes the within-partition score on each result", () => {
    const [only] = prioritize([mk({ id: "x", evidence: "trace", depth: 1, weight: 4 })], { now: NOW });
    // depth 1 → proximity 1 (×0.6); weight 4 → 4/8 = 0.5 intensity (×0.4); no recency.
    // score = 0.6*1 + 0.4*0.5 = 0.8
    expect(only!.score).toBeCloseTo(0.8, 10);
  });
});

describe("apfd — textbook value + the fail-fast win", () => {
  it("reproduces the hand-computed Rothermel value EXACTLY (n=5, fault at position 2)", () => {
    // ordering of 5 tests; the single fault is detected by the 2nd test.
    // APFD = 1 - (2)/(5*1) + 1/(2*5) = 1 - 0.4 + 0.1 = 0.7
    const ordering = ["t1", "t2", "t3", "t4", "t5"];
    const failing = new Set(["t2"]);
    expect(apfd(ordering, failing)).toBeCloseTo(0.7, 12);
  });

  it("a fault at position 1 scores higher than the same fault at position 5", () => {
    const ordering = ["t1", "t2", "t3", "t4", "t5"];
    const early = apfd(ordering, new Set(["t1"])); // 1 - 1/5 + 1/10 = 0.9
    const late = apfd(ordering, new Set(["t5"])); //  1 - 5/5 + 1/10 = 0.1
    expect(early).toBeCloseTo(0.9, 12);
    expect(late).toBeCloseTo(0.1, 12);
    expect(early).toBeGreaterThan(late);
  });

  it("multiple faults: averages the earliest-detecting positions (hand-checked)", () => {
    // n=4, faults at positions 1 and 3. APFD = 1 - (1+3)/(4*2) + 1/(2*4)
    //   = 1 - 4/8 + 1/8 = 1 - 0.5 + 0.125 = 0.625
    const ordering = ["a", "b", "c", "d"];
    expect(apfd(ordering, new Set(["a", "c"]))).toBeCloseTo(0.625, 12);
  });

  it("ignores a failing id that the ordering never runs (it can't be detected)", () => {
    // 'ghost' is failing but absent → m counts only 'a' (position 1).
    // APFD = 1 - 1/(3*1) + 1/(2*3) = 1 - 0.3333… + 0.1666… = 0.8333…
    const ordering = ["a", "b", "c"];
    expect(apfd(ordering, new Set(["a", "ghost"]))).toBeCloseTo(5 / 6, 12);
  });

  it("empty ordering → 0; no faults → 1 (defensive edge cases, never NaN)", () => {
    expect(apfd([], new Set(["x"]))).toBe(0);
    expect(apfd(["a", "b"], new Set())).toBe(1);
  });

  it("the prioritized order beats a deliberately-bad reverse order on APFD (the fail-fast win)", () => {
    // Construct a case whose ONLY failing test is the one the prioritizer ranks
    // FIRST (it's a trace, just-failed, direct, heavy) and a reverse-bad order
    // buries at the very end. Same set, opposite orderings → measure the delta.
    const tests = [
      mk({ id: "f-bug", evidence: "trace", depth: 1, weight: 50, lastFailedAt: NOW - 1 * DAY }),
      mk({ id: "g-green", evidence: "trace", depth: 3, weight: 5 }),
      mk({ id: "h-green", evidence: "static", depth: 2, weight: 5 }),
      mk({ id: "i-green", evidence: "static", depth: 4, weight: 5 }),
      mk({ id: "j-green", evidence: "static", depth: 6, weight: 5 }),
    ];
    const failing = new Set(["f-bug"]);

    const good = prioritize(tests, { now: NOW }).map((t) => t.id);
    const bad = [...good].reverse();

    const apfdGood = apfd(good, failing);
    const apfdBad = apfd(bad, failing);

    // The bug test is ranked first → APFD is maximal for a single fault (0.9).
    expect(good[0]).toBe("f-bug");
    expect(apfdGood).toBeCloseTo(0.9, 12); // 1 - 1/5 + 1/10
    expect(apfdBad).toBeCloseTo(0.1, 12); //  1 - 5/5 + 1/10
    expect(apfdGood).toBeGreaterThan(apfdBad);
  });
});
