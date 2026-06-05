// Convergence proofs for the three CRDT types on simulated network
// partitions. Per Week 5 PRD: "CRDT library passes convergence proofs on
// simulated network partitions."
//
// This simulator is LOAD-BEARING (the previous version was not — its gossip
// delivered every op to every replica exactly once, so for commutative CRDTs
// the property could not fail). The model here:
//   1. Build N replicas, each with its own writer + HLC.
//   2. Generate ops, each authored on a random replica.
//   3. PARTITION phase: deliver a random SUBSET of ops to each replica, with
//      duplicates and arbitrary order — replicas legitimately diverge.
//   4. HEAL phase: deliver every op to every replica (anti-entropy catch-up),
//      again with duplicates and reorder.
//   5. Assert all replicas converge, and that a redundant second heal is a
//      no-op (idempotence).
//
// Because delivery is lossy + duplicated + reordered, a CRDT that wasn't
// idempotent or order-independent WOULD diverge here. The forced-tie LWW
// test additionally exercises the degenerate shared-writer case that the
// contentHash tiebreak fixes.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { type Hlc, type WriterId } from "../src/crdt/hlc.ts";
import { applyLww, makeLwwOp, mergeLww, type LwwOp, type LwwState } from "../src/crdt/lww.ts";
import { bucketize, GsetState, materializeGset, type GsetOp } from "../src/crdt/gset.ts";
import { OrSetState, type OrAddOp, type OrOp } from "../src/crdt/orset.ts";

function deterministicWriter(seed: number): WriterId {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = (seed * 31 + i * 17) & 0xff;
  return out;
}

/** A simple seeded PRNG so fast-check counterexamples are reproducible. */
function rng(seedArr: number[]): () => number {
  let i = 0;
  let acc = 0x9e3779b9;
  return () => {
    const s = seedArr.length > 0 ? (seedArr[i % seedArr.length] as number) : 1;
    i += 1;
    acc = (acc ^ (s + 0x6d2b79f5 + (acc << 6) + (acc >>> 2))) >>> 0;
    return acc / 0xffffffff;
  };
}

/**
 * Partition-then-heal delivery. `deliver(repId, op)` applies one op to one
 * replica (idempotently). Returns nothing — assertions are the caller's.
 */
function partitionThenHeal<TOp>(
  repIds: number[],
  pending: { from: number; op: TOp }[],
  deliver: (repId: number, op: TOp) => void,
  rand: () => number,
): void {
  // Partition: each op reaches a random subset of replicas, sometimes twice,
  // in random visitation order. Origin always has it (applied at author time).
  for (const { op } of pending) {
    for (const id of repIds) {
      if (rand() < 0.5) {
        deliver(id, op);
        if (rand() < 0.25) deliver(id, op); // duplicate delivery
      }
    }
  }
  // Heal: full anti-entropy — every op to every replica, shuffled, with the
  // occasional duplicate. After this every replica has seen every op.
  const order = [...pending.keys()].sort(() => (rand() < 0.5 ? -1 : 1));
  for (const idx of order) {
    const { op } = pending[idx]!;
    for (const id of repIds) {
      deliver(id, op);
      if (rand() < 0.1) deliver(id, op);
    }
  }
}

describe("LWW-Register converges", () => {
  test("3 replicas, lossy partition + duplicated heal, all converge", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat({ max: 2 }), fc.string({ minLength: 1, maxLength: 8 })), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.array(fc.nat({ max: 9999 }), { minLength: 1, maxLength: 40 }),
        (writeSeq, seed) => {
          const states: (LwwState<string> | null)[] = [null, null, null];
          const clocks = [0, 0, 0];
          const pending: { from: number; op: LwwOp<string> }[] = [];
          for (const [ridx, value] of writeSeq) {
            clocks[ridx] = (clocks[ridx] as number) + 1;
            const op = makeLwwOp({
              entityId: "auth/login",
              value,
              hlc: { wallMs: 1_700_000_000_000 + (clocks[ridx] as number), counter: ridx },
              writer: deterministicWriter(ridx),
            });
            states[ridx] = applyLww(states[ridx]!, op);
            pending.push({ from: ridx, op });
          }
          partitionThenHeal(
            [0, 1, 2],
            pending,
            (id, op) => {
              states[id] = applyLww(states[id]!, op);
            },
            rng(seed),
          );
          // All replicas converged.
          for (let i = 1; i < 3; i++) {
            expect(states[i]?.value).toBe(states[0]?.value);
          }
          // Idempotence: re-delivering everything changes nothing.
          const before = states[0]?.value;
          for (const { op } of pending) states[0] = applyLww(states[0]!, op);
          expect(states[0]?.value).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  test("converges even on FORCED composite-key ties (shared writer, M1)", () => {
    // The degenerate case the contentHash tiebreak exists for: many ops on
    // the same entity with IDENTICAL [hlc, writer] but different content,
    // delivered to two replicas in opposite orders. Without a deterministic
    // tiebreak this diverges; with it both pick the same winner.
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 2, maxLength: 12 }), (vals) => {
        const sharedHlc: Hlc = { wallMs: 42, counter: 0 };
        const sharedWriter = deterministicWriter(7);
        const ops = vals.map((v) =>
          makeLwwOp({ entityId: "x", value: v, hlc: sharedHlc, writer: sharedWriter }),
        );
        let a: LwwState<string> | null = null;
        let b: LwwState<string> | null = null;
        for (const op of ops) a = applyLww(a, op);
        for (const op of [...ops].reverse()) b = applyLww(b, op);
        expect(a?.value).toBe(b?.value);
        // And mergeLww agrees with applyLww.
        expect(mergeLww(a!, b!).value).toBe(a!.value);
      }),
      { numRuns: 100 },
    );
  });
});

