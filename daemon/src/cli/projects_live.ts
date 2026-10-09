/**
 * The RUNNING-daemon half of `hayven projects`: find out what a live daemon
 * serves, stop it serving one alias, and serve one again — so a registry edit
 * takes effect with no restart.
 *
 * Kept apart from `projects.ts` so the command module stays about the
 * registry, and so `hayven daemon register` can reuse the same "stop serving
 * the stale alias first" step when it auto-relocates a moved repo.
 *
 * SAFETY, inherited rather than re-invented: the base URL comes from the same
 * config resolution `hayven daemon register` uses, every request is bounded by
 * the budgets in `daemon/detach.ts`, and nothing is sent to a daemon whose
 * global home differs from ours (`probeDaemonGlobalHome`). That last guard is
 * what keeps a sandboxed test, or a user with a relocated `$HAYVEN_HOME`, from
 * stopping or re-pointing projects in SOMEONE ELSE's daemon.
 */
import { homedir } from "node:os";

import { loadConfig } from "../config/load.ts";
import { DETACH_HEALTH_TIMEOUT_MS, DETACH_PROBE_TIMEOUT_MS } from "../daemon/detach.ts";
import { sameProjectRoot, type ProjectEntry } from "../daemon/registry.ts";
import { canonicalRoot, detectRepoRoot } from "../util/paths.ts";
import { hotAddToRunningDaemon, probeDaemonGlobalHome, type HotAddResult } from "./_shared.ts";

/**
 * True when `$HAYVEN_HOME` is EXPLICITLY set to something other than the real
 * home: a sandbox (a test, a second install). Pure, so it is testable without
 * touching the real environment.
 *
 * Used to close the hole the home handshake leaves open: a daemon that
 * predates `global_home` (every installed v0.0.7) answers "unknown", and
 * "unknown" deliberately proceeds so ordinary users can still manage their
 * daemon. A SANDBOXED process is the one case where proceeding is how test
 * fixtures used to leak into a real registry, so for mutations it must not.
 */
export function homeIsSandboxed(
  env: Readonly<Record<string, string | undefined>> = process.env,
  realHome: string = homedir(),
): boolean {
  const envValue = env["HAYVEN_HOME"];
  if (envValue === undefined || envValue.trim().length === 0) return false;
  return canonicalRoot(envValue.trim()) !== canonicalRoot(realHome);
}

/** One project a live daemon reports serving (`GET /api/projects`). */
export interface ServedProject {
  readonly alias: string;
  readonly root: string;
}

/** What we learned about the daemon at the configured address. */
export type LiveDaemon =
  /** A multi-project daemon under OUR global home. Safe to manage. */
  | { kind: "up"; base: string; primary: string | null; projects: ServedProject[] }
  /** Nothing answering. Registry edits load on the next start. */
  | { kind: "none"; base: string }
  /**
   * Something answered but cannot be managed live: a different global home, a
   * daemon that predates `/api/projects`, a wedged one. `message` says which,
   * and the caller must leave it alone.
   */
  | { kind: "unmanaged"; base: string; message: string };

/**
 * The daemon address, resolved exactly as `hayven daemon register` resolves
 * it: the config of the project we are standing in (falling back to global +
 * env when we are not in one), so `HAYVEN_PORT`/`HAYVEN_HOST` and a per-repo
 * `daemon_port` are all honored. A malformed config is reported, not thrown:
 * the registry edit does not need the daemon at all.
 */
export function daemonBaseUrl(cwd: string = process.cwd()): string | Error {
  try {
    const cfg = loadConfig(detectRepoRoot(cwd).root).config;
    return `http://${cfg.daemon_host}:${cfg.daemon_port}`;
  } catch (err) {
    return err as Error;
  }
}

/**
 * Probe the daemon at `base`. Never throws.
 *
 * The home handshake runs FIRST, before any request that could lead to a
 * mutation, and a mismatch is final: see `_shared.ts` for the incident (86
 * fixture rows in a real registry) that made it necessary.
 */
