/**
 * `GET /api/health` — liveness/readiness for the daemon.
 */
import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";

/**
 * HLC skew rejections, or `null` when the CRDT clock is unavailable.
 *
 * `/api/health` is the LIVENESS endpoint — every probe, every `daemon start`
 * readiness wait, and `assertDaemonServesProject` hit it — so it must not be
 * able to 500 on the strength of a diagnostic field. A daemon whose `CrdtState`
 * failed to construct (or a caller that wired a partial one) still needs to be
 * able to answer "am I up?", so an unreadable counter degrades to `null` rather
 * than taking the endpoint down.
 */
function skewRejections(deps: ServerDependencies): number | null {
  try {
    const n = deps.crdt?.clock?.rejectedSkewCount();
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

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
    // LIVE branch re-pointing: the branch key + index path the daemon CURRENTLY
    // serves, read through the swappable holder so it reflects a `git checkout`
    // the daemon followed mid-run. `null`/`branch_path` absent when no holder is
    // wired (no per-branch caching / one-shot callers). A client can compare
    // `branch` against its own `git` branch to confirm the daemon is in sync.
    branch: deps.dbRef ? deps.dbRef.branchKey : null,
    branch_path: deps.dbRef ? deps.dbRef.path : null,
    // Multi-project: the default project's alias + every project this daemon
    // serves. Absent (undefined → omitted from JSON) for a single-project
    // daemon, so the viewer's switcher stays hidden and old clients are
    // unaffected. Select one on any endpoint with `?project=<alias>`.
    primary: deps.primaryAlias,
    projects: deps.listProjects ? deps.listProjects() : undefined,
    // HLC SKEW REJECTIONS for the selected project. `HlcGenerator` refuses a
    // remote HLC whose wall clock is too far ahead of ours, and the running
    // count lived ONLY in the daemon's in-memory `CrdtState` — unreachable from
    // the CLI, so a peer with a badly wrong clock silently had its ops dropped
    // with the evidence trapped in a process nobody could query. Nonzero means
    // some clock (theirs or ours) is wrong and sync is losing writes.
    hlc_skew_rejections: skewRejections(deps),
  }));
}
