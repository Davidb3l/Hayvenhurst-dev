/**
 * Shared helpers used by multiple CLI subcommands.
 */
import { existsSync } from "node:fs";

import { loadConfig } from "../config/load.ts";
import { DETACH_HEALTH_TIMEOUT_MS, DETACH_PROBE_TIMEOUT_MS } from "../daemon/detach.ts";
import { isRegistrableRoot } from "../daemon/registry.ts";
import { resolveReadIndex } from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import { canonicalRoot, detectRepoRoot, hayvenHomeDir, hayvenPathsFor, type HayvenPaths } from "../util/paths.ts";
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
  | { kind: "error"; message: string }
  /**
   * The daemon anchors its GLOBAL state to a different home than we do, so we
   * did not POST at all. Distinct from `error` because nothing went wrong: the
   * hot-add was correctly SKIPPED, and every caller must report it as a note
   * rather than a failure.
   */
  | { kind: "foreign-home"; ourHome: string; daemonHome: string; message: string };

/**
 * The `/api/health` field a daemon reports its global home under, and the
 * `POST /api/projects` body field a client declares its own under. Named once
 * so the client, the route and the tests cannot drift apart.
 */
export const HEALTH_GLOBAL_HOME_FIELD = "global_home";
export const PROJECTS_CLIENT_HOME_FIELD = "client_home";

/**
 * THE SANDBOX ESCAPE this exists to close.
 *
 * `$HAYVEN_HOME` is the only way to sandbox global state (see
 * `util/paths.ts#hayvenHomeDir`), and every test that touches the project
 * registry sets it. But registration does not stay in-process: it travels over
 * HTTP to a RUNNING daemon, and that daemon writes to ITS OWN registry, derived
 * from ITS OWN `$HAYVEN_HOME`. So a child process with a throwaway home still
 * caused a row to land in the developer's real `~/.hayven/projects.json`
 * whenever any daemon happened to be listening on the configured port. The
 * observed damage was 86 registry entries, ~76 of them test-fixture temp dirs
 * whose tests sandboxed correctly. The tests were not at fault; the hop was.
 *
 * The fix is a home handshake in BOTH directions. This type is the client half.
 */
export type DaemonHomeCheck =
  /** Both sides anchor to the same global home. Safe to mutate the daemon. */
  | { kind: "match"; home: string }
  /** Different homes. A write here escapes our sandbox into theirs. */
  | { kind: "mismatch"; ours: string; theirs: string }
  /**
   * Cannot verify: the daemon is unreachable, unhealthy, or predates the field.
   * MUST NOT block the hot-add. An older daemon reports no home at all, and
   * treating silence as mismatch would mean upgrading the CLI breaks
   * registration against every daemon already running.
   */
  | { kind: "unknown" };

/**
 * Our own global home, or `undefined` when it cannot be determined.
 *
 * `hayvenHomeDir()` THROWS on a relative `$HAYVEN_HOME`. The hot-add path is
 * best-effort and must never throw, so a bad override degrades to "no opinion"
 * here and the real error surfaces from whichever command actually needs the
 * path.
 */
function callerGlobalHome(): string | undefined {
  try {
    return hayvenHomeDir();
  } catch {
    return undefined;
  }
}

/*
 * THE RESIDUAL EXPOSURE, stated so nobody has to rediscover it. A plain block
 * comment, not a doc comment: it documents a DECISION about the whole handshake
 * rather than any one symbol, and there is no declaration for it to attach to.
 *
 * The handshake closes the leak against a daemon that reports its home. It does
 * NOT close it against an OLDER daemon, which reports nothing: the probe returns
 * `unknown`, `unknown` proceeds, and that daemon has no guard of its own. This is
 * a deliberate compatibility choice, because treating silence as a mismatch would
 * mean a CLI upgrade breaks registration against every daemon already running.
 *
 * Measured, so the size of the residual is on record rather than assumed: with
 * this fix in place and a resident 0.0.7 daemon on the default port, a full
 * `bun test` on the owner's machine still added two fixture rows to the real
 * `~/.hayven/projects.json`. A fresh contributor is not exposed (they build this
 * tree, so their daemon reports a home and the mismatch rule fires). Anyone with
 * a pre-handshake daemon still running is, until they restart it.
 *
 * A stricter rule was written and measured: refuse the unverifiable post when
 * `$HAYVEN_HOME` is set to something other than the real home, which is exactly
 * the sandbox case and leaves ordinary users untouched. It DOES close the
 * residual (registry rows held flat at 7 across a full suite run). It was backed
 * out because it contradicts the compatibility rule above and because it changes
 * the expectations of four existing test files that hot-add against stub daemons
 * which omit the field. Reinstate it as a follow-up, with those tests, if the
 * residual is judged worse than the incompatibility.
 */

