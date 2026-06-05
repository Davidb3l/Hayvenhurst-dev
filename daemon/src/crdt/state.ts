// Shared CRDT state for the daemon. Owns the three in-memory CRDT states,
// the OpLog, the HlcGenerator, and the per-daemon writer ID. The HTTP
// routes (traces, claims) and the sync layer all reach for state through
// this single object — there is exactly one instance per daemon process,
// constructed at startup in `daemon/src/cli/daemon.ts`.

import { GsetState, type GsetOp } from "./gset.ts";
import {
  HlcGenerator,
  loadOrCreateWriterId,
  writerIdFromHex,
  type Hlc,
  type WriterId,
} from "./hlc.ts";
import { applyLww, makeLwwOp, type LwwOp, type LwwState } from "./lww.ts";
import { OpLog, type CrdtType } from "./oplog.ts";
import { OrSetState, type OrAddOp, type OrOp, type OrRemoveOp } from "./orset.ts";
import {
  gsetToWire,
  lwwToWire,
  orToWire,
  wireHlc,
  type WireOp,
} from "./wire.ts";

export interface CrdtStateOptions {
  /** Absolute path to `.hayven/crdt/`. */
  crdtRoot: string;
  /** Absolute path to `.hayven/config.json` — where the writer ID lives. */
  configFile: string;
  /** Inject a clock for tests. Returns Unix milliseconds. */
  now?: () => number;
  /** Skip hydrate-from-disk in tests where it would slow things down. */
  skipHydrate?: boolean;
}

/**
 * A batch of freshly-appended ops emitted by the local write path, tagged with
 * its CRDT type so a listener (live-sync WS, §15.3) can frame it without
 * re-deriving the type. The `ops` are the SAME wire ops just written to the
 * op log — already persisted, so a listener forwarding them is best-effort and
 * loss-tolerant (the Merkle path in §15.2 is the correctness backstop).
 */
export interface LocalOpsEvent {
  type: CrdtType;
  ops: WireOp[];
}

/** A subscriber to {@link CrdtState.onOps}. Must not throw — the emitter wraps
 *  each call so a misbehaving listener can't break the append path. */
export type LocalOpsListener = (event: LocalOpsEvent) => void;

export class CrdtState {
  readonly writer: WriterId;
  readonly clock: HlcGenerator;
  readonly oplog: OpLog;

  /** LWW-Register registry keyed by entity ID. */
  readonly lww = new Map<string, LwwState<string>>();
  readonly gset = new GsetState();
  readonly orset = new OrSetState();

  /**
   * Listeners notified AFTER a fresh local op is appended (segment + memory).
   * ADDITIVE hook for live-sync (§15.3): {@link observe}/{@link applyOr}/
   * {@link recordLww} fire this so connected WS peers get the op pushed in real
   * time. Deliberately NOT fired by {@link applyWireOpInMemory} — inbound peer
   * ops must not be re-broadcast (that would loop). The op-log-bucketing and
   * apply semantics are untouched; this is an observer on top of them.
   */
  private readonly opsListeners = new Set<LocalOpsListener>();

  constructor(opts: CrdtStateOptions) {
    this.writer = loadOrCreateWriterId(opts.configFile);
    this.clock = new HlcGenerator({ now: opts.now });
    this.oplog = new OpLog(opts.crdtRoot, { now: opts.now });
    if (!opts.skipHydrate) this.hydrate();
  }

  /** Replay every persisted op into the in-memory states. */
  hydrate(): { lww: number; gset: number; orset: number } {
    const counts = { lww: 0, gset: 0, orset: 0 };
    for (const wireOp of this.oplog.hydrate("gset")) {
      if (this.applyWireOpInMemory(wireOp)) counts.gset += 1;
    }
    for (const wireOp of this.oplog.hydrate("orset")) {
      if (this.applyWireOpInMemory(wireOp)) counts.orset += 1;
    }
    for (const wireOp of this.oplog.hydrate("lww")) {
      if (this.applyWireOpInMemory(wireOp)) counts.lww += 1;
    }
    return counts;
  }

  /**
   * Apply a single decoded wire op to the in-memory CRDT state (no disk
   * write — the bytes are already persisted by the caller, e.g. the sync
   * push path or hydrate). Returns true if applied, false if the op was
   * malformed and skipped. Never throws on bad input — a malicious peer
   * must not be able to crash the daemon by pushing a shape-invalid op.
   */
  applyWireOpInMemory(wireOp: WireOp): boolean {
    try {
      if (wireOp.kind === "gset_observe") {
        const op = wireOpToGset(wireOp);
        if (op === null) return false;
        this.gset.apply(op);
        this.clock.observe(op.hlc);
        return true;
      }
      if (wireOp.kind === "or_add" || wireOp.kind === "or_remove") {
        const op = wireOpToOr(wireOp);
        if (op === null) return false;
        this.orset.apply(op);
        this.clock.observe(op.hlc);
        return true;
      }
      if (wireOp.kind === "lww") {
        const hlc = wireHlc(wireOp.hlc);
        const op = {
          kind: "lww" as const,
          entityId: wireOp.entity_id,
          value: new TextDecoder().decode(new Uint8Array(wireOp.body)),
          contentHash: new Uint8Array(wireOp.content_hash),
          hlc,
          writer: new Uint8Array(wireOp.writer),
        };
        const prev = this.lww.get(op.entityId) ?? null;
        this.lww.set(op.entityId, applyLww(prev, op));
        this.clock.observe(hlc);
        return true;
      }
      return false;
    } catch {
      // Shape-invalid op from an untrusted peer — skip rather than crash.
      return false;
    }
  }

