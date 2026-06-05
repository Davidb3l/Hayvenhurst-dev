// LWW-Register CRDT for code-entity node bodies. See ARCHITECTURE.md §12.1.
//
// State is an opaque payload plus a 28-byte total-order key. Merge picks the
// op whose key is greater; ties on the key are mathematically impossible by
// the §11 monotonicity rule (an HLC counter never repeats for a single writer
// and a writer ID is unique per replica).
import { blake3 } from "@noble/hashes/blake3";

import {
  compareComposite,
  type Hlc,
  type WriterId,
} from "./hlc.ts";

export interface LwwOp<T> {
  readonly kind: "lww";
  readonly entityId: string;
  readonly value: T;
  readonly contentHash: Uint8Array;
  readonly hlc: Hlc;
  readonly writer: WriterId;
}

export interface LwwState<T> {
  readonly entityId: string;
  readonly value: T;
  readonly contentHash: Uint8Array;
  readonly hlc: Hlc;
  readonly writer: WriterId;
}

/** Serialize a value to bytes for hashing. Stable across runs. */
function bytesFor(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new TextEncoder().encode(JSON.stringify(value));
}

/** Build a well-formed `LwwOp`. The content hash is computed from `value`. */
export function makeLwwOp<T>(args: {
  entityId: string;
  value: T;
  hlc: Hlc;
  writer: WriterId;
}): LwwOp<T> {
  return {
    kind: "lww",
    entityId: args.entityId,
    value: args.value,
    contentHash: blake3(bytesFor(args.value)),
    hlc: args.hlc,
    writer: args.writer,
  };
}

/** True if `op.contentHash` matches `op.value`. The application layer should
 *  reject ops that fail this check before merging. */
export function verifyLwwOp<T>(op: LwwOp<T>): boolean {
  const expected = blake3(bytesFor(op.value));
  if (expected.length !== op.contentHash.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== op.contentHash[i]) return false;
  }
  return true;
}

/**
 * Total order over two LWW versions: composite key (HLC, then writer) first,
 * then `contentHash` byte order as a final tiebreak. The contentHash tiebreak
 * is what keeps merge commutative even on a *true* composite-key tie — which
 * §11 says is "impossible" for honestly-generated ops, but becomes reachable
 * if two replicas ever share a writer ID (e.g. a careless `.hayven/` copy).
 * Without it, `applyLww`/`mergeLww` would pick different winners depending on
 * argument order and the replicas would silently diverge forever.
 * Returns -1 | 0 | 1 (0 only when the content is also byte-identical).
 */
function compareVersion(
  ah: LwwState<unknown>["hlc"],
  aw: LwwState<unknown>["writer"],
  ac: Uint8Array,
  bh: LwwState<unknown>["hlc"],
  bw: LwwState<unknown>["writer"],
  bc: Uint8Array,
): -1 | 0 | 1 {
  const key = compareComposite(ah, aw, bh, bw);
  if (key !== 0) return key;
  return byteCompare(ac, bc);
}

function byteCompare(a: Uint8Array, b: Uint8Array): -1 | 0 | 1 {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return 0;
}

/** Apply an op to the current state (or null for a fresh entity). */
export function applyLww<T>(prev: LwwState<T> | null, op: LwwOp<T>): LwwState<T> {
  if (prev === null) return opToState(op);
  if (prev.entityId !== op.entityId) {
    throw new Error(
      `applyLww entity mismatch: state=${prev.entityId} op=${op.entityId}`,
    );
  }
  return compareVersion(op.hlc, op.writer, op.contentHash, prev.hlc, prev.writer, prev.contentHash) === 1
    ? opToState(op)
    : prev;
}

/** Commutative, associative, idempotent merge of two states. */
export function mergeLww<T>(a: LwwState<T>, b: LwwState<T>): LwwState<T> {
  if (a.entityId !== b.entityId) {
    throw new Error(`mergeLww entity mismatch: ${a.entityId} vs ${b.entityId}`);
  }
  return compareVersion(a.hlc, a.writer, a.contentHash, b.hlc, b.writer, b.contentHash) >= 0 ? a : b;
}

/**
 * True when two ops at the same total-order rank produce different content.
 * Mathematically the §11 rules prevent rank ties between independently-
 * generated ops, so a "true" return from this function means one of:
 *   - the test harness constructed an op with a forged writer/HLC,
 *   - a wire-format decoder produced a duplicate by mistake,
 *   - or two writers shared a writer ID (config tampering, treat as bug).
 * The application layer can use this as a sanity check on inbound batches.
 */
export function lwwConflict<T>(a: LwwOp<T>, b: LwwOp<T>): boolean {
  if (a.entityId !== b.entityId) return false;
  if (compareComposite(a.hlc, a.writer, b.hlc, b.writer) !== 0) return false;
  if (a.contentHash.length !== b.contentHash.length) return true;
  for (let i = 0; i < a.contentHash.length; i++) {
    if (a.contentHash[i] !== b.contentHash[i]) return true;
  }
  return false;
}

function opToState<T>(op: LwwOp<T>): LwwState<T> {
  return {
    entityId: op.entityId,
    value: op.value,
    contentHash: op.contentHash,
    hlc: op.hlc,
    writer: op.writer,
  };
}
