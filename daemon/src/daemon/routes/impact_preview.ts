/**
 * Pre-edit blast-radius preview API (ROADMAP Tier 3 — `impact --preview`):
 *
 *   - `GET /api/impact/preview?id=<symbol>&depth=<N>` — RANKED, GROUPED-BY-WHY
 *     "what breaks if I change this symbol's contract".
 *
 * Mirrors the daemonless `hayven impact --preview` CLI: same {@link previewImpact}
 * engine, same JSON shape `{symbol, resolved, contract, directBreakers,
 * transitive, depth, capped, advisory}`. The id is resolved via the top FTS hit
 * when not found exactly (echoed in `resolved`). Read-only.
 *
 * Contract enrichment is best-effort: the route locates `hayven-native` if
 * present and passes the repo root so signatures can be extracted; when neither
 * is available `contract` is null and the graph classification is unchanged.
 *
 * Registered in server.ts BEFORE viewerRoutes (its `/*` catch-all must stay last).
 */
import { Elysia } from "elysia";

import { MAX_IMPACT_DEPTH } from "../../db/graph_walk.ts";
import { previewImpact } from "../../db/impact_preview.ts";
import { tryLocateNativeBinary } from "../../native/locate.ts";
import type { ServerDependencies } from "../server.ts";

export function impactPreviewRoutes(deps: ServerDependencies) {
  // Locate the native binary once at wiring time (best-effort). When absent the
  // preview still works — contract enrichment degrades to null.
  const binary =
    tryLocateNativeBinary({ repoRoot: deps.paths.repoRoot }) ?? undefined;

  return new Elysia().get("/api/impact/preview", ({ query, set }) => {
    const rawId = query["id"];
    if (typeof rawId !== "string" || rawId.length === 0) {
      set.status = 400;
      return { error: "missing or unknown `id`" };
    }
    const depthRaw = query["depth"];
    const requested = depthRaw == null ? MAX_IMPACT_DEPTH : Number(depthRaw);
    const maxDepth = Number.isNaN(requested) ? MAX_IMPACT_DEPTH : requested;

    const preview = previewImpact(deps.db, rawId, {
      repoRoot: deps.paths.repoRoot,
      binary,
      depth: maxDepth,
    });
    if (!preview) {
      set.status = 404;
      return { error: "missing or unknown `id`" };
    }
    return {
      symbol: preview.symbol,
      resolved: preview.resolved,
      contract: preview.contract,
      depth: preview.depth,
      capped: preview.capped,
      directBreakers: preview.directBreakers,
      transitive: preview.transitive,
      advisory: preview.advisory,
    };
  });
}
