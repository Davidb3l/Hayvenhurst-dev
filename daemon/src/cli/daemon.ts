/**
 * `hayven daemon <start|stop|status>` — daemon control.
 *
 * `start` DETACHES by default: it re-execs this CLI as a background child
 * (`--foreground` internally), redirects stdio to the daemon log, unrefs the
 * child so it survives the launching shell/session, waits for the health
 * endpoint, and exits 0. When a healthy hayven daemon already owns the port
 * (started from another repo), `start` registers this project with it instead
 * of failing with EADDRINUSE. `--foreground` keeps the classic in-terminal
 * server for CI, tests, and external supervisors. `stop` sends SIGTERM to the
 * PID recorded in the project's pidfile. `status` reports the current state.
 */
import {
  buildMultiProjectApp,
  wireBranchAwareDb,
  type DbRef,
  type ProjectAddResult,
  type ServerDependencies,
} from "../daemon/server.ts";
import {
  daemonStatus,
  installShutdownHandlers,
  isAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from "../daemon/lifecycle.ts";
import type { IngestController } from "../daemon/routes/ingest.ts";
import { CrdtState } from "../crdt/state.ts";
import { reresolveAllEdges, runIngest as drainIngest, type IngestResult } from "../graph/ingest.ts";
import { locateNativeBinary, tryLocateNativeBinary } from "../native/locate.ts";
import { startParse } from "../native/process.ts";
import {
  defaultTypecheck,
  nativeParseRunner,
  verifyMerge,
} from "../conflict/verify.ts";
import { startWatch, type WatchEvent, type WatchSupervisor } from "../native/watcher.ts";
import { emitCodeChanged } from "../spine.ts";
import { rootLogger } from "../util/log.ts";
import type { ParsedArgs } from "../cli.ts";
import { Db } from "../db/queries.ts";
import { activeBranchKey, resolveWriteIndex, resolveWriteIndexForKey } from "../db/branch_index.ts";
import type { HayvenConfig } from "../config/defaults.ts";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  buildDetachedCommand,
  probeDaemon,
  waitForDaemon,
  DETACH_HEALTH_TIMEOUT_MS,
  type HayvenHealth,
} from "../daemon/detach.ts";
import { canonicalRoot, globalLogsDir, hayvenPathsFor, type HayvenPaths } from "../util/paths.ts";
import type { Logger } from "../util/log.ts";
import { loadConfig } from "../config/load.ts";
import {
  readRegistry,
  registerProject,
  unregisterProject,
  type ProjectEntry,
} from "../daemon/registry.ts";
import { hotAddToRunningDaemon, requireProject } from "./_shared.ts";
import { VERSION } from "../version.ts";

/** Hard cap on repos one daemon serves live — a DoS backstop for the add endpoint
 *  (each project opens a Db + native watcher + branch poller). */
const MAX_LIVE_PROJECTS = 64;
/** Grace window before a live-removed project's Db is closed, so a request that
 *  selected it just before removal finishes reading instead of hitting a closed
 *  handle. Bounded — a long in-flight query beyond this still races (rare; a
 *  closed-Db read throws → a clean 500, never corruption). */
const REMOVE_GRACE_MS = 250;

/**
 * How often the daemon polls `.git/HEAD` (via {@link activeBranchKey}) to detect
 * a `git checkout` and re-point its served index to the new branch. The native
 * file watcher does NOT reliably observe `.git/HEAD`, so branch changes are
 * found by polling, not by the watcher. 2s is responsive without being chatty
 * (it is a cheap fs read of one small file).
 */
export const BRANCH_POLL_INTERVAL_MS = 2000;

/** How long shutdown waits for an in-flight ingest/re-point to settle before
 *  closing the db. Bounded so a stuck ingest can't hang shutdown forever. */
export const SHUTDOWN_DRAIN_MS = 5000;

/**
 * Await an in-flight ingest/re-point (the serialized `ingestChain`) before we
 * close the db on shutdown — otherwise `db.close()` can fire while a `drainIngest`
 * is mid-write, and the write throws "Database was closed" (use-after-close). The
 * wait is BOUNDED: if the chain hasn't settled in `timeoutMs` we proceed anyway
 * so a wedged ingest can't block process exit. Resolves regardless of whether the
 * chain fulfilled or rejected (we only care that it's no longer writing).
 */
