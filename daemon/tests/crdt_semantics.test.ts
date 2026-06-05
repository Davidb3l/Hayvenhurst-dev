// Per-type unit tests for the three CRDTs. Convergence proofs live next door
// in crdt_convergence.test.ts; this file pins down the individual semantics.
import { describe, expect, test } from "bun:test";

import { generateWriterId, type Hlc } from "../src/crdt/hlc.ts";
import {
  applyLww,
  lwwConflict,
  makeLwwOp,
  mergeLww,
  verifyLwwOp,
} from "../src/crdt/lww.ts";
import {
  bucketize,
  GsetState,
  materializeGset,
  TS_BUCKET_SECONDS,
  type GsetOp,
} from "../src/crdt/gset.ts";
import {
  addOpTag,
  makeRemoveOpFor,
  OrSetState,
  type OrAddOp,
} from "../src/crdt/orset.ts";

const W1 = new Uint8Array(16).fill(0x01);
const W2 = new Uint8Array(16).fill(0x02);
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

describe("LWW-Register", () => {
  test("higher HLC wins", () => {
    const a = makeLwwOp({ entityId: "auth/login", value: "v1", hlc: H(1), writer: W1 });
    const b = makeLwwOp({ entityId: "auth/login", value: "v2", hlc: H(2), writer: W1 });
    const state = applyLww(applyLww(null, a), b);
    expect(state.value).toBe("v2");
  });

  test("same HLC: writer ID breaks the tie", () => {
    const a = makeLwwOp({ entityId: "x", value: "from-w1", hlc: H(5), writer: W1 });
    const b = makeLwwOp({ entityId: "x", value: "from-w2", hlc: H(5), writer: W2 });
    expect(mergeLww(applyLww(null, a), applyLww(null, b)).value).toBe("from-w2");
  });

  test("merge is commutative", () => {
    const a = makeLwwOp({ entityId: "x", value: "A", hlc: H(1), writer: W1 });
    const b = makeLwwOp({ entityId: "x", value: "B", hlc: H(2), writer: W2 });
    const ab = mergeLww(applyLww(null, a), applyLww(null, b));
    const ba = mergeLww(applyLww(null, b), applyLww(null, a));
    expect(ab.value).toBe(ba.value);
  });

  test("merge stays commutative on a TRUE composite-key tie (M1)", () => {
    // Same HLC AND same writer (the degenerate writer-id-collision case) but
    // different content. The old code picked the first argument, so
    // merge(a,b) !== merge(b,a) — silent divergence. The contentHash
    // tiebreak makes it deterministic regardless of order.
    const a = makeLwwOp({ entityId: "x", value: "machine-1-body", hlc: H(5), writer: W1 });
    const b = makeLwwOp({ entityId: "x", value: "machine-2-body", hlc: H(5), writer: W1 });
    const sa = applyLww(null, a);
    const sb = applyLww(null, b);
    expect(mergeLww(sa, sb).value).toBe(mergeLww(sb, sa).value);
    // applyLww must agree with mergeLww regardless of arrival order too.
    expect(applyLww(sa, b).value).toBe(applyLww(sb, a).value);
  });

  test("verifyLwwOp catches a tampered body", () => {
    const op = makeLwwOp({ entityId: "x", value: "original", hlc: H(1), writer: W1 });
    expect(verifyLwwOp(op)).toBe(true);
    const tampered = { ...op, value: "tampered" };
    expect(verifyLwwOp(tampered)).toBe(false);
  });

  test("lwwConflict requires same rank AND different content", () => {
    const a = makeLwwOp({ entityId: "x", value: "p", hlc: H(1), writer: W1 });
    const b = makeLwwOp({ entityId: "x", value: "q", hlc: H(2), writer: W1 });
    expect(lwwConflict(a, b)).toBe(false);
    // Forge two ops at the same rank with different content.
    const forge1 = makeLwwOp({ entityId: "x", value: "alpha", hlc: H(1), writer: W1 });
    const forge2 = makeLwwOp({ entityId: "x", value: "beta", hlc: H(1), writer: W1 });
    expect(lwwConflict(forge1, forge2)).toBe(true);
  });
});

