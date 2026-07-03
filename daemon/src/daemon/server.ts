/**
 * Elysia HTTP control plane.
 *
 * Bound to `localhost:<port>` (default 7777). Routes are split by concern in
 * the `routes/` subdirectory.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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

/**
 * A mutable holder for the served {@link Db}. Optional per-project indirection:
 * when a caller supplies one, `buildApp` (or the multi-project facade) rewires
 * `deps.db` to read `dbRef.current` at REQUEST time, so a live re-point that
 * reassigns `dbRef.current` is picked up by every route without touching any
 * route file. `path`/`branchKey` are surfaced via `/api/health`.
 */
export interface DbRef {
  current: Db;
  /** Absolute path of the index `current` was opened from (for /api/health). */
  path: string;
  /** Active branch key of the served index, or `null` for the legacy index. */
  branchKey: string | null;
}

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
  /**
   * Optional swappable holder for the served db. When present, `buildApp`
   * redefines `deps.db` as a getter delegating to `dbRef.current`. When absent
   * (single-project daemon, tests, one-shot callers), `deps.db` stays the fixed
   * instance passed in.
   */
  dbRef?: DbRef;
  /**
   * Multi-project only: alias of the primary/default project (the one served
   * when a request omits `?project=`). Absent for single-project callers/tests.
   */
  primaryAlias?: string | undefined;
  /**
   * Multi-project only: enumerate every project this daemon serves. `/api/health`
   * uses it to list projects; absent for single-project callers/tests.
   */
  listProjects?: (() => ProjectSummary[]) | undefined;
}

/** One row of the multi-project `/api/health` listing. */
export interface ProjectSummary {
  alias: string;
  root: string;
  branch: string | null;
}

export interface BuildAppOptions {
  /**
   * Per-request hook (multi-project): runs before every handler with the raw
   * Request, so the caller can select which project this request targets.
   * `buildMultiProjectApp` uses it to enter the AsyncLocalStorage project scope.
   */
  onRequest?: (request: Request) => void;
  /**
   * When true (default), a supplied `deps.dbRef` rewires `deps.db` to read
   * `dbRef.current` at request time. The multi-project facade passes false: its
   * own `db` getter already resolves the current project's live db per request,
   * so buildApp must not re-pin it.
   */
  branchAwareDb?: boolean;
}

/**
 * Rewire `deps.db` to resolve `deps.dbRef.current` at REQUEST time, so a live
 * re-point (reassigning `dbRef.current`) reaches every route with zero
 * per-route changes. No-op when there is no swappable holder.
 */
export function wireBranchAwareDb(deps: ServerDependencies): void {
  if (!deps.dbRef) return;
  const dbRef = deps.dbRef;
  Object.defineProperty(deps, "db", {
    configurable: true,
    enumerable: true,
    get: () => dbRef.current,
  });
}

// Intentionally untyped return — Elysia's chained generics inflate the signature
// past TypeScript's comparison limits when composed with `.use()` modules.
export function buildApp(deps: ServerDependencies, opts: BuildAppOptions = {}) {
  // LIVE re-pointing (single-project): rewire `deps.db` → `dbRef.current` at
  // REQUEST time so a swap reaches every route with ZERO per-route changes.
  // Skipped for the multi-project facade (branchAwareDb:false), whose own `db`
  // getter already resolves the current project's live db per request.
  if (opts.branchAwareDb ?? true) {
    wireBranchAwareDb(deps);
  }

  const app = new Elysia({ name: "hayvenhurst" });

  // Multi-project: select the request's project BEFORE any handler runs, so the
  // facade getters below resolve the right project for the rest of the request.
  if (opts.onRequest) {
    const hook = opts.onRequest;
    app.onRequest(({ request }) => hook(request));
  }

  app
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

export interface MultiProjectDeps {
  /** Alias of the default project, served when a request omits `?project=`. */
  primary: string;
  /** alias → that project's fully-wired single-project {@link ServerDependencies}. */
  projects: Map<string, ServerDependencies>;
  logger: Logger;
  daemonVersion: string;
  nativeVersion?: string | undefined;
}

/**
 * Per-request project selection. The `onRequest` hook calls `enterWith` with
 * the chosen project's deps; the facade getters below read `getStore()`, so
 * every route transparently answers for the selected project. We use
 * `enterWith` (not `run`) because Elysia owns the serve loop via `app.listen` —
 * there is no outer callback to wrap; `enterWith` sets the store for the rest
 * of the request's async continuation, and each request re-selects at its start.
 */
const projectContext = new AsyncLocalStorage<ServerDependencies>();

/**
 * Build ONE Elysia app that serves N projects from a single daemon. The route
 * modules are UNCHANGED: they close over a facade `deps` whose db/paths/config/
 * crdt/ingest getters resolve the CURRENT request's project — chosen from
 * `?project=<alias>` (or the `x-hayven-project` header), defaulting to `primary`.
 *
 * Each per-project {@link ServerDependencies} in `multi.projects` that supplies
 * a `dbRef` must already be branch-wired (call {@link wireBranchAwareDb} on it)
 * so `deps.db` follows that project's own live re-point.
 */
export function buildMultiProjectApp(multi: MultiProjectDeps) {
  const primaryDeps = multi.projects.get(multi.primary);
  if (!primaryDeps) {
    throw new Error(`primary project '${multi.primary}' is not in the project map`);
  }
  const current = (): ServerDependencies => projectContext.getStore() ?? primaryDeps;

  // The facade: fixed daemon-level fields + per-project getters. Routes read
  // `deps.db` etc. at request time; health reads `listProjects()`/`primaryAlias`.
  const facade = {
    logger: multi.logger,
    daemonVersion: multi.daemonVersion,
    nativeVersion: multi.nativeVersion,
    primaryAlias: multi.primary,
    listProjects: (): ProjectSummary[] =>
      [...multi.projects.entries()].map(([alias, d]) => ({
        alias,
        root: d.paths.repoRoot,
        branch: d.dbRef?.branchKey ?? null,
      })),
  } as ServerDependencies;

  for (const key of ["db", "dbRef", "config", "paths", "ingest", "crdt"] as const) {
    Object.defineProperty(facade, key, {
      configurable: true,
      enumerable: true,
      get: () => (current() as unknown as Record<string, unknown>)[key],
    });
  }

  const onRequest = (request: Request): void => {
    let alias: string | null = null;
    try {
      alias = new URL(request.url).searchParams.get("project");
    } catch {
      alias = null;
    }
    if (!alias) alias = request.headers.get("x-hayven-project");
    projectContext.enterWith((alias && multi.projects.get(alias)) || primaryDeps);
  };

  // branchAwareDb:false — the facade's own `db` getter already resolves the
  // current project's live db (each per-project deps is branch-wired upstream),
  // so buildApp must not re-pin `deps.db` to a single project's holder.
  return buildApp(facade, { onRequest, branchAwareDb: false });
}