export async function drainIngestChain(
  chain: Promise<unknown>,
  timeoutMs: number,
): Promise<"drained" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const drained = chain.then(
    () => "drained" as const,
    () => "drained" as const,
  );
  const result = await Promise.race([drained, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * Dependencies for {@link repointToBranch} — the LIVE branch re-point. Factored
 * out of `startDaemon` so it is deterministically testable WITHOUT a real
 * long-lived HTTP server (the test drives this function directly).
 */
export interface RepointDeps {
  readonly dbRef: DbRef;
  readonly paths: HayvenPaths;
  readonly config: HayvenConfig;
  readonly logger: Logger;
  /**
   * Run `fn` on the SAME serialized ingest chain the watcher/API use, so the
   * swap never races a mid-flight ingest writer (review HIGH: concurrent SQLite
   * writers corrupt the index). The re-point happens INSIDE this exclusion.
   */
  readonly runIngestExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Freshen the NEW branch db (full/incremental ingest) so it reflects the
   * branch's current code before it is served. Receives the new db; it runs
   * INSIDE the same exclusion as the swap. A throw here is non-fatal — the swap
   * still happens (a seeded-but-stale index is better than serving the wrong
   * branch), and the next watcher batch reconciles it.
   */
  readonly freshen: (db: Db) => Promise<void>;
}

/**
 * Result of a re-point: the path now served AND the branch key it corresponds
 * to. The poller sets its `lastBranchKey` to `branchKey` (NOT the key it
 * detected) so the poller's transition tracker, `dbRef.branchKey`, and the
 * served index all agree on the SAME key — no desync if a resolution reconciled
 * to a different key than detected.
 */
export interface RepointResult {
  readonly path: string;
  readonly branchKey: string | null;
}

/**
 * Re-point the served db to `newKey`'s branch index, serialized through the
 * ingest chain. Resolves (seeding on first touch) FOR `newKey` specifically —
 * NOT "whatever `.git/HEAD` says at execution time" — then migrates + freshens
 * the new branch index, SWAPS it into `dbRef.current`, and closes the OLD db.
 * Returns the path + branch key now served.
 *
 * (A) Consistency: the swap target is the branch the poller DETECTED (`newKey`).
 * `freshen()` can take seconds; a `git checkout` during that window must not
 * retarget the swap to a different branch than the poller already claimed. We
 * resolve FOR `newKey` (via `resolveWriteIndexForKey`), and the returned
 * `branchKey` is what the poller writes back to `lastBranchKey`, so all three
 * (poller tracker, `dbRef.branchKey`, served index) stay in lockstep.
 *
 * (B) Never serve an EMPTY index: if `freshen` throws AND the new index was not
 * seeded (no sibling / no legacy → a freshly-migrated empty Db with no nodes),
 * we do NOT swap — we keep serving the OLD index, discard `next`, and warn. A
 * seeded index (has content) or a successful freshen swaps as before. A later
 * tick reconciles once the tree yields records.
 *
 * (C) Eviction safety: resolution protects BOTH `newKey` and the currently-
 * served (old) branch key, so the still-open OLD branch dir is never the LRU
 * victim mid-swap.
 *
 * No-op (returns the current path/key) when `newKey` is `null` — outside a git
 * repo or with per-branch caching disabled, `activeBranchKey` is null and
 * behavior is UNCHANGED. The swap runs entirely inside `runIngestExclusive`, so
 * no ingest is mid-write when the db handle is replaced.
 */
export async function repointToBranch(deps: RepointDeps, newKey: string | null): Promise<RepointResult> {
  const { dbRef, paths, config, logger, runIngestExclusive, freshen } = deps;
  if (newKey === null) return { path: dbRef.path, branchKey: dbRef.branchKey };

  return runIngestExclusive(async () => {
    // Resolve FOR the DETECTED key (not a fresh HEAD read), protecting the
    // still-open OLD served branch from eviction while we hold it (C).
    const resolved = resolveWriteIndexForKey(paths, config, newKey, {
      seed: true,
      keepAlsoKey: dbRef.branchKey ?? undefined,
    });
    // If the resolver lands on the SAME file we already serve, there is nothing
    // to swap (already on this branch). Reconcile `dbRef.branchKey` to the
    // resolved key so the served holder + poller agree even in this no-op.
    if (resolved.path === dbRef.path) {
      dbRef.branchKey = resolved.branchKey;
      return { path: dbRef.path, branchKey: resolved.branchKey };
    }

    const next = new Db(resolved.path);
    next.migrate();
    const seeded = resolved.seededFrom !== null;
    let freshenOk = false;
    try {
      await freshen(next);
      freshenOk = true;
    } catch (err) {
      logger.warn("watch: branch re-point freshen failed", {
        branchKey: resolved.branchKey,
        seeded,
        error: (err as Error).message,
      });
    }

    // (B) Only swap when the new index has real content: it freshened OK, OR it
    // was seeded (from a sibling/legacy), OR — belt-and-suspenders — it happens
    // to hold nodes already. If freshen failed on a NON-seeded (empty) index,
    // keep serving the OLD index rather than swapping in an empty one.
    const hasContent = freshenOk || seeded || next.counts().nodes > 0;
    if (!hasContent) {
      logger.warn(
        "watch: branch re-point ABORTED — freshen failed on an empty (unseeded) index; " +
          `keeping the current branch ${dbRef.branchKey ?? "(legacy)"} (${dbRef.path})`,
        { detectedKey: newKey },
      );
      try {
        next.close();
      } catch (err) {
        logger.warn("watch: closing discarded branch db failed (non-fatal)", {
          error: (err as Error).message,
        });
      }
      // Served index unchanged; report the still-served key so the poller
      // reconciles `lastBranchKey` back to what is ACTUALLY served (a later tick
      // re-attempts once the tree yields records).
      return { path: dbRef.path, branchKey: dbRef.branchKey };
    }

    const old = dbRef.current;
    // SWAP — subsequent requests + ingests resolve through `dbRef.current`.
    dbRef.current = next;
    dbRef.path = resolved.path;
    dbRef.branchKey = resolved.branchKey;
    try {
      old.close();
    } catch (err) {
      logger.warn("watch: closing previous branch db failed (non-fatal)", {
        error: (err as Error).message,
      });
    }

    logger.info(`watch: re-pointed to branch ${resolved.branchKey ?? "(legacy)"} (${resolved.path})`);
    return { path: resolved.path, branchKey: resolved.branchKey };
  });
}

const DAEMON_USAGE = `hayven daemon <subcommand>

  start                    Start the daemon detached (background) and return once
                           it is healthy. Serves the cwd project plus every
                           registered project; if a hayven daemon already owns
                           the port, registers this project with it instead.
                           --foreground runs it in this terminal (CI/supervisors);
                           --port/--host override the primary's bind address.
  stop                     Send SIGTERM to the running daemon (via its pidfile).
  status                   Report whether the daemon is running.
  restart                  Alias for stop + start.
  logs                     Tail the daemon logs.
  register [<path>]        Register a project so the daemon serves it. Defaults
                           to the cwd project. --alias <x> names it.
  projects                 List registered projects (alias → root). --json for JSON.
  unregister <alias|path>  Remove a project from the registry.
`;

export async function runDaemon(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  switch (sub) {
    case "start":
      return startDaemon(args);
    case "stop":
      return stopDaemon();
    case "status":
      return statusDaemon();
    case "register":
      return registerDaemonProject(args);
    case "projects":
      return listDaemonProjects(args);
    case "unregister":
      return unregisterDaemonProject(args);
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(DAEMON_USAGE);
      return 0;
    default:
      process.stderr.write(`unknown daemon subcommand: ${sub}\n\n${DAEMON_USAGE}`);
      return 2;
  }
}

/**
 * `hayven daemon register [<path>] [--alias <x>]` — add a project to the
 * multi-project registry so a (re)started daemon serves it. Idempotent by root.
 * With no path arg, registers the cwd project.
 */
async function registerDaemonProject(args: ParsedArgs): Promise<number> {
  const pathArg = args.positionals[1];
  const root = canonicalRoot(pathArg ?? process.cwd());
  const aliasFlag = args.flags["alias"];
  const alias = typeof aliasFlag === "string" && aliasFlag.length > 0 ? aliasFlag : undefined;
  if (aliasFlag === true) {
    process.stderr.write("error: --alias requires a value, e.g. --alias myrepo\n");
    return 2;
  }
  let entry: ProjectEntry;
  try {
    entry = registerProject(root, alias);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`registered ${entry.alias} → ${entry.root}\n`);

  // If a daemon is already up, hot-add so the repo appears WITHOUT a restart.
  const cfg = loadConfig(root).config;
  const base = `http://${cfg.daemon_host}:${cfg.daemon_port}`;
  const hot = await hotAddToRunningDaemon(root, base, alias);
  switch (hot.kind) {
    case "added":
      process.stdout.write(`added live to the running daemon (no restart needed)\n`);
      break;
    case "exists":
      process.stdout.write(`already served by the running daemon\n`);
      break;
    case "error":
      process.stderr.write(`note: daemon reachable but did not add it: ${hot.message}\n`);
      break;
    case "no-daemon":
      process.stdout.write(`no running daemon — it will load on the next \`hayven daemon start\`\n`);
      break;
  }
  return 0;
}

/**
 * `hayven daemon projects [--json]` — list the registered projects. Human output
 * is an aligned two-column table; `--json` prints the raw entry array.
 */
function listDaemonProjects(args: ParsedArgs): number {
  const entries = readRegistry();
  if (args.flags["json"] === true || args.flags["json"] === "true") {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write("no registered projects\n");
    return 0;
  }
  const aliasWidth = Math.max(5, ...entries.map((e) => e.alias.length));
  process.stdout.write(`${"ALIAS".padEnd(aliasWidth)}  ROOT\n`);
  for (const e of entries) {
    process.stdout.write(`${e.alias.padEnd(aliasWidth)}  ${e.root}\n`);
  }
  return 0;
}

/**
 * `hayven daemon unregister <alias|path>` — remove a project from the registry.
 */
function unregisterDaemonProject(args: ParsedArgs): number {
  const arg = args.positionals[1];
  if (!arg) {
    process.stderr.write("error: unregister requires an alias or path\n");
    return 2;
  }
  const removed = unregisterProject(arg);
  process.stdout.write(removed ? `unregistered ${arg}\n` : `not found: ${arg}\n`);
  return 0;
}

/** A fully-wired per-project runtime: its request deps + a bounded shutdown. */
interface ProjectRuntime {
  readonly alias: string;
  readonly deps: ServerDependencies;
  readonly shutdown: () => Promise<void>;
}

/**
 * Apply validated `--port`/`--host` overrides onto a copy of `config`.
 * Returns the effective config, or an exit code (2) after printing a usage
 * error. Shared by the detached parent (to know where to probe/poll) and the
 * foreground server (to know where to bind) so the two can never disagree.
 */
function applyBindOverrides(
  args: ParsedArgs,
  config: HayvenConfig,
): { config: HayvenConfig } | { exitCode: number } {
  const effective = { ...config };

  const hostFlag = args.flags["host"];
  if (typeof hostFlag === "string" && hostFlag.length > 0) {
    effective.daemon_host = hostFlag;
  } else if (hostFlag === true) {
    process.stderr.write("error: --host requires a value, e.g. --host 0.0.0.0\n");
    return { exitCode: 2 };
  }

  const portFlag = args.flags["port"];
  if (portFlag !== undefined && portFlag !== false) {
    if (portFlag === true) {
      process.stderr.write("error: --port requires a value, e.g. --port 7878\n");
      return { exitCode: 2 };
    }
    const port = Number(portFlag);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`error: --port must be an integer in 1..65535 (got ${portFlag})\n`);
      return { exitCode: 2 };
    }
    effective.daemon_port = port;
  }
  return { config: effective };
}

