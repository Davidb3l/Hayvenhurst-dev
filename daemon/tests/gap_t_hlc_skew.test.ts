// LANE T / T4 — `HlcGenerator.observe` bounds the skew it will absorb.
//
// The failure being prevented: `observe` adopted max(local, remote) with no
// bound, so ONE op carrying a year-2099 `wall_ms` moved this replica's logical
// clock there PERMANENTLY. That is not a cosmetic problem —
// `OpLog.appendOps` buckets a segment by the op's HLC day, so every subsequent
// LOCAL write lands in a year-2099 segment; every honest peer refuses those on
// receipt (`MAX_FUTURE_SEGMENT_DAYS`), and the replica silently loses the
// ability to propagate any of its own work. It also survived restart, because
// `hydrate()` replays the poisoning op off our own disk and re-adopts it.
//
// The convergence argument is asserted, not asserted-by-comment: `observe`
// touches only the MINTING clock, never a stored op key, so refusing an
// adoption cannot change any merge outcome. See the two "convergence" cases.
import { describe, expect, it } from "bun:test";

import {
  compareHlc,
  HlcGenerator,
  MAX_OBSERVED_SKEW_MS,
  type Hlc,
} from "../src/crdt/hlc.ts";
import { applyLww, makeLwwOp } from "../src/crdt/lww.ts";
import { MAX_FUTURE_SEGMENT_DAYS } from "../src/crdt/oplog.ts";

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0);
const DAY_MS = 86_400_000;

function gen(opts: { warn?: (l: string) => void; maxSkewMs?: number } = {}): HlcGenerator {
  return new HlcGenerator({ now: () => NOW, warn: opts.warn ?? (() => {}), ...opts });
}

