/**
 * Build and LAZILY REFRESH a per-worktree overlay index (HAYV-13).
 *
 * An overlay is a FULL COPY of a graph for one registered worktree, not a
 * base+delta pair. Layering was rejected because every reader (FTS, the
 * resolver, impact walks, affected-tests) would have to learn to union two
 * databases and honor deletions across them; a copy keeps every read path
 * byte-for-byte the code it already is, at the cost of one index file per
 * worktree (capped at 16, see `registry.ts`).
 *
 * How it stays cheap:
 *   1. SEED by snapshotting the main project's current read index
 *      (`copySqlite`, the same WAL-consistent copy a new branch seeds with).
 *   2. INCREMENTALLY re-parse only what differs: `git diff <seed head>` against
 *      the worktree's working tree, plus untracked files, plus whatever was
 *      dirty at the last refresh (so a REVERTED edit is re-parsed back too —
 *      the plain branch path misses that case because a reverted file drops out
 *      of the diff while the index still holds the edited version).
 *   3. Over the 2000-file cap, re-ingest the worktree in full.
 *
 * How it stays honest:
 *   - Freshness is a FINGERPRINT (HEAD + `git status` + dirty-file mtimes, see
 *     `git.ts`) compared to a stamp stored IN the overlay's own `stats` table.
 *     The stamp is retracted before any destructive write and re-written only
 *     after success, in the same file as the graph it describes.
 *   - The ingest-in-progress marker (`Db.beginIngest`) is raised before the
 *     purge, exactly as `cli/ingest.ts` does, so a refresh killed mid-way reads
 *     as BROKEN, never as fresh, and the next refresh reseeds instead of
 *     amending wreckage.
 *   - One refresh per overlay at a time (`refresh.lock`); a waiter re-checks
 *     the fingerprint after the lock, so N concurrent reads cost one ingest.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { HayvenConfig } from "../config/defaults.ts";
import { copySqlite, gitDiffSince, gitUntracked, hasSeedableContent, resolveReadIndex } from "../db/branch_index.ts";
import { isSourcePath } from "../db/freshness.ts";
import { INGEST_IN_PROGRESS_KEY } from "../db/index_health.ts";
import { readIngestDirty } from "../db/ingest_dirty.ts";
import { SchemaTooNewError } from "../db/migrations.ts";
import { Db } from "../db/queries.ts";
import { reresolveAllEdges, runIngest as drainIngest } from "../graph/ingest.ts";
import { removeNodeMarkdowns } from "../graph/nodeWriter.ts";
import { locateNativeBinary } from "../native/locate.ts";
import { startParse } from "../native/process.ts";
import { withFileLock } from "../util/file_lock.ts";
import { rootLogger, type Logger } from "../util/log.ts";
import type { HayvenPaths } from "../util/paths.ts";
import { gitProbe, gitStatus, isAncestor, worktreeFingerprint, type WorktreeFingerprint } from "./git.ts";
import { overlayDir, overlayNodesDir, overlaySqlitePath, worktreesDir, type WorktreeEntry } from "./registry.ts";

/** Same ceiling as `cli/ingest.ts`: past this, a clean full parse is simpler and not slower. */
export const OVERLAY_INCREMENTAL_CAP = 2000;

/** `stats` keys owned by the overlay layer. */
const STAMP_KEY = "overlay_fingerprint";
const DIRTY_KEY = "overlay_dirty";
/**
 * "1" on an overlay that is a fresh SEED awaiting its first reconcile: a
 * faithful copy of main whose `overlay_dirty` already names what must be
 * re-parsed. It is a usable BASE (amend it, do not rebuild it) but never
 * fresh. Cleared, atomically with taking the ingest marker, before the first
 * destructive write.
 */
const SEED_PENDING_KEY = "overlay_seed_pending";
/** Value prefix of the in-progress marker a seed writes (see `seedFromMain`). */
const SEED_MARKER_PREFIX = "overlay-seed:";

