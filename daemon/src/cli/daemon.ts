/**
 * `hayven daemon <start|stop|status>` — daemon control.
 *
 * `start` is a foreground server for v1. `stop` sends SIGTERM to the PID
 * recorded in the project's pidfile. `status` reports the current state.
 */
import { buildApp } from "../daemon/server.ts";
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
import { requireProject } from "./_shared.ts";
import { VERSION } from "../version.ts";

export async function runDaemon(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "status";
  switch (sub) {
    case "start":
      return startDaemon(args);
    case "stop":
      return stopDaemon();
    case "status":
      return statusDaemon();
    default:
      process.stderr.write(`unknown daemon subcommand: ${sub}\n`);
      return 2;
  }
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
  const { paths } = ctx;

  // Fix: honor `--port`/`--host` overrides (previously silently ignored — the
  // daemon always bound config.daemon_port/daemon_host). Build the effective
  // bind config from the project config, then apply validated overrides.
  const config = { ...ctx.config };

  const hostFlag = args.flags["host"];
  if (typeof hostFlag === "string" && hostFlag.length > 0) {
    config.daemon_host = hostFlag;
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
    config.daemon_port = port;
  }

  // Refuse to start twice.
  const existing = daemonStatus(paths.pidFile);
  if (existing.state === "running") {
    process.stderr.write(`daemon already running (pid ${existing.pid})\n`);
    return 1;
  }
  if (existing.state === "stale") {
    logger.warn("stale pidfile detected; removing", { pid: existing.pid });
    removePidFile(paths.pidFile);
  }

  const db = new Db(paths.sqliteFile);
  const migration = db.migrate();
  if (migration.crdtCutover) {
    logger.warn(
      `crdt_migration: dropped legacy v0.0.1 SQL state (traces=${migration.crdtCutover.droppedObservations}, claims=${migration.crdtCutover.droppedClaims}) — pre-MVP, intentional per ARCHITECTURE.md §13.4`,
    );
  }

  // Shared CRDT state: writer ID + HLC + in-memory CRDTs + op-log,
  // hydrated from .hayven/crdt/ on construction.
  const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile });
  logger.info("crdt hydrated", {
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
      logger,
    });
    return drainIngest({ db, nodesDir: paths.nodesDir, run, logger, repoRoot: paths.repoRoot });
  }

  const ingest: IngestController = {
    current: () => inFlight,
    // Queues behind any in-flight ingest rather than throwing — callers get
    // serialized execution, not a "already running" error.
    start: (_options): Promise<IngestResult> => runIngestExclusive(fullIngest),
  };

  const app = buildApp({
    db,
    config,
    paths,
    logger,
    ingest,
    crdt,
    daemonVersion: VERSION,
    // Native version is populated on first `ingest` from the `start` record;
    // until then we just surface whether the binary was located.
    nativeVersion: tryLocateNativeBinary({ repoRoot: paths.repoRoot }) ? "present" : undefined,
  });

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
      logger: logger.child("watch"),
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
        logger.info("watch: incremental re-ingest", { changed: changed.size, deleted: deleted.size });
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
              logger: logger.child("watch.parse"),
              files: [...changed],
            });
            await drainIngest({ db, nodesDir: paths.nodesDir, run, logger: logger.child("watch.ingest"), repoRoot: paths.repoRoot });

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
                logger.info("watch: re-resolved cross-file edges", { fixed });
              }
            } catch (rerr) {
              logger.warn("watch: cross-file edge re-resolution failed (non-fatal)", {
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
                  logger: logger.child("verify.parse"),
                }),
                typecheck: defaultTypecheck({ root: paths.repoRoot, logger: logger.child("verify.type") }),
                logger: logger.child("verify"),
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
                logger.warn("verify: merge_rejected — flagged in read cache (CRDT NOT rolled back)", {
                  failures: verify.failures.length,
                  files: [...new Set(verify.failures.map((f) => f.file))],
                });
              }
            } catch (verr) {
              // The gate is advisory; a gate error must never break ingest.
              logger.warn("verify: gate errored — skipping (merge already materialized)", {
                error: (verr as Error).message,
              });
            }
          } catch (err) {
            logger.warn("watch: incremental re-ingest failed", { error: (err as Error).message });
          }
        });
      },
      onOverflow: async ({ dropped, sinceMs }) => {
        logger.warn("watch: overflow — full re-ingest", { dropped, sinceMs });
        try {
          await runIngestExclusive(fullIngest);
        } catch (err) {
          logger.warn("watch: full re-ingest after overflow failed", { error: (err as Error).message });
        }
      },
    });
  } else {
    logger.warn("hayven-native binary not found — file watcher disabled");
  }

  writePidFile(paths.pidFile);
  installShutdownHandlers(paths.pidFile, async () => {
    logger.info("shutting down");
    if (watcher) await watcher.stop();
    crdt.close();
    db.close();
  });

  // Bind. `app.listen` calls `Bun.serve` synchronously, which THROWS on
  // EADDRINUSE — without this guard a second `daemon start` on a port already
  // bound by another project's daemon would crash with a raw stack trace (or,
  // worse on some platforms, appear to double-bind). Catch it, print a clean
  // message, release our pidfile, and exit non-zero.
  try {
    app.listen({ hostname: config.daemon_host, port: config.daemon_port });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    removePidFile(paths.pidFile);
    if (watcher) await watcher.stop();
    crdt.close();
    db.close();
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
  logger.info("listening", { host: boundHost, port: boundPort });
  process.stdout.write(
    `hayvend listening on http://${boundHost}:${boundPort}/ (pid ${process.pid})\n` +
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
