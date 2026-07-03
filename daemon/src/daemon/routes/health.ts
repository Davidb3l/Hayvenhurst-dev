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
    // Absolute project root this daemon serves (the one selected by `?project=`,
    // else the primary). Lets a CLI client verify it is talking to the daemon
    // for THIS project before a mutating request — every project defaults to
    // port 7777, so without an identity check a foreign repo's daemon on the
    // same port would be silently mutated.
    root: deps.paths.repoRoot,
    // Multi-project: the default project's alias + every project this daemon
    // serves. Absent (undefined → omitted from JSON) for a single-project
    // daemon, so the viewer's switcher stays hidden and old clients are
    // unaffected. Select one on any endpoint with `?project=<alias>`.
    primary: deps.primaryAlias,
    projects: deps.listProjects ? deps.listProjects() : undefined,
  }));
}
