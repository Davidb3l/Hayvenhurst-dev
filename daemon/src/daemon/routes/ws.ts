/**
 * Live-sync WebSocket endpoint — ARCHITECTURE.md §15.3.
 *
 * `/ws/sync` is the long-lived, push-based sibling of `POST /api/sync/push`.
 * When both peers are online they stream CRDT ops in real time instead of
 * waiting for the next Merkle anti-entropy pass. It is a LATENCY optimization,
 * not a correctness mechanism: every op pushed here is already on disk in the
 * sender's segment (we forward exactly the wire ops `CrdtState` just appended),
 * and the §15.2 Merkle path remains the catch-up/heal backstop. Nothing in the
 * HTTP sync layer changes.
 *
 * Frames (§15.3):
 *   text   : {"type":"hello","writer_id":"<32-hex>",
 *             "versions":{"lww":<n>,"gset":<n>,"orset":<n>}}
 *   binary : <1-byte type: 0x10 lww | 0x20 gset | 0x30 orset> <§13 envelope>
 *
 * The §13 envelope is the exact `encode_batch` output (see `crdt/wire.ts`), so
 * the receiver decodes it through the SAME bridge the HTTP push path uses and
 * rejects malformed/untrusted bytes the same way (never panics). Ops are
 * commutative + idempotent (§12), so a re-delivered op is a no-op.
 */
import { Elysia } from "elysia";

import type { CrdtType } from "../../crdt/oplog.ts";
import { utcDate } from "../../crdt/oplog.ts";
import { writerIdToHex } from "../../crdt/hlc.ts";
import { computeRoots } from "../../crdt/merkle.ts";
import { openWireBridge, type WireBridge, type WireOp } from "../../crdt/wire.ts";
import type { ServerDependencies } from "../server.ts";

// §15.3 binary frame type discriminator (first byte). Distinct high nibbles so
// a frame type is unambiguous and never collides with a §13 compression marker
// (which lives INSIDE the envelope, after this byte).
const TYPE_BYTE: Record<CrdtType, number> = { lww: 0x10, gset: 0x20, orset: 0x30 };
const BYTE_TYPE: Record<number, CrdtType> = { 0x10: "lww", 0x20: "gset", 0x30: "orset" };

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];

/** Hello envelope shape — exactly the §15.3 text frame, plus an additive
 *  `roots` field (the §15.2 Merkle roots) so a peer can immediately tell if
 *  it is behind without a follow-up `GET /api/sync/merkle`. The §15.3-required
 *  keys (`type`, `writer_id`, `versions`) are unchanged. */
interface HelloEnvelope {
  type: "hello";
  writer_id: string;
  versions: Record<CrdtType, number>;
  roots: Record<CrdtType, string>;
}

/**
 * Per-type op count = the size of the segment's order-independent op-key set
 * (the same identity the Merkle leaves hash, §15.1). A peer compares this
 * against its own to learn roughly how far behind it is; `roots` gives the
 * exact same/different signal. Decodes each segment once on connect only.
 */
function opVersions(deps: ServerDependencies): Record<CrdtType, number> {
  const out = {} as Record<CrdtType, number>;
  for (const type of TYPES) {
    let n = 0;
    for (const day of deps.crdt.oplog.listSegmentDays(type)) {
      n += deps.crdt.oplog.segmentCompositeKeys(type, day).length;
    }
    out[type] = n;
  }
  return out;
}

/** True when `raw` is a binary payload (Buffer / ArrayBuffer / TypedArray) —
 *  i.e. a §15.3 op frame, not a control text frame. */
function isBinary(raw: unknown): boolean {
  return raw instanceof ArrayBuffer || ArrayBuffer.isView(raw);
}

/** Coerce whatever Bun hands `message` (Buffer | ArrayBuffer | TypedArray)
 *  into bytes. A non-binary inbound frame yields null (caller rejects it). */
