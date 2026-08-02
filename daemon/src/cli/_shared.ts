/**
 * Shared helpers used by multiple CLI subcommands.
 */
import { existsSync } from "node:fs";

import { loadConfig } from "../config/load.ts";
import { DETACH_HEALTH_TIMEOUT_MS, DETACH_PROBE_TIMEOUT_MS } from "../daemon/detach.ts";
import { isRegistrableRoot } from "../daemon/registry.ts";
import { resolveReadIndex } from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import { canonicalRoot, detectRepoRoot, hayvenPathsFor, type HayvenPaths } from "../util/paths.ts";
import { rootLogger } from "../util/log.ts";

export interface ProjectContext {
  paths: HayvenPaths;
  config: ReturnType<typeof loadConfig>["config"];
  configSources: string[];
}

/**
 * Locate the project and load its config. Throws (with a friendly message)
 * if the project hasn't been initialized via `hayven init`.
 */
export function requireProject(cwd: string = process.cwd()): ProjectContext {
  const { root, reason } = detectRepoRoot(cwd);
  // The REGISTRY guard only stops a bad root from being PERSISTED. It does not
  // stop the damage: in `$HOME`, `detectRepoRoot` falls through to
  // `cwd-fallback`, `paths.hayvenDir` resolves to `~/.hayven` — which exists,
  // because it is the global config dir — and the `existsSync` below passes.
  // Every daemonless command (`ingest`, `reindex`, `view`, `mcp`, `proxy`, …)
  // funnels through here, so without this check they would each happily walk
  // and re-index the user's ENTIRE home tree. This is the real chokepoint for
  // the CPU/disk blowup; the registry is the chokepoint for persistence.
  if (!isRegistrableRoot(root)) {
    throw new Error(
      `Refusing to operate on ${root} as a project — \`~/.hayven\` is the global\n` +
        "config dir, not a project marker. cd into a repository and run this there.\n",
    );
  }
  const paths = hayvenPathsFor(root);
  if (!existsSync(paths.hayvenDir)) {
    throw new Error(
      `No .hayven/ directory found (searched up from ${cwd}).\n` +
        (reason === "cwd-fallback"
          ? "You don't appear to be inside a project. cd into one and run `hayven init`.\n"
          : "Run `hayven init` to initialize this project.\n"),
    );
  }
  const loaded = loadConfig(root);
  return { paths, config: loaded.config, configSources: loaded.sources };
}

/** Open the LEGACY SQLite index directly (no branch resolution). Used by the
 *  daemon and any caller that must target `.hayven/index.sqlite` verbatim. */
export function openDb(paths: HayvenPaths, opts: { readonly?: boolean } = {}): Db {
  return new Db(paths.sqliteFile, opts);
}

/**
 * Open the index a READ should use for this project: the current branch's
 * cached index when per-branch caching applies and that index exists, otherwise
 * the legacy index (fallback). This is the daemonless read path the packer /
 * `query` / `refs` / `impact` / `neighbors` / `traces` all go through, so they
 * automatically hit the current branch. Outside a git repo (or with per-branch
 * caching disabled) this is identical to {@link openDb}.
 */
export function openProjectDb(
  ctx: ProjectContext,
  opts: { readonly?: boolean } = {},
): Db {
  const resolved = resolveReadIndex(ctx.paths, ctx.config);
  return new Db(resolved.path, opts);
}