describe("T4 — observe() refuses an out-of-window remote HLC", () => {
  it("does NOT adopt a far-future remote clock", () => {
    const g = gen();
    const before = g.peek();
    expect(g.observe({ wallMs: Date.UTC(2099, 0, 1), counter: 0 })).toBe(false);
    expect(g.peek()).toEqual(before);
    expect(g.rejectedSkewCount()).toBe(1);

    // The next local tick is a NORMAL timestamp, not a year-2099 one.
    const t = g.tick();
    expect(t.wallMs).toBe(NOW);
  });

  it("still adopts a remote clock inside the window (the old behaviour is intact)", () => {
    const g = gen();
    const remote: Hlc = { wallMs: NOW + 60_000, counter: 5 };
    expect(g.observe(remote)).toBe(true);
    expect(g.peek()).toEqual(remote);
    const next = g.tick();
    expect(compareHlc(remote, next)).toBe(-1); // strictly dominates what we saw
    expect(g.rejectedSkewCount()).toBe(0);
  });

  it("accepts exactly at the bound and refuses one millisecond past it", () => {
    const at = gen();
    expect(at.observe({ wallMs: NOW + MAX_OBSERVED_SKEW_MS, counter: 0 })).toBe(true);
    const past = gen();
    expect(past.observe({ wallMs: NOW + MAX_OBSERVED_SKEW_MS + 1, counter: 0 })).toBe(false);
  });

  it("cannot be RATCHETED forward by repeated observations", () => {
    // The bound is measured against the physical clock, never against
    // `this.last` — otherwise a peer walks us forward one window per call,
    // which is the same poisoning with extra steps.
    const g = gen();
    for (let i = 1; i <= 20; i++) {
      g.observe({ wallMs: NOW + i * MAX_OBSERVED_SKEW_MS, counter: 0 });
    }
    expect(g.peek().wallMs).toBeLessThanOrEqual(NOW + MAX_OBSERVED_SKEW_MS);
    expect(g.tick().wallMs).toBeLessThanOrEqual(NOW + MAX_OBSERVED_SKEW_MS);
  });

  it("the accepted skew stays well inside the segment-day window peers enforce", () => {
    // This is the property that makes the bound SAFE: a clock pushed all the
    // way to the bound must still mint segment days every peer accepts,
    // otherwise the fix would recreate the very unsyncable-writes failure it
    // exists to prevent. Six days of margin.
    expect(MAX_OBSERVED_SKEW_MS).toBeLessThan(MAX_FUTURE_SEGMENT_DAYS * DAY_MS);
    const g = gen();
    g.observe({ wallMs: NOW + MAX_OBSERVED_SKEW_MS, counter: 0 });
    const minted = g.tick();
    expect(minted.wallMs).toBeLessThan(NOW + MAX_FUTURE_SEGMENT_DAYS * DAY_MS);
  });

  it("shouts ONCE, then only counts — a skew storm cannot become unbounded output", () => {
    const lines: string[] = [];
    const g = gen({ warn: (l) => lines.push(l) });
    for (let i = 0; i < 5_000; i++) {
      g.observe({ wallMs: Date.UTC(2099, 0, 1) + i, counter: 0 });
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("crdt_clock:remote_skew_rejected");
    expect(lines[0]).toContain("max_skew_ms=");
    expect(g.rejectedSkewCount()).toBe(5_000);
  });

  it("a replay of our OWN past ops (hydrate) is unaffected", () => {
    // hydrate() re-observes every persisted op on daemon start. Those are in
    // the PAST, so the bound must be invisible to them.
    const g = gen();
    for (const ago of [7 * DAY_MS, DAY_MS, 60_000, 1]) {
      expect(g.observe({ wallMs: NOW - ago, counter: 0 })).toBe(true);
    }
    expect(g.rejectedSkewCount()).toBe(0);
  });
});

describe("T4 — convergence is untouched by the bound", () => {
  it("refusing an observation does not change an LWW merge outcome", () => {
    // The merge compares each op's OWN embedded [hlc][writer] key. `observe`
    // only influences the clock used to MINT new ops, so a replica that
    // refused an adoption and one that never saw the op materialize the same
    // winner from the same op set.
    const writerA = new Uint8Array(16).fill(1);
    const writerB = new Uint8Array(16).fill(2);
    const early = makeLwwOp({ entityId: "n", value: "early", hlc: { wallMs: NOW, counter: 0 }, writer: writerA });
    const future = makeLwwOp({
      entityId: "n",
      value: "future",
      hlc: { wallMs: Date.UTC(2099, 0, 1), counter: 0 },
      writer: writerB,
    });

    const forward = applyLww(applyLww(null, early), future);
    const backward = applyLww(applyLww(null, future), early);
    expect(forward.value).toBe(backward.value);
    expect(forward.value).toBe("future"); // deterministic, order-independent
  });

  it("two replicas with the same op set agree regardless of their generators", () => {
    const writerA = new Uint8Array(16).fill(1);
    const writerB = new Uint8Array(16).fill(2);
    const ops = [
      makeLwwOp({ entityId: "n", value: "a", hlc: { wallMs: NOW, counter: 1 }, writer: writerA }),
      makeLwwOp({ entityId: "n", value: "b", hlc: { wallMs: NOW, counter: 2 }, writer: writerB }),
      makeLwwOp({ entityId: "n", value: "c", hlc: { wallMs: Date.UTC(2099, 0, 1), counter: 0 }, writer: writerA }),
    ];

    // Replica 1 has a generator that refuses the skewed op; replica 2's is
    // never consulted at all. Same op set in different orders → same state.
    const g1 = gen();
    let s1 = null as ReturnType<typeof applyLww> | null;
    for (const op of ops) {
      g1.observe(op.hlc);
      s1 = applyLww(s1, op);
    }
    let s2 = null as ReturnType<typeof applyLww> | null;
    for (const op of [...ops].reverse()) s2 = applyLww(s2, op);

    expect(g1.rejectedSkewCount()).toBe(1); // it really did refuse one
    expect(s1?.value).toBe(s2?.value);
    expect(s1?.hlc).toEqual(s2?.hlc as Hlc);
  });
});
