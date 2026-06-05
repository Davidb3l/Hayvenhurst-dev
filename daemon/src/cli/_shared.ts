/**
 * Shared helpers used by multiple CLI subcommands.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../config/load.ts";
import { resolveReadIndex } from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import { detectRepoRoot, hayvenPathsFor, type HayvenPaths } from "../util/paths.ts";
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

export type DaemonIdentityResult =
  | { ok: true; warning?: string }
  | { ok: false; message: string };

/**
 * Verify that the daemon at `base` actually serves THIS project before we send
 * it a mutating request.
 *
 * Why this exists: every project defaults to `daemon_port: 7777`. A mutating
 * CLI command (`claim`/`release`/`node body`/`sync`) POSTs to
 * `http://host:7777/...` with no proof the daemon there is OURS — so if another
 * repo's daemon is bound to 7777, we would silently mutate the WRONG repo's
 * CRDT op-log. This GETs `${base}/api/health`, reads its `root`, and compares it
 * (path-normalized) to our project root.
 *
 * Tolerance: an OLD daemon predating the `root` field returns no `root`. We
 * cannot verify identity against it, so we DO NOT hard-fail — we pass with a
 * `warning` the caller may surface. A genuine mismatch is a hard `ok: false`.
 *
 * A network/parse failure here is NOT fatal: the subsequent mutating request
 * will hit the same daemon and produce its own clear "could not reach daemon"
 * error, so we let it through (ok: true) rather than double-reporting.
 */
export async function assertDaemonServesProject(
  base: string,
  ctx: ProjectContext,
): Promise<DaemonIdentityResult> {
  let health: { root?: unknown };
  try {
    const res = await fetch(`${base}/api/health`);
    if (!res.ok) {
      // Reachable but unhealthy — let the real request surface the failure.
      return { ok: true };
    }
    health = (await res.json()) as { root?: unknown };
  } catch {
    // Unreachable — the mutating request will report this clearly itself.
    return { ok: true };
  }

  const remoteRoot = typeof health.root === "string" ? health.root : undefined;
  if (remoteRoot === undefined) {
    // Old daemon without identity — cannot verify; warn but don't block.
    return {
      ok: true,
      warning:
        `daemon at ${base} did not report a project root (old version?) — ` +
        "skipping project-identity check. Upgrade the daemon to enable it.",
    };
  }

  const ours = resolve(ctx.paths.repoRoot);
  const theirs = resolve(remoteRoot);
  if (ours !== theirs) {
    return {
      ok: false,
      message:
        `daemon at ${base} serves a DIFFERENT project — refusing to mutate it.\n` +
        `  this project: ${ours}\n` +
        `  daemon serves: ${theirs}\n` +
        "Start this project's daemon (`hayven daemon start`), or point at the right host:port.",
    };
  }
  return { ok: true };
}
