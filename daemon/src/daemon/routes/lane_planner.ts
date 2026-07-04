/**
 * GRAPH-COMPUTED disjoint-lane planner API:
 *
 *   - `GET /api/plan-lanes?files=a,b,c`     — plan lanes from changed files.
 *   - `GET /api/plan-lanes?symbols=x,y`     — plan lanes from symbol ids.
 *   - optional `&depth=<N>`                 — cap the blast-radius walk.
 *
 * Returns the same `LanePlan` the `hayven plan-lanes` CLI prints: lanes that are
 * pairwise disjoint in files AND symbols (safe to run concurrently) plus a human
 * `note`. `files` and `symbols` are comma-separated; pass either or both.
 * Read-only.
 *
 * Registered in server.ts BEFORE viewerRoutes (its `/*` catch-all must stay last).
 */
import { Elysia } from "elysia";

import { planLanes } from "../../db/lane_planner.ts";
import type { ServerDependencies } from "../server.ts";

/** Split a comma-separated query param into a trimmed, non-empty list. */
function csv(v: unknown): string[] {
  if (typeof v !== "string" || v.length === 0) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function lanePlannerRoutes(deps: ServerDependencies) {
  return new Elysia().get("/api/plan-lanes", ({ query, set }) => {
    const files = csv(query["files"]);
    const symbols = csv(query["symbols"]);
    if (files.length === 0 && symbols.length === 0) {
      set.status = 400;
      return { error: "pass `files` and/or `symbols` (comma-separated)" };
    }
    const depthRaw = query["depth"];
    const depth =
      typeof depthRaw === "string" && depthRaw.length > 0
        ? Number(depthRaw)
        : undefined;
    const hubRaw = query["maxHubDegree"];
    const maxHubDegree =
      typeof hubRaw === "string" && hubRaw.length > 0 ? Number(hubRaw) : undefined;
    return planLanes(deps.db, { files, symbols }, {
      maxDepth: depth !== undefined && !Number.isNaN(depth) ? depth : undefined,
      maxHubDegree:
        maxHubDegree !== undefined && !Number.isNaN(maxHubDegree) ? maxHubDegree : undefined,
    });
  });
}
