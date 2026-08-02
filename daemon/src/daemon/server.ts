/**
 * Elysia HTTP control plane.
 *
 * Bound to `localhost:<port>` (default 7777). Routes are split by concern in
 * the `routes/` subdirectory.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";

import { Elysia } from "elysia";

import type { HayvenConfig } from "../config/defaults.ts";
import type { CrdtState } from "../crdt/state.ts";
import type { Db } from "../db/queries.ts";
import { canonicalRoot, hayvenHomeDir, type HayvenPaths } from "../util/paths.ts";
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
  /**
   * WATCHER LIVENESS. Without these, a dead watcher and an idle one look
   * identical over HTTP: incremental ingest silently stops, the index quietly
   * goes stale, and nothing anywhere says so — the same "no signal" shape as the
   * original incident, just in the opposite direction.
   *
   * `null` when this daemon has no watcher at all (the `hayven-native` binary
   * was not found at startup), which is itself the answer to "why is nothing
   * re-ingesting?".
   */
  watcherAlive: boolean | null;
  /** Times the watcher child has been restarted since the daemon started. */
  watcherRestarts: number | null;
  /** Milliseconds since ANY record was read off the watcher child's stdout.
   *  Past the stall budget the supervisor kills and restarts the child. */
  watcherSilentForMs: number | null;
  /** Times the child was restarted for going silent past the stall budget. */
  watcherHeartbeatStalls: number | null;
  /** Exit code of the most recent watcher child exit, or null if none yet. */
  watcherLastExitCode: number | null;
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
 * Every directory prefix that must be stripped out of an outbound error message.
 *
 * `process.env.HOME` ALONE was the bug. `plugin/scripts/ensure-daemon.sh`
 * documents HOME being unset or empty under launchd, systemd, several CI
 * runners and slim containers — and starts the daemon anyway. In exactly those
 * environments the redaction silently no-opped and `onError`'s raw
 * `error.message` (which routinely embeds absolute paths) leaked the account
 * name and the on-disk layout to anything that could reach the port. So we take
 * the union of the three notions of "home" this codebase actually has:
 *
 *   - `$HOME`          — what the shell/hook environment says.
 *   - `os.homedir()`   — resolved from `getpwuid` when `$HOME` is absent, which
 *                        is the whole point: it still works under launchd.
 *   - `hayvenHomeDir()` — the `$HAYVEN_HOME` override, which may live entirely
 *                        outside either of the above.
 *
 * Sorted LONGEST FIRST so a nested root (`$HAYVEN_HOME` under `$HOME`) is
 * replaced before its own parent turns it into a half-redacted string.
 *
 * `env` is injectable so tests can exercise the empty-HOME environments without
 * mutating the process (Bun resolves `os.homedir()` once per process).
 */
export function homeRedactionRoots(env: Record<string, string | undefined> = process.env): string[] {
  const candidates: Array<string | undefined> = [env["HOME"]];
  // Both of these read real state and must never take a request down.
  try {
    candidates.push(homedir());
  } catch {
    /* no passwd entry — nothing to add */
  }
  try {
    candidates.push(hayvenHomeDir());
  } catch {
    /* unresolvable — nothing to add */
  }
  const roots = new Set<string>();
  for (const c of candidates) {
    // `length < 2` drops "" and "/": redacting "/" would replace every slash in
    // the message with "~" and destroy it.
    if (typeof c === "string" && c.length >= 2) roots.add(c);
  }
  return [...roots].sort((a, b) => b.length - a.length);
}

/**
 * Strip the user's home directory out of an error message before it leaves the
 * process. `onError` echoes `error.message` straight back to the caller, and
 * those messages routinely embed absolute paths — which leaks the account name
 * and the on-disk layout to anything that can reach the port. The message stays
 * readable (`~/code/repo/...`); the full text still goes to the daemon log.
 */
