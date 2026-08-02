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
import { lanePlannerRoutes } from "./routes/lane_planner.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { ingestRoutes, type IngestController } from "./routes/ingest.ts";
import { nodesRoutes } from "./routes/nodes.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { searchRoutes } from "./routes/search.ts";
import { statsRoutes } from "./routes/stats.ts";
import { syncRoutes } from "./routes/sync.ts";
import { tracesRoutes } from "./routes/traces.ts";
import { viewerRoutes } from "./routes/viewer.ts";
import { wsRoutes } from "./routes/ws.ts";

/**
 * A mutable holder for the served {@link Db}. LIVE branch re-pointing (the
 * daemon following a `git checkout` while it is up) swaps `current` to a new
 * branch's index. Routes never see this type — `buildApp` rewires `deps.db` to
 * read through `current` at REQUEST time, so a swap is invisible to every route
 * module (they keep using `deps.db.…`).
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
  /**
   * Optional swappable holder for the served db. When present, `buildApp`
   * redefines `deps.db` as a getter delegating to `dbRef.current`, so a live
   * branch re-point that reassigns `dbRef.current` is picked up by every route
   * on its next request WITHOUT touching any route file. When absent (tests,
   * one-shot callers), `deps.db` stays the fixed instance passed in.
   */
  dbRef?: DbRef;
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
   * Multi-project only: alias of the primary/default project (the one served
   * when a request omits `?project=`). Absent for single-project callers/tests.
   */
  primaryAlias?: string | undefined;
  /**
   * Multi-project only: enumerate every project this daemon serves. `/api/health`
   * uses it to list projects; absent for single-project callers/tests.
   */
  listProjects?: (() => ProjectSummary[]) | undefined;
  /**
   * Multi-project only: register + open a new repo into the LIVE daemon with no
   * restart. Resolves with the served alias and whether it was newly added.
   */
  addProject?: AddProjectFn | undefined;
  /** Multi-project only: stop serving a repo (by alias or root) in the LIVE daemon. */
  removeProject?: RemoveProjectFn | undefined;
  /**
   * Multi-project only: subscribe to project-set changes (add/remove). Returns an
   * unsubscribe fn. Used by the `/api/projects/stream` SSE endpoint so an open
   * viewer updates its switcher the instant the set changes.
   */
  subscribeProjects?: SubscribeProjectsFn | undefined;
  /**
   * Multi-project only: resolve the LIVE per-project deps for an alias
   * (`null` → the primary; `undefined` result → alias unknown). WebSocket
   * handlers must pin a connection through this at open() time: the facade's
   * AsyncLocalStorage-backed getters resolve per HTTP request, and that
   * context does NOT reach Bun's ws message/close callbacks — reading the
   * facade there silently yields the PRIMARY project's op-log.
   */
  resolveProject?: ((alias: string | null) => ServerDependencies | undefined) | undefined;
  /** Ingest backlog + failure-breaker state for THIS project (see {@link IngestHealth}). */
  ingestHealth?: (() => IngestHealth) | undefined;
  /** Clear this project's tripped ingest breaker so automatic re-ingest resumes. */
  resetIngestBreaker?: (() => void) | undefined;
  /** Multi-project only: {@link IngestHealth} for EVERY served project. */
  listIngestHealth?: (() => Array<IngestHealth & { alias: string }>) | undefined;
}

/**
 * Automatic-ingest health for one project — the signal the runaway-ingest
 * incident had no way to surface.
 *
 * The daemon re-ingests on its own (watcher batches, watcher overflow, branch
 * re-point). When that work starts failing, or starts piling up, NOTHING was
 * visible to the user: the incident ran 11,600 ingest cycles while every symptom
 * lived only in a 576 MB log nobody was reading. These counters are served over
 * HTTP so "is my daemon melting down?" is one request away.
 */