function asBytes(raw: unknown): Uint8Array | null {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    const v = raw as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

// One wire bridge for the whole WS module (mirrors one-bridge-per-process in
// the op log). Opening it lazily keeps daemon startup free of a subprocess
// probe when no peer ever connects.
let sharedBridge: WireBridge | null = null;
function bridge(): WireBridge {
  if (sharedBridge === null) sharedBridge = openWireBridge();
  return sharedBridge;
}

/** Frame a freshly-appended op batch as a §15.3 binary frame:
 *  `<type byte><§13 envelope>`. Returns a `Buffer` (not a bare `Uint8Array`):
 *  Elysia's `ws.send` only routes a value as a *binary* frame when
 *  `Buffer.isBuffer(data)` is true — a plain Uint8Array gets `JSON.stringify`d
 *  into a TEXT frame, which would corrupt the wire envelope. `Buffer.from`
 *  shares the underlying memory, so this is a view, not a copy. */
function frameOps(type: CrdtType, ops: WireOp[]): Buffer {
  const envelope = bridge().encode(ops);
  const out = Buffer.allocUnsafe(1 + envelope.length);
  out[0] = TYPE_BYTE[type];
  out.set(envelope, 1);
  return out;
}

/** Result of applying one inbound binary frame. */
interface ApplyResult {
  applied: number;
  total: number;
}

/**
 * Inbound apply — the WS counterpart of `POST /api/sync/push`, reusing the
 * SAME validate→persist→fold path so a streamed op is as safe as a pushed one:
 *   1. Strip the §15.3 type byte; reject an unknown/missing discriminator.
 *   2. Decode the §13 envelope through `crdt.decodeBatch` (the op-log bridge).
 *      Malformed/untrusted bytes throw here and are rejected — never persisted,
 *      never crash the handler.
 *   3. Persist the raw envelope to the op's HLC-day segment (NOT today) via
 *      `appendRawBatchToDate`, exactly like push, so cross-day live ops land in
 *      the same-named segment on every replica (§14.1) and Merkle converges.
 *   4. Fold each op into memory via `applyWireOpInMemory` (per-op guarded,
 *      idempotent — a re-delivered op is a commutative no-op, §12).
 * Throws with a clear message on a bad frame; the caller turns that into an
 * `error` text frame rather than tearing the socket down.
 */
function applyInboundFrame(deps: ServerDependencies, bytes: Uint8Array): ApplyResult {
  if (bytes.length < 1) throw new Error("empty frame");
  const type = BYTE_TYPE[bytes[0] as number];
  if (type === undefined) {
    throw new Error(`unknown frame type byte 0x${(bytes[0] as number).toString(16)}`);
  }
  const envelope = bytes.subarray(1);
  if (envelope.length === 0) throw new Error("frame carries no §13 envelope");

  // Decode FIRST (untrusted bytes) — a malformed batch is rejected before we
  // touch disk or memory. Mirrors sync.ts's "decode then persist" ordering.
  let decoded: WireOp[];
  try {
    decoded = deps.crdt.decodeBatch(new Uint8Array(envelope));
  } catch (err) {
    throw new Error(`batch failed to decode: ${(err as Error).message}`);
  }
  if (decoded.length === 0) return { applied: 0, total: 0 };

  // A §13 batch is bucketed by its FIRST op's HLC day (op-log §14.1 contract),
  // so the whole frame belongs to one segment day. Write the raw envelope to
  // THAT day — never today — so live + Merkle paths agree on segment naming.
  const day = utcDate(decoded[0]!.hlc.wall_ms);
  deps.crdt.oplog.appendRawBatchToDate(type, day, new Uint8Array(envelope));

  let applied = 0;
  for (const op of decoded) {
    if (deps.crdt.applyWireOpInMemory(op)) applied += 1;
  }
  return { applied, total: decoded.length };
}

/**
 * Resolve which project's deps a ws connection is pinned to, from the upgrade
 * URL's `?project=<alias>` (or the `x-hayven-project` header, for parity with
 * the HTTP surface). MUST be called at open() time and the result reused for
 * the connection's whole life: on a multi-project daemon `deps` is the
 * AsyncLocalStorage-backed facade, whose per-request context does not reach
 * Bun's ws message/close callbacks — reading it there silently resolves to
 * the PRIMARY project and streams a peer's ops into the wrong op-log.
 *
 * `ok:false` = an explicit selector the daemon does not serve. onRequest
 * already refuses such upgrades with a 404 (strictRoute covers /ws/sync);
 * this is the in-handler backstop for callers that wire wsRoutes directly.
 */
function connectionProject(
  deps: ServerDependencies,
  ws: { data?: unknown },
): { ok: true; deps: ServerDependencies; alias: string | null } | { ok: false; error: string } {
  const data = ws.data as
    | {
        query?: Record<string, string | undefined>;
        headers?: Record<string, string | undefined>;
      }
    | undefined;
  // `||` (not `??`): an EMPTY `?project=` must fall through to the header,
  // matching the HTTP path's `if (!alias)` precedence in server.ts.
  const raw = data?.query?.["project"] || data?.headers?.["x-hayven-project"];
  const alias = typeof raw === "string" && raw.length > 0 ? raw : null;
  // Single-project app (no resolver): the passed deps ARE the project. Alias
  // is reported as null — there is no project set to be evicted from.
  if (deps.resolveProject === undefined) return { ok: true, deps, alias: null };
  const resolved = deps.resolveProject(alias);
  if (resolved === undefined) {
    return {
      ok: false,
      error: `daemon does not serve a project with alias '${alias ?? ""}'`,
    };
  }
  return { ok: true, deps: resolved, alias };
}

/** Minimal socket surface the hot-remove sweep needs to evict a peer. */
interface WsHandle {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

/** Everything a live connection is pinned to: the project's deps, the alias it
 *  was selected by (`null` = primary/single-project), and the socket handle so
 *  a hot-remove sweep can close it. */
interface PinnedConnection {
  deps: ServerDependencies;
  alias: string | null;
  ws: WsHandle;
}

export function wsRoutes(deps: ServerDependencies) {
  // Per-connection state, keyed by the socket's stable id (Elysia gives each
  // ws an `id`): the onOps unsubscribe handle, and the project pin taken at
  // open() that message()/the hot-remove sweep read.
  const unsubscribers = new Map<string, () => void>();
  const connections = new Map<string, PinnedConnection>();

  /** Idempotent teardown of a connection's book-keeping — shared by close()
   *  and the hot-remove sweep (whichever runs first; the other no-ops). */
  const dropConnection = (id: string): void => {
    const unsubscribe = unsubscribers.get(id);
    if (unsubscribe) {
      unsubscribe();
      unsubscribers.delete(id);
    }
    connections.delete(id);
  };

  // Hot-remove eviction: when the served project set changes, close every
  // socket whose pinned project no longer resolves — by IDENTITY, so a
  // remove-then-re-add under the same alias (a NEW runtime; the pinned deps'
  // CrdtState/Db are closed) also evicts. Without this, a peer pinned to a
  // removed project lingers forever getting per-frame errors and its ops are
  // silently dropped. The notification fires AFTER the removal's grace window
  // + runtime shutdown, so in-flight frames drain into the still-live op-log
  // first. Primary-pinned (`alias: null`) sockets are never evicted — the
  // primary cannot be removed. The subscription lives for the daemon's life.
  const resolveProject = deps.resolveProject;
  if (deps.subscribeProjects !== undefined && resolveProject !== undefined) {
    deps.subscribeProjects(() => {
      for (const [id, conn] of [...connections]) {
        if (conn.alias === null) continue;
        if (resolveProject(conn.alias) === conn.deps) continue;
        deps.logger.info("ws/sync evicting peer of removed project", {
          id,
          alias: conn.alias,
        });
        try {
          conn.ws.send(
            JSON.stringify({
              type: "error",
              error: `project '${conn.alias}' was removed from this daemon`,
            }),
          );
          conn.ws.close(4004, "project removed");
        } catch (err) {
          deps.logger.error("ws/sync eviction failed", {
            id,
            message: (err as Error).message,
          });
        }
        // Drop book-keeping NOW rather than waiting for the close event, so a
        // socket that never fires one (already torn down) cannot leak its pin.
        dropConnection(id);
      }
    });
  }

  return new Elysia().ws("/ws/sync", {
    open(ws) {
      // 0. Pin the connection to its project FIRST — everything below (hello
      //    identity, outbound subscription, inbound applies) must speak for
      //    the selected project, never the facade's request-scoped default.
      const pinned = connectionProject(deps, ws);
      if (!pinned.ok) {
        deps.logger.info("ws/sync refused connection", { id: ws.id, error: pinned.error });
        ws.send(JSON.stringify({ type: "error", error: pinned.error }));
        ws.close(4004, "unknown project");
        return;
      }
      const conn = pinned.deps;
      connections.set(ws.id, { deps: conn, alias: pinned.alias, ws });
      deps.logger.info("ws/sync peer connected", { id: ws.id });

      // 1. Hello: identity + state vector + Merkle roots (§15.3).
      const hello: HelloEnvelope = {
        type: "hello",
        writer_id: writerIdToHex(conn.crdt.writer),
        versions: opVersions(conn),
        roots: computeRootsSafe(conn),
      };
      ws.send(JSON.stringify(hello));

      // 2. Outbound push: forward every fresh LOCAL op append to this peer as a
      //    §15.3 binary frame. `onOps` only fires on local writes (observe /
      //    applyOr / recordLww), never on inbound peer ops, so there is no
      //    re-broadcast loop. Best-effort: a send fault is logged, not fatal.
      const unsubscribe = conn.crdt.onOps(({ type, ops }) => {
        try {
          ws.send(frameOps(type, ops));
        } catch (err) {
          deps.logger.error("ws/sync push failed", {
            id: ws.id,
            message: (err as Error).message,
          });
        }
      });
      unsubscribers.set(ws.id, unsubscribe);
    },

    message(ws, raw) {
      // The deps this connection was pinned to at open(). EVERY accepted
      // connection has an entry (single-project included), so a missing pin
      // means open() refused this socket (unknown project) — or the hot-remove
      // sweep evicted it — and a frame raced the close. Refuse it rather than
      // fall back to the facade, whose request-scoped getters would resolve to
      // the PRIMARY project here.
      const pin = connections.get(ws.id);
      if (pin === undefined) {
        ws.send(JSON.stringify({ type: "error", error: "connection is not pinned to a project" }));
        return;
      }
      const conn = pin.deps;
      // 3. Inbound apply. Binary frames carry ops; text frames carry control
      //    messages (ping, or a peer's own hello). NB: Elysia auto-parses an
      //    incoming JSON text frame into an OBJECT before this handler runs, so
      //    a control frame arrives as a string OR a parsed object, never as raw
      //    JSON text — `handleTextFrame` accepts both.
      if (typeof raw === "string" || (raw !== null && !isBinary(raw))) {
        handleTextFrame(ws, raw);
        return;
      }
      const bytes = asBytes(raw);
      if (bytes === null) {
        ws.send(JSON.stringify({ type: "error", error: "unrecognized frame encoding" }));
        return;
      }
      try {
        const { applied, total } = applyInboundFrame(conn, bytes);
        // A lightweight ack is handy for tests + flow visibility; harmless to a
        // peer that ignores unknown text frames.
        ws.send(JSON.stringify({ type: "ack", applied, total }));
      } catch (err) {
        deps.logger.info("ws/sync rejected inbound frame", { message: (err as Error).message });
        ws.send(JSON.stringify({ type: "error", error: (err as Error).message }));
      }
    },

    close(ws) {
      deps.logger.info("ws/sync peer disconnected", { id: ws.id });
      // 4. Cleanup: detach the op listener so a dead socket isn't fed forever,
      //    and drop the connection's project pin. No-op if the hot-remove
      //    sweep already tore this connection down.
      dropConnection(ws.id);
    },
  });
}

/** Heartbeat: a peer may send a `{"type":"ping"}` text frame; we pong. Mirrors
 *  the watcher's NDJSON heartbeat philosophy (keep a long-lived stream warm
 *  without protocol-level complexity). Any other text frame (incl. the peer's
 *  own hello) is informational and ignored. Accepts either a raw string or the
 *  object Elysia already parsed a JSON text frame into. */
function handleTextFrame(ws: { send: (data: string) => void }, raw: unknown): void {
  let parsed: { type?: unknown };
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // not JSON — ignore
    }
  } else if (raw !== null && typeof raw === "object") {
    parsed = raw as { type?: unknown };
  } else {
    return;
  }
  if (parsed.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
}

/** Merkle roots for the hello envelope; never throws (a fresh daemon with no
 *  segments still produces well-defined empty roots). This is the same call
 *  the HTTP `GET /api/sync/merkle` handler makes. */
function computeRootsSafe(deps: ServerDependencies): Record<CrdtType, string> {
  try {
    return computeRoots(deps.crdt.oplog);
  } catch {
    return { lww: "", gset: "", orset: "" };
  }
}