/**
 * Test seams. `afterSeedCopy` runs on the temp seed right after it is copied
 * from main and before it is checked, so a test can make the copy look exactly
 * like one taken mid-ingest without racing a real daemon.
 */
export const overlayTestHooks: { afterSeedCopy?: (tmpPath: string) => void } = {};

/**
 * Say ONCE per project why a worktree was fully parsed instead of seeded: the
 * main index was built before any worktree was registered, so it carries no
 * record of its uncommitted files. Main's next ingest (or daemon re-index)
 * writes one, after which overlays seed incrementally.
 */
function noteMissingDirtyRecordOnce(target: OverlayTarget): void {
  const flag = join(worktreesDir(target.paths), ".dirty-record-noted");
  if (existsSync(flag)) return;
  process.stderr.write(
    "note: the main index has no record of which files were uncommitted when it was built, so this worktree " +
      "overlay is built with a full parse. The next `hayven ingest` (or daemon re-index) in the main checkout " +
      "records it, and later overlays seed incrementally.\n",
  );
  try {
    mkdirSync(worktreesDir(target.paths), { recursive: true });
    writeFileSync(flag, "");
  } catch {
    // worst case the note repeats
  }
}

const SQLITE_FILES = ["", "-wal", "-shm", "-journal"] as const;

export interface OverlayTarget {
  /** The MAIN project's paths (owns `.hayven/`). */
  readonly paths: HayvenPaths;
  readonly config: HayvenConfig;
  readonly entry: WorktreeEntry;
}

export interface OverlayRefreshResult {
  /** `fresh` = stamp matched, nothing done. */
  readonly action: "fresh" | "incremental" | "full";
  /** True when this refresh (re)seeded the overlay from the main index. */
  readonly seeded: boolean;
  /** The index file copied as the seed, when {@link seeded}. */
  readonly seededFrom: string | null;
  /** Source files re-parsed (incremental) — 0 for `fresh`, -1 for `full`. */
  readonly reparsed: number;
  /** Source files purged because they no longer exist. */
  readonly deleted: number;
  /** Whether the whole-graph edge re-resolution pass ran (skipped when nothing changed). */
  readonly reresolved: boolean;
  /** Graph node count after the refresh. */
  readonly nodes: number;
  /** The worktree HEAD the overlay now reflects. */
  readonly head: string | null;
}

/** What an overlay's own `stats` say about it. */
interface OverlayState {
  readonly stamp: string | null;
  readonly dirty: string[];
  readonly head: string | null;
  readonly integrityOk: boolean;
  /** See {@link SEED_PENDING_KEY}. */
  readonly seedPending: boolean;
  readonly nodes: number;
}

/**
 * Read an overlay's stamp/head/health, or `null` when there is no overlay file.
 * An index that exists but cannot be opened reads as UNHEALTHY (rebuild it),
 * never as absent-and-fine.
 */