  /**
   * Subscribe to fresh local op appends (live-sync push source, §15.3).
   * Returns an unsubscribe function — the WS route calls it on disconnect.
   * ADDITIVE: does not alter any append/bucketing semantics.
   */
  onOps(listener: LocalOpsListener): () => void {
    this.opsListeners.add(listener);
    return () => {
      this.opsListeners.delete(listener);
    };
  }

  /** Notify subscribers of a freshly-appended op batch. Each listener is
   *  isolated: a throw never propagates into the write path. */
  private emitOps(type: CrdtType, ops: WireOp[]): void {
    if (this.opsListeners.size === 0) return;
    const event: LocalOpsEvent = { type, ops };
    for (const listener of this.opsListeners) {
      try {
        listener(event);
      } catch {
        // A live-sync listener fault must never break a local CRDT write.
      }
    }
  }

  /** Record a fresh G-Set observation: append to log + update in-memory. */
  observe(op: GsetOp): void {
    const wire = gsetToWire(op);
    this.oplog.appendOps("gset", [wire]);
    this.gset.apply(op);
    this.emitOps("gset", [wire]);
  }

  /** Record a fresh OR-Set op (add or remove). */
  applyOr(op: OrOp): void {
    const wire = orToWire(op);
    this.oplog.appendOps("orset", [wire]);
    this.orset.apply(op);
    this.emitOps("orset", [wire]);
  }

  /**
   * Record a fresh LWW-Register write for a code-entity node body (§12.1).
   * Mints an `LwwOp` (its content hash is computed from `value`), appends it
   * to the on-disk op log so it participates in Merkle sync, then folds it
   * into the in-memory registry. Mirrors {@link observe} / {@link applyOr}:
   * the op log is the source of truth on restart, and the §17.x write-through
   * pattern keeps any SQL read cache derived. Returns the resulting LWW state
   * (which may be the pre-existing one if `op` lost the §11.3 total order —
   * e.g. a stale clock — making this a no-op on the materialized value).
   */
  recordLww(args: { entityId: string; value: string; hlc?: Hlc }): LwwState<string> {
    const op: LwwOp<string> = makeLwwOp({
      entityId: args.entityId,
      value: args.value,
      hlc: args.hlc ?? this.tick(),
      writer: this.writer,
    });
    // Segment first, then memory (§14.4): a crash between the two re-reads the
    // segment on next start and converges.
    const wire = lwwToWire(op);
    this.oplog.appendOps("lww", [wire]);
    const prev = this.lww.get(op.entityId) ?? null;
    const next = applyLww(prev, op);
    this.lww.set(op.entityId, next);
    this.emitOps("lww", [wire]);
    return next;
  }

  /** Decode a §13 wire batch into wire ops via the op-log's bridge. Throws
   *  on malformed bytes — callers validate untrusted input with this before
   *  persisting. */
  decodeBatch(bytes: Uint8Array): WireOp[] {
    return this.oplog.decodeBatch(bytes);
  }

  /** Generate a fresh HLC tick. */
  tick(): Hlc {
    return this.clock.tick();
  }

  /** Force-flush every open op-log segment. Called on shutdown. */
  close(): void {
    this.oplog.close();
  }
}

// ─── Wire → logical converters used during hydrate ──────────────────────────

function wireOpToGset(w: WireOp): GsetOp | null {
  if (w.kind !== "gset_observe") return null;
  return {
    kind: "observe",
    src: w.src,
    dst: w.dst,
    tsBucket: w.ts_bucket,
    observed: w.observed,
    weight: w.weight,
    hlc: wireHlc(w.hlc),
    writer: new Uint8Array(w.writer),
  };
}

function wireOpToOr(w: WireOp): OrOp | null {
  if (w.kind === "or_add") {
    let payload: OrAddOp["payload"];
    try {
      const text = new TextDecoder().decode(new Uint8Array(w.payload_cbor));
      const parsed = JSON.parse(text);
      payload = {
        intent: String(parsed.intent ?? ""),
        scope: Array.isArray(parsed.scope) ? parsed.scope.map(String) : [],
        fingerprint: String(parsed.fingerprint ?? ""),
        createdMs: Number(parsed.createdMs ?? 0),
        ttlMs: Number(parsed.ttlMs ?? 0),
      };
    } catch {
      return null;
    }
    return {
      kind: "add",
      claimId: w.claim_id,
      agent: w.agent,
      payload,
      hlc: wireHlc(w.hlc),
      writer: new Uint8Array(w.writer),
    };
  }
  if (w.kind === "or_remove") {
    const tagBytes = new Uint8Array(w.observed_tags);
    const tags: string[] = [];
    for (let off = 0; off + 28 <= tagBytes.length; off += 28) {
      let s = "";
      for (let i = 0; i < 28; i++) {
        s += (tagBytes[off + i] as number).toString(16).padStart(2, "0");
      }
      tags.push(s);
    }
    const op: OrRemoveOp = {
      kind: "remove",
      claimId: w.claim_id,
      observedTags: tags,
      hlc: wireHlc(w.hlc),
      writer: new Uint8Array(w.writer),
    };
    return op;
  }
  return null;
}

// Re-export so callers don't need a second import for these.
export { writerIdFromHex };
export type { CrdtType };