export interface IngestHealth {
  /** Consecutive AUTOMATIC ingest failures since the last success. */
  consecutiveFailures: number;
  /** True once the breaker tripped: automatic re-ingest is STOPPED here. */
  tripped: boolean;
  /**
   * Which bound tripped. `"rate"` is the one that matches the original
   * incident — work that SUCCEEDED, far too often — and `"failures"` is the
   * classic retry-forever case.
   */
  tripReason: "failures" | "rate" | null;
  /** ISO timestamp the breaker tripped, else null. */
  trippedAt: string | null;
  /** Message of the most recent automatic-ingest failure, else null. */
  lastError: string | null;
  /** Message of the most recent MANUAL ingest failure, tracked separately so a
   *  manual run can never disarm the automatic breaker. */
  lastManualError: string | null;
  /** Automatic whole-repo re-ingests started inside the current rate window. */
  autoRunsInWindow: number;
  /** The work-rate limit those runs are measured against. */
  autoRunLimitPerWindow: number;
  /** Length of the work-rate window, in ms. */
  rateWindowMs: number;
  /** Minimum enforced gap between automatic whole-repo re-ingests, in ms. */
  minIntervalMs: number;
  /** Times a queued full re-ingest had to wait out the minimum interval. */
  rateLimitedWaits: number;
  /** Daemon-wide automatic ingests running right now (across ALL projects). */
  limiterActive: number;
  /** Daemon-wide automatic ingests queued behind the concurrency limit. */
  limiterWaiting: number;
  /** A full re-ingest is queued but has not started yet (coalesced to <= 1). */
  fullIngestQueued: boolean;
  /** Full re-ingest requests that COLLAPSED into an already-queued run. */
  fullIngestsCoalesced: number;
  /** Watcher events buffered right now (the backlog). */
  pendingWatchEvents: number;
  /** True while a watcher batch handler is running. */
  watchBatchInFlight: boolean;
  /** True while a watcher overflow full-rescan is running. */
  watchOverflowInFlight: boolean;
  /** Overflow records that collapsed into a running/queued rescan. */
  watchOverflowsCoalesced: number;
}

/** One row of the multi-project `/api/health` listing. */
export interface ProjectSummary {
  alias: string;
  root: string;
  branch: string | null;
}

/** Result of a live project add: the served alias/root, and whether it was newly
 *  added (`false` = the daemon already served this root, returned untouched). */
export interface ProjectAddResult {
  alias: string;
  root: string;
  added: boolean;
}

/** Register + open a repo into the live daemon. Throws if `root` has no `.hayven/`. */
export type AddProjectFn = (root: string, alias?: string) => Promise<ProjectAddResult>;
/** Remove a served repo by alias OR root. Resolves `false` if it wasn't served. */
export type RemoveProjectFn = (aliasOrRoot: string) => Promise<boolean>;
/** Subscribe to project-set changes; returns an unsubscribe fn. */
export type SubscribeProjectsFn = (listener: () => void) => () => void;

export interface BuildAppOptions {
  /**
   * Per-request hook (multi-project): runs before every handler with the raw
   * Request, so the caller can select which project this request targets.
   * `buildMultiProjectApp` uses it to enter the AsyncLocalStorage project scope.
   * Returning a `Response` SHORT-CIRCUITS the request (Elysia treats a value
   * returned from `onRequest` as the response) — used to refuse a mutation
   * addressed to a project this daemon does not serve.
   */
  onRequest?: (request: Request) => Response | undefined;
  /**
   * When true (default), a supplied `deps.dbRef` rewires `deps.db` to read
   * `dbRef.current` at request time (live branch re-point). The multi-project
   * facade passes false: its own `db` getter already resolves the current
   * project's live db per request, so buildApp must not re-pin it.
   */
  branchAwareDb?: boolean;
}

/**
 * Rewire `deps.db` to resolve `deps.dbRef.current` at REQUEST time, so a live
 * branch re-point (reassigning `dbRef.current`) reaches every route with zero
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

/**
 * Strip the user's home directory out of an error message before it leaves the
 * process. `onError` echoes `error.message` straight back to the caller, and
 * those messages routinely embed absolute paths — which leaks the account name
 * and the on-disk layout to anything that can reach the port. The message stays
 * readable (`~/code/repo/...`); the full text still goes to the daemon log.
 */
export function redactHomePaths(message: string): string {
  const home = process.env["HOME"];
  if (typeof home !== "string" || home.length < 2) return message;
  return message.split(home).join("~");
}

/**
 * `GET /api/ingest/health` + `POST /api/ingest/health/reset`.
 *
 * Defined here rather than in `routes/` because it reports on daemon-level
 * machinery (the per-project ingest breaker and watcher backlog wired up in
 * `cli/daemon.ts`), not on the graph. Both are no-ops with a clear 501 for
 * single-project/test callers that never wired the state.
 */
