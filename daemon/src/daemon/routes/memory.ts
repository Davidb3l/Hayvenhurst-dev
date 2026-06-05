/**
 * Fleet-memory API (Phase 0.0.4) — durable, cross-agent/cross-session knowledge
 * keyed to the code graph. Distinct from `claims` (which coordinate concurrent
 * EDITS, short-lived + blocking): fleet memory is shared KNOWLEDGE — a decision,
 * a dead-end, a gotcha, a note — that a LATER agent inherits instead of
 * re-deriving. Read-mostly; never blocks work.
 *
 *   - `GET  /api/memory?node=<id>`        — live notes about a node (own + scope).
 *   - `GET  /api/memory?q=<term>`         — live notes matching a substring.
 *   - `GET  /api/memory?kind=<k>&limit=N` — all live notes (optionally by kind).
 *   - `POST /api/memory`                  — record a note (body = RecordMemory*).
 *   - `DELETE /api/memory/:id`            — forget a note.
 *
 * Reads exclude expired notes; the `now` used for expiry is the server clock.
 * Registered in server.ts BEFORE viewerRoutes (its `/*` catch-all stays last).
 */
import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";
import {
  forgetMemory,
  listMemory,
  memoryForNode,
  recordMemory,
  searchMemory,
  type MemoryKind,
} from "../../db/fleet_memory.ts";

const KINDS: ReadonlySet<string> = new Set(["decision", "deadend", "gotcha", "note"]);

export function memoryRoutes(deps: ServerDependencies) {
  return new Elysia()
    .get("/api/memory", ({ query }) => {
      const now = Date.now();
      const node = typeof query["node"] === "string" ? query["node"] : undefined;
      const term = typeof query["q"] === "string" ? query["q"] : undefined;
      const kindRaw = typeof query["kind"] === "string" ? query["kind"] : undefined;
      const kind = kindRaw && KINDS.has(kindRaw) ? (kindRaw as MemoryKind) : undefined;
      const limit = query["limit"] != null ? Number(query["limit"]) : undefined;
      const lim = limit !== undefined && Number.isFinite(limit) ? limit : undefined;

      let notes;
      if (node) notes = memoryForNode(deps.db, node, now);
      else if (term) notes = searchMemory(deps.db, term, now, lim);
      else notes = listMemory(deps.db, now, { kind, limit: lim });
      return { count: notes.length, notes };
    })
    .post("/api/memory", ({ body, set }) => {
      const b = (body ?? {}) as Record<string, unknown>;
      if (typeof b["note"] !== "string" || !b["note"]) {
        set.status = 400;
        return { error: "`note` is required" };
      }
      const kindRaw = typeof b["kind"] === "string" ? b["kind"] : "note";
      if (!KINDS.has(kindRaw)) {
        set.status = 400;
        return { error: `\`kind\` must be one of: ${[...KINDS].join(", ")}` };
      }
      const scope = Array.isArray(b["scope"])
        ? (b["scope"] as unknown[]).filter((s): s is string => typeof s === "string")
        : undefined;
      const note = recordMemory(deps.db, {
        agent: typeof b["agent"] === "string" ? b["agent"] : undefined,
        nodeId: typeof b["nodeId"] === "string" ? b["nodeId"] : null,
        kind: kindRaw as MemoryKind,
        note: b["note"],
        scope,
        ttl: typeof b["ttl"] === "number" ? b["ttl"] : null,
        now: Date.now(),
      });
      set.status = 201;
      return note;
    })
    .delete("/api/memory/:id", ({ params, set }) => {
      const removed = forgetMemory(deps.db, params.id);
      if (!removed) {
        set.status = 404;
        return { error: "no such note" };
      }
      return { ok: true, id: params.id };
    });
}