export async function connectLiveDaemon(base: string, opts: { mutating?: boolean } = {}): Promise<LiveDaemon> {
  const homes = await probeDaemonGlobalHome(base);
  if (homes.kind === "mismatch") {
    return {
      kind: "unmanaged",
      base,
      message:
        `the daemon at ${base} keeps its registry under ${homes.theirs}, not ${homes.ours}; ` +
        "it was left alone, and only this home's registry was changed.",
    };
  }
  const signal = AbortSignal.timeout(DETACH_PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/api/projects`, { signal });
  } catch {
    // Same distinction `hotAddToRunningDaemon` draws: a TIMEOUT is a wedged
    // daemon, not an absent one, and saying "no daemon" would hide it.
    if (signal.aborted) {
      return {
        kind: "unmanaged",
        base,
        message: `the daemon at ${base} accepted the connection but did not answer; try \`hayven daemon restart\`.`,
      };
    }
    return { kind: "none", base };
  }
  const body = (await res.json().catch(() => null)) as { primary?: unknown; projects?: unknown } | null;
  const list = Array.isArray(body?.projects) ? body.projects : null;
  // A daemon without the route (404), or a single-project daemon (the route
  // answers but with no list and no primary), cannot be managed live.
  if (!res.ok || list === null || (list.length === 0 && typeof body?.primary !== "string")) {
    return {
      kind: "unmanaged",
      base,
      message: `the daemon at ${base} does not support live project management; changes load on \`hayven daemon restart\`.`,
    };
  }
  // The daemon answered but did not say which home it serves. For a READ, or
  // for an ordinary user (default home), that is fine and we proceed, exactly
  // as the hot-add does. For a MUTATION from a SANDBOXED home it is not: every
  // installed v0.0.7 daemon reports no home, so the handshake above is blind,
  // and stopping/re-serving projects in it from a test or a second install is
  // the leak the handshake exists to stop. Edit our own registry only.
  if (homes.kind === "unknown" && opts.mutating === true && homeIsSandboxed()) {
    return {
      kind: "unmanaged",
      base,
      message:
        `the daemon at ${base} does not report which HAYVEN_HOME it serves, and this one is set to ` +
        `${process.env["HAYVEN_HOME"] ?? ""}; it was left alone, and only this home's registry was changed.`,
    };
  }
  const projects: ServedProject[] = [];
  for (const p of list as Array<{ alias?: unknown; root?: unknown }>) {
    if (typeof p?.alias === "string" && typeof p?.root === "string") {
      projects.push({ alias: p.alias, root: p.root });
    }
  }
  return { kind: "up", base, primary: typeof body?.primary === "string" ? body.primary : null, projects };
}

/**
 * The project a live daemon is serving for this registry row, if any.
 *
 * Alias AND root first: runtimes are keyed by alias, but an alias can drift to
 * a different repo (a `daemon unregister` + re-register while the daemon ran),
 * and acting on an alias-only match would stop the WRONG repo. Falling back to
 * root alone catches the same repo served under an alias the registry no
 * longer holds.
 */
export function servedFor(live: LiveDaemon, entry: ProjectEntry): ServedProject | undefined {
  if (live.kind !== "up") return undefined;
  return (
    live.projects.find((p) => p.alias === entry.alias && sameProjectRoot(p.root, entry.root)) ??
    live.projects.find((p) => sameProjectRoot(p.root, entry.root))
  );
}

/**
 * `DELETE /api/projects/:alias`: stop serving it. The daemon keeps the
 * registration by design (an unauthenticated localhost call must not be able
 * to forget one), which is why every caller edits the registry itself.
 *
 * Budgeted with the HEALTH timeout, not the probe one: a remove legitimately
 * waits out the daemon's removal grace period plus a watcher teardown.
 */
export async function stopServingLive(
  base: string,
  alias: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const signal = AbortSignal.timeout(DETACH_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/projects/${encodeURIComponent(alias)}`, { method: "DELETE", signal });
    // 404 = "not served": the end state we wanted, already true.
    if (res.ok || res.status === 404) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: body.error ?? `daemon returned ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      message: signal.aborted
        ? `the daemon at ${base} did not answer within ${DETACH_HEALTH_TIMEOUT_MS}ms`
        : (err as Error).message,
    };
  }
}

/** Serve `root` live under `alias`: the same hot-add `daemon register` uses. */
export function serveLive(base: string, root: string, alias: string): Promise<HotAddResult> {
  return hotAddToRunningDaemon(root, base, alias);
}

/** One human line for a hot-add outcome. */
export function describeServe(hot: HotAddResult, alias: string): string {
  switch (hot.kind) {
    case "added":
      return `daemon: now serving it as "${hot.alias || alias}" (no restart needed)`;
    case "exists":
      return `daemon: already serving it as "${hot.alias || alias}"`;
    case "no-daemon":
      return "daemon: went away mid-command; it will load on the next `hayven daemon start`";
    case "foreign-home":
      return `daemon: skipped. ${hot.message}`;
    case "error":
      return `daemon: did NOT start serving it again: ${hot.message} (\`hayven daemon restart\` will)`;
  }
}
