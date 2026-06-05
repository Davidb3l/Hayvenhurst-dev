/**
 * Node read + CRDT-aware body-write API.
 *
 * - `GET /api/nodes/:id`        — parsed metadata + raw markdown body.
 * - `PUT /api/nodes/:id/body`   — BL-12: update a node's markdown body through
 *   the LWW-Register CRDT (§12.1). Mirrors the claims/trace write-through
 *   pattern (`tracesRoutes` → `crdt.observe`, `claimsRoutes` → `crdt.applyOr`):
 *   it mints an `LwwOp`, persists it via the op log (so the body participates
 *   in Merkle sync + `/api/sync/push` apply), updates the markdown
 *   source-of-truth under `.hayven/nodes/`, and refreshes the denormalized SQL
 *   `summary` read cache. The CRDT op log is the source of truth on restart.
 */
import { Elysia } from "elysia";

import {
  renderNodeMarkdown,
  writeNodeMarkdown,
  type NodeNeighbors,
} from "../../graph/nodeWriter.ts";
import { edgeRowToGraphEdge, nodeRowToGraphNode } from "../../db/queries.ts";
import type { ServerDependencies } from "../server.ts";

interface RawBody {
  body?: unknown;
}

/**
 * Max accepted markdown body size for `PUT /api/nodes/:id/body`, in bytes.
 *
 * Node summaries/bodies are human-authored prose — a few paragraphs at most.
 * 1 MiB is ~250k words of UTF-8: orders of magnitude past any legitimate node
 * body, while still cheap to hold in memory and write through the LWW op log.
 * Anything larger is almost certainly a mistake or abuse, so we reject it with
 * a 413 rather than persisting it into the CRDT/Merkle sync path (where every
 * peer would then have to replicate the oversized op). Measured against the
 * UTF-8 byte length of the `body` string, not the raw HTTP envelope.
 */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/**
 * Decode an entity id that arrived on the URL path.
 *
 * Entity ids routinely contain `/` (e.g. `conflict/oracle`,
 * `graph/interact/attachPanZoom`). Two ways an id reaches a route:
 *
 *  - URL-encoded into a single `:id` segment (`conflict%2Foracle`) — the
 *    viewer/CLI path; one `decodeURIComponent` recovers the raw id.
 *  - Raw, with literal slashes, captured by a `/*` wildcard tail
 *    (`conflict/oracle`) — the natural shape an agent or human types into
 *    curl. The segments arrive already split, so the wildcard hands us the
 *    rejoined tail; any `%xx` inside it (mixed encodings) still decodes.
 *
 * `decodeURIComponent` can throw on malformed `%` sequences — fall back to
 * the raw value so a weird-but-real id still gets a resolution attempt
 * (and an honest 404) instead of a 500.
 */
function decodePathId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Helpful 404 body for an unresolved id. Entity ids contain `/`; the bare
 * "node not found" used to mislead agents into thinking the graph API was
 * dead when they'd merely hit the wrong (split) path shape.
 */
function notFound(set: { status?: number | string }, id: string) {
  set.status = 404;
  return {
    error: "node not found",
    id,
    hint:
      "entity ids may contain '/'; pass it raw on the path " +
      "(e.g. /api/nodes/conflict/oracle) or url-encoded " +
      "(/api/nodes/conflict%2Foracle)",
  };
}

export function nodesRoutes(deps: ServerDependencies) {
  const getNode = (id: string, set: { status?: number | string }) => {
    const row = deps.db.getNode(id);
    if (!row) {
      return notFound(set, id);
    }
    const node = nodeRowToGraphNode(row);
    const neighbors: NodeNeighbors = {
      callers: deps.db.incoming(id).map(edgeRowToGraphEdge),
      callees: deps.db.outgoing(id).map(edgeRowToGraphEdge),
    };
    return {
      node,
      neighbors,
      markdown: renderNodeMarkdown(node, neighbors),
    };
  };

  return new Elysia()
    // Single-segment / already-encoded ids land here (`conflict%2Foracle`,
    // or a slash-free id). Encoded slashes are recovered by decodePathId.
    .get("/api/nodes/:id", ({ params, set }) =>
      getNode(decodePathId(params.id), set),
    )
    // Raw slashed ids (`conflict/oracle`) arrive split across segments; the
    // wildcard rejoins them into `params["*"]` so the id stays intact. This
    // makes the raw-curl path work without the viewer's encodeURIComponent.
    .get("/api/nodes/*", ({ params, set }) =>
      getNode(decodePathId(params["*"]), set),
    )
    .put("/api/nodes/:id/body", ({ params, body, set }) => {
      const id = decodeURIComponent(params.id);
      const raw = body as RawBody | null;
      if (typeof raw !== "object" || raw === null || typeof raw.body !== "string") {
        set.status = 400;
        return { error: "`body` must be a string" };
      }
      const newBody = raw.body;

      // Reject oversized bodies before they enter the CRDT/Merkle sync path.
      // Cap is on the UTF-8 byte length so multi-byte content can't slip past.
      const bodyBytes = Buffer.byteLength(newBody, "utf8");
      if (bodyBytes > MAX_BODY_BYTES) {
        set.status = 413;
        return {
          error: `body too large: ${bodyBytes} bytes exceeds the ${MAX_BODY_BYTES}-byte limit`,
        };
      }

      const row = deps.db.getNode(id);
      if (!row) {
        set.status = 404;
        return { error: "node not found", id };
      }

      // (1) CRDT write-through: mint + persist an LwwOp keyed by the entity id.
      // The LWW total order (§11.3) decides the winner; a fresh local tick is
      // monotonically greater than anything previously seen, so the local write
      // always wins locally, but a higher-HLC op pushed from a peer would win.
      const state = deps.crdt.recordLww({ entityId: id, value: newBody });

      // (2) Markdown source-of-truth. `state.value` is the materialized winner
      // (always the just-written body locally), so the on-disk file reflects
      // exactly what the CRDT holds.
      const node = nodeRowToGraphNode(row);
      node.summary = state.value;
      node.last_modified_by = hex(deps.crdt.writer);
      const neighbors: NodeNeighbors = {
        callers: deps.db.incoming(id).map(edgeRowToGraphEdge),
        callees: deps.db.outgoing(id).map(edgeRowToGraphEdge),
      };
      const path = writeNodeMarkdown(deps.paths.nodesDir, node, neighbors);

      // (3) Denormalized SQL read cache (CRDT is source of truth). upsertNode's
      // ON CONFLICT keeps the row; summary is overwritten with the winner.
      deps.db.upsertNode(node);

      set.status = 200;
      return {
        ok: true,
        id,
        body: state.value,
        path,
      };
    });
}

/** Lowercase-hex a writer id for the markdown `last_modified_by` field. */
function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] as number).toString(16).padStart(2, "0");
  }
  return s;
}