/**
 * Compare a daemon-reported global home against ours.
 *
 * CANONICAL comparison, not string equality. On macOS `/tmp` is a symlink to
 * `/private/tmp`, so a sandbox created as `/tmp/x` and reported back as
 * `/private/tmp/x` is the SAME directory; a naive `===` would call that a
 * mismatch and refuse a perfectly legitimate hot-add. `canonicalRoot` resolves
 * symlinks and normalizes away a trailing slash, and falls back to a plain
 * `resolve` for a path that does not exist on this side.
 */
export function compareGlobalHomes(reported: unknown): DaemonHomeCheck {
  if (typeof reported !== "string" || reported.length === 0) return { kind: "unknown" };
  const ours = callerGlobalHome();
  if (ours === undefined) return { kind: "unknown" };
  const oursCanon = canonicalRoot(ours);
  const theirsCanon = canonicalRoot(reported);
  return oursCanon === theirsCanon
    ? { kind: "match", home: oursCanon }
    : { kind: "mismatch", ours: oursCanon, theirs: theirsCanon };
}

/**
 * Ask the daemon at `base` which global home it anchors to, and compare it to
 * ours. Never throws: every failure mode (refused, wedged, unhealthy, old
 * daemon with no field) resolves to `unknown`, which is explicitly NOT a
 * mismatch.
 *
 * Bounded with the PROBE budget, not the health budget: this is the same
 * one-shot `/api/health` call `probeDaemon` makes, and it runs BEFORE the
 * hot-add POST, so it must not double the worst case against a wedged daemon.
 */
export async function probeDaemonGlobalHome(base: string): Promise<DaemonHomeCheck> {
  const signal = AbortSignal.timeout(DETACH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/health`, { signal });
    if (!res.ok) return { kind: "unknown" };
    const body = (await res.json()) as Record<string, unknown>;
    return compareGlobalHomes(body[HEALTH_GLOBAL_HOME_FIELD]);
  } catch {
    return { kind: "unknown" };
  }
}

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
  // GLOBAL-HOME HANDSHAKE, before anything is sent. `$HAYVEN_HOME` sandboxes
  // our own process, but this POST is a write to SOMEONE ELSE'S global state:
  // the daemon persists the registration under the home ITS process resolved.
  // Posting across that boundary is how test fixtures ended up in a real
  // `~/.hayven/projects.json`. `unknown` (unreachable, unhealthy, or a daemon
  // predating the field) deliberately falls through and posts, so upgrading the
  // CLI does not break registration against a daemon that is already running.
  const homes = await probeDaemonGlobalHome(base);
  if (homes.kind === "mismatch") {
    return {
      kind: "foreign-home",
      ourHome: homes.ours,
      daemonHome: homes.theirs,
      message:
        `daemon at ${base} anchors its global state to a different home, so it was NOT asked to serve ${root}.\n` +
        `  this process: ${homes.ours}\n` +
        `  that daemon:  ${homes.theirs}\n` +
        "Registering across that boundary would write into the daemon's project registry, not ours.",
    };
  }
  // `unknown` DELIBERATELY FALLS THROUGH AND POSTS. The "RESIDUAL EXPOSURE"
  // block above states what that leaves open, why it is left open, and the
  // measurement behind the decision.
  // ONE signal for the whole exchange, exactly as `probeDaemon` does: aborting
  // tears down the response BODY stream too, so a daemon that sends headers and
  // then stalls mid-body is bounded by the same budget as the connect phase —
  // otherwise `res.json()` below just becomes the new place to hang forever.
  const ourHome = callerGlobalHome();
  const signal = AbortSignal.timeout(DETACH_HEALTH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Declare our home in the body as well as probing for theirs. The probe
      // is the primary guard; this is defense in depth for the reverse pairing,
      // where a NEW daemon receives a post from an OLD CLI that never probed.
      // The field is omitted when we cannot determine our own home, and the
      // route reads absence as "no opinion", never as a mismatch.
      body: JSON.stringify({
        path: root,
        ...(alias ? { alias } : {}),
        ...(ourHome !== undefined ? { [PROJECTS_CLIENT_HOME_FIELD]: ourHome } : {}),
      }),
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
      : hot.kind === "foreign-home"
        ? // Not a failure, a refusal on our side: that daemon keeps its global
          // state somewhere else, so registering into it would leave the row in
          // a registry this process never reads.
          `\n  (live registration SKIPPED: that daemon's global home is ${hot.daemonHome}, ours is ${hot.ourHome})`
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
