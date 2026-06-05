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
import type { CrdtType } from "../../crdt/oplog.ts";
import type { ServerDependencies } from "../server.ts";

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];

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

      const all = deps.crdt.oplog.readSegmentBytes(raw.type, raw.path);
      if (all === null) {
        set.status = 404;
        return { error: "segment not found", type: raw.type, path: raw.path };
      }
      const size = all.length;
      set.headers["content-type"] = "application/octet-stream";
      set.headers["x-segment-size"] = String(size);
      if (offset >= size) {
        set.headers["x-segment-eof"] = "1";
        return new Uint8Array(0);
      }
      const end = Math.min(offset + cap, size);
      set.headers["x-segment-eof"] = end >= size ? "1" : "0";
      return all.subarray(offset, end);
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
      if (typeof raw.batch !== "string" || raw.batch.length === 0) {
        set.status = 400;
        return { error: "body.batch must be a base64-encoded §13 batch" };
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
      deps.crdt.oplog.appendRawBatchToDate(raw.type, raw.path, bytes);
      let applied = 0;
      for (const op of decoded) {
        if (deps.crdt.applyWireOpInMemory(op)) applied += 1;
      }
      return { ok: true, applied, total: decoded.length, persisted: true };
    });
}