function readOverlayState(sqlite: string): OverlayState | null {
  if (!existsSync(sqlite)) return null;
  let db: Db | null = null;
  try {
    db = new Db(sqlite, { readonly: true });
    const integrity = db.checkIndexIntegrity();
    let dirty: string[] = [];
    try {
      const parsed = JSON.parse(db.getStat(DIRTY_KEY) ?? "[]") as unknown;
      if (Array.isArray(parsed)) dirty = parsed.filter((p): p is string => typeof p === "string");
    } catch {
      // a damaged dirty list only costs re-parsing less; the diff still runs
    }
    const stamp = db.getStat(STAMP_KEY);
    return {
      stamp: stamp !== null && stamp.length > 0 ? stamp : null,
      dirty,
      head: db.getStat("last_ingest_git_head"),
      integrityOk: integrity.ok,
      // Pending only if the flag is set AND the sole thing wrong is OUR seed
      // marker. Any other marker (main's own in-flight ingest carried over in
      // the copy, or a refresh that died mid-purge) means the graph may be
      // partial, and a partial graph must be rebuilt, never amended.
      seedPending:
        db.getStat(SEED_PENDING_KEY) === "1" &&
        integrity.reason === "ingest-interrupted" &&
        (db.getStat(INGEST_IN_PROGRESS_KEY) ?? "").startsWith(SEED_MARKER_PREFIX),
      nodes: db.counts().nodes,
    };
  } catch (err) {
    if (err instanceof SchemaTooNewError) throw err;
    return { stamp: null, dirty: [], head: null, integrityOk: false, seedPending: false, nodes: 0 };
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function removeSqliteFiles(sqlite: string): void {
  for (const s of SQLITE_FILES) rmSync(sqlite + s, { force: true });
}

/**
 * Replace the overlay with a snapshot of the main project's CURRENT read index.
 * Returns the seed path, or `null` when main has nothing seedable (or we cannot
 * tell what it holds), and the caller does a full ingest instead.
 *
 * WHAT THE SEED MUST RE-PARSE. The main index may hold UNCOMMITTED content,
 * and `git diff <seed head>` inside the worktree knows nothing about it. The
 * set to re-parse from the worktree's own copy is the union of
 *   - `last_ingest_dirty`, what main was dirty with WHEN IT WAS INDEXED (a
 *     `git stash` after the ingest makes main clean while its index still holds
 *     the stashed code), and
 *   - main's CURRENT dirty set (an index older than the record, or edits the
 *     daemon watcher folded in since).
 *
 * CRASH SAFETY. That union is written INTO the seed, together with an
 * in-progress marker and {@link SEED_PENDING_KEY}, BEFORE the seed is renamed
 * into place. A process killed at any point after the rename therefore leaves
 * an overlay that (a) can never read as fresh, and (b) still knows which files
 * to re-parse. Keeping the list in memory instead let a kill between the
 * rename and the re-parse produce an overlay that later stamped itself fresh
 * while serving main's uncommitted edits.
 */
function seedFromMain(target: OverlayTarget, sqlite: string): { from: string } | null {
  const src = resolveReadIndex(target.paths, target.config).path;
  if (!existsSync(src) || !hasSeedableContent(src)) return null;
  // Snapshot to a temp file beside the overlay, then RENAME it into place. A
  // reader that opened the old overlay keeps its (unlinked) inode, and one that
  // opens now sees either the old file or the complete new one, never a
  // half-copied database. A fixed name is safe: seeding only ever runs under
  // the overlay's refresh lock, and a leftover from a crashed seed is simply
  // overwritten here.
  const tmp = `${sqlite}.seed.tmp`;
  removeSqliteFiles(tmp);
  copySqlite(src, tmp);

  overlayTestHooks.afterSeedCopy?.(tmp);

  const db = new Db(tmp);
  try {
    // CHECK THE COPY, NOT THE SOURCE. `hasSeedableContent(src)` above ran
    // BEFORE the copy; a daemon ingest that starts in between leaves the copy
    // holding main's own in-progress marker over a half-written graph. Writing
    // our seed marker over that would launder it into a "pending seed" that
    // the next step amends and stamps fresh. A copy that is not provably whole
    // is abandoned, and the worktree gets a full parse instead.
    const integrity = db.checkIndexIntegrity();
    const abandon = (why: string): null => {
      db.close();
      removeSqliteFiles(tmp);
      rootLogger().child("worktree").info("overlay seed abandoned; full parse instead", {
        worktree: target.entry.path,
        why,
      });
      return null;
    };
    if (!integrity.ok || integrity.nodes <= 0) {
      return abandon(`main index copy is not whole (${integrity.reason}: ${integrity.detail})`);
    }
    // What uncommitted content does the main index hold? Without a usable
    // record we cannot say, and amending a seed whose dirt we cannot name could
    // serve main's edits as the worktree's code. A full parse cannot.
    const recorded = readIngestDirty(db);
    if (recorded === null) {
      noteMissingDirtyRecordOnce(target);
      return abandon("main index has no last_ingest_dirty record");
    }
    if (recorded.kind !== "paths") return abandon(`main's dirty record is ${recorded.kind}`);
    const current = gitStatus(target.paths.repoRoot)?.paths ?? null;
    if (current === null) return abandon("git status failed in the main checkout");
    const dirty = [...new Set([...recorded.paths, ...current])].sort();
    db.transaction(() => {
      db.setStat(DIRTY_KEY, JSON.stringify(dirty));
      db.setStat(STAMP_KEY, "");
      db.setStat(SEED_PENDING_KEY, "1");
      // OUR marker, recognizably so. Two properties matter: it is ADOPTABLE
      // (it parses as an unowned declaration, so the refresh that reconciles
      // this seed takes it over with `beginIngest` and retracts it on success
      // instead of leaving an orphan), and it is DISTINGUISHABLE from any
      // marker main itself wrote, so `usable()` can accept "pending seed" for
      // this marker and for nothing else.
      db.setStat(INGEST_IN_PROGRESS_KEY, `${SEED_MARKER_PREFIX}${Date.now()}`);
    });
    // Back to a self-contained, non-WAL file before the rename (see copySqlite).
    db.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.handle.exec("PRAGMA journal_mode = DELETE");
    db.close();
  } catch (err) {
    try {
      db.close();
    } catch {
      // already closed
    }
    removeSqliteFiles(tmp);
    throw err;
  }
  for (const s of SQLITE_FILES) if (s !== "") rmSync(tmp + s, { force: true });
  // The old generation's `-wal`/`-shm` must go before the rename: SQLite would
  // replay a stale WAL onto the new file.
  for (const s of SQLITE_FILES) if (s !== "") rmSync(sqlite + s, { force: true });
  renameSync(tmp, sqlite);
  // Node markdown from the previous generation describes a graph we just threw
  // away; without this the directory only ever grows.
  rmSync(overlayNodesDir(target.paths, target.entry.id), { recursive: true, force: true });
  mkdirSync(overlayNodesDir(target.paths, target.entry.id), { recursive: true });
  return { from: src };
}

interface ChangeSet {
  readonly changed: string[];
  readonly deleted: string[];
}

/**
 * The SOURCE files an overlay built at `fromRef` (+ `prevDirty`) must re-parse
 * or purge to match the worktree as it is now, or `null` when git cannot diff
 * from `fromRef` (unknown/garbage-collected commit). Classification is by
 * existence on disk, which folds renames, deletions and reverted untracked
 * files into one rule.
 */
function computeChangeSet(worktree: string, fromRef: string, prevDirty: string[]): ChangeSet | null {
  const diff = gitDiffSince(worktree, fromRef);
  if (diff === null) return null;
  const candidates = new Set([...diff.changed, ...diff.deleted, ...gitUntracked(worktree), ...prevDirty]);
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const p of candidates) {
    if (!isSourcePath(p)) continue;
    if (existsSync(join(worktree, p))) changed.push(p);
    else deleted.push(p);
  }
  return { changed: changed.sort(), deleted: deleted.sort() };
}

function overCap(cs: ChangeSet): boolean {
  return cs.changed.length + cs.deleted.length > OVERLAY_INCREMENTAL_CAP;
}

/** Open the overlay for writing, recreating it when it is unreadable junk. */
function openWritable(sqlite: string): Db {
  try {
    const db = new Db(sqlite);
    db.migrate();
    return db;
  } catch (err) {
    if (err instanceof SchemaTooNewError) throw err;
    removeSqliteFiles(sqlite);
    const db = new Db(sqlite);
    db.migrate();
    return db;
  }
}

/** Record that the overlay now reflects `fp`. Called only after a successful ingest. */
function writeStamp(db: Db, fp: WorktreeFingerprint): void {
  db.transaction(() => {
    // Pin the diff base to the HEAD the change set was computed against, not
    // whatever `drainIngest` read at the END of the parse: if HEAD moved during
    // the ingest, the next refresh must diff from the commit we actually
    // reconciled with, or the files between the two would never be re-parsed.
    if (fp.head !== null) db.setStat("last_ingest_git_head", fp.head);
    db.setStat(DIRTY_KEY, JSON.stringify(fp.dirty));
    db.setStat(SEED_PENDING_KEY, "");
    db.setStat(STAMP_KEY, fp.hash);
  });
}

export interface RefreshOptions {
  /** Force a full re-ingest of the worktree (`hayven ingest --full` in a worktree). */
  readonly full?: boolean;
  /** Re-ingest even when the stamp matches (`hayven ingest` in a worktree). */
  readonly force?: boolean;
  readonly logger?: Logger;
  /** Native binary override (tests); located from the main project otherwise. */
  readonly binary?: string;
}

/**
 * Bring the overlay for `target` up to date with its worktree, building it if
 * needed. A no-op (`action: "fresh"`) when the worktree's fingerprint matches
 * the overlay's stamp. Throws on failure; the overlay is then left marked
 * in-progress (unless the failure preceded any write) and is never stamped.
 */
export async function refreshOverlay(target: OverlayTarget, opts: RefreshOptions = {}): Promise<OverlayRefreshResult> {
  const { paths, config, entry } = target;
  const logger = opts.logger ?? rootLogger().child("worktree");
  const dir = overlayDir(paths, entry.id);
  const sqlite = overlaySqlitePath(paths, entry.id);
  const nodesDir = overlayNodesDir(paths, entry.id);
  mkdirSync(nodesDir, { recursive: true });

  // Waiters sit out at most one ingest timeout, then read the overlay as it is
  // (with a warning). A holder that DIED is reclaimed at once by pid. The
  // touch-based staleness window is deliberately long: the holder's touch timer
  // runs on its event loop, which a large synchronous SQLite pass can block for
  // many seconds, and reclaiming a live holder's lock would put two refreshes
  // in one overlay at once.
  const lockOpts = { budgetMs: config.ingest_timeout_seconds * 1000 + 30_000, staleMs: 120_000 };
  return withFileLock(join(dir, "refresh.lock"), async () => {
    const fp = worktreeFingerprint(entry.path);
    if (fp === null) {
      throw new Error(
        `${entry.path} can no longer be read as a git worktree. Run \`hayven worktree prune\``,
      );
    }
    let state = readOverlayState(sqlite);
    if (!opts.full && !opts.force && state !== null && state.integrityOk && state.stamp === fp.hash) {
      return {
        action: "fresh",
        seeded: false,
        seededFrom: null,
        reparsed: 0,
        deleted: 0,
        reresolved: false,
        nodes: state.nodes,
        head: fp.head,
      };
    }

    let seeded = false;
    let seededFrom: string | null = null;
    let prevDirty: string[] = state?.dirty ?? [];
    const reseed = (): boolean => {
      const s = seedFromMain(target, sqlite);
      if (s === null) return false;
      seeded = true;
      seededFrom = s.from;
      state = readOverlayState(sqlite);
      prevDirty = state?.dirty ?? [];
      return true;
    };
    // A pending seed is a usable BASE despite its marker: it is an intact copy
    // of main plus the list of what to re-parse (see `seedFromMain`).
    const usable = (s: OverlayState | null): s is OverlayState & { head: string } =>
      s !== null && (s.integrityOk || s.seedPending) && s.head !== null && s.nodes > 0;

    let plan: ChangeSet | null = null;
    if (!opts.full) {
      if (!usable(state)) reseed();
      if (usable(state)) {
        plan = computeChangeSet(entry.path, state.head, prevDirty);
        // Sirius resets a worktree to a NEW base tip every iteration. When that
        // tip is not a descendant of what the overlay holds AND the diff is too
        // big to amend, the main index is the nearer starting point: reseed
        // from it and diff again before giving up on incremental.
        const diverged =
          plan === null || (overCap(plan) && !(fp.head !== null && isAncestor(entry.path, state.head, fp.head)));
        // After a reseed the old plan describes a file that no longer exists:
        // recompute against the seed, or fall back to a full ingest.
        if (diverged && !seeded && reseed()) {
          plan = usable(state) ? computeChangeSet(entry.path, state.head, prevDirty) : null;
        }
        if (plan !== null && overCap(plan)) plan = null;
      }
    }

    const binary = opts.binary ?? locateNativeBinary({ repoRoot: paths.repoRoot });
    const includeVendored = config.index?.includeVendored ?? false;
    const includeFixtures = config.index?.includeFixtures ?? false;
    const parseBase = {
      binary,
      root: entry.path,
      languages: config.parse_languages,
      jobs: config.parse_jobs,
      timeoutMs: config.ingest_timeout_seconds * 1000,
      logger,
      includeVendored,
      includeFixtures,
    };

    // A full parse over a BROKEN overlay starts from an empty file. Clearing
    // the graph in place would keep the dead refresh's in-progress token, and
    // `clearGraph` only reaps tokens whose owner is provably dead, so a token
    // it cannot judge would leave the rebuilt overlay reading broken forever.
    // (A pending seed is not broken, and an abandoned reseed already left the
    // previous file untouched; only a genuinely unhealthy one is discarded.)
    if (plan === null && state !== null && !state.integrityOk && !state.seedPending) removeSqliteFiles(sqlite);
    const db = openWritable(sqlite);
    let reresolved = false;
    try {
      if (plan !== null) {
        // Raise the in-progress marker and RETRACT the stamp before the first
        // destructive write, so nothing between here and `writeStamp` can be
        // mistaken for a fresh overlay by a concurrent or later reader.
        // One transaction: take the marker (adopting a pending seed's) AND drop
        // the seed-pending flag, so no crash can leave "seed pending" on a graph
        // the purge below has already started to change.
        db.transaction(() => {
          db.beginIngest();
          db.setStat(STAMP_KEY, "");
          db.setStat(SEED_PENDING_KEY, "");
        });
        const orphanIds: string[] = [];
        for (const f of [...plan.deleted, ...plan.changed]) {
          orphanIds.push(...db.nodeIdsForFile(f));
          db.deleteNodesByFile(f);
        }
        try {
          removeNodeMarkdowns(nodesDir, orphanIds);
        } catch {
          // disk hygiene never fails a refresh
        }
        if (plan.changed.length > 0) {
          // NEVER hand `startParse` an empty list: it reads that as "no
          // incremental set" and parses the whole tree.
          const run = startParse({ ...parseBase, files: plan.changed });
          const res = await drainIngest({ db, nodesDir, run, logger, repoRoot: entry.path, fullRebuild: false });
          // The native parser ACCEPTED NONE of the files we handed it. Before
          // the scope fix in `native/src/parse/scope.rs`, that is exactly what a
          // worktree nested under a path its main checkout ignores
          // (`.sirius/worktrees/w1` with `.sirius/` in `.gitignore`) got on
          // EVERY incremental parse: the explicit-files path applied the main
          // `.gitignore` above the worktree's own root, while the full walk did
          // not. An older native binary is still in the field, and "nothing
          // parsed" is otherwise indistinguishable from "nothing to parse", so
          // treat it as untrustworthy and rebuild from a full walk. With a fixed
          // binary this only fires when every changed file is legitimately out
          // of scope (a fixture-only edit), where the full parse costs time but
          // never correctness.
          if (res.filesTotal === 0) {
            logger.warn("overlay incremental parse accepted 0 files; falling back to a full ingest", {
              worktree: entry.path,
              requested: plan.changed.length,
            });
            plan = null;
          }
        } else {
          db.transaction(() => {
            db.setStat("last_ingest_at", String(Date.now()));
            db.recordNodeWatermark(db.counts().nodes, false);
            db.endIngest();
          });
        }
        // Nothing re-parsed and nothing purged: the graph is byte-for-byte what
        // it was, so the whole-graph resolver pass would only burn time.
        if (plan !== null && (plan.changed.length > 0 || plan.deleted.length > 0)) {
          reresolved = true;
          try {
            // Callers in UNCHANGED files may point at entities that moved; the
            // resolver pass is what keeps cross-file edges right after a partial
            // re-parse (same as `cli/ingest.ts` and the daemon watcher).
            reresolveAllEdges(db, entry.path);
          } catch (err) {
            logger.warn("overlay edge re-resolution failed (non-fatal)", { error: (err as Error).message });
          }
        }
      }
      if (plan === null) {
        db.transaction(() => {
          db.setStat(STAMP_KEY, "");
          db.setStat(SEED_PENDING_KEY, "");
        });
        const run = startParse(parseBase);
        await drainIngest({
          db,
          nodesDir,
          run,
          logger,
          repoRoot: entry.path,
          fullRebuild: true,
          clearBeforeIngest: true,
          // This overlay is the ONLY writer of its own nodes dir, which is
          // exactly the condition the sweep requires.
          sweepOrphanMarkdown: true,
        });
      }
      writeStamp(db, fp);
      const nodes = db.counts().nodes;
      logger.info("overlay refreshed", {
        worktree: entry.path,
        id: entry.id,
        action: plan === null ? "full" : "incremental",
        seeded,
        reparsed: plan?.changed.length ?? -1,
        deleted: plan?.deleted.length ?? 0,
      });
      return {
        action: plan === null ? "full" : "incremental",
        seeded,
        seededFrom,
        reparsed: plan?.changed.length ?? -1,
        deleted: plan?.deleted.length ?? 0,
        reresolved,
        nodes,
        head: fp.head,
      };
    } finally {
      db.close();
    }
  }, lockOpts);
}

/** How a registered overlay compares to its worktree right now. */
export type OverlayFreshness =
  | "fresh" // stamp matches the worktree
  | "stale" // will re-ingest on the next read
  | "missing" // no overlay index on disk (rebuilt on the next read)
  | "broken" // a refresh died mid-way; the next read reseeds
  | "worktree-gone" // `hayven worktree prune` will drop it
  | "unknown"; // git could not answer (missing, slow, failing): no verdict

export interface OverlayStatus {
  readonly freshness: OverlayFreshness;
  readonly nodes: number;
  readonly head: string | null;
  readonly sqlitePath: string;
}

/** Read-only status for `worktree list` / `doctor`. Never ingests, never throws. */
export function overlayStatus(target: OverlayTarget): OverlayStatus {
  const sqlitePath = overlaySqlitePath(target.paths, target.entry.id);
  let state: OverlayState | null = null;
  try {
    state = readOverlayState(sqlitePath);
  } catch {
    state = { stamp: null, dirty: [], head: null, integrityOk: false, seedPending: false, nodes: 0 };
  }
  const base = { nodes: state?.nodes ?? 0, head: state?.head ?? null, sqlitePath };
  if (!existsSync(target.entry.path)) return { ...base, freshness: "worktree-gone" };
  const fp = worktreeFingerprint(target.entry.path);
  if (fp === null) {
    // "Gone" only on POSITIVE evidence, the same rule as prune: git ran and
    // said this is not a repository. A missing, slow or failing git says
    // nothing about the worktree, and telling the user to prune on that basis
    // would have them delete a live worker's overlay.
    const probe = gitProbe(target.entry.path, ["rev-parse", "--show-toplevel"]);
    const gone = probe.kind === "exit" && /not a git repository/i.test(probe.stderr);
    return { ...base, freshness: gone ? "worktree-gone" : "unknown" };
  }
  if (state === null) return { ...base, freshness: "missing" };
  // A pending seed is not broken: the next read reconciles it.
  if (state.seedPending) return { ...base, freshness: "stale" };
  if (!state.integrityOk) return { ...base, freshness: "broken" };
  return { ...base, freshness: state.stamp === fp.hash ? "fresh" : "stale" };
}