function ingestHealthRoutes(deps: ServerDependencies) {
  return new Elysia()
    .get("/api/ingest/health", () => {
      const all = deps.listIngestHealth?.();
      if (all) {
        return { ok: true, tripped: all.filter((p) => p.tripped).map((p) => p.alias), projects: all };
      }
      const one = deps.ingestHealth?.();
      if (!one) return { ok: true, tripped: [], projects: [] };
      const alias = deps.primaryAlias ?? "primary";
      return { ok: true, tripped: one.tripped ? [alias] : [], projects: [{ alias, ...one }] };
    })
    .post("/api/ingest/health/reset", ({ set }) => {
      if (!deps.resetIngestBreaker) {
        set.status = 501;
        return { error: "this daemon does not expose an ingest breaker" };
      }
      deps.resetIngestBreaker();
      return { ok: true, reset: true, health: deps.ingestHealth?.() ?? null };
    });
}

// Intentionally untyped return — Elysia's chained generics inflate the signature
// past TypeScript's comparison limits when composed with `.use()` modules.
export function buildApp(deps: ServerDependencies, opts: BuildAppOptions = {}) {
  // LIVE branch re-pointing (single-project): rewire `deps.db` → `dbRef.current`
  // at REQUEST time so a branch swap reaches every route with ZERO per-route
  // changes. Skipped for the multi-project facade (branchAwareDb:false), whose
  // own `db` getter already resolves the current project's live db per request.
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
      const message = (error as Error).message;
      // Log the FULL message (the daemon log is local and is the debugging
      // surface); return a home-redacted one to the caller.
      deps.logger.error("request error", { code, message });
      return { error: redactHomePaths(message), code };
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
    .use(projectsRoutes(deps))
    .use(nodesRoutes(deps))
    .use(searchRoutes(deps))
    .use(graphRoutes(deps))
    .use(affectedTestsRoutes(deps))
    .use(lanePlannerRoutes(deps))
    .use(memoryRoutes(deps))
    .use(contextRoutes(deps))
    .use(impactPreviewRoutes(deps))
    .use(statsRoutes(deps))
    .use(claimsRoutes(deps))
    .use(tracesRoutes(deps))
    .use(ingestRoutes(deps))
    .use(ingestHealthRoutes(deps))
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
  /** Live add of a repo into `projects` (no restart). Wired onto the facade for the route layer. */
  addProject?: AddProjectFn | undefined;
  /** Live remove of a repo from `projects`. Wired onto the facade for the route layer. */
  removeProject?: RemoveProjectFn | undefined;
  /** Subscribe to add/remove for the SSE stream. Wired onto the facade for the route layer. */
  subscribeProjects?: SubscribeProjectsFn | undefined;
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

/** HTTP methods that mutate state — the ones an unknown-project selector must
 *  hard-refuse (404) rather than fall back to the primary project. */
const MUTATING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE", "PATCH"]);


/**
 * True when `origin` is a loopback web origin (or the opaque `"null"` that a
 * `file://` page sends). Used to refuse browser-driven mutations against an
 * unauthenticated localhost daemon.
 */
export function isLocalOrigin(origin: string): boolean {
  if (origin === "null") return false; // opaque origin — treat as untrusted
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false; // unparseable Origin is not something to trust
  }
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Build ONE Elysia app that serves N projects from a single daemon. The route
 * modules are UNCHANGED: they close over a facade `deps` whose db/paths/config/
 * crdt/ingest getters resolve the CURRENT request's project — chosen from
 * `?project=<alias>` (or the `x-hayven-project` header), defaulting to `primary`.
 *
 * Each per-project {@link ServerDependencies} in `multi.projects` must already
 * be branch-wired (call {@link wireBranchAwareDb} on it) so `deps.db` follows
 * that project's own live branch re-point.
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
    addProject: multi.addProject,
    removeProject: multi.removeProject,
    subscribeProjects: multi.subscribeProjects,
    listIngestHealth: (): Array<IngestHealth & { alias: string }> => {
      const out: Array<IngestHealth & { alias: string }> = [];
      for (const [alias, d] of multi.projects) {
        const h = d.ingestHealth?.();
        if (h) out.push({ alias, ...h });
      }
      return out;
    },
    // Live map lookup (not a snapshot): hot-added projects are ws-reachable
    // immediately, removed ones stop resolving.
    resolveProject: (alias: string | null) =>
      alias === null ? primaryDeps : multi.projects.get(alias),
  } as ServerDependencies;

  for (const key of [
    "db",
    "dbRef",
    "config",
    "paths",
    "ingest",
    "crdt",
    "ingestHealth",
    "resetIngestBreaker",
  ] as const) {
    Object.defineProperty(facade, key, {
      configurable: true,
      enumerable: true,
      get: () => (current() as unknown as Record<string, unknown>)[key],
    });
  }

  const onRequest = (request: Request): Response | undefined => {
    let alias: string | null = null;
    let pathname = "";
    try {
      const url = new URL(request.url);
      alias = url.searchParams.get("project");
      pathname = url.pathname;
    } catch {
      alias = null;
    }
    if (!alias) alias = request.headers.get("x-hayven-project");
    const selected = alias ? multi.projects.get(alias) : undefined;

    // SAFETY: a MUTATION that explicitly addresses a project this daemon does
    // NOT serve must be refused, never silently routed to the primary — that
    // would write into the WRONG project's CRDT op-log (e.g. a CLI whose alias
    // went stale after a daemon restart). Reads keep the legacy fall-back to
    // the primary (an unknown `?project=` in the viewer degrades gracefully) —
    // EXCEPT the sync surface: a peer's `GET /api/sync/merkle` answered from
    // the primary's tree would diff two different projects and start a
    // bidirectional cross-contamination, so /api/sync/* is strict on every
    // method once a selector is present.
    // /ws/sync is the WebSocket sibling of POST /api/sync/push (it streams
    // CRDT ops into the op-log), so its upgrade GET gets the same strictness.
    // CROSS-ORIGIN GATE on mutations.
    //
    // The daemon has no authentication, so any web page the user happens to have
    // open can aim requests at 127.0.0.1:7777. The browser's same-origin policy
    // stops it READING the responses, but nothing stopped it CAUSING WRITES —
    // registering claims, adding/removing projects, triggering ingests. A
    // cross-origin `fetch` always carries an `Origin` header, while the CLI,
    // curl and the daemon's own same-origin viewer either omit it or send a
    // loopback one, so this costs legitimate callers nothing.
    //
    // Applied to MUTATIONS only. Reads are deliberately left alone: the viewer
    // is served from this origin, an opaque cross-origin GET leaks nothing to
    // the caller, and refusing them would break embedding without closing a
    // hole. (Unbounded-work GETs are a separate problem, fixed by bounding the
    // work, not by guessing at the caller.)
    if (MUTATING_METHODS.has(request.method)) {
      const origin = request.headers.get("origin");
      if (origin !== null && !isLocalOrigin(origin)) {
        multi.logger.warn("request: REFUSED cross-origin mutation", {
          origin,
          method: request.method,
          path: pathname,
        });
        return new Response(
          JSON.stringify({
            error:
              "cross-origin mutations are refused: this daemon is unauthenticated and " +
              "must not be driven by a web page.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
    }

    const strictRoute = pathname.startsWith("/api/sync/") || pathname === "/ws/sync";
    if (alias && !selected && (strictRoute || MUTATING_METHODS.has(request.method))) {
      return new Response(
        JSON.stringify({
          error: `daemon does not serve a project with alias '${alias}' — register it (\`hayven daemon register\`) or restart the daemon from that repo`,
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    // Two SILENT fall-throughs remain below. Neither can be closed unilaterally
    // (see the notes), so at minimum they must stop being invisible — the
    // logger dedups identical lines, so a chatty client cannot flood the log.
    if (alias && !selected) {
      // A READ with an unknown selector answers from the PRIMARY project's
      // index — a DIFFERENT repo. Kept (a viewer holding a stale alias degrades
      // instead of erroring), but it is a wrong answer with no error, so say so.
      multi.logger.warn("request: unknown project selector — answered from the PRIMARY project", {
        requested: alias,
        primary: multi.primary,
        method: request.method,
        path: pathname,
      });
    } else if (!alias && MUTATING_METHODS.has(request.method) && multi.projects.size > 1) {
      // A MUTATION with no selector writes into whichever project happens to be
      // primary. Refusing it outright is the real fix, but `cli/_shared.ts`
      // deliberately omits the header when the daemon's primary IS this project
      // (`projectHeader()` returns {} in that case), so refusing here would
      // break every correct CLI mutation from the primary repo. Making the
      // client always send its alias is a cross-lane change; until then, log it.
      multi.logger.warn("request: un-addressed MUTATION routed to the primary project", {
        primary: multi.primary,
        projectsServed: multi.projects.size,
        method: request.method,
        path: pathname,
      });
    }

    projectContext.enterWith(selected ?? primaryDeps);
    return undefined;
  };

  // branchAwareDb:false — the facade's own `db` getter already resolves the
  // current project's live db (each per-project deps is branch-wired upstream),
  // so buildApp must not re-pin `deps.db` to a single project's holder.
  return buildApp(facade, { onRequest, branchAwareDb: false });
}
