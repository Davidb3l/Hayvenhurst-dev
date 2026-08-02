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

import { gitDiffSince, gitUntracked, resolveWriteIndex } from "../db/branch_index.ts";
import { isSourcePath } from "../db/freshness.ts";
import { Db } from "../db/queries.ts";
import {
  readGitHead,
  reresolveAllEdges,
  runIngest as drainIngest,
} from "../graph/ingest.ts";
import { removeNodeMarkdowns } from "../graph/nodeWriter.ts";
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
  // The OPEN is inside the try, not just `migrate()`. The schema guard moved
  // into `Db`'s constructor so it covers the daemonless writers and all the
  // readonly paths that never migrate — which means `new Db(...)` is now the
  // throw site, and a catch wrapped around `migrate()` alone misses it. That
  // gap was live for exactly one test run.
  let db: Db;
  try {
    db = new Db(writeIndex.path);
    db.migrate(); // safe to call repeatedly.
  } catch (err) {
    // `SchemaTooNewError`: an old binary opening an index a NEWER daemon wrote.
    // Migrating DOWN would silently discard the newer schema's tables and
    // corrupt what that daemon stored, so the refusal is intentional and must
    // not be defeated. Print it as an actionable error instead of stack-tracing
    // out of the ingest; the message already names both versions and says to
    // upgrade.
    process.stderr.write(`ingest aborted: ${(err as Error).message}\n`);
    return 1;
  }

  // INCREMENTAL re-parse — the cheap path, for BOTH a branch switch AND a
  // same-branch refresh. `git diff <fromRef>` (no second ref) compares the
  // WORKING TREE to the commit the index was last built against, so it names
  // exactly the tracked files that changed (committed-since OR uncommitted) +
  // deletions; `gitUntracked` adds brand-new files. We then purge those files'
  // rows and re-parse ONLY them (never the whole repo, never a re-embed —
  // hayven is embedding-free). This fires when EITHER we just seeded a new
  // branch index (the "cheap switch", `bench/branch-switch-cost.ts`) OR this is
  // a refresh of an index that already has a graph + a recorded HEAD to diff
  // against. Falls back to a full re-parse when: `--full`, a path-scoped ingest,
  // no recorded HEAD (first ingest / pre-feature index), the diff can't be
  // computed (non-git), or the change set is so large a clean rebuild is simpler
  // and not slower. (A full `--full` remains the authoritative rebuild — e.g. it
  // restores per-file call-SITES, which an incremental re-parse thins for
  // unchanged callers; see ARCHITECTURE.md §7/§10 Q4.)
  const INCREMENTAL_FILE_CAP = 2000;
  let incrementalFiles: string[] | null = null;
  if (!forceFull && pathArg === undefined) {
    const fromRef = db.getStat("last_ingest_git_head");
    const hasExistingGraph = db.counts().nodes > 0;
    // The incremental path re-parses ONLY the git diff, so it is correct only
    // when the index it is amending actually holds the rest of the graph.
    //
    // This used to accept `writeIndex.seededFrom !== null` — "we copied a file"
    // — as proof of that, which is not the same claim at all. A seed copied from
    // an index emptied by an interrupted ingest satisfied it at 0 nodes, and
    // because the seed also carried `last_ingest_git_head`, the branch then
    // re-parsed only the diff forever: permanently partial, permanently
    // self-certifying. Ask the graph directly instead. (`freshestSeed` now
    // refuses empty/broken seeds too, so a genuinely-seeded index reaches here
    // WITH content and still takes the fast path — this only removes the case
    // where the copy was worthless.)
    //
    // A half-written index is likewise ineligible: amending a graph we know is
    // incomplete would bake the damage in. Fall through to the full rebuild,
    // which is the authoritative repair.
    const integrity = db.checkIndexIntegrity();
    if (!integrity.ok) {
      process.stderr.write(
        `note: index integrity check failed (${integrity.reason}: ${integrity.detail}) ` +
          "— doing a FULL rebuild instead of an incremental re-parse.\n",
      );
    }
    const eligible = fromRef !== null && hasExistingGraph && integrity.ok;
    const diff = eligible ? gitDiffSince(paths.repoRoot, fromRef!) : null;
    if (diff !== null) {
      // Only SOURCE files matter for the re-parse. Filtering out non-source paths
      // (`.gitignore`, `AGENTS.md`, `.claude/` — including `hayven init`'s own
      // footprint) keeps the change set minimal and lets a refresh with no source
      // edits hit the fast 0-reparse no-op. Mirrors the freshness lane's scoping.
      const changed = [
        ...new Set([...diff.changed, ...gitUntracked(paths.repoRoot)]),
      ].filter(isSourcePath);
      const deleted = diff.deleted.filter(isSourcePath);
      const touched = changed.length + deleted.length;
      if (touched > INCREMENTAL_FILE_CAP) {
        logger.info("incremental skipped — change set too large, doing a full ingest", {
          touched,
          cap: INCREMENTAL_FILE_CAP,
        });
      } else {
        incrementalFiles = changed;
        // Flag the index BEFORE the destructive purge below. `drainIngest` marks
        // it too, but only once it is entered — and the purge + `startParse`
        // happen first, so a kill in that window would otherwise leave rows
        // deleted with nothing recording that a rebuild was underway.
        db.beginIngest();
        // Purge stale rows for every affected file FIRST (handles entities removed
        // from a modified file + outright deletions), mirroring the watcher's
        // incremental reconcile, so the re-parse is authoritative, not additive.
        // Capture each file's node ids BEFORE the delete so their markdown can be
        // unlinked: `deleteNodesByFile` touches SQLite only, so without this every
        // renamed or removed symbol leaves a permanent orphan under
        // `.hayven/nodes/` and that directory grows monotonically forever.
        const orphanIds: string[] = [];
        for (const f of [...deleted, ...changed]) {
          orphanIds.push(...db.nodeIdsForFile(f));
          db.deleteNodesByFile(f);
        }
        // Unlink now; the re-parse immediately rewrites the ids that still exist.
        // Best-effort — disk hygiene must never fail an ingest.
        try {
          const reclaimed = removeNodeMarkdowns(paths.nodesDir, orphanIds);
          if (reclaimed > 0) logger.info("reclaimed node markdown", { removed: reclaimed });
        } catch (err) {
          logger.warn("node-markdown reclaim failed (non-fatal)", {
            error: (err as Error).message,
          });
        }
        logger.info("incremental ingest", {
          branch: writeIndex.branchKey,
          seeded: writeIndex.seededFrom !== null,
          changed: changed.length,
          deleted: deleted.length,
        });
      }
    }
  }

  // Whether this run rebuilds the WHOLE graph, and therefore needs the
  // nodes+edges clear that keeps a rebuild idempotent (edges accumulate
  // `weight +=` on conflict, so without a clear a repeated `hayven ingest`
  // doubles every edge weight). `--full` forces it for a path-scoped ingest;
  // SKIPPED on the incremental branch-switch path (we purge per-file above).
  //
  // We do NOT clear here. The clear is delegated to `drainIngest` via
  // `clearBeforeIngest` so it happens AFTER the native `start` record has
  // cleared the file-count cap. Clearing at this point destroyed a perfectly
  // good index whenever the run was then refused for scope — and every retry
  // re-destroyed it, since the emptied index is ineligible for the incremental
  // path and takes the full path again. A scope refusal must be non-destructive.
  const wholeRepoRebuild = pathArg === undefined;
  const fullRebuild = incrementalFiles === null && (forceFull || wholeRepoRebuild);

  // Incremental ingest with NOTHING to re-parse (the working tree matches the
  // commit the index was built against — a no-op refresh, or a branch seed that
  // already matched): just re-mark freshness against the current HEAD and
  // return. We must short-circuit BEFORE startParse — `startParse({files: []})`
  // falls back to a FULL parse (process.ts treats an empty list as "no
  // incremental set").
  if (incrementalFiles !== null && incrementalFiles.length === 0) {
    const now = Date.now();
    const head = readGitHead(paths.repoRoot);
    // Nothing was re-parsed, so nothing is half-written — but we DID stamp the
    // in-progress marker before the per-file purge above, and returning without
    // clearing it would leave the index flagged BROKEN forever. Record success
    // and clear the marker in one transaction, exactly as `drainIngest` does.
    db.transaction(() => {
      db.setStat("last_ingest_at", String(now));
      if (head) db.setStat("last_ingest_git_head", head);
      // NOT authoritative: this run re-parsed nothing, so its live `counts()` is
      // not its own output and must never LOWER the watermark — a concurrent
      // process holding the graph cleared would otherwise have us commit 0 and
      // disarm the empty-but-claims-content detector.
      db.recordNodeWatermark(db.counts().nodes, false);
      db.endIngest(); // retracts only OUR token
    });
    db.close();
    const graph0 = new Db(writeIndex.path, { readonly: true });
    const counts = graph0.counts();
    graph0.close();
    const seeded = writeIndex.seededFrom !== null;
    if (isJson(args.flags)) {
      process.stdout.write(
        JSON.stringify({ incremental: true, seeded, reparsed: 0, graphNodes: counts.nodes, graphEdges: counts.edges }, null, 2) + "\n",
      );
    } else {
      process.stdout.write(
        `Up to date: 0 files changed since the last ingest — nothing to re-parse.\n` +
          `  nodes: ${counts.nodes} in graph\n  edges: ${counts.edges} in graph\n`,
      );
    }
    return 0;
  }

  // Dependency-source dirs (vendor/, Godeps/, third_party/) are skipped by
  // default for a leaner index + sharper search; `--include-vendored` (or
  // `index.includeVendored`) opts into navigating dependency code. The CLI flag
  // wins over config. (No effect on the incremental `files` path.)
  const includeVendored =
    args.flags["include-vendored"] === true || args.flags["include-vendored"] === "true"
      ? true
      : (config.index?.includeVendored ?? false);
  // Test-fixture apps / examples / benchmarks are likewise skipped by default
  // (measured on withastro/astro: test/fixtures apps alone were 27.6% of the
  // index); `--include-fixtures` (or `index.includeFixtures`) opts back in.
  const includeFixtures =
    args.flags["include-fixtures"] === true || args.flags["include-fixtures"] === "true"
      ? true
      : (config.index?.includeFixtures ?? false);
  // Be LOUD about the scope decision — never silently drop code the user might
  // expect indexed (stderr, so stdout/--json stay byte-identical).
  if (incrementalFiles === null && !includeVendored) {
    process.stderr.write(
      "note: skipping vendored dirs (vendor/, Godeps/, third_party/) — pass --include-vendored or set index.includeVendored to index them.\n",
    );
  }
  if (incrementalFiles === null && !includeFixtures) {
    process.stderr.write(
      "note: skipping test-fixture/example/benchmark dirs (test/fixtures/, examples/, benchmark(s)/) — pass --include-fixtures or set index.includeFixtures to index them.\n",
    );
  }

  const run = startParse({
    binary,
    root,
    languages: config.parse_languages,
    jobs: config.parse_jobs,
    timeoutMs: config.ingest_timeout_seconds * 1000,
    logger,
    includeVendored,
    includeFixtures,
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
      // Declare an authoritative whole-repo rebuild: the run's output IS the
      // complete graph, so `drainIngest` may do the O(1) call-site clear and may
      // lower the node watermark. A scoped/incremental run leaves this false and
      // replaces only what it parsed.
      fullRebuild,
      // Let the ingest perform the destructive clear itself, once the scope cap
      // has passed (see the comment where `fullRebuild` is computed).
      clearBeforeIngest: fullRebuild,
      // The orphan-markdown sweep is only safe when this index is the ONLY
      // writer of `paths.nodesDir`. That directory is per-PROJECT and shared by
      // every per-branch index, so under per-branch caching "not in THIS
      // branch's node set" is not the same as "orphaned" — sweeping there
      // deletes other branches' markdown. Opt in only for a single-index
      // (legacy, non-per-branch) project. The sweep additionally refuses to
      // delete anything it cannot prove hayven wrote.
      sweepOrphanMarkdown: fullRebuild && writeIndex.branchKey === null,
    });

    // After an INCREMENTAL re-parse, only the changed files' edges were
    // (re-)resolved; a caller in an UNCHANGED file that referenced a now-moved
    // entity keeps a stale `?:<name>` edge. Re-run the §7 resolver over the whole
    // (seeded) node set — a cheap in-memory pass — so cross-file edges are
    // correct, exactly as the daemon watcher does after its incremental batch.
    if (incrementalFiles !== null) {
      try {
        reresolveAllEdges(db, paths.repoRoot);
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
    // BE LOUD. A failed ingest does not leave the index untouched: the graph was
    // cleared (full path) or the changed files' rows were purged (incremental),
    // and node rows flush in batches BEFORE the native exit-code gate while
    // edges, call sites and stats are written after it. So the index is now
    // empty or structurally partial, and it used to keep reporting itself FRESH
    // off the surviving `last_ingest_at` — every subsequent query answered "No
    // matches", which reads as a fact about the user's code rather than as this
    // failure. The in-progress marker is deliberately LEFT SET so readers see a
    // broken index; say so here rather than only in a log.
    const detail = (err as Error).message;
    process.stderr.write(
      `ingest failed: ${detail}\n` +
        "WARNING: the index is now EMPTY or PARTIAL and has been marked broken. " +
        "Reads will warn and may return zero or too few hits until you re-run " +
        "`hayven ingest --full`.\n",
    );
    logger.error("ingest failed — index left marked in-progress", { error: detail });
    return 1;
  } finally {
    db.close();
  }
}
