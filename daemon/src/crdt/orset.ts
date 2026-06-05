// OR-Set CRDT for the claims board. See ARCHITECTURE.md §12.3.
//
// Standard tag-based semantics: each `add` carries a unique 28-byte tag
// `[hlc][writer]`. A `remove` un-shadows only the tags it has observed.
// Concurrent add + remove resolves in favor of the add — the canonical OR-Set
// guarantee called out in PRD §6.3.
import {
  compareComposite,
  encodeComposite,
  type Hlc,
  type WriterId,
} from "./hlc.ts";

export type Tag = string; // 56-char lowercase hex of `[hlc][writer]`.

export interface ClaimPayload {
  readonly intent: string;
  readonly scope: readonly string[];
  readonly fingerprint: string;
  readonly createdMs: number;
  readonly ttlMs: number;
}

export interface OrAddOp {
  readonly kind: "add";
  readonly claimId: string;
  readonly agent: string;
  readonly payload: ClaimPayload;
  readonly hlc: Hlc;
  readonly writer: WriterId;
}

export interface OrRemoveOp {
  readonly kind: "remove";
  readonly claimId: string;
  /** Tags this remove has observed. Other tags survive the remove. */
  readonly observedTags: readonly Tag[];
  readonly hlc: Hlc;
  readonly writer: WriterId;
}

export type OrOp = OrAddOp | OrRemoveOp;

function tagOf(hlc: Hlc, writer: WriterId): Tag {
  const bytes = encodeComposite(hlc, writer);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return s;
}

export function addOpTag(op: OrAddOp): Tag {
  return tagOf(op.hlc, op.writer);
}

interface AddRecord {
  op: OrAddOp;
  tag: Tag;
}

/** OR-Set state, keyed by `claimId`. */
export class OrSetState {
  private readonly adds = new Map<string, AddRecord[]>();
  private readonly removed = new Set<Tag>();

  apply(op: OrOp): void {
    if (op.kind === "add") this.applyAdd(op);
    else this.applyRemove(op);
  }

  private applyAdd(op: OrAddOp): void {
    const tag = addOpTag(op);
    const list = this.adds.get(op.claimId) ?? [];
    if (!list.some((r) => r.tag === tag)) {
      list.push({ op, tag });
      this.adds.set(op.claimId, list);
    }
  }

  private applyRemove(op: OrRemoveOp): void {
    for (const t of op.observedTags) this.removed.add(t);
  }

  /** Merge another state into this one. Idempotent. */
  merge(other: OrSetState): void {
    for (const [, list] of other.adds) {
      for (const r of list) this.applyAdd(r.op);
    }
    for (const t of other.removed) this.removed.add(t);
  }

  /**
   * Currently-active claims (any add whose tag is not in `removed`).
   *
   * When `nowMs` is provided, claims whose TTL has elapsed
   * (`payload.ttlMs <= nowMs`) are ALSO excluded. This is load-bearing for the
   * claim board: blocking decisions (scope-overlap 409 / adjacency oracle) must
   * NOT be gated by a claim that has expired, or a leaked/abandoned claim (e.g.
   * an agent that crashed or never released) deadlocks its scope FOREVER — the
   * `active()`-ignores-TTL bug that turned a contended scope into a 54-minute
   * spin under real concurrency. Omitting `nowMs` keeps the pure OR-Set view
   * (used for display / id lookup), so this is backward-compatible.
   */
  active(nowMs?: number): OrAddOp[] {
    const out: OrAddOp[] = [];
    for (const list of this.adds.values()) {
      const live = list.filter(
        (r) =>
          !this.removed.has(r.tag) &&
          (nowMs === undefined || r.op.payload.ttlMs > nowMs),
      );
      if (live.length === 0) continue;
      // Among multiple concurrent adds for the same claimId, expose the
      // winner by composite-key order so two replicas in the same state
      // surface the same claim object. Stable per spec.
      live.sort((a, b) =>
        compareComposite(a.op.hlc, a.op.writer, b.op.hlc, b.op.writer),
      );
      out.push((live[live.length - 1] as AddRecord).op);
    }
    out.sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
    return out;
  }

  /** Snapshot copy. */
  clone(): OrSetState {
    const out = new OrSetState();
    for (const list of this.adds.values()) {
      for (const r of list) out.applyAdd(r.op);
    }
    for (const t of this.removed) out.removed.add(t);
    return out;
  }

  /** All add records, in deterministic composite-key order. Used by encoders. */
  *sortedAdds(): IterableIterator<OrAddOp> {
    const all: OrAddOp[] = [];
    for (const list of this.adds.values()) for (const r of list) all.push(r.op);
    all.sort((a, b) => compareComposite(a.hlc, a.writer, b.hlc, b.writer));
    yield* all;
  }

  /** Set of removed tags in deterministic order. Used by encoders. */
  removedTags(): Tag[] {
    return [...this.removed].sort();
  }
}

/**
 * Build a remove op that targets every add tag currently visible for
 * `claimId`. This is the "release" path the daemon calls when an agent
 * intentionally drops a claim.
 */
export function makeRemoveOpFor(
  state: OrSetState,
  claimId: string,
  hlc: Hlc,
  writer: WriterId,
): OrRemoveOp {
  const observed: Tag[] = [];
  for (const add of state.sortedAdds()) {
    if (add.claimId === claimId) observed.push(addOpTag(add));
  }
  return { kind: "remove", claimId, observedTags: observed, hlc, writer };
}
