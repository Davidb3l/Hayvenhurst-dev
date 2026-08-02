// HTTP sync endpoints — ARCHITECTURE.md §15.2.
//
//   GET  /api/sync/merkle           → per-CRDT-type root hashes
//   POST /api/sync/leaves           → leaves per CRDT type (full or filtered)
//   POST /api/sync/batch            → raw segment bytes (range-able)
//   POST /api/sync/push             → caller appends a §13 batch to a segment
//
// Naming note: the PRD's older draft (§13.1) named these `merkle-root`,
// `diff`, `branch`. Week 6 nails them down to the §15.2 spec — that's what
// the Merkle-tree implementation in `crdt/merkle.ts` and the `hayven sync`
// CLI agree on.
import { Elysia } from "elysia";

import { computeMerkle, computeRoots, type SegmentLeaf } from "../../crdt/merkle.ts";
import {
  assertAcceptableSegmentDay,
  SegmentRejectedError,
  type CrdtType,
} from "../../crdt/oplog.ts";
import { CRDT_LIMITS } from "../../crdt/retention.ts";
import type { ServerDependencies } from "../server.ts";

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];

/**
 * Largest window `/api/sync/batch` will return in one response, regardless of
 * the caller's `max_bytes` (F1/F4). The endpoint is unauthenticated and local:
 * without a ceiling a peer asks for `max_bytes: 2**31` and we allocate and
 * serialize the entire segment in one go, which is the read-amplification hole
 * we just closed on the disk side. 8 MiB is 8x the default page.
 */
const MAX_BATCH_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Largest base64 `batch` field `/api/sync/push` will even look at (F4). Base64
 * inflates by 4/3, so this is the wire-side sibling of
 * `CRDT_LIMITS.maxPushBatchBytes`; checking it BEFORE `Buffer.from` means a
 * hostile body is rejected without materializing its decoded form too.
 */
const MAX_PUSH_BASE64_CHARS = Math.ceil((CRDT_LIMITS.maxPushBatchBytes * 4) / 3) + 4;

function isCrdtType(s: unknown): s is CrdtType {
  return typeof s === "string" && (s === "lww" || s === "gset" || s === "orset");
}

