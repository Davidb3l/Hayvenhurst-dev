/**
 * `hayven ingest [path] [--full]` — re-scan and index the codebase.
 *
 * Spawns `hayven-native` and streams its NDJSON into the SQLite index and
 * markdown writer. A whole-repo ingest (no `path` arg) re-parses everything and
 * **clears nodes+edges first**, so repeated runs are idempotent — edges are
 * derived per-parse and would otherwise double their accumulated `weight` on
 * every run. `--full` forces the same clear even for a path-scoped ingest.
 * True file-level incremental updates happen via the daemon's file watcher
 * (which deletes-by-file before re-ingesting the changed set).
 */
import { existsSync, mkdirSync } from "node:fs";

import { gitDiffSince, resolveWriteIndex } from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import {
  readGitHead,
  reresolveAllEdges,
  runIngest as drainIngest,
} from "../graph/ingest.ts";
import { locateNativeBinary, NativeBinaryNotFound } from "../native/locate.ts";
import { startParse } from "../native/process.ts";
import { rootLogger } from "../util/log.ts";
import type { ParsedArgs } from "../cli.ts";
import { isJson, requireProject } from "./_shared.ts";

export async function runIngest(args: ParsedArgs): Promise<number> {
  const logger = rootLogger().child("ingest");
  // Resolve the project from the same cwd `init` used (threaded as a flag), so
  // `hayven init --cwd <dir>`'s first ingest targets <dir>, not process.cwd().
  const cwdFlag = typeof args.flags["cwd"] === "string" ? args.flags["cwd"] : undefined;
  let ctx;
  try {
    ctx = requireProject(cwdFlag);
  } catch (err) {
    process.stderr.write((err as Error).message + "\n");
    return 1;
  }

  const { paths, config } = ctx;

  // `--files` is not honored by the CLI ingest path (it always does a full or
  // path-scoped re-parse). Incremental, file-scoped re-ingest happens through
  // the daemon's native watcher. Warn rather than silently ignore the flag.
  if (args.flags["files"]) {
    process.stderr.write(
      "warning: `--files` is not supported by `hayven ingest` — the daemon's " +
        "file watcher handles incremental re-ingest. Proceeding with a full ingest.\n",
    );
  }

  const pathArg = args.positionals[0];
  const root = pathArg ?? paths.repoRoot;
  if (!existsSync(root)) {
    process.stderr.write(`error: path does not exist: ${root}\n`);
    return 1;
  }

  // Locate the native binary.
  let binary: string;
  try {
    binary = locateNativeBinary({ repoRoot: paths.repoRoot });
  } catch (err) {
    if (err instanceof NativeBinaryNotFound) {
      process.stderr.write(err.message + "\n");
      return 1;
    }
    throw err;
  }

  // Ensure nodes dir exists.
  mkdirSync(paths.nodesDir, { recursive: true });

  // Branch-aware index resolution (§5 item 3). In a git repo with per-branch
  // caching, this targets `.hayven/branches/<key>/index.sqlite`, SEEDING a brand-
  // new branch index by copying the freshest sibling branch's index so a switch
  // can re-parse only the diff. Outside a git repo (or with the feature off) it
  // returns the legacy `.hayven/index.sqlite` and behaves exactly as before.
  const forceFull = args.flags["full"] === true || args.flags["full"] === "true";
  const writeIndex = resolveWriteIndex(paths, config, { seed: !forceFull });
  const db = new Db(writeIndex.path);
  db.migrate(); // safe to call repeatedly.

  // THE CHEAP SWITCH: when we just seeded a new branch index from a sibling,
  // re-parse ONLY the `git diff` between the seed's commit and now, instead of
  // the whole repo. `git checkout` preserves the mtimes of unchanged files, and
  // the diff names exactly what differs — so a re-visited or freshly-branched
  // checkout costs the diff, never a full re-index (and NEVER a re-embed, since
  // hayven is embedding-free). `bench/branch-switch-cost.ts` measures the win.
  // Falls back to a full re-parse if the diff can't be computed.
  let incrementalFiles: string[] | null = null;
  if (writeIndex.seededFrom !== null && !forceFull && pathArg === undefined) {
    const fromRef = db.getStat("last_ingest_git_head");
    const diff = fromRef !== null ? gitDiffSince(paths.repoRoot, fromRef) : null;
    if (diff !== null) {
      incrementalFiles = diff.changed;
      // Purge stale rows for every affected file FIRST (handles entities removed
      // from a modified file + outright deletions), mirroring the watcher's
      // incremental reconcile, so the re-parse is authoritative, not additive.
      for (const f of diff.deleted) db.deleteNodesByFile(f);
      for (const f of diff.changed) db.deleteNodesByFile(f);
      logger.info("branch-switch incremental ingest", {
        branch: writeIndex.branchKey,
        changed: diff.changed.length,
        deleted: diff.deleted.length,
      });
    }
  }

  // Clear nodes+edges before a whole-repo re-parse so the rebuild is idempotent
  // (edges accumulate `weight += ` on conflict, so without a clear a repeated
  // `hayven ingest` doubles every edge weight). A whole-repo ingest re-derives
  // everything anyway; `--full` forces the same clear for a path-scoped ingest.
  // SKIPPED on the incremental branch-switch path (we purge per-file above).
  const wholeRepoRebuild = pathArg === undefined;
  if (incrementalFiles === null && (forceFull || wholeRepoRebuild)) {
    db.handle.exec("DELETE FROM edges; DELETE FROM nodes;");
  }

  // Incremental branch switch with NOTHING to re-parse (the seed already matched
  // this branch): just re-mark freshness against the new HEAD and return. We must
  // short-circuit BEFORE startParse — `startParse({files: []})` falls back to a
  // FULL parse (process.ts treats an empty list as "no incremental set").
  if (incrementalFiles !== null && incrementalFiles.length === 0) {
    const now = Date.now();
    db.setStat("last_ingest_at", String(now));
    const head = readGitHead(paths.repoRoot);
    if (head) db.setStat("last_ingest_git_head", head);
    db.close();
    const graph0 = new Db(writeIndex.path, { readonly: true });
    const counts = graph0.counts();
    graph0.close();
    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify({ branchSwitch: true, reparsed: 0, graphNodes: counts.nodes, graphEdges: counts.edges }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(
        `Branch switch: index seeded from a sibling, 0 files changed — nothing to re-parse.\n` +
          `  nodes: ${counts.nodes} in graph\n  edges: ${counts.edges} in graph\n`,
      );
    }
    return 0;
  }

  const run = startParse({
    binary,
    root,
    languages: config.parse_languages,
    jobs: config.parse_jobs,
    timeoutMs: config.ingest_timeout_seconds * 1000,
    logger,
    // Incremental: hand the native parser ONLY the changed files (`--files-stdin`).
    ...(incrementalFiles !== null ? { files: incrementalFiles } : {}),
  });

  try {
    const result = await drainIngest({
      db,
      nodesDir: paths.nodesDir,
      run,
      logger,
      repoRoot: paths.repoRoot,
    });

    // After an INCREMENTAL re-parse, only the changed files' edges were
    // (re-)resolved; a caller in an UNCHANGED file that referenced a now-moved
    // entity keeps a stale `?:<name>` edge. Re-run the §7 resolver over the whole
    // (seeded) node set — a cheap in-memory pass — so cross-file edges are
    // correct, exactly as the daemon watcher does after its incremental batch.
    if (incrementalFiles !== null) {
      try {
        reresolveAllEdges(db);
      } catch (err) {
        logger.warn("branch-switch edge re-resolution failed (non-fatal)", {
          error: (err as Error).message,
        });
      }
    }

    // Report the resulting GRAPH size (distinct rows in the tables), not the raw
    // parser-record counts in `result`. Records collapse on upsert/merge — node
    // ids dedupe and edges merge their weight on the (src,dst,kind) key — so
    // `result.nodes`/`result.edges` (records processed) read higher than the
    // graph and don't match `/api/stats` or the viewer. Show graph truth here.
    const graph = db.counts();
    const unresolved =
      db.handle
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM edges WHERE dst LIKE '?:%'")
        .get()?.c ?? 0;

    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify(
          { ...result, graphNodes: graph.nodes, graphEdges: graph.edges, graphUnresolvedEdges: unresolved },
          null,
          2,
        ) + "\n",
      );
    } else {
      const seconds = ((result.finishedAt - result.startedAt) / 1000).toFixed(2);
      process.stdout.write(
        `Ingest complete (${seconds}s wall, native ${result.nativeElapsedMs}ms)\n` +
          `  files:    ${result.filesDone} / ${result.filesTotal}\n` +
          `  nodes:    ${graph.nodes} in graph\n` +
          `  edges:    ${graph.edges} in graph (${unresolved} unresolved)\n` +
          `  warnings: ${result.warnings}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`ingest failed: ${(err as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
}