/** Exit-with-error helper. Logs through the daemon logger and prints to stderr. */
export function fatal(message: string, fields?: Record<string, unknown>): never {
  rootLogger().error(message, fields);
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** Friendly JSON-or-markdown selector. */
export function isJson(flags: Record<string, string | boolean>): boolean {
  return flags["json"] === true || flags["json"] === "true";
}

/** Outcome of a best-effort live hot-add against a running daemon. */
export type HotAddResult =
  | { kind: "added"; alias: string }
  | { kind: "exists"; alias: string }
  | { kind: "no-daemon" }
  | { kind: "error"; message: string };

/**
 * Best-effort: ask the daemon at `base` to serve `root` LIVE (`POST /api/projects`)
 * so a newly-registered repo appears in the switcher/routing WITHOUT a restart.
 * Never throws — an unreachable daemon or a route-missing (old) daemon both resolve
 * to `no-daemon`, and the caller falls back to "loads on next start".
 *
 * BOUNDED. Both fetches in this file used to carry no `AbortSignal`, so they
 * inherited Bun's 5-minute idle default — the same class of bug that made the
 * original incident invisible: a wedged daemon ACCEPTS the connection and never
 * answers, and the CLI parks for five minutes while its own message promises
 * ten seconds. Budget reused from `daemon/detach.ts` rather than invented here:
 * `DETACH_HEALTH_TIMEOUT_MS` is already the "wait for the daemon to finish
 * doing something" budget, and a live hot-add legitimately queues behind
 * `serializeMutation` in `cli/daemon.ts` (a concurrent remove costs
 * REMOVE_GRACE_MS plus a watcher teardown), so the shorter per-probe cap would
 * time out on a perfectly healthy daemon.
 */
export async function hotAddToRunningDaemon(root: string, base: string, alias?: string): Promise<HotAddResult> {
  // Guard CLIENT-side too, not just in the daemon's `addProjectLive`. This is
  // the path a `daemon start` takes when a daemon is ALREADY up, and that
  // daemon may be an older build with no guard — in which case an un-upgraded
  // process would happily accept `$HOME` and index the user's whole tree.
  // Refusing here means the new CLI cannot re-arm the bug through an old daemon.
  if (!isRegistrableRoot(root)) {
    return { kind: "error", message: `refusing to serve ${root} as a project (see \`hayven daemon register --help\`)` };
  }
  // ONE signal for the whole exchange, exactly as `probeDaemon` does: aborting
  // tears down the response BODY stream too, so a daemon that sends headers and
  // then stalls mid-body is bounded by the same budget as the connect phase —
  // otherwise `res.json()` below just becomes the new place to hang forever.
  const signal = AbortSignal.timeout(DETACH_HEALTH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alias ? { path: root, alias } : { path: root }),
      signal,
    });
  } catch {
    // A TIMEOUT is NOT "no daemon". Reporting a wedged daemon as absent makes
    // `assertDaemonServesProject` fall through to "this daemon does not support
    // live project registration — restart it from this repo", which sends the
    // user chasing a version problem that does not exist. Name the hang.
    if (signal.aborted) {
      return {
        kind: "error",
        message:
          `daemon at ${base} accepted the connection but did not answer POST /api/projects ` +
          `within ${DETACH_HEALTH_TIMEOUT_MS}ms — it is wedged. Try \`hayven daemon stop\`.`,
      };
    }
    return { kind: "no-daemon" }; // unreachable
  }
  if (res.status === 404) return { kind: "no-daemon" }; // old daemon w/o the route
  const body = (await res.json().catch(() => ({}))) as { added?: boolean; alias?: string; error?: string };
  if (!res.ok) return { kind: "error", message: body.error ?? `daemon returned ${res.status}` };
  return { kind: body.added ? "added" : "exists", alias: body.alias ?? alias ?? "" };
}

export type DaemonIdentityResult =
  | {
      ok: true;
      warning?: string;
      /**
       * The alias the daemon serves THIS project under, when known. Mutating
       * commands MUST forward it (`x-hayven-project` header — see
       * {@link projectHeader}) so one long-lived shared daemon routes the write
       * to the right project instead of its primary. Absent when talking to a
       * single-project/old daemon whose primary IS this project (no selector
       * needed) or when the daemon was unreachable.
       */
      alias?: string;
    }
  | { ok: false; message: string };

/**
 * Verify that the daemon at `base` serves THIS project before we send it a
 * mutating request — REGISTERING the project live when it doesn't yet.
 *
 * Why this exists: every project defaults to `daemon_port: 7777`, and ONE
 * long-lived daemon serves N registered projects. A mutating CLI command
 * (`claim`/`release`/`node body`/`sync`) POSTs to `http://host:7777/...`; the
 * daemon routes an un-addressed request to its PRIMARY project — so without
 * this check + the returned `alias`, a command run from repo B against repo A's
 * daemon would silently mutate the WRONG repo's CRDT op-log.
 *
 * Resolution order:
 *   1. The daemon's `/api/health` `projects` list contains our root → pass,
 *      returning that alias.
 *   2. Its (legacy, single-project) `root` matches ours → pass, no alias needed
 *      (an un-addressed request already routes to us — we're the primary).
 *   3. Neither → ask the daemon to serve us live (`POST /api/projects`, the
 *      same hot-add `hayven daemon register` uses). Success → pass with the
 *      new alias (+ a note). Failure → hard `ok: false`; we never fall through
 *      to an un-addressed mutation of a foreign primary.
 *
 * Tolerance: an OLD daemon predating the `root` field returns no identity at
 * all. We cannot verify against it, so we DO NOT hard-fail — we pass with a
 * `warning` the caller may surface. A network/parse failure here is NOT fatal
 * either: the subsequent mutating request will hit the same daemon and produce
 * its own clear "could not reach daemon" error (ok: true, no alias).
 */