function isSafeSegmentName(s: string): boolean {
  // YYYY-MM-DD; defends against path traversal in the segment-bytes endpoint.
  // The shape regex alone (`^\d{4}-\d{2}-\d{2}$`) still rejects `..`, `/`, NUL
  // and absolute paths, but it ALSO accepted impossible calendar dates like
  // `9999-99-99`, `2026-13-40`, `0000-00-00` (BL-4). Require the parsed date to
  // round-trip through UTC so out-of-range months/days are rejected.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

export function syncRoutes(deps: ServerDependencies) {
  return new Elysia()
    .get("/api/sync/merkle", () => {
      return computeRoots(deps.crdt.oplog);
    })
    .post("/api/sync/leaves", ({ body, set }) => {
      const raw = body as { type?: unknown } | null;
      if (!raw || !isCrdtType(raw.type)) {
        set.status = 400;
        return { error: "body.type must be one of lww|gset|orset" };
      }
      const snap = computeMerkle(deps.crdt.oplog);
      const leaves: SegmentLeaf[] = snap.leaves[raw.type];
      return { type: raw.type, leaves };
    })
    .post("/api/sync/batch", ({ body, set }) => {
      const raw = body as { type?: unknown; path?: unknown; offset?: unknown; max_bytes?: unknown } | null;
      if (!raw || !isCrdtType(raw.type)) {
        set.status = 400;
        return { error: "body.type must be one of lww|gset|orset" };
      }
      if (typeof raw.path !== "string" || !isSafeSegmentName(raw.path)) {
        set.status = 400;
        return { error: "body.path must be a YYYY-MM-DD segment name" };
      }
      const offset = raw.offset === undefined ? 0 : Number(raw.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        set.status = 400;
        return { error: "body.offset must be a non-negative integer if present" };
      }
      const cap = raw.max_bytes === undefined ? 1024 * 1024 : Number(raw.max_bytes);
      if (!Number.isInteger(cap) || cap <= 0) {
        set.status = 400;
        return { error: "body.max_bytes must be a positive integer if present" };
      }

      // F1: read ONLY the requested window off disk. Reading the whole
      // segment and slicing turned a paginated pull of a large segment into
      // O(pages x segment_size) read I/O. The response is additionally
      // clamped to MAX_BATCH_RESPONSE_BYTES so `max_bytes` cannot be used to
      // demand an arbitrarily large allocation.
      const window = Math.min(cap, MAX_BATCH_RESPONSE_BYTES);
      const chunk = deps.crdt.oplog.readSegmentRange(raw.type, raw.path, offset, window);
      if (chunk === null) {
        set.status = 404;
        return { error: "segment not found", type: raw.type, path: raw.path };
      }
      set.headers["content-type"] = "application/octet-stream";
      set.headers["x-segment-size"] = String(chunk.size);
      set.headers["x-segment-eof"] =
        offset + chunk.bytes.length >= chunk.size ? "1" : "0";
      return chunk.bytes;
    })
    .post("/api/sync/push", ({ body, set }) => {
      const raw = body as { type?: unknown; path?: unknown; batch?: unknown } | null;
      if (!raw || !isCrdtType(raw.type)) {
        set.status = 400;
        return { error: "body.type must be one of lww|gset|orset" };
      }
      if (typeof raw.path !== "string" || !isSafeSegmentName(raw.path)) {
        set.status = 400;
        return { error: "body.path must be a YYYY-MM-DD segment name" };
      }
      // F4: `isSafeSegmentName` only proves the date is on the calendar, so
      // `9999-12-31` used to be a legal push target — and segments are never
      // pruned, so a peer with a broken clock could mint millions of segment
      // files that every later hydrate/diskUsage/Merkle pass walks. Check the
      // acceptance window HERE, before we spend a subprocess decode on the
      // payload; `appendRawBatchToDate` re-checks it for every other caller.
      try {
        assertAcceptableSegmentDay(raw.path, Date.now());
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message, type: raw.type, path: raw.path };
      }
      if (typeof raw.batch !== "string" || raw.batch.length === 0) {
        set.status = 400;
        return { error: "body.batch must be a base64-encoded §13 batch" };
      }
      // F4: bound the payload BEFORE decoding it. `appendRawBatchToDate`
      // enforces the same cap on the decoded bytes as a backstop for every
      // caller (the WS path included); this check just avoids materializing a
      // huge decode first.
      if (raw.batch.length > MAX_PUSH_BASE64_CHARS) {
        set.status = 413;
        return {
          error:
            `body.batch is ${raw.batch.length} base64 chars, over the ` +
            `${MAX_PUSH_BASE64_CHARS}-char cap (${CRDT_LIMITS.maxPushBatchBytes} decoded bytes)`,
        };
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(raw.batch, "base64"));
      } catch {
        set.status = 400;
        return { error: "body.batch is not valid base64" };
      }

      // Decode FIRST (untrusted bytes) so a malformed batch is rejected before
      // we persist it. Only well-formed batches reach disk + in-memory state.
      let decoded;
      try {
        decoded = deps.crdt.decodeBatch(bytes);
      } catch (err) {
        set.status = 400;
        return { error: `batch failed to decode: ${(err as Error).message}` };
      }

      // Persist to the peer-specified day (NOT today) so cross-day sync
      // converges, then apply each op in-memory. Both are guarded — a bad op
      // is skipped, never crashes the handler.
      //
      // F4: the append can now REFUSE (segment day outside the acceptance
      // window, batch too large, segment at its hard cap). Translate that into
      // a 413 the peer can see, rather than an opaque 500 — and crucially do
      // NOT apply the ops in memory, so refused bytes leave no trace.
      try {
        deps.crdt.oplog.appendRawBatchToDate(raw.type, raw.path, bytes);
      } catch (err) {
        if (err instanceof SegmentRejectedError) {
          // Same mapping as the pre-checks above: a bad segment DAY is a 400
          // (the request names something we will not accept), a too-large
          // payload or segment is a 413.
          set.status = err.kind === "day" ? 400 : 413;
          return { error: err.message, type: raw.type, path: raw.path };
        }
        throw err;
      }
      let applied = 0;
      for (const op of decoded) {
        if (deps.crdt.applyWireOpInMemory(op)) applied += 1;
      }
      return { ok: true, applied, total: decoded.length, persisted: true };
    });
}