describe("G-Set", () => {
  function obs(args: Partial<GsetOp> & { hlc: Hlc; writer: Uint8Array }): GsetOp {
    return {
      kind: "observe",
      src: "a",
      dst: "b",
      tsBucket: bucketize(1_700_000_000),
      observed: 1,
      weight: 100,
      ...args,
    };
  }

  test("bucketize rounds down to bucket boundary", () => {
    // 60-second buckets; pick numbers we can verify by hand.
    expect(bucketize(120)).toBe(120);
    expect(bucketize(179)).toBe(120);
    expect(bucketize(180)).toBe(180);
    expect(TS_BUCKET_SECONDS).toBe(60);
  });

  test("apply is idempotent", () => {
    const s = new GsetState();
    const op = obs({ hlc: H(1), writer: W1 });
    s.apply(op);
    s.apply(op);
    expect(s.size).toBe(1);
  });

  test("merge unions disjoint replicas", () => {
    const a = new GsetState();
    const b = new GsetState();
    a.apply(obs({ hlc: H(1), writer: W1 }));
    b.apply(obs({ hlc: H(1), writer: W2 }));
    const added = a.merge(b);
    expect(added).toBe(1);
    expect(a.size).toBe(2);
  });

  test("partition: same (src,dst,bucket) by two replicas survives both", () => {
    // Q3 resolution: keep both observations, sum honestly.
    const a = new GsetState();
    const b = new GsetState();
    const bucket = bucketize(1_700_000_000);
    a.apply(obs({ hlc: H(10), writer: W1, observed: 3, weight: 300, tsBucket: bucket }));
    b.apply(obs({ hlc: H(10), writer: W2, observed: 5, weight: 500, tsBucket: bucket }));
    a.merge(b);
    const view = materializeGset(a);
    expect(view).toHaveLength(1);
    expect(view[0]!.observed).toBe(8);
    expect(view[0]!.weight).toBe(800);
    expect(view[0]!.observers).toBe(2);
  });
});

describe("OR-Set", () => {
  function addOp(args: { claimId: string; hlc: Hlc; writer: Uint8Array; intent?: string }): OrAddOp {
    return {
      kind: "add",
      claimId: args.claimId,
      agent: "agent-1",
      payload: {
        intent: args.intent ?? "refactor",
        scope: ["auth/login"],
        fingerprint: "f",
        createdMs: 1,
        ttlMs: 600_000,
      },
      hlc: args.hlc,
      writer: args.writer,
    };
  }

  test("add then remove: claim disappears", () => {
    const s = new OrSetState();
    const a = addOp({ claimId: "c1", hlc: H(1), writer: W1 });
    s.apply(a);
    s.apply(makeRemoveOpFor(s, "c1", H(2), W1));
    expect(s.active()).toHaveLength(0);
  });

  test("concurrent add + remove favours the add", () => {
    // Two replicas. R1 adds claim c1 at HLC 5. R2 has never seen the add,
    // and at HLC 6 issues a remove that observes ZERO tags. After merge
    // the add survives — this is the OR-Set guarantee.
    const r1 = new OrSetState();
    const r2 = new OrSetState();
    const a = addOp({ claimId: "c1", hlc: H(5), writer: W1 });
    r1.apply(a);
    r2.apply({ kind: "remove", claimId: "c1", observedTags: [], hlc: H(6), writer: W2 });
    r1.merge(r2);
    expect(r1.active()).toHaveLength(1);
    expect((r1.active()[0] as OrAddOp).claimId).toBe("c1");
  });

  test("remove with the right tag drops the add even out of order", () => {
    const r1 = new OrSetState();
    const r2 = new OrSetState();
    const a = addOp({ claimId: "c1", hlc: H(5), writer: W1 });
    r1.apply(a);
    const tag = addOpTag(a);
    // R2 separately learned the tag and issues a remove that observes it.
    r2.apply({ kind: "remove", claimId: "c1", observedTags: [tag], hlc: H(7), writer: W2 });
    r1.merge(r2);
    expect(r1.active()).toHaveLength(0);
  });

  test("two concurrent adds for the same claimId both survive until removed", () => {
    const s = new OrSetState();
    const a1 = addOp({ claimId: "c1", hlc: H(1), writer: W1, intent: "refactor-A" });
    const a2 = addOp({ claimId: "c1", hlc: H(1), writer: W2, intent: "refactor-B" });
    s.apply(a1);
    s.apply(a2);
    // active() exposes a single winner by composite-key tiebreak so the
    // viewer never shows duplicated claim IDs.
    expect(s.active()).toHaveLength(1);
  });
});
