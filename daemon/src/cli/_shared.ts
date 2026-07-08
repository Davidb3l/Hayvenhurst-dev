/**
 * Shared helpers used by multiple CLI subcommands.
 */
import { existsSync } from "node:fs";

import { loadConfig } from "../config/load.ts";
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
 */
export async function hotAddToRunningDaemon(root: string, base: string, alias?: string): Promise<HotAddResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alias ? { path: root, alias } : { path: root }),
    });
  } catch {
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
  let health: { root?: unknown; projects?: unknown };
  try {
    const res = await fetch(`${base}/api/health`);
    if (!res.ok) {
      // Reachable but unhealthy — let the real request surface the failure.
      return { ok: true };
    }
    health = (await res.json()) as { root?: unknown; projects?: unknown };
  } catch {
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
