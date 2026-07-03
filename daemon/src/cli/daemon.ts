/**
 * `hayven daemon <start|stop|status>` — daemon control.
 *
 * `start` is a foreground server for v1. `stop` sends SIGTERM to the PID
 * recorded in the project's pidfile. `status` reports the current state.
 */
import {
  buildMultiProjectApp,
  wireBranchAwareDb,
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
import { rootLogger } from "../util/log.ts";
import type { ParsedArgs } from "../cli.ts";
import { Db } from "../db/queries.ts";
import { existsSync } from "node:fs";
import type { HayvenConfig } from "../config/defaults.ts";
import { loadConfig } from "../config/load.ts";
import { hayvenPathsFor, type HayvenPaths } from "../util/paths.ts";
import {
  readRegistry,
  registerProject,
  unregisterProject,
  type ProjectEntry,
} from "../daemon/registry.ts";
import { requireProject } from "./_shared.ts";
import { VERSION } from "../version.ts";

const DAEMON_USAGE = `hayven daemon <subcommand>

  start                    Start the daemon (foreground). Serves the cwd project
                           plus every registered project. --port/--host override
                           the primary's bind address.
  stop                     Send SIGTERM to the running daemon (via its pidfile).
  status                   Report whether the daemon is running.
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
function registerDaemonProject(args: ParsedArgs): number {
  const pathArg = args.positionals[1];
  const root = pathArg ?? process.cwd();
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

async function startDaemon(args: ParsedArgs): Promise<number> {
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
  const primaryConfig = { ...ctx.config };

  const hostFlag = args.flags["host"];
  if (typeof hostFlag === "string" && hostFlag.length > 0) {
    primaryConfig.daemon_host = hostFlag;
  } else if (hostFlag === true) {
    process.stderr.write("error: --host requires a value, e.g. --host 0.0.0.0\n");
    return 2;
  }

  const portFlag = args.flags["port"];
  if (portFlag !== undefined && portFlag !== false) {
    if (portFlag === true) {
      process.stderr.write("error: --port requires a value, e.g. --port 7878\n");
      return 2;
    }
    const port = Number(portFlag);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`error: --port must be an integer in 1..65535 (got ${portFlag})\n`);
      return 2;
    }
    primaryConfig.daemon_port = port;
  }

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
   * Build the full per-project runtime — everything scoped to ONE project: the
   * served db, migration, CRDT state, the serialized ingest chain, and the
   * native file watcher with its incremental re-ingest (+ Layer B verify gate +
   * cross-file edge re-resolution). Returns the wired {@link ServerDependencies}
   * for this project plus a bounded `shutdown`.
   *
   * Does NOT build an Elysia app: the daemon builds ONE app over ALL projects.
   */
  function initProject(alias: string, paths: HayvenPaths, config: HayvenConfig): ProjectRuntime {
    const plog = logger.child(alias);

    const db = new Db(paths.sqliteFile);
    const migration = db.migrate();
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
      });
      return drainIngest({ db, nodesDir: paths.nodesDir, run, logger: plog, repoRoot: paths.repoRoot });
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
          // Purge stale rows for every affected file FIRST, so the re-parse is
          // a true reconcile (handles entities removed from a modified file
          // and files deleted outright), not an additive upsert. Also clear any
          // prior Layer B verify-gate state for the affected files so a file
          // that now passes loses its stale `merge_rejected` flag (§17.2).
          for (const f of deleted) db.deleteNodesByFile(f);
          for (const f of changed) db.deleteNodesByFile(f);
          db.clearMergeState([...changed, ...deleted]);
          if (changed.size === 0) return;
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
              const fixed = reresolveAllEdges(db);
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

    // Build this project's request deps. buildMultiProjectApp reads them through
    // its per-request facade; wireBranchAwareDb is a no-op unless a `dbRef`
    // holder is supplied (this leaner build serves a fixed per-project db).
    const deps: ServerDependencies = {
      db,
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
      if (watcher) await watcher.stop();
      // Let any in-flight ingest finish writing before we close the db — closing
      // under a live write is a use-after-close.
      await ingestChain.catch(() => undefined);
      crdt.close();
      db.close();
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

  const app = buildMultiProjectApp({
    primary: primaryAlias,
    projects: new Map([...runtimes].map(([a, r]) => [a, r.deps])),
    logger,
    daemonVersion: VERSION,
    nativeVersion: primaryRuntime.deps.nativeVersion,
  });

  const config = primaryConfig;
  const shutdownAll = async (): Promise<void> => {
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

function stopDaemon(): number {
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
    return 0;
  } catch (err) {
    process.stderr.write(`failed to signal pid ${pid}: ${(err as Error).message}\n`);
    return 1;
  }
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