export function redactHomePaths(
  message: string,
  roots: readonly string[] = homeRedactionRoots(),
): string {
  let out = message;
  for (const root of roots) out = out.split(root).join("~");
  return out;
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
 * Mutations whose TARGET is spelled out in the request itself rather than taken
 * from the ambient project selector, so requiring a `?project=` on them would be
 * meaningless (there is no project to name yet) or contradictory (the alias is
 * already in the path).
 *
 *   - `POST /api/projects`          — body carries the repo path being ADDED.
 *   - `DELETE /api/projects/<alias>` — the alias is the path segment.
 *
 * Everything else that mutates writes into whichever project the request
 * resolves to, and must therefore say which one.
 */
function isDaemonLevelMutation(method: string, pathname: string): boolean {
  if (pathname === "/api/projects") return method === "POST";
  return pathname.startsWith("/api/projects/") && method === "DELETE";
}

/**
 * Project-scoped mutating routes that CANNOT be required to carry a selector,
 * because no client that reaches them is able to supply one.
 *
 * `POST /api/traces/observations` is the whole list. Its only callers are the
 * three language collectors (`trace/go/flusher.go`, `trace/python/.../flusher.py`,
 * `trace/rust/src/flusher.rs`); each is configured with nothing but a daemon
 * base URL, sends only Content-Type/User-Agent, and has no way to learn an
 * alias — the payload does not even carry a repo root to infer one from.
 * Refusing these would silently drop every runtime trace the moment a daemon
 * picked up a second project, which is the steady state (the registry
 * accumulates every repo a `daemon start` was ever run in).
 *
 * So they keep the legacy fall-through to the primary, and it is LOGGED rather
 * than refused. That is a known, stated gap — routing traces correctly needs a
 * selector in the collector wire format, which is a cross-repo change.
 *
 * Everything else that mutates has a client that already sends one: `claim` /
 * `release` / `node body` / `summarize` attach `projectHeader()`, and `sync`
 * attaches both `localHeaders` and `peerHeaders` (`resolvePeerProject` makes
 * `--peer-project` mandatory against a multi-project peer).
 */
function hasNoSelectorCapableClient(pathname: string): boolean {
  return pathname.startsWith("/api/traces/");
}

/**
 * Header a client sends to say "I checked, and this daemon's PRIMARY project is
 * the repo I mean" — the case where there is no alias to send because
 * `/api/health` answered with a bare `root` and no `projects` list (a
 * single-project or pre-multi-project daemon).
 *
 * It carries the ABSOLUTE ROOT the client verified, not a bare "trust me" flag,
 * so the daemon re-checks it against the primary's own root and refuses if the
 * primary has since changed. See {@link buildMultiProjectApp} for why an
 * un-addressed mutation cannot simply be allowed.
 */
export const PRIMARY_ROOT_HEADER = "x-hayven-primary-root";


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

    // ONE silent fall-through remains below (an unknown selector on a READ,
    // which is deliberate). The un-addressed MUTATION case underneath it is no
    // longer a fall-through — it is refused. The logger dedups identical lines,
    // so a chatty client cannot flood the log either way.
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
    } else if (
      !alias &&
      MUTATING_METHODS.has(request.method) &&
      multi.projects.size > 1 &&
      !isDaemonLevelMutation(request.method, pathname)
    ) {
      // A MUTATION with no selector used to fall through to whichever project
      // happened to be primary — writing into a DIFFERENT repo's CRDT op-log
      // with no error anywhere. It is now REFUSED, with two escape hatches that
      // between them cover every correct client:
      //
      //   1. `x-hayven-project: <alias>` — what `cli/_shared.ts` already sends
      //      whenever `/api/health` listed this repo in `projects`, which a
      //      multi-project daemon always does (including for its own primary).
      //      That is the normal path and is unaffected by this refusal.
      //   2. `x-hayven-primary-root: <abs root>` — for the one case where the
      //      client legitimately has no alias: `/api/health` answered with a
      //      bare `root` and no `projects` list, so the client verified identity
      //      against the PRIMARY. We re-check the claim here rather than trust
      //      it, so a client holding a stale idea of the primary is refused
      //      instead of silently writing to the wrong repo.
      //
      // Daemon-level mutations (add/remove a project) are exempt — their target
      // is in the request itself, not in the selector.
      if (hasNoSelectorCapableClient(pathname)) {
        // Cannot be refused (see `hasNoSelectorCapableClient`) — but it must not
        // be invisible either: this IS a write landing in a possibly-wrong
        // project's op-log.
        multi.logger.warn(
          "request: un-addressed MUTATION routed to the primary project (no selector-capable client for this route)",
          {
            primary: multi.primary,
            projectsServed: multi.projects.size,
            method: request.method,
            path: pathname,
          },
        );
        projectContext.enterWith(primaryDeps);
        return undefined;
      }
      const claimedRoot = request.headers.get(PRIMARY_ROOT_HEADER);
      const primaryRoot = primaryDeps.paths.repoRoot;
      // Length-capped before `canonicalRoot`, which does a `realpathSync`: this
      // is the one place a raw header value reaches the filesystem, and PATH_MAX
      // is 4096 on Linux / 1024 on macOS, so anything longer cannot name a real
      // directory and is not worth a syscall.
      const claimOk =
        claimedRoot !== null &&
        claimedRoot.length > 0 &&
        claimedRoot.length <= 4096 &&
        canonicalRoot(claimedRoot) === canonicalRoot(primaryRoot);
      if (!claimOk) {
        multi.logger.warn("request: REFUSED un-addressed MUTATION", {
          primary: multi.primary,
          projectsServed: multi.projects.size,
          method: request.method,
          path: pathname,
          claimedRoot: claimedRoot ?? "(none)",
        });
        return new Response(
          JSON.stringify({
            error:
              `this daemon serves ${multi.projects.size} projects, so a mutating request must say ` +
              "which one: add `?project=<alias>` (or the `x-hayven-project` header). " +
              "Run `hayven daemon projects` to list the aliases.",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }

    projectContext.enterWith(selected ?? primaryDeps);
    return undefined;
  };

  // branchAwareDb:false — the facade's own `db` getter already resolves the
  // current project's live db (each per-project deps is branch-wired upstream),
  // so buildApp must not re-pin `deps.db` to a single project's holder.
  return buildApp(facade, { onRequest, branchAwareDb: false });
}