export async function assertDaemonServesProject(
  base: string,
  ctx: ProjectContext,
): Promise<DaemonIdentityResult> {
  // Bounded with the SAME per-probe budget `probeDaemon` uses — this is the
  // same one-shot `/api/health` call, and a healthy daemon answers it in
  // single-digit ms. Unbounded, a daemon with a pegged event loop (a runaway
  // ingest: precisely the incident) parked every `claim`/`release`/`sync` here
  // for Bun's 5-minute idle default before the real request even started.
  const signal = AbortSignal.timeout(DETACH_PROBE_TIMEOUT_MS);
  let health: { root?: unknown; projects?: unknown };
  try {
    const res = await fetch(`${base}/api/health`, { signal });
    if (!res.ok) {
      // Reachable but unhealthy — let the real request surface the failure.
      return { ok: true };
    }
    health = (await res.json()) as { root?: unknown; projects?: unknown };
  } catch {
    // Distinguish "nothing is listening" (the overwhelmingly common case — an
    // instant connection refusal, and staying silent about it is correct) from
    // "something accepted and then went quiet". Only the second is worth a
    // note: it means the identity check was SKIPPED, so the mutating request
    // that follows is unverified and about to hang the same way.
    if (signal.aborted) {
      return {
        ok: true,
        warning:
          `daemon at ${base} accepted the connection but did not answer /api/health within ` +
          `${DETACH_PROBE_TIMEOUT_MS}ms — skipping the project-identity check. If the next ` +
          "request hangs, the daemon is wedged (`hayven daemon stop`).",
      };
    }
    // Unreachable — the mutating request will report this clearly itself.
    return { ok: true };
  }

  const remoteRoot = typeof health.root === "string" ? health.root : undefined;
  const projects = Array.isArray(health.projects)
    ? (health.projects as Array<{ alias?: unknown; root?: unknown }>)
    : undefined;

  if (remoteRoot === undefined && projects === undefined) {
    // Old daemon without identity — cannot verify; warn but don't block.
    return {
      ok: true,
      warning:
        `daemon at ${base} did not report a project root (old version?) — ` +
        "skipping project-identity check. Upgrade the daemon to enable it.",
    };
  }

  const ours = canonicalRoot(ctx.paths.repoRoot);

  // 1. Multi-project daemon already serving us → address requests by alias.
  if (projects) {
    const served = projects.find(
      (p) => typeof p.root === "string" && canonicalRoot(p.root) === ours,
    );
    if (served && typeof served.alias === "string" && served.alias.length > 0) {
      return { ok: true, alias: served.alias };
    }
  }

  // 2. Single-project (or primary) match → un-addressed requests route to us.
  if (remoteRoot !== undefined && canonicalRoot(remoteRoot) === ours) {
    return { ok: true };
  }

  // 3. Daemon is healthy but does not serve this project — register it LIVE
  //    (same mechanism as `hayven daemon register`) instead of refusing.
  const hot = await hotAddToRunningDaemon(ctx.paths.repoRoot, base);
  if ((hot.kind === "added" || hot.kind === "exists") && hot.alias.length > 0) {
    return {
      ok: true,
      alias: hot.alias,
      warning:
        `daemon at ${base} was not serving this project — registered it live as '${hot.alias}'.`,
    };
  }

  const theirs = remoteRoot !== undefined ? canonicalRoot(remoteRoot) : "(unknown)";
  const registerNote =
    hot.kind === "error"
      ? `\n  (live registration failed: ${hot.message})`
      : hot.kind === "no-daemon"
        ? "\n  (this daemon does not support live project registration — restart it from this repo)"
        : "\n  (live registration did not return a usable project alias)";
  return {
    ok: false,
    message:
      `daemon at ${base} serves a DIFFERENT project and this one could not be registered — refusing to mutate it.\n` +
      `  this project: ${ours}\n` +
      `  daemon serves: ${theirs}` +
      registerNote +
      "\nStart this project's daemon (`hayven daemon start`), or point at the right host:port.",
  };
}

/**
 * The request headers a mutating command must attach so a SHARED daemon routes
 * the write to the right project: `x-hayven-project: <alias>` when
 * {@link assertDaemonServesProject} resolved one, empty otherwise (primary /
 * single-project daemon — un-addressed routing is already correct).
 */
export function projectHeader(identity: DaemonIdentityResult): Record<string, string> {
  return identity.ok && identity.alias !== undefined && identity.alias.length > 0
    ? { "x-hayven-project": identity.alias }
    : {};
}

/**
 * Uniform handling for an {@link assertDaemonServesProject} result, so every
 * mutating CLI command treats it the same way: a hard mismatch (`ok:false`) prints
 * the error and signals ABORT; a soft `warning` (an old daemon that can't prove its
 * identity) prints a `note:` to stderr but signals PROCEED. Funnel the result
 * through this instead of hand-checking `!identity.ok` — that pattern silently
 * DROPS the warning, so a command talking to an unverifiable daemon gives the user
 * no heads-up.
 *
 * Returns `true` when the caller should PROCEED, `false` when it should abort (the
 * error has already been written). `write` is injectable for testing.
 */
export function reportIdentity(
  identity: DaemonIdentityResult,
  write: (s: string) => void = (s) => void process.stderr.write(s),
): boolean {
  if (!identity.ok) {
    write(`error: ${identity.message}\n`);
    return false;
  }
  if (identity.warning) write(`note: ${identity.warning}\n`);
  return true;
}