/** Render the "serving N project(s): a, b" line from a health payload. */
function renderServing(health: HayvenHealth): string {
  const aliases = (health.projects ?? []).map((p) => p.alias);
  if (aliases.length === 0) return "";
  return `serving ${aliases.length} project(s): ${aliases.join(", ")}\n`;
}

/**
 * DEFAULT `hayven daemon start`: spawn the daemon as a DETACHED background
 * process and return once it is healthy.
 *
 * Why: the foreground server dies with the shell/session that launched it —
 * clear a Claude Code session (or close the terminal) and every other repo's
 * tools start failing with "could not reach daemon". Detaching (own process
 * group via `detached: true`, stdio redirected to the daemon log, `unref()` so
 * the parent exits freely) makes the daemon survive its launcher.
 *
 * Shared-daemon path: when a HEALTHY hayven daemon already owns the port
 * (started from another repo — one daemon serves N projects), we do NOT fail
 * with EADDRINUSE: we verify it via `/api/health`, ensure THIS project is
 * registered with it (live hot-add), and exit 0. A port held by something that
 * is not a hayven daemon stays a clear error.
 */
async function startDetachedDaemon(args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const bind = applyBindOverrides(args, ctx.config);
  if ("exitCode" in bind) return bind.exitCode;
  const config = bind.config;
  const base = `http://${config.daemon_host}:${config.daemon_port}`;

  // Is something already answering on the target address?
  const probe = await probeDaemon(base);
  if (probe.kind === "foreign") {
    process.stderr.write(
      `error: ${config.daemon_host}:${config.daemon_port} is in use by something that is NOT a hayven daemon.\n` +
        "Stop it, or start with a free port (`hayven daemon start --port <N>`).\n",
    );
    return 1;
  }
  if (probe.kind === "hayven") {
    return ensureServedByRunningDaemon(base, probe.health, ctx.paths.repoRoot);
  }

  // Nothing listening. If the pidfile claims a LIVE pid, the daemon is probably
  // bound elsewhere (config/port drift) — refuse rather than start a duplicate.
  const existing = daemonStatus(ctx.paths.pidFile);
  if (existing.state === "running") {
    process.stderr.write(
      `error: pidfile reports a live daemon (pid ${existing.pid}) but ${base} is unreachable — ` +
        "it may be bound to a different host/port.\n" +
        "Stop it first (`hayven daemon stop`) or check `hayven config daemon_port`.\n",
    );
    return 1;
  }
  if (existing.state === "stale") {
    removePidFile(ctx.paths.pidFile); // dead pid — clean and proceed
  }

  // Re-exec ourselves as the detached child, stdio → the daemon out-log.
  const extraArgs: string[] = [];
  if (typeof args.flags["host"] === "string") extraArgs.push("--host", args.flags["host"]);
  if (typeof args.flags["port"] === "string") extraArgs.push("--port", args.flags["port"]);
  const cmd = buildDetachedCommand({
    execPath: process.execPath,
    entryScript: process.argv[1],
    extraArgs,
  });

  const logPath = join(globalLogsDir(), "daemon.out.log");
  let child;
  try {
    mkdirSync(globalLogsDir(), { recursive: true });
    const fd = openSync(logPath, "a");
    try {
      child = spawn(cmd[0]!, cmd.slice(1), {
        cwd: ctx.paths.repoRoot,
        detached: true, // own process group/session — survives the parent's terminal
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(`error: failed to spawn the daemon: ${(err as Error).message}\n`);
    return 1;
  }
  child.unref(); // let THIS process exit without waiting on the child

  const health = await waitForDaemon(base, { timeoutMs: DETACH_HEALTH_TIMEOUT_MS });
  if (health === null) {
    process.stderr.write(
      `error: daemon did not become healthy at ${base} within ${Math.round(DETACH_HEALTH_TIMEOUT_MS / 1000)}s.\n` +
        `Check the log: ${logPath}\n` +
        "(or run it in this terminal: `hayven daemon start --foreground`)\n",
    );
    return 1;
  }

  // TOCTOU guard: between our `unreachable` probe and the child's bind, ANOTHER
  // daemon (e.g. a concurrent `daemon start` from a different repo) may have won
  // the port — our child then died on EADDRINUSE while a hayven daemon still
  // answers. Verify the answering daemon serves THIS repo before declaring
  // success; if not, fall into the same register-with-it path as the pre-spawn
  // probe instead of printing a false "started".
  const ours = canonicalRoot(ctx.paths.repoRoot);
  const servesUs =
    (health.projects ?? []).some((p) => canonicalRoot(p.root) === ours) ||
    (typeof health.root === "string" && canonicalRoot(health.root) === ours);
  if (!servesUs) {
    return ensureServedByRunningDaemon(base, health, ctx.paths.repoRoot);
  }

  const pid = readPidFile(ctx.paths.pidFile) ?? child.pid;
  process.stdout.write(
    `hayven daemon started (pid ${pid}) — listening on ${base}/\n` +
      renderServing(health) +
      "It runs detached from this shell; stop it with `hayven daemon stop`.\n",
  );
  return 0;
}

/**
 * `daemon start` found a healthy hayven daemon already on the port: make sure
 * it serves THIS project (registering it live when it doesn't) and exit 0 —
 * one long-lived daemon serves every registered repo; a second `start` from a
 * new repo should join it, not crash on EADDRINUSE.
 */
async function ensureServedByRunningDaemon(
  base: string,
  health: HayvenHealth,
  repoRoot: string,
): Promise<number> {
  const ours = canonicalRoot(repoRoot);
  const served = (health.projects ?? []).find((p) => canonicalRoot(p.root) === ours);
  if (served) {
    process.stdout.write(
      `daemon already running at ${base}/ — serving this project as '${served.alias}'.\n` + renderServing(health),
    );
    return 0;
  }
  // Legacy/single-project daemon whose primary root IS this repo.
  if (typeof health.root === "string" && canonicalRoot(health.root) === ours) {
    process.stdout.write(`daemon already running at ${base}/ — serving this project.\n`);
    return 0;
  }
  const hot = await hotAddToRunningDaemon(repoRoot, base);
  if ((hot.kind === "added" || hot.kind === "exists") && hot.alias.length > 0) {
    process.stdout.write(`daemon already running at ${base}/ — now serving '${hot.alias}'.\n`);
    return 0;
  }
  const detail =
    hot.kind === "error"
      ? hot.message
      : "it does not support live project registration (old version?)";
  process.stderr.write(
    `error: a hayven daemon is running at ${base} but this project could not be registered with it: ${detail}\n` +
      "Restart it from this repo (`hayven daemon stop && hayven daemon start`).\n",
  );
  return 1;
}

async function startDaemon(args: ParsedArgs): Promise<number> {
  // Detach by default; `--foreground` keeps the in-terminal server (CI, tests,
  // supervisors, and the re-exec'd detached child itself).
  const foreground = args.flags["foreground"] === true || args.flags["foreground"] === "true";
  return foreground ? startForegroundDaemon(args) : startDetachedDaemon(args);
}

async function startForegroundDaemon(args: ParsedArgs): Promise<number> {
  const logger = rootLogger().child("daemon");
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const primaryPaths = ctx.paths;

  // Fix: honor `--port`/`--host` overrides (previously silently ignored — the
  // daemon always bound config.daemon_port/daemon_host). Build the effective
  // bind config from the PRIMARY project config, then apply validated overrides.
  // The daemon binds ONE port, so only the primary's bind config matters.
  const bind = applyBindOverrides(args, ctx.config);
  if ("exitCode" in bind) return bind.exitCode;
  const primaryConfig = bind.config;

  // Refuse to start twice (checked on the PRIMARY's pidfile — the one this
  // process writes and `hayven daemon stop` reads).
  const existing = daemonStatus(primaryPaths.pidFile);
  if (existing.state === "running") {
    process.stderr.write(`daemon already running (pid ${existing.pid})\n`);
    return 1;
  }
  if (existing.state === "stale") {
    logger.warn("stale pidfile detected; removing", { pid: existing.pid });
    removePidFile(primaryPaths.pidFile);
  }

  /**
   * Build the full per-project runtime — everything that is scoped to ONE
   * project: the branch-resolved served db (behind a swappable {@link DbRef}),
   * migration, CRDT state, the serialized ingest chain, the native file watcher
   * with its incremental re-ingest (+ Layer B verify gate + cross-file edge
   * re-resolution), and the live branch-re-point poller. Returns the wired
   * {@link ServerDependencies} for this project plus a bounded `shutdown`.
   *
   * Does NOT build an Elysia app: the daemon builds ONE app over ALL projects.
   */
  function initProject(alias: string, paths: HayvenPaths, config: HayvenConfig): ProjectRuntime {
    const plog = logger.child(alias);

    // Open the BRANCH-RESOLVED index — the SAME index `init`/reindex write to and
    // `openProjectDb` (the daemonless read path) reads from for the current branch.
    // `resolveWriteIndex` mirrors `resolveReadIndex`'s branch resolution (via
    // `activeBranchKey`), so trace coverage + graph nodes co-locate. Outside a git
    // repo, or when per-branch caching is disabled, this returns the legacy index.
    const resolvedIndex = resolveWriteIndex(paths, config);
    plog.info("index resolved", {
      path: resolvedIndex.path,
      branchKey: resolvedIndex.branchKey,
      usedFallback: resolvedIndex.usedFallback,
    });

    // The served db lives behind a mutable holder so LIVE branch re-pointing can
    // SWAP it (the daemon following a `git checkout`). The facade rewires the
    // route `db` to read `dbRef.current` at request time; the ingest closures
    // read `dbRef.current` too, so post-swap ingests write the new branch's index.
    const dbRef: DbRef = {
      current: new Db(resolvedIndex.path),
      path: resolvedIndex.path,
      branchKey: resolvedIndex.branchKey,
    };
    let lastBranchKey: string | null = resolvedIndex.branchKey;
    const migration = dbRef.current.migrate();
    if (migration.crdtCutover) {
      plog.warn(
        `crdt_migration: dropped legacy v0.0.1 SQL state (traces=${migration.crdtCutover.droppedObservations}, claims=${migration.crdtCutover.droppedClaims}) — pre-MVP, intentional per ARCHITECTURE.md §13.4`,
      );
    }

    // Shared CRDT state: writer ID + HLC + in-memory CRDTs + op-log,
    // hydrated from .hayven/crdt/ on construction.
    const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile });
    plog.info("crdt hydrated", {
      lww: crdt.lww.size,
      gset: crdt.gset.size,
      orset: crdt.orset.active().length,
      diskBytes: crdt.oplog.diskUsage(),
    });

    // Serialize ALL ingest work — API-triggered full ingests, the watcher's
    // incremental re-ingests, and overflow full re-scans — through a single
    // chain. Concurrent runs would otherwise interleave SQLite writers and
    // corrupt the index (review HIGH). `inFlight` is the status marker the
    // /api/ingest route reports via current().
    let inFlight: { startedAt: number } | null = null;
    let ingestChain: Promise<void> = Promise.resolve();
    function runIngestExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const next = ingestChain.then(async () => {
        inFlight = { startedAt: Date.now() };
        try {
          return await fn();
        } finally {
          inFlight = null;
        }
      });
      // Keep the chain alive even if one run rejects.
      ingestChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    }

    async function fullIngest(): Promise<IngestResult> {
      const binary = locateNativeBinary({ repoRoot: paths.repoRoot });
      const run = startParse({
        binary,
        root: paths.repoRoot,
        languages: config.parse_languages,
        jobs: config.parse_jobs,
        timeoutMs: config.ingest_timeout_seconds * 1000,
        logger: plog,
        includeVendored: config.index?.includeVendored ?? false,
        includeFixtures: config.index?.includeFixtures ?? false,
      });
      // Read the CURRENT served db so a post-swap ingest writes the new branch's
      // index, not the one captured at startup.
      return drainIngest({ db: dbRef.current, nodesDir: paths.nodesDir, run, logger: plog, repoRoot: paths.repoRoot });
    }

    const ingest: IngestController = {
      current: () => inFlight,
      // Queues behind any in-flight ingest rather than throwing — callers get
      // serialized execution, not a "already running" error.
      start: (_options): Promise<IngestResult> => runIngestExclusive(fullIngest),
    };

    // Start the long-lived native file watcher (ARCHITECTURE.md §16). Skipped
    // if the binary isn't installed yet — the daemon still works without
    // incremental re-ingest, you just have to `hayven ingest` by hand.
    let watcher: WatchSupervisor | null = null;
    const watcherBinary = tryLocateNativeBinary({ repoRoot: paths.repoRoot });
    if (watcherBinary) {
      watcher = startWatch({
        binary: watcherBinary,
        root: paths.repoRoot,
        debounceMs: 200,
        logger: plog.child("watch"),
        onBatch: async (events: WatchEvent[]) => {
          // Classify by kind so we reconcile deletes + renames, not just
          // re-parse (review HIGH H3: deleted files used to linger in the index
          // forever). A rename's `from` path is treated as a delete.
          const changed = new Set<string>();
          const deleted = new Set<string>();
          for (const e of events) {
            if (e.kind === "delete") {
              deleted.add(e.file);
            } else if (e.kind === "rename") {
              changed.add(e.file);
              if (e.from) deleted.add(e.from);
            } else {
              changed.add(e.file);
            }
          }
          for (const f of changed) deleted.delete(f); // changed wins over a stale delete
          plog.info("watch: incremental re-ingest", { changed: changed.size, deleted: deleted.size });
          await runIngestExclusive(async () => {
            // Snapshot the CURRENT served db. The swap is serialized through this
            // same chain, so within one batch the db never changes underfoot; a
            // post-swap batch writes the new branch's index.
            const db = dbRef.current;
            // Purge stale rows for every affected file FIRST, so the re-parse is
            // a true reconcile (handles entities removed from a modified file
            // and files deleted outright), not an additive upsert. Also clear any
            // prior Layer B verify-gate state for the affected files so a file
            // that now passes loses its stale `merge_rejected` flag (§17.2).
            for (const f of deleted) db.deleteNodesByFile(f);
            for (const f of changed) db.deleteNodesByFile(f);
            db.clearMergeState([...changed, ...deleted]);

            // Suite spine PRODUCER (SUITE_CONTRACTS §2): after this batch is
            // durable, append one `code.changed` event. Best-effort — the emitter
            // itself never throws; this guard only covers the symbol query.
            // `files` = sorted union of changed+deleted (a delete still shows up
            // though its nodes are already gone); `symbols` = the surviving node
            // ids of the changed files.
            const emitSpine = () => {
              if (changed.size === 0 && deleted.size === 0) return;
              try {
                const files = [...new Set([...changed, ...deleted])].sort();
                const symbols: string[] = [];
                const q = db.handle.query<{ id: string }, [string]>(
                  "SELECT id FROM nodes WHERE file = ? AND kind != 'module'",
                );
                for (const f of changed) {
                  for (const r of q.all(f)) symbols.push(r.id);
                }
                emitCodeChanged({ repoRoot: paths.repoRoot, files, symbols });
              } catch (spineErr) {
                plog.warn("watch: spine code.changed emit failed (non-fatal)", {
                  error: (spineErr as Error).message,
                });
              }
            };

            if (changed.size === 0) {
              // Delete-only batch: nodes already purged above and durable, so the
              // deletion is real — emit before returning (no re-parse).
              emitSpine();
              return;
            }
            try {
              const run = startParse({
                binary: watcherBinary,
                root: paths.repoRoot,
                languages: config.parse_languages,
                jobs: config.parse_jobs,
                timeoutMs: config.ingest_timeout_seconds * 1000,
                logger: plog.child("watch.parse"),
                files: [...changed],
              });
              await drainIngest({ db, nodesDir: paths.nodesDir, run, logger: plog.child("watch.ingest"), repoRoot: paths.repoRoot });

              // BL-10 (ARCHITECTURE.md §7 / §10 Q4): an incremental batch only
              // resolves edges within the changed file set, so a caller in an
              // UNCHANGED file that referenced a now-renamed/moved entity keeps a
              // stale `?:<name>` edge. Re-run the §7 resolver against the WHOLE
              // node set — a cheap in-memory pass — so cross-file callers pick up
              // the new id immediately instead of waiting for the next full
              // ingest. Idempotent and additive (it only rewrites `?:` edges).
              try {
                const fixed = reresolveAllEdges(db, paths.repoRoot);
                if (fixed > 0) {
                  plog.info("watch: re-resolved cross-file edges", { fixed });
                }
              } catch (rerr) {
                plog.warn("watch: cross-file edge re-resolution failed (non-fatal)", {
                  error: (rerr as Error).message,
                });
              }

              // Layer B (ARCHITECTURE.md §17.2): re-validate the affected files
              // AFTER the merge is materialized into the read cache. This is
              // advisory — the CRDT/op-log is never rolled back; a failure only
              // raises a `merge_rejected` record and flags the rows so an agent
              // can re-base. Hooked here (not before storage) because this is the
              // narrowest point where an accepted merge has a known affected-file
              // set; the API full-ingest path re-walks the whole repo and has no
              // "merge" semantics, so it is deliberately not gated.
              try {
                const verify = await verifyMerge([...changed], {
                  root: paths.repoRoot,
                  native: nativeParseRunner({
                    binary: watcherBinary,
                    root: paths.repoRoot,
                    languages: config.parse_languages,
                    jobs: config.parse_jobs,
                    timeoutMs: config.ingest_timeout_seconds * 1000,
                    logger: plog.child("verify.parse"),
                  }),
                  typecheck: defaultTypecheck({ root: paths.repoRoot, logger: plog.child("verify.type") }),
                  logger: plog.child("verify"),
                });
                if (!verify.ok) {
                  db.recordMergeRejections(
                    verify.failures.map((f) => ({
                      file: f.file,
                      phase: f.phase,
                      language: f.language,
                      reason: f.reason,
                      detected_at: f.detectedAt,
                    })),
                  );
                  plog.warn("verify: merge_rejected — flagged in read cache (CRDT NOT rolled back)", {
                    failures: verify.failures.length,
                    files: [...new Set(verify.failures.map((f) => f.file))],
                  });
                }
              } catch (verr) {
                // The gate is advisory; a gate error must never break ingest.
                plog.warn("verify: gate errored — skipping (merge already materialized)", {
                  error: (verr as Error).message,
                });
              }

              // Re-ingest is durable (drainIngest returned) — emit the spine
              // event. Inside the try so a failed re-ingest (caught below) never
              // emits a `code.changed` for a change that didn't land.
              emitSpine();
            } catch (err) {
              plog.warn("watch: incremental re-ingest failed", { error: (err as Error).message });
            }
          });
        },
        onOverflow: async ({ dropped, sinceMs }) => {
          plog.warn("watch: overflow — full re-ingest", { dropped, sinceMs });
          try {
            await runIngestExclusive(fullIngest);
          } catch (err) {
            plog.warn("watch: full re-ingest after overflow failed", { error: (err as Error).message });
          }
        },
      });
    } else {
      plog.warn("hayven-native binary not found — file watcher disabled");
    }

    // LIVE branch re-pointing poller. The native watcher does NOT reliably see
    // `.git/HEAD`, so detect a `git checkout` by POLLING the active branch key.
    // When it changes, re-point the served db to the new branch's index (seeded +
    // freshened), serialized through the SAME ingest chain so no ingest is
    // mid-write during the swap. Outside a git repo / with per-branch caching
    // disabled, `activeBranchKey` is null and nothing re-points (UNCHANGED).
    const repointDeps: RepointDeps = {
      dbRef,
      paths,
      config,
      logger: plog,
      runIngestExclusive,
      // Freshen the NEW branch db with a full reconcile so it reflects the
      // branch's current code. Reuses the existing parse→drainIngest path against
      // the passed (new) db. We are already inside `runIngestExclusive`, so this
      // calls `drainIngest` directly rather than re-entering the chain.
      freshen: async (freshDb: Db) => {
        const binary = locateNativeBinary({ repoRoot: paths.repoRoot });
        const run = startParse({
          binary,
          root: paths.repoRoot,
          languages: config.parse_languages,
          jobs: config.parse_jobs,
          timeoutMs: config.ingest_timeout_seconds * 1000,
          logger: plog.child("watch.repoint"),
          includeVendored: config.index?.includeVendored ?? false,
          includeFixtures: config.index?.includeFixtures ?? false,
        });
        await drainIngest({
          db: freshDb,
          nodesDir: paths.nodesDir,
          run,
          logger: plog.child("watch.repoint"),
          repoRoot: paths.repoRoot,
        });
      },
    };
    let repointing = false;
    const branchPoll = setInterval(() => {
      // Skip while a prior re-point is still resolving (poll faster than a full
      // freshen ingest takes). `activeBranchKey` is a cheap one-file fs read.
      if (repointing) return;
      let currentKey: string | null;
      try {
        currentKey = activeBranchKey(paths, config);
      } catch (err) {
        plog.warn("watch: branch poll failed (non-fatal)", { error: (err as Error).message });
        return;
      }
      if (currentKey === lastBranchKey) return;
      const from = lastBranchKey;
      lastBranchKey = currentKey; // claim the transition so we don't double-fire
      repointing = true;
      plog.info("watch: branch change detected", { from, to: currentKey });
      void repointToBranch(repointDeps, currentKey)
        .then((result) => {
          // (A) Reconcile `lastBranchKey` to the key that was ACTUALLY swapped in
          // (or is still served, if the swap was aborted/no-op), so the poller's
          // transition tracker, `dbRef.branchKey`, and the served index all agree
          // on ONE key. Prevents desync / flip-flop when the resolved-or-served
          // key differs from the detected one.
          lastBranchKey = result.branchKey;
        })
        .catch((err) => {
          plog.warn("watch: branch re-point failed", { error: (err as Error).message });
        })
        .finally(() => {
          repointing = false;
        });
    }, BRANCH_POLL_INTERVAL_MS);
    // Don't let the poll timer keep the event loop alive on its own.
    if (typeof branchPoll.unref === "function") branchPoll.unref();

    // Build this project's request deps and rewire `deps.db` → `dbRef.current`
    // at request time. buildMultiProjectApp passes branchAwareDb:false, so it
    // will NOT wire this for us — we must call wireBranchAwareDb ourselves.
    const deps: ServerDependencies = {
      db: dbRef.current,
      dbRef,
      config,
      paths,
      logger: plog,
      ingest,
      crdt,
      daemonVersion: VERSION,
      // Native version is populated on first `ingest` from the `start` record;
      // until then we just surface whether the binary was located.
      nativeVersion: tryLocateNativeBinary({ repoRoot: paths.repoRoot }) ? "present" : undefined,
    };
    wireBranchAwareDb(deps);

    const shutdown = async (): Promise<void> => {
      clearInterval(branchPoll);
      if (watcher) await watcher.stop();
      // Let any in-flight ingest/re-point finish writing before we close the db
      // (bounded) — closing under a live write is a use-after-close.
      const drain = await drainIngestChain(ingestChain, SHUTDOWN_DRAIN_MS);
      if (drain === "timeout") {
        plog.warn("shutdown: ingest still in flight after drain timeout; closing anyway");
      }
      crdt.close();
      dbRef.current.close();
    };

    return { alias, deps, shutdown };
  }

  // Auto-register the cwd project so it's in the registry, and capture its alias
  // as the primary. Every project defaults to the same port, so the primary is
  // the one this process binds + writes a pidfile for.
  let primaryAlias: string;
  try {
    primaryAlias = registerProject(primaryPaths.repoRoot).alias;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Build a de-duplicated, ordered project list: primary first, then each
  // registry entry whose root differs from the primary root.
  const primaryRoot = primaryPaths.repoRoot;
  const toLoad: Array<{ alias: string; paths: HayvenPaths; config: HayvenConfig }> = [
    { alias: primaryAlias, paths: primaryPaths, config: primaryConfig },
  ];
  for (const entry of readRegistry()) {
    if (entry.root === primaryRoot) continue;
    toLoad.push({ alias: entry.alias, paths: hayvenPathsFor(entry.root), config: loadConfig(entry.root).config });
  }

  // Init each project. A broken registry entry (missing `.hayven/` or a throwing
  // initProject) must NOT crash startup — log a warning and skip it.
  const runtimes = new Map<string, ProjectRuntime>();
  for (const p of toLoad) {
    if (!existsSync(p.paths.hayvenDir)) {
      logger.warn("skipping project — no .hayven/ directory", { alias: p.alias, root: p.paths.repoRoot });
      continue;
    }
    try {
      // The primary's config already carries the loaded config (+ --port/--host);
      // others got theirs from loadConfig when the list was built above.
      runtimes.set(p.alias, initProject(p.alias, p.paths, p.config));
    } catch (err) {
      logger.warn("skipping project — initProject failed", {
        alias: p.alias,
        root: p.paths.repoRoot,
        error: (err as Error).message,
      });
    }
  }

  // The primary MUST have loaded (requireProject already proved its .hayven/
  // exists), but guard defensively so we never bind an app with no primary.
  if (!runtimes.has(primaryAlias)) {
    process.stderr.write(`error: failed to load the primary project (${primaryAlias})\n`);
    for (const rt of runtimes.values()) await rt.shutdown();
    return 1;
  }

  const primaryRuntime = runtimes.get(primaryAlias)!;

  // The LIVE served-projects map — the SAME Map object the multi-project facade
  // reads on every request (routing + `/api/health` listing), so mutating it here
  // is picked up with NO restart. Kept in lockstep with `runtimes` (which owns
  // each project's `shutdown`).
  const servedProjects = new Map<string, ServerDependencies>([...runtimes].map(([a, r]) => [a, r.deps]));

  // SSE subscribers for `/api/projects/stream` — notified after any add/remove so
  // an open viewer updates its switcher with no manual refresh.
  const projectListeners = new Set<() => void>();
  const notifyProjectsChanged = (): void => {
    for (const listener of [...projectListeners]) {
      try {
        listener();
      } catch (err) {
        logger.warn("projects: SSE listener threw (ignored)", { error: (err as Error).message });
      }
    }
  };

  // Serialize add/remove so two concurrent requests can't interleave the map +
  // registry mutations (or double-open the same index). Each op waits its turn;
  // a rejection never breaks the chain for the next op.
  let mutationChain: Promise<unknown> = Promise.resolve();
  const serializeMutation = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(fn, fn);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const addProjectLive = (rootArg: string, aliasHint?: string): Promise<ProjectAddResult> =>
    serializeMutation(async () => {
      const root = canonicalRoot(rootArg);
      // Idempotent by CANONICAL (symlink-resolved) root: if we already serve this
      // repo, return it untouched — never double-open the same index.
      const already = [...runtimes.values()].find((rt) => canonicalRoot(rt.deps.paths.repoRoot) === root);
      if (already) return { alias: already.alias, root, added: false };

      if (runtimes.size >= MAX_LIVE_PROJECTS) {
        throw new Error(`project cap reached (${MAX_LIVE_PROJECTS} served) — remove one before adding another`);
      }
      const paths = hayvenPathsFor(root);
      if (!existsSync(paths.hayvenDir)) {
        throw new Error(`no .hayven/ directory at ${root} — run \`hayven init\` there first`);
      }
      // Persist (derives a unique alias), then build + wire the runtime and add it
      // to the live map. `initProject` throws on a broken index — let it propagate
      // to the caller (the route returns 400) WITHOUT mutating any map.
      const entry = registerProject(root, aliasHint);
      const cfg = loadConfig(root).config;
      const runtime = initProject(entry.alias, paths, cfg);
      runtimes.set(entry.alias, runtime);
      servedProjects.set(entry.alias, runtime.deps);
      logger.info("project added live", { alias: entry.alias, root });
      notifyProjectsChanged();
      return { alias: entry.alias, root, added: true };
    });

  const removeProjectLive = (aliasOrRoot: string): Promise<boolean> =>
    serializeMutation(async () => {
      const abs = canonicalRoot(aliasOrRoot);
      let runtime = runtimes.get(aliasOrRoot);
      if (!runtime) runtime = [...runtimes.values()].find((rt) => canonicalRoot(rt.deps.paths.repoRoot) === abs);
      if (!runtime) return false;
      if (runtime.alias === primaryAlias) {
        throw new Error(`cannot remove the primary project (${primaryAlias}) — it owns the daemon's port`);
      }
      // 1. Stop NEW requests from selecting it (drop from the ROUTING map only).
      servedProjects.delete(runtime.alias);
      // 2. Give a request that selected it just before step 1 a bounded window to
      //    finish before its Db is closed.
      await new Promise((r) => setTimeout(r, REMOVE_GRACE_MS));
      // 3. Shut the runtime down (drains ingest, stops watcher/poller, closes Db).
      //    Only AFTER a clean shutdown do we drop ownership + persist + notify, so a
      //    shutdown FAILURE leaves it in `runtimes` (still owned by shutdownAll) and
      //    in the registry rather than orphaning a live Db.
      try {
        await runtime.shutdown();
      } catch (err) {
        throw new Error(`failed to shut down ${runtime.alias}: ${(err as Error).message}`);
      }
      runtimes.delete(runtime.alias);
      unregisterProject(runtime.alias);
      notifyProjectsChanged();
      logger.info("project removed live", { alias: runtime.alias });
      return true;
    });

  const subscribeProjects = (listener: () => void): (() => void) => {
    projectListeners.add(listener);
    return () => {
      projectListeners.delete(listener);
    };
  };

  const app = buildMultiProjectApp({
    primary: primaryAlias,
    projects: servedProjects,
    logger,
    daemonVersion: VERSION,
    nativeVersion: primaryRuntime.deps.nativeVersion,
    addProject: addProjectLive,
    removeProject: removeProjectLive,
    subscribeProjects,
  });

  const config = primaryConfig;
  const shutdownAll = async (): Promise<void> => {
    // Let any in-flight add/remove settle first so we snapshot a quiescent map and
    // don't race a mutation that's mid-`initProject`/`shutdown`.
    await mutationChain.catch(() => undefined);
    for (const rt of runtimes.values()) {
      try {
        await rt.shutdown();
      } catch (err) {
        logger.warn("shutdown: project shutdown failed (non-fatal)", {
          alias: rt.alias,
          error: (err as Error).message,
        });
      }
    }
  };

  writePidFile(primaryPaths.pidFile);
  installShutdownHandlers(primaryPaths.pidFile, async () => {
    logger.info("shutting down");
    await shutdownAll();
  });

  // Bind. `app.listen` calls `Bun.serve` synchronously, which THROWS on
  // EADDRINUSE — without this guard a second `daemon start` on a port already
  // bound by another project's daemon would crash with a raw stack trace (or,
  // worse on some platforms, appear to double-bind). Catch it, print a clean
  // message, release our pidfile, shut down all projects, and exit non-zero.
  try {
    app.listen({ hostname: config.daemon_host, port: config.daemon_port });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    removePidFile(primaryPaths.pidFile);
    await shutdownAll();
    if (e.code === "EADDRINUSE" || /in use|EADDRINUSE/i.test(e.message ?? "")) {
      process.stderr.write(
        `error: ${config.daemon_host}:${config.daemon_port} is already in use — ` +
          "another daemon is bound there.\n" +
          "Stop it (`hayven daemon stop`), or start with a free port (`hayven daemon start --port <N>`).\n",
      );
    } else {
      process.stderr.write(`error: failed to bind ${config.daemon_host}:${config.daemon_port}: ${e.message}\n`);
    }
    return 1;
  }

  // Echo the ACTUAL bound address (may differ from config when overridden).
  const boundHost = app.server?.hostname ?? config.daemon_host;
  const boundPort = app.server?.port ?? config.daemon_port;
  logger.info("listening", { host: boundHost, port: boundPort, projects: runtimes.size });
  const served = [...runtimes.keys()];
  process.stdout.write(
    `hayvend listening on http://${boundHost}:${boundPort}/ (pid ${process.pid})\n` +
      `hayvend: serving ${served.length} project(s): ${served.join(", ")}\n` +
      "Press Ctrl-C to stop.\n",
  );

  // Keep the process alive — Elysia's listen returns synchronously.
  await new Promise<void>(() => {
    // Intentionally never resolves; signal handlers will exit.
  });
  return 0;
}

/** How long `daemon stop` waits for the signaled pid to actually exit. The
 *  daemon's own shutdown drain is bounded (SHUTDOWN_DRAIN_MS per project), so a
 *  healthy daemon dies well within this. */
export const STOP_WAIT_MS = 10_000;

async function stopDaemon(): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const pid = readPidFile(ctx.paths.pidFile);
  if (pid === null) {
    process.stdout.write("daemon is not running\n");
    return 0;
  }
  if (!isAlive(pid)) {
    removePidFile(ctx.paths.pidFile);
    process.stdout.write("stale pidfile removed; daemon is not running\n");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`SIGTERM sent to daemon (pid ${pid})\n`);
  } catch (err) {
    process.stderr.write(`failed to signal pid ${pid}: ${(err as Error).message}\n`);
    return 1;
  }
  // WAIT for the process to actually exit. The daemon keeps answering
  // `/api/health` while its shutdown drains project runtimes, so returning
  // immediately would let a follow-up `daemon start` (the sequence our own
  // error messages recommend) probe the DYING daemon, report "already
  // running", exit 0 — and moments later nothing is running.
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      process.stdout.write(`daemon stopped (pid ${pid})\n`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  process.stderr.write(
    `error: daemon (pid ${pid}) is still shutting down after ${Math.round(STOP_WAIT_MS / 1000)}s — ` +
      "check `hayven daemon status` before restarting.\n",
  );
  return 1;
}

function statusDaemon(): number {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const status = daemonStatus(ctx.paths.pidFile);
  switch (status.state) {
    case "running":
      process.stdout.write(`running (pid ${status.pid})\n`);
      return 0;
    case "stale":
      process.stdout.write(`stale pidfile (pid ${status.pid} is not alive)\n`);
      return 1;
    case "stopped":
      process.stdout.write("stopped\n");
      return 1;
  }
}
