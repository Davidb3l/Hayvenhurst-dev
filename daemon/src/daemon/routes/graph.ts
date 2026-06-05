/**
 * Edges-backed graph-enumeration API (ROADMAP Tier 1.2 + Tier 3):
 *
 *   - `GET /api/importers?id=<module>`            — EXHAUSTIVE incoming `import` edges.
 *   - `GET /api/refs?id=<symbol>`                 — EXHAUSTIVE callers ∪ importers.
 *   - `GET /api/impact?id=<symbol>&depth=<N>`     — TRANSITIVE blast radius (BFS).
 *
 * All three accept a node id; if it isn't found exactly, the id is resolved via
 * the top FTS hit and the chosen id is echoed in the response `resolved` field
 * (the CLI prints that to STDERR; over HTTP we surface it in the body). These
 * mirror the daemonless CLI commands — same helpers, same completeness
 * guarantee (never a ranked top-N). All read-only.
 *
 * Registered in server.ts BEFORE viewerRoutes (its `/*` catch-all must stay
 * last).
 */
import { Elysia } from "elysia";

import {
  impactOf,
  importersOf,
  MAX_IMPACT_DEPTH,
  refsSummary,
  resolveNodeId,
  sitesOf,
} from "../../db/graph_walk.ts";
import type { ServerDependencies } from "../server.ts";

export function graphRoutes(deps: ServerDependencies) {
  /** Shared id-or-400 + resolve-via-FTS-or-404 preamble. Returns the resolved
   *  id (+ whether it was fuzzy-resolved) or null after setting `set.status`. */
  const resolve = (
    rawId: unknown,
    set: { status?: number | string },
  ): { id: string; resolved: boolean } | null => {
    if (typeof rawId !== "string" || rawId.length === 0) {
      set.status = 400;
      return null;
    }
    const r = resolveNodeId(deps.db, rawId);
    if (!r) {
      set.status = 404;
      return null;
    }
    return r;
  };

  return new Elysia()
    .get("/api/importers", ({ query, set }) => {
      const r = resolve(query["id"], set);
      if (!r) return { error: "missing or unknown `id`" };
      const edges = importersOf(deps.db, r.id);
      const importSites = edges.reduce((sum, e) => sum + e.weight, 0);
      return {
        module: r.id,
        resolved: r.resolved ? r.id : null,
        count: edges.length,
        // Sum of import-edge weights (import occurrences); rarely > count.
        importSites,
        importers: edges.map((e) => ({ id: e.src, kind: e.kind, weight: e.weight })),
      };
    })
    .get("/api/refs", ({ query, set }) => {
      const r = resolve(query["id"], set);
      if (!r) return { error: "missing or unknown `id`" };
      const { refs, callerCount, importerCount, callSites, importSites } =
        refsSummary(deps.db, r.id);
      // `?sites=1` / `&sites=true`: include line-precise call sites. Default (no
      // param) stays byte-identical — the `sites` key is omitted entirely.
      const sitesParam = query["sites"];
      const wantSites = sitesParam === "1" || sitesParam === "true";
      const sites = wantSites ? sitesOf(deps.db, r.id) : [];
      return {
        symbol: r.id,
        resolved: r.resolved ? r.id : null,
        count: refs.length,
        // Refactor aggregates (additive): `callerCount` = distinct caller
        // entities; `callSites` = SUM of caller weights = total textual call
        // occurrences a signature change must touch. Per-edge `weight` unchanged.
        callerCount,
        importerCount,
        callSites,
        importSites,
        callers: refs
          .filter((x) => x.via === "call")
          .map((x) => ({ id: x.id, kind: x.kind, weight: x.weight })),
        importers: refs
          .filter((x) => x.via === "import")
          .map((x) => ({ id: x.id, kind: x.kind, weight: x.weight })),
        // ADDITIVE: only present when `?sites=1`/`&sites=true`, so the default
        // response shape is unchanged. Line-precise `{file,line,col,caller}`.
        ...(wantSites
          ? {
              sites: sites.map((s) => ({
                file: s.file,
                line: s.line,
                col: s.col,
                caller: s.caller,
              })),
            }
          : {}),
      };
    })
    .get("/api/impact", ({ query, set }) => {
      const r = resolve(query["id"], set);
      if (!r) return { error: "missing or unknown `id`" };
      const depthRaw = query["depth"];
      const requested = depthRaw == null ? MAX_IMPACT_DEPTH : Number(depthRaw);
      const maxDepth = Number.isNaN(requested) ? MAX_IMPACT_DEPTH : requested;
      const result = impactOf(deps.db, r.id, maxDepth);
      const maxHitDepth = result.hits.reduce((m, h) => Math.max(m, h.depth), 0);
      return {
        symbol: r.id,
        resolved: r.resolved ? r.id : null,
        depth: result.depth,
        capped: result.capped,
        count: result.hits.length,
        max_depth_reached: maxHitDepth,
        hits: result.hits,
      };
    });
}
