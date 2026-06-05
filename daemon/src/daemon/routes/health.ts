/**
 * `GET /api/health` — liveness/readiness for the daemon.
 */
import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";

export function healthRoutes(deps: ServerDependencies) {
  return new Elysia().get("/api/health", () => ({
    ok: true,
    version: deps.daemonVersion,
    native_version: deps.nativeVersion ?? null,
    // Absolute project root this daemon serves. Lets a CLI client verify it is
    // talking to the daemon for THIS project before issuing a mutating request
    // — every project defaults to port 7777, so without an identity check a
    // foreign repo's daemon on the same port would be silently mutated.
    root: deps.paths.repoRoot,
  }));
}