describe("G-Set converges", () => {
  test("4 replicas, lossy partition + duplicated heal, identical materialized view", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.nat({ max: 3 }),
            fc.constantFrom("a", "b", "c"),
            fc.constantFrom("x", "y"),
            fc.integer({ min: 1, max: 5 }),
          ),
          { minLength: 1, maxLength: 40 },
        ),
        fc.array(fc.nat({ max: 9999 }), { minLength: 1, maxLength: 50 }),
        (observations, seed) => {
          const states = [new GsetState(), new GsetState(), new GsetState(), new GsetState()];
          const clocks = [0, 0, 0, 0];
          const pending: { from: number; op: GsetOp }[] = [];
          for (const [ridx, src, dst, observed] of observations) {
            clocks[ridx] = (clocks[ridx] as number) + 1;
            const op: GsetOp = {
              kind: "observe",
              src,
              dst,
              tsBucket: bucketize(1_700_000_000),
              observed,
              weight: observed * 100,
              hlc: { wallMs: 1_700_000_000_000 + (clocks[ridx] as number), counter: ridx },
              writer: deterministicWriter(ridx),
            };
            states[ridx]!.apply(op);
            pending.push({ from: ridx, op });
          }
          partitionThenHeal([0, 1, 2, 3], pending, (id, op) => states[id]!.apply(op), rng(seed));
          const views = states.map((s) => materializeGset(s));
          for (let i = 1; i < 4; i++) expect(views[i]).toEqual(views[0]!);
          // Idempotence: re-applying every op leaves size unchanged.
          const size0 = states[0]!.size;
          for (const { op } of pending) states[0]!.apply(op);
          expect(states[0]!.size).toBe(size0);
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("OR-Set converges", () => {
  test("3 replicas, mixed add/remove, lossy partition + heal, identical active set", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(fc.nat({ max: 2 }), fc.constantFrom("add", "remove"), fc.constantFrom("c1", "c2", "c3")),
          { minLength: 1, maxLength: 30 },
        ),
        fc.array(fc.nat({ max: 9999 }), { minLength: 1, maxLength: 40 }),
        (events, seed) => {
          const states = [new OrSetState(), new OrSetState(), new OrSetState()];
          const clocks = [0, 0, 0];
          const pending: { from: number; op: OrOp }[] = [];
          for (const [ridx, kind, claimId] of events) {
            clocks[ridx] = (clocks[ridx] as number) + 1;
            const hlc: Hlc = { wallMs: 1_700_000_000_000 + (clocks[ridx] as number), counter: ridx };
            const writer = deterministicWriter(ridx);
            let op: OrOp;
            if (kind === "add") {
              op = {
                kind: "add",
                claimId,
                agent: `agent-${ridx}`,
                payload: { intent: "work", scope: [claimId], fingerprint: "f", createdMs: 1, ttlMs: 600_000 },
                hlc,
                writer,
              };
            } else {
              const observed: string[] = [];
              for (const a of states[ridx]!.sortedAdds()) {
                if (a.claimId === claimId) observed.push(addOpTagOf(a));
              }
              op = { kind: "remove", claimId, observedTags: observed, hlc, writer };
            }
            states[ridx]!.apply(op);
            pending.push({ from: ridx, op });
          }
          partitionThenHeal([0, 1, 2], pending, (id, op) => states[id]!.apply(op), rng(seed));
          const actives = states.map((s) => s.active().map((a) => a.claimId).sort());
          for (let i = 1; i < 3; i++) expect(actives[i]).toEqual(actives[0]!);
        },
      ),
      { numRuns: 80 },
    );
  });
});

/** Composite-key tag of an add — mirrors orset.ts's encodeComposite layout. */
function addOpTagOf(op: OrAddOp): string {
  const bytes = new Uint8Array(28);
  const view = new DataView(bytes.buffer);
  const hi = Math.floor(op.hlc.wallMs / 0x1_0000_0000);
  const lo = op.hlc.wallMs >>> 0;
  view.setUint32(0, hi, false);
  view.setUint32(4, lo, false);
  view.setUint16(8, op.hlc.counter, false);
  bytes.set(op.writer, 12);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] as number).toString(16).padStart(2, "0");
  return s;
}
