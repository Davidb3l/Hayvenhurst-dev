/**
 * Elysia HTTP control plane.
 *
 * Bound to `localhost:<port>` (default 7777). Routes are split by concern in
 * the `routes/` subdirectory.
 */
import { Elysia } from "elysia";

import type { HayvenConfig } from "../config/defaults.ts";
import type { CrdtState } from "../crdt/state.ts";
import type { Db } from "../db/queries.ts";
import type { HayvenPaths } from "../util/paths.ts";
import type { Logger } from "../util/log.ts";
import { affectedTestsRoutes } from "./routes/affected_tests.ts";
import { claimsRoutes } from "./routes/claims.ts";
import { contextRoutes } from "./routes/context.ts";
import { graphRoutes } from "./routes/graph.ts";
import { healthRoutes } from "./routes/health.ts";
import { impactPreviewRoutes } from "./routes/impact_preview.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { ingestRoutes, type IngestController } from "./routes/ingest.ts";
import { nodesRoutes } from "./routes/nodes.ts";
import { searchRoutes } from "./routes/search.ts";
import { statsRoutes } from "./routes/stats.ts";
import { syncRoutes } from "./routes/sync.ts";
import { tracesRoutes } from "./routes/traces.ts";
import { viewerRoutes } from "./routes/viewer.ts";
import { wsRoutes } from "./routes/ws.ts";

export interface ServerDependencies {
  db: Db;
  config: HayvenConfig;
  paths: HayvenPaths;
  logger: Logger;
  ingest: IngestController;
  /** Shared CRDT state: in-memory CRDTs + OpLog + HLC + writer ID. */
  crdt: CrdtState;
  /** Daemon version string surfaced via /api/health. */
  daemonVersion: string;
  /** Native binary version, if known. */
  nativeVersion?: string | undefined;
}

// Intentionally untyped return — Elysia's chained generics inflate the signature
// past TypeScript's comparison limits when composed with `.use()` modules.
export function buildApp(deps: ServerDependencies) {
  const app = new Elysia({ name: "hayvenhurst" })
    .onError(({ error, code }) => {
      deps.logger.error("request error", { code, message: (error as Error).message });
      return { error: (error as Error).message, code };
    })
    // The `/` JSON banner only fires if no static file serves at root —
    // viewerRoutes registers a `GET /*` catch-all below, so this is a
    // defensive default for installs where the viewer isn't built yet.
    .get("/__daemon", () => ({
      name: "hayvenhurst",
      version: deps.daemonVersion,
      docs: "see https://hayvenhurst.dev",
    }))
    // API + WS routes register first so they win over the static catch-all.
    .use(healthRoutes(deps))
    .use(nodesRoutes(deps))
    .use(searchRoutes(deps))
    .use(graphRoutes(deps))
    .use(affectedTestsRoutes(deps))
    .use(memoryRoutes(deps))
    .use(contextRoutes(deps))
    .use(impactPreviewRoutes(deps))
    .use(statsRoutes(deps))
    .use(claimsRoutes(deps))
    .use(tracesRoutes(deps))
    .use(ingestRoutes(deps))
    .use(syncRoutes(deps))
    .use(wsRoutes(deps))
    // viewerRoutes contains `/node/*` and a `/*` catch-all — MUST be last.
    .use(viewerRoutes(deps));

  return app;
}
