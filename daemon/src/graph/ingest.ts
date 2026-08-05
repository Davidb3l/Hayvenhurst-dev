/**
 * Orchestrates a single ingest run.
 *
 * Drains the native binary's NDJSON stream, derives entity IDs, batches inserts
 * into SQLite (1000 records per transaction), resolves raw edge `dst_name`s to
 * entity IDs in a second pass, and writes markdown files in parallel.
 */
import { blake3 } from "@noble/hashes/blake3";

import { EdgeResolver } from "./edgeResolver.ts";
import type { CallSite, ImportAliasPair, RawEdgeWithChain } from "./edgeResolver.ts";
import { deriveEntityId } from "./idScheme.ts";
import { PackageScopedNameIndex } from "./nameIndex.ts";
import { pruneOrphanNodeMarkdowns, writeNodeMarkdowns } from "./nodeWriter.ts";
import { normalizePosix } from "./specifierResolve.ts";
import type { GraphEdge, GraphNode, RawEdge } from "./types.ts";
import { pruneExpired } from "../db/fleet_memory.ts";
import { IngestSpill, type Db } from "../db/queries.ts";
import { describeFailure, type ParseRun } from "../native/process.ts";
import type { NativeRecord } from "../native/protocol.ts";
import type { Logger } from "../util/log.ts";

/**
 * BARREL RE-EXPORTS. Edge resolution moved to `edgeResolver.ts` and the shared
 * name index to `nameIndex.ts`, but consumers across the CLI, daemon routes and
 * the test suite import these names from this module. Re-exported at the same
 * names so no consumer needed an edit for the split.
 */
export { EdgeResolver, resolveEdges, reresolveAllEdges } from "./edgeResolver.ts";
export type { CallSite, EdgeOutcome, ResolveEdgesOptions } from "./edgeResolver.ts";

const NODE_BATCH = 1000;
const EDGE_BATCH = 1000;
/**
 * How many nodes are replayed from the ingest spill per markdown-writing pass.
 * Bounds the heap held by that phase; the writer's own `concurrency` still
 * bounds in-flight I/O within a page.
 */
const MARKDOWN_BATCH = 1000;

/** `stats` key holding when expired fleet memory was last reclaimed (epoch ms).
 *  See the prune block at the end of {@link runIngest} for why it is rate-limited. */
const FLEET_MEMORY_PRUNED_AT_KEY = "fleet_memory_pruned_at";

/** How often a successful ingest may reclaim expired fleet memory. One hour: the
 *  watcher can run dozens of incremental ingests a minute, and an expired note
 *  costs nothing but a table row until it is collected. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * HARD CAPS on a single ingest run — the "unbounded work with no user-visible
 * signal" guard.
 *
 * A `hayven daemon` once indexed an entire home directory for six hours (98%
 * CPU, 195 GB read, a 593 MB index) because nothing anywhere bounded how much
 * an ingest could take on. `files_total` arrives in the native `start` record
 * and was LOGGED but never checked against anything, and `nodes[]`/`rawEdges[]`
 * are held in memory for the whole run (see the comment on those arrays), so
 * heap grows linearly with repo size with no ceiling either.
 *
 * These caps are deliberately GENEROUS — far above any real first-party repo,
 * chosen to catch "you are indexing something that is not a project" rather
 * than to police large monorepos. Exceeding one FAILS LOUDLY with a message
 * naming the cap and its override. A refusal that has not yet written anything
 * (the file cap, evaluated on the `start` record) leaves the index untouched AND
 * unflagged; one that fires after rows have landed leaves it flagged BROKEN.
 * Override per-process via the env vars below when a genuinely huge repo needs
 * it. A non-positive / non-finite value falls back to the default.
 */
const DEFAULT_MAX_INGEST_FILES = 200_000;
const DEFAULT_MAX_INGEST_NODES = 2_000_000;
const DEFAULT_MAX_INGEST_EDGES = 5_000_000;

/** Read a positive-integer cap from `env`, else `fallback`. Use-time, not
 *  module-load, so tests/operators can set it per-process. */
function capFromEnv(env: string, fallback: number): number {
  const raw = process.env[env];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Filenames whose module name comes from the PARENT DIRECTORY rather than the
 * file stem: the per-language exceptions in ARCHITECTURE.md §2's module-name
 * table (`mod.rs`, `lib.rs`, `main.rs`, `__init__.py`). Mirrored here so the
 * ordering FALLBACK below derives exactly the segment a real module record
 * would have carried for the same file.
 */
const PARENT_DIR_MODULE_FILES = new Set(["mod.rs", "lib.rs", "main.rs", "__init__.py"]);

/**
 * Derive the module-name segment for `file` the way the native extractor does:
 * the extension-stripped file stem, except the {@link PARENT_DIR_MODULE_FILES}
 * cases, which take the parent directory's name (`src/y/mod.rs` → `y`, matching
 * the qualified_name the file's module record would carry). Used ONLY by the
 * module-record-ordering fallback in {@link drainIntoIndex}; the module record
 * itself is always the authority when it has arrived.
 */
function fallbackModuleName(file: string): string {
  const parts = normalizePosix(file)
    .split("/")
    .filter((p) => p.length > 0);
  const filename = parts[parts.length - 1] ?? file;
  if (PARENT_DIR_MODULE_FILES.has(filename) && parts.length >= 2) {
    return parts[parts.length - 2]!;
  }
  // Extension strip mirrors idScheme.ts `stripExt`: `dot <= 0` keeps dotfiles
  // (`.env`) and extensionless names whole rather than emptying them.
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? filename : filename.slice(0, dot);
}

/** Test-only handle on the shared name index. Not part of the ingest API: it
 *  exists so the extraction above can be unit-tested directly instead of only
 *  through a full ingest. */
export const __testing = { PackageScopedNameIndex };

export interface IngestResult {
  startedAt: number;
  finishedAt: number;
  filesTotal: number;
  filesDone: number;
  nodes: number;
  edges: number;
  unresolvedEdges: number;
  warnings: number;
  /** Native-reported elapsed_ms (from `done` record). */
  nativeElapsedMs: number;
  /**
   * How many of this run's source files were OVERWRITTEN by another file
   * deriving the same module id (ids are the `nodes` primary key, so the loser
   * vanishes from the graph). Counted once per losing file. Normally 0; also
   * logged per occurrence and recorded as the `last_ingest_id_collisions` stat.
   */
  idCollisions: number;
}

export interface IngestOptions {
  db: Db;
  nodesDir: string;
  run: ParseRun;
  logger?: Logger;
  /** Concurrency for parallel markdown writes. */
  markdownConcurrency?: number;
  /**
   * Absolute repo root, used to locate `tsconfig.json` for alias-import
   * specifier resolution (`~/x`). Defaults to `process.cwd()` when omitted;
   * alias resolution simply no-ops if no tsconfig is found, so relative-import
   * resolution works regardless.
   */
  repoRoot?: string;
  /**
   * Declare this run an AUTHORITATIVE WHOLE-REPO REBUILD (the caller cleared the
   * graph and is re-parsing everything). Default `false` = a scoped run that
   * replaces only what it parsed.
   *
   * This governs two reclaim steps that are only SAFE when the run's output is
   * the complete graph:
   *   - call sites: a full rebuild does the O(1) `clearCallSites()`; a scoped
   *     run replaces only the parsed files' sites (see below).
   *   - node markdown: a full rebuild sweeps `nodesDir` for orphan `.md` files
   *     whose node no longer exists. A scoped run must NEVER sweep — it knows
   *     only the changed files' nodes and would delete the rest of the repo's
   *     markdown.
   *
   * Defaulting to `false` is the SAFE default: a caller that forgets to set it
   * gets correct-but-less-thorough reclaim, never destruction.
   */
  fullRebuild?: boolean;
  /**
   * Let `runIngest` perform the `clearGraph()` itself, at the ONE safe moment:
   * after the native `start` record has cleared the file-count cap, and before
   * any node batch flushes. Default `false` (the caller manages its own clear).
   *
   * A caller that clears BEFORE `startParse` destroys a good index whenever the
   * run is then refused for scope — and every retry re-destroys it, because the
   * now-empty index is ineligible for the incremental path and takes the full
   * path again. Delegating the clear here makes a scope refusal non-destructive.
   */
  clearBeforeIngest?: boolean;
  /**
   * Permit the FULL-rebuild orphan-markdown sweep. Default `false`, and
   * deliberately SEPARATE from {@link fullRebuild}, because the sweep is only
   * safe when this index is the ONLY writer of `nodesDir`.
   *
   * `nodesDir` is one directory per PROJECT (`util/paths.ts`), shared by every
   * per-branch index, so sweeping "every `.md` not in THIS branch's node set"
   * deletes other branches' markdown. Callers must pass `true` only when
   * per-branch caching is not in play. Even then the sweep refuses to delete
   * anything it cannot prove hayven wrote — see `pruneOrphanNodeMarkdowns`.
   */
  sweepOrphanMarkdown?: boolean;
}

/**
 * Read the current git HEAD commit hash for `repoRoot`, or `null` if it can't be
 * determined. BEST-EFFORT + SAFE for the ingest path: never throws — any
 * failure (git not installed, not a git repo, timeout, non-zero exit, empty
 * output) returns `null` so the caller simply skips writing the stat. Bounded by
 * a short timeout so a hung/slow git can't stall the ingest.
 */
export function readGitHead(repoRoot: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
    });
    if (!proc.success || proc.exitCode !== 0) return null;
    const head = proc.stdout.toString().trim();
    // A valid full SHA-1 is 40 hex chars (sha256 repos: 64). Guard against any
    // unexpected output rather than storing garbage.
    if (!/^[0-9a-f]{7,64}$/.test(head)) return null;
    return head;
  } catch {
    return null;
  }
}

/**
 * Drain a {@link ParseRun} into the database and markdown directory.
 * Resolves after the native binary exits cleanly. Throws on non-zero exit.
 */
export async function runIngest(opts: IngestOptions): Promise<IngestResult> {
  /**
   * ON-DISK OVERFLOW for this run's node and raw-edge records — the fix for
   * KNOWN_ISSUES #2. Both collections used to be plain arrays held for the whole
   * run, so heap grew linearly with repo size and a large enough repo could
   * exhaust memory mid-ingest.
   *
   * They CANNOT simply be processed as they stream: edge resolution needs the
   * COMPLETE node set before it may resolve anything (the per-package ambiguity
   * sentinel in {@link EdgeResolver} is only correct over the whole graph — a
   * name looks unique until its second definition arrives), and node markdown
   * must not be written until the native binary's exit code is known. So they go
   * to disk, in order, and are replayed in pages.
   *
   * Opened HERE, outside the drain, so the `finally` covers EVERY exit path —
   * success, a hard-cap refusal, a non-zero native exit, a thrown spill write.
   * Nothing about a failed ingest should leave a multi-hundred-MB file on the
   * temp volume. Opened BEFORE the drain raises the in-progress marker too, so a
   * spill that cannot be created at all (no writable temp dir) leaves a healthy
   * index untouched AND unflagged, exactly like the over-cap scope refusal.
   */
  const spill = IngestSpill.open("ingest");
  try {
    return await drainIntoIndex(opts, spill);
  } finally {
    spill.destroy();
  }
}

/** The ingest proper. Separated from {@link runIngest} only so the spill's
 *  lifetime is a single unmissable `try`/`finally` around the whole thing. */
async function drainIntoIndex(opts: IngestOptions, spill: IngestSpill): Promise<IngestResult> {
  const { db, nodesDir, run, logger } = opts;
  const startedAt = Date.now();

  // MARK THE INDEX IN-PROGRESS BEFORE WRITING ANYTHING.
  //
  // Node rows flush in 1000-row batches DURING the drain below — i.e. BEFORE the
  // native exit-code gate — while ALL edges, call sites and stats are written
  // AFTER it. So a run killed anywhere in the middle (the 300s ingest timeout,
  // `kill -9`, OOM, a full disk, a segfaulting native binary) leaves nodes with
  // ZERO edges, or an empty graph if the caller cleared first. `last_ingest_at`
  // lives in `stats` and is only written on SUCCESS, so the wreckage kept the
  // PREVIOUS successful timestamp and `evaluateStaleness` reported `stale:
  // false` — every query answered "No matches" and the user read that as a fact
  // about their code.
  //
  // We cannot wrap clear+repopulate in one SQLite transaction (the repopulate
  // spans a subprocess that runs for minutes and flushes in batches), so we do
  // the equivalent: flag the index unusable up front and unflag it ONLY in the
  // same transaction that records success. Any reader that finds the flag treats
  // the index as broken rather than fresh. Idempotent — `clearGraph()` already
  // stamped it inside its own wipe transaction and the earliest start wins.
  //
  // Read BEFORE marking: true when the CALLER already declared an ingest on this
  // handle, which in practice means it cleared the graph itself (`cli/daemon.ts`
  // does, ahead of both its full-ingest and its branch-re-point paths). A refused
  // run must not retract a marker it did not raise — see the abort path below.
  const callerDeclaredIngest = db.hasDeclaredIngest();
  db.markIngestInProgress(startedAt);

  /**
   * Every source file this run actually parsed (from the node records' `file`).
   * This is what lets the call-site replacement below be per-file WITHOUT the
   * caller having to tell us which files it handed the parser — see the
   * `clearCallSites` discussion further down.
   */
  const parsedFiles = new Set<string>();
  const maxFiles = capFromEnv("HAYVEN_MAX_INGEST_FILES", DEFAULT_MAX_INGEST_FILES);
  const maxNodes = capFromEnv("HAYVEN_MAX_INGEST_NODES", DEFAULT_MAX_INGEST_NODES);
  const maxEdges = capFromEnv("HAYVEN_MAX_INGEST_EDGES", DEFAULT_MAX_INGEST_EDGES);
  /** Set when a hard cap is breached; ends the drain and throws (see caps above). */
  let abortReason: string | null = null;
  /**
   * True once this run has made ANY destructive or partial write to the index
   * (the delegated `clearGraph`, or a node batch flush). Drives whether an
   * aborted run leaves the index FLAGGED: a scope refusal that never touched a
   * byte must leave a good index both intact AND unflagged, or it is still
   * "destroyed for being large" as far as every reader is concerned.
   */
  let mutatedIndex = false;

  /**
   * file → module name, populated as we see each file's synthetic `module`
   * node. Non-module entities in that file use the module name as their ID
   * prefix to disambiguate from same-named entities in sibling files.
   * The native binary guarantees the module record arrives before any
   * function/class/method record from the same file.
   */
  const moduleByFile = new Map<string, string>();

  /**
   * Latch for the module-record-ordering warning below (one per ingest, like
   * {@link mutatedIndex}): a payload that violates ordering usually violates it
   * for EVERY record of an affected file, and a per-record warning would flood
   * the log the way the pre-dedup `native parse warning` lines once did.
   */
  let warnedModuleOrderFallback = false;

  /**
   * module entity id → the FIRST file that claimed it, so a second file
   * deriving the same id is REPORTED instead of silently overwriting it.
   *
   * WHY: ids are the `nodes` PRIMARY KEY, so when two files derive the same one
   * the second file's rows UPSERT over the first's and one file disappears from
   * the graph with no error anywhere — the class of bug that erased 22% of a
   * real monorepo. Reporting it is the difference between a wrong answer and a
   * reported one.
   *
   * SCHEMA v8 NARROWED THIS, IT DID NOT RETIRE IT. The collision this detector
   * was originally written for — `scopeForFile` eliding the first `src/`
   * segment, so `a/src/b.ts` and `a/b.ts` both derived `a/b` — is GONE: the
   * scope is now the directory path verbatim and is therefore injective on
   * files by construction (see `idScheme.ts`). Two collisions remain, both
   * pre-existing and both still only DETECTED here, never prevented:
   *   - EXTENSION-ONLY difference: `a/b.ts` and `a/b.py` both derive `a/b`,
   *     because the module name is the extension-stripped stem.
   *   - FILE-VERSUS-DIRECTORY: a function `b` in `a/src.ts` and the module node
   *     of `a/src/b.ts` both spell `a/src/b` — a file and a directory of the
   *     same name occupy one id namespace.
   *
   * Module-level is sufficient AND cheap: a non-module id is
   * `<scope>/<module>/<qn>`, so two files can only collide on an entity id if
   * they already collide on their module id. One entry per parsed file, bounded
   * by the file cap.
   *
   * SCOPE: per-RUN. A scoped/incremental run only sees the files it re-parsed,
   * so a collision against a file that was NOT re-parsed goes unreported until
   * the next whole-repo ingest. That is a detection gap, not a correctness one —
   * the overwrite it reports is pre-existing either way.
   */
  const fileByModuleId = new Map<string, string>();
  /** How many parsed files were OVERWRITTEN by an id collision this run (one
   *  per losing file, so three files sharing an id counts 2). Reported, never
   *  silent. */
  let idCollisions = 0;

  let filesTotal = 0;
  let filesDone = 0;
  let warnings = 0;
  let nativeNodes = 0;
  let nativeEdges = 0;
  let nativeElapsedMs = 0;
  /** Node RECORDS seen this run (not distinct ids) — the value `nodes.length`
   *  used to supply for the node cap and the {@link IngestResult}. */
  let nodeCount = 0;
  /** Raw edge RECORDS seen this run — the value `rawEdges.length` used to
   *  supply for the edge cap. */
  let edgeCount = 0;

  /**
   * Edge resolution, built INCREMENTALLY as node records arrive rather than in
   * one pass over a retained array. Same class the exported `resolveEdges`
   * runs on, so this path and every `resolveEdges` unit test share one
   * implementation — see {@link EdgeResolver}.
   */
  const resolver = new EdgeResolver(opts.repoRoot ?? process.cwd());

  const nodeBuffer: GraphNode[] = [];
  const flushNodes = (): void => {
    if (nodeBuffer.length === 0) return;
    db.upsertNodes(nodeBuffer);
    // One buffer, two sinks, flushed together: the spilled node set is
    // BY CONSTRUCTION the set that reached the `nodes` table, so the markdown
    // pass below cannot drift from the rows it describes.
    spill.appendNodes(nodeBuffer);
    mutatedIndex = true; // rows are now persisted — an abort leaves it partial
    nodeBuffer.length = 0;
  };
  const edgeBuffer: RawEdge[] = [];
  const flushEdges = (): void => {
    if (edgeBuffer.length === 0) return;
    spill.appendEdges(edgeBuffer);
    edgeBuffer.length = 0;
  };

  for await (const rec of run.records) {
    handleRecord(rec);
    if (abortReason !== null) break;
  }

  function handleRecord(rec: NativeRecord): void {
    switch (rec.type) {
      case "start":
        filesTotal = rec.files_total;
        logger?.info("native ingest started", {
          files_total: rec.files_total,
          native_version: rec.version,
        });
        // `files_total` was logged here and NEVER checked against anything —
        // there was no file-count cap anywhere. This is the earliest and
        // cheapest point to refuse an absurd scope (the home-directory case),
        // before a single file is parsed.
        if (filesTotal > maxFiles) {
          abortReason =
            `refusing to ingest ${filesTotal} files — above the ${maxFiles}-file ` +
            "cap. This usually means the ingest root is not a project (e.g. a " +
            "home directory). Check the root, or raise HAYVEN_MAX_INGEST_FILES. " +
            "The existing index was NOT modified.";
          break;
        }
        // THE DESTRUCTIVE CLEAR HAPPENS HERE, NOT BEFORE THE PARSE.
        //
        // `cli/ingest.ts` used to call `db.clearGraph()` before `startParse`,
        // while the file cap is only knowable from this `start` record — so a
        // repo above the cap had its previously-good index destroyed and flagged
        // broken purely for being large, and every retry re-wiped it: the next
        // run saw 0 nodes, was ineligible for the incremental path, took the
        // full path, cleared again, refused again. Permanently wedged until
        // someone exported the override. A scope refusal MUST precede the
        // destructive step, so the caller now delegates the clear to us and we
        // do it only once the run is known to be in-bounds.
        if (opts.clearBeforeIngest === true) {
          db.clearGraph();
          mutatedIndex = true;
        }
        break;
      case "node": {
        const qn = rec.qualified_name || rec.name;
        // Track the file's module name when the module node arrives.
        if (rec.kind === "module") {
          moduleByFile.set(rec.file, qn);
        }
        // For non-module entities, prepend the module name to disambiguate
        // across sibling files. The module node itself uses `qn` as-is.
        let moduleName =
          rec.kind === "module" ? undefined : moduleByFile.get(rec.file);
        if (rec.kind !== "module" && moduleName === undefined) {
          // ORDERING FALLBACK (ARCHITECTURE.md §2). The native binary
          // guarantees a file's module record arrives before any other record
          // from that file, so a miss here is a protocol violation. But
          // deriving the id WITHOUT the module segment silently reintroduces
          // the sibling-file collision the segment exists to prevent
          // (`parse/hash.rs` and `parse/extract.rs` both defining
          // `do_something` would collapse onto one `parse/do_something` row,
          // and ids are the PRIMARY KEY, so one definition vanishes). Fall
          // back to the segment a real module record WOULD have carried for
          // this file (`fallbackModuleName`: the stem, with the parent-dir
          // exceptions), so the derived id is byte-identical to the
          // well-ordered one, and warn once per ingest.
          moduleName = fallbackModuleName(rec.file);
          if (!warnedModuleOrderFallback) {
            warnedModuleOrderFallback = true;
            logger?.warn(
              "module-record ORDERING violation: non-module record arrived before its file's module record",
              {
                file: rec.file,
                kind: rec.kind,
                fallbackModule: moduleName,
                hint:
                  "the native binary guarantees module-first ordering per file; " +
                  "falling back to the file stem as the module segment so ids " +
                  "keep the documented <scope>/<module>/<qn> shape (warned once " +
                  "per ingest; later records use the same fallback silently)",
              },
            );
          }
        }
        const id = deriveEntityId(
          rec.file,
          qn,
          moduleName ? { moduleName, kind: rec.kind } : { kind: rec.kind },
        );
        if (rec.kind === "module") {
          const owner = fileByModuleId.get(id);
          if (owner === undefined) {
            fileByModuleId.set(id, rec.file);
          } else if (owner !== rec.file) {
            // Two source files derive the SAME primary key: the second silently
            // UPSERTs over the first. See `fileByModuleId` for why we report
            // rather than fix (an id-scheme migration) — but never stay quiet.
            idCollisions++;
            logger?.warn("entity-id COLLISION — two files derive the same module id", {
              id,
              file: rec.file,
              collidesWith: owner,
              hint:
                "ids are the `nodes` primary key, so one of these files is being " +
                "overwritten in the graph. Since schema v8 the id scope is the " +
                "directory path verbatim, so this is no longer a `src/`-elision " +
                "collision; the remaining causes are two files differing only by " +
                "EXTENSION (`a/b.ts` and `a/b.py` share the stem `b`, hence the " +
                "module id `a/b`), or a FILE AND A DIRECTORY of the same name " +
                "(`a/src.ts` defining `b` collides with `a/src/b.ts`'s module). " +
                "Rename one of them, or exclude one from indexing.",
            });
          }
        }
        const node: GraphNode = {
          id,
          name: rec.name,
          qualified_name: qn,
          kind: rec.kind,
          language: rec.language,
          file: rec.file,
          range: rec.range,
          ast_hash: rec.ast_hash,
          last_seen: Date.now(),
          logical_clock: 0,
        };
        nodeCount++;
        // Index the node NOW. Resolution still cannot start until the last node
        // has been offered (the ambiguity sentinel is only correct over the
        // complete set), but the INDEX can be built as they stream, which is
        // what removes the retained `nodes[]`.
        resolver.addNode(node);
        parsedFiles.add(rec.file);
        nodeBuffer.push(node);
        if (nodeBuffer.length >= NODE_BATCH) flushNodes();
        if (nodeCount > maxNodes) {
          abortReason =
            `refusing to ingest more than ${maxNodes} nodes — the resolver's ` +
            "name/qualified-name/ambiguity indexes must cover the whole graph " +
            "before any edge can be resolved, so they are the remaining heap " +
            "ceiling even though the node records themselves now spill to disk. " +
            "Raise HAYVEN_MAX_INGEST_NODES if this repo really is that large.";
        }
        break;
      }
      case "edge": {
        // `receiver` / `local` are OPTIONAL cross-lane contract fields that the
        // native EdgeRecord type doesn't declare yet (absent today). Read them
        // defensively so Tier-2 member-call resolution lights up automatically
        // once the native side emits them, with no behavior change until then.
        const anyRec = rec as unknown as {
          receiver?: unknown;
          receiver_chain?: unknown;
          local?: unknown;
          import_aliases?: unknown;
        };
        const receiver = typeof anyRec.receiver === "string" ? anyRec.receiver : undefined;
        // Multi-segment receiver chain (`api.client.search()` → ["api","client"]).
        // Additive cross-lane field; absent on single-segment receivers and older
        // binaries. Carried on RawEdge via the chain-augmented shape (see
        // {@link RawEdgeWithChain}) so types.ts (another lane) stays untouched.
        const receiverChain =
          Array.isArray(anyRec.receiver_chain) &&
          anyRec.receiver_chain.every((x): x is string => typeof x === "string") &&
          anyRec.receiver_chain.length > 0
            ? (anyRec.receiver_chain as string[])
            : undefined;
        const local = Array.isArray(anyRec.local)
          ? anyRec.local.filter((x): x is string => typeof x === "string")
          : undefined;
        // Aliased-import {local,imported} pairs (additive cross-lane field;
        // absent on the non-aliased common case and older binaries). Lets
        // resolveEdges map a call to a local alias back to the exported symbol.
        const importAliases = Array.isArray(anyRec.import_aliases)
          ? anyRec.import_aliases.filter(
              (x): x is ImportAliasPair =>
                typeof x === "object" &&
                x !== null &&
                typeof (x as { local?: unknown }).local === "string" &&
                typeof (x as { imported?: unknown }).imported === "string",
            )
          : undefined;
        // `line` / `col` are the additive 1-based call-site coordinates a native
        // agent emits on `static_call` edges (one edge record == one call
        // occurrence). Read defensively (finite-number only) like the receiver
        // fields above; absent on import edges and older binaries. Carried onto
        // RawEdge so resolveEdges can emit a per-occurrence call-site record.
        const lineRaw = (rec as unknown as { line?: unknown }).line;
        const line =
          typeof lineRaw === "number" && Number.isFinite(lineRaw) ? lineRaw : undefined;
        const colRaw = (rec as unknown as { col?: unknown }).col;
        const col =
          typeof colRaw === "number" && Number.isFinite(colRaw) ? colRaw : undefined;
        edgeBuffer.push({
          src_file: rec.src_file,
          src_name: rec.src_name,
          dst_name: rec.dst_name,
          kind: rec.kind,
          ...(receiver !== undefined ? { receiver } : {}),
          ...(receiverChain !== undefined ? { receiver_chain: receiverChain } : {}),
          ...(local !== undefined ? { local } : {}),
          ...(importAliases !== undefined && importAliases.length > 0
            ? { import_aliases: importAliases }
            : {}),
          ...(line !== undefined ? { line } : {}),
          ...(col !== undefined ? { col } : {}),
        } as RawEdgeWithChain);
        edgeCount++;
        if (edgeBuffer.length >= EDGE_BATCH) flushEdges();
        if (edgeCount > maxEdges) {
          abortReason =
            `refusing to ingest more than ${maxEdges} edges — every raw edge is ` +
            "retained until the second-pass resolve (they now spill to disk, but " +
            "the run still holds one aggregated row per distinct edge plus the " +
            "import-witness table). Raise HAYVEN_MAX_INGEST_EDGES if this repo " +
            "really is that large.";
        }
        break;
      }
      case "progress":
        filesDone = rec.files_done;
        break;
      case "warn":
        warnings++;
        logger?.warn("native parse warning", { file: rec.file, message: rec.message });
        break;
      case "done":
        filesDone = rec.files_done;
        nativeNodes = rec.nodes;
        nativeEdges = rec.edges;
        nativeElapsedMs = rec.elapsed_ms;
        break;
    }
  }
  // A cap breach means we are ABANDONING this run: kill the child (it would
  // otherwise keep burning CPU on a root we've already refused) and throw
  // WITHOUT flushing the tail buffer. Whatever earlier batches already landed
  // stay flagged by the in-progress marker, so the index reads as broken rather
  // than as a smaller-but-fine graph.
  if (abortReason !== null) {
    try {
      await run.kill();
    } catch {
      // the throw below is the signal that matters; a kill failure must not mask it
    }
    // A refusal that never wrote anything must leave the index EXACTLY as it
    // found it — including unflagged. Retract our own in-flight token so an
    // over-cap repo is not reported broken purely for being large (which also
    // made the next run ineligible for the incremental path, so it took the
    // full path, refused again, and stayed wedged). If we DID write, the flag
    // stays: the index really is partial.
    //
    // `callerDeclaredIngest` is the second half of that test. `endIngest()`
    // retracts the HANDLE's token, and a caller that cleared the graph itself
    // stamped that same token — so retracting on its behalf un-flags an index
    // the caller just EMPTIED, leaving a zero-node graph reading as healthy.
    // "We wrote nothing" is only "the index is untouched" when nobody else on
    // this handle wrote either.
    if (!mutatedIndex && !callerDeclaredIngest) db.endIngest();
    logger?.error("ingest aborted — hard cap exceeded", { reason: abortReason });
    throw new Error(abortReason);
  }

  flushNodes();
  flushEdges();

  // Verify the native binary exited cleanly.
  const code = await run.wait();
  if (code !== 0) {
    throw new Error(describeFailure(code, run.recentStderr()));
  }

  // SECOND PASS — resolve edges. The node set is complete, so the resolver may
  // now build its module-specifier index and start answering.
  resolver.sealNodes();
  // Import-witness pre-pass. `addImportEdge` ignores non-import edges, so this
  // is the same subset in the same order as the old inline loop over the whole
  // `rawEdges` array; the SQL filter just avoids parsing the other 80%.
  for (const page of spill.edges<RawEdge>(EDGE_BATCH, "import")) {
    for (const e of page) resolver.addImportEdge(e);
  }

  // Line-precise call sites — replace only what this run re-derived.
  //
  // This used to call `db.clearCallSites()` UNCONDITIONALLY, on the assumption
  // that `runIngest` is only ever the full-ingest path. It is not: the daemon
  // watcher's incremental `--files` batch drains through this exact function. So
  // saving ONE file in a watched project wiped the `call_sites` table for the
  // ENTIRE repo, and `refs --sites` then silently returned nothing for anything
  // except the last-saved file until someone ran a manual full ingest.
  //
  // We do not need the caller to tell us which files it handed the parser — the
  // node records already name every file this run parsed (`parsedFiles`). A call
  // site's `file` is the CALLER's source location, so re-parsing that file
  // supersedes its sites: deleting exactly the parsed files' sites and
  // re-inserting is correct for a full run AND a scoped one. `fullRebuild`
  // additionally opts into the O(1) whole-table clear, which also reclaims sites
  // belonging to files that vanished from the repo.
  //
  // The DELETE now runs BEFORE the resolve loop rather than after it, because
  // the loop streams its call sites straight into the table instead of building
  // one big `sites[]` array first. Same order of effects on the table (clear,
  // then insert this run's sites); it just no longer needs the array to exist.
  if (opts.fullRebuild === true) {
    db.clearCallSites();
  } else if (parsedFiles.size > 0) {
    db.deleteCallSitesByFile(parsedFiles);
  }

  // AGGREGATE before writing: `resolveEdges` emits ONE GraphEdge per raw edge
  // OCCURRENCE, so the same (src, dst, kind) key recurs once per call site. Fold
  // them into one row per key with the weight summed, then write with SET (not
  // accumulate) semantics via `replaceEdges`.
  //
  // WHY: `upsertEdges` does `weight = edges.weight + excluded.weight` on
  // conflict, which is correct ONLY if each key is written once per rebuild.
  // `hayven ingest` guaranteed that by calling `clearGraph()` first — and the
  // daemon's full re-ingest simply did not clear, so every repeated full ingest
  // INFLATED every edge weight without bound (measured: max weight 1 → 3 after
  // two runs), silently corrupting every weight-ordered ranking with no
  // user-visible signal. Making the DB write idempotent means a caller that
  // forgets to clear can no longer cause that. Correct on the incremental path
  // too: edges are keyed by `src`, and the incremental reconcile deletes a
  // changed file's nodes (and their src-side edges) before re-parsing, so every
  // key this run re-emits is a key it fully re-derived.
  //
  // Folding happens INLINE as each edge resolves, rather than over two
  // materialised `resolved[]`/`unresolved[]` arrays. That is safe because the
  // two groups can never share a key — a resolved dst is an entity id and an
  // unresolved one is `?:<name>` — so interleaving them cannot merge rows that
  // the old resolved-then-unresolved concatenation kept apart, and summing an
  // occurrence's weight is order-independent.
  // ONE `last_seen` stamp for every edge this run writes — the value the old
  // `const now = Date.now()` at the top of `resolveEdges` supplied.
  const now = Date.now();
  const aggregated = new Map<string, GraphEdge>();
  /** Unresolved edge OCCURRENCES (the old `unresolved.length`). */
  let unresolvedCount = 0;
  let siteBuffer: CallSite[] = [];
  for (const page of spill.edges<RawEdge>(EDGE_BATCH)) {
    for (const e of page) {
      const out = resolver.resolveOne(e, now);
      if (out === null) continue; // src not in the index — dropped, as before
      if (!out.resolved) unresolvedCount++;
      // NUL is the field separator (it cannot occur in an id or kind), written
      // as the ESCAPE `\x00` and never as a literal byte: a raw NUL makes
      // `file(1)` report this source as `data` and makes GNU grep/ripgrep
      // classify it as BINARY and skip it SILENTLY. Two separate audits of this
      // file (the ingest caps, the edge writes, the orphan sweep) came back empty
      // for exactly that reason. The escape costs nothing and keeps the file
      // visible to every tool.
      const key = `${out.edge.src}\x00${out.edge.dst}\x00${out.edge.kind}`;
      const prior = aggregated.get(key);
      if (prior === undefined) aggregated.set(key, out.edge);
      else prior.weight += out.edge.weight;
      // Per-occurrence call sites stream to the table in batches instead of
      // accumulating a whole-repo `sites[]` array (30k+ objects on a mid-size
      // repo). The delete that supersedes them already ran, above.
      if (out.site !== null) {
        siteBuffer.push(out.site);
        if (siteBuffer.length >= EDGE_BATCH) {
          db.insertCallSites(siteBuffer);
          siteBuffer = [];
        }
      }
    }
  }
  if (siteBuffer.length > 0) db.insertCallSites(siteBuffer);

  // One aggregated row per (src, dst, kind), written in batches straight off
  // the map so no whole-repo edge array is materialised.
  const edgeWriteBuffer: GraphEdge[] = [];
  for (const e of aggregated.values()) {
    edgeWriteBuffer.push(e);
    if (edgeWriteBuffer.length >= EDGE_BATCH) {
      db.replaceEdges(edgeWriteBuffer);
      edgeWriteBuffer.length = 0;
    }
  }
  if (edgeWriteBuffer.length > 0) db.replaceEdges(edgeWriteBuffer);

  // Write markdown files. `writeNodeMarkdowns` skips any file whose bytes are
  // already identical, so a watcher cycle over an unchanged repo now writes
  // nothing at all (this unconditional per-node rewrite was a direct contributor
  // to the incident's 12.6 GB written).
  //
  // Replayed from the spill a page at a time instead of from a retained
  // `nodes[]`. The nodes are byte-for-byte the objects that were written to the
  // `nodes` table (same buffer, same flush), so the markdown is identical to
  // what the array produced — in particular it still renders the `logical_clock`
  // and (absent) `summary` THIS RUN parsed, not whatever the stored row merged
  // them into, which is why the nodes are replayed rather than re-read from
  // SQLite. `ensuredDirs` is shared across pages so a directory is still
  // `mkdir`ed once per RUN, not once per page.
  const ensuredDirs = new Set<string>();
  for (const page of spill.nodes<GraphNode>(MARKDOWN_BATCH)) {
    await writeNodeMarkdowns(
      nodesDir,
      page,
      new Map(),
      opts.markdownConcurrency ?? 16,
      ensuredDirs,
    );
  }

  // Reclaim orphan markdown — files whose symbol was renamed or removed. ONLY
  // on a declared full rebuild, where `nodes` IS the complete graph; a scoped
  // run knows only the changed files' nodes and sweeping would delete the rest
  // of the repo's markdown. (Scoped runs reclaim via `removeNodeMarkdowns` with
  // ids captured before the per-file delete — see cli/ingest.ts.) Best-effort:
  // never fail a successful ingest over disk hygiene.
  if (opts.fullRebuild === true && opts.sweepOrphanMarkdown === true) {
    try {
      // `resolver.ids` is every id this run indexed — the same keep-set the old
      // `nodes.map((n) => n.id)` produced (the sweep builds a Set of derived
      // paths from it, so de-duplication is immaterial).
      const orphans = pruneOrphanNodeMarkdowns(nodesDir, resolver.ids);
      if (orphans > 0) logger?.info("reclaimed orphan node markdown", { removed: orphans });
    } catch (err) {
      logger?.warn("orphan node-markdown sweep failed (non-fatal)", {
        error: (err as Error).message,
      });
    }
  }

  // Stash stats. Record the git HEAD the index was built against, for the
  // freshness lane (it READS this stat; we only WRITE it). BEST-EFFORT + SAFE:
  // if git is unavailable, errors, times out, or this isn't a git repo, we
  // silently skip it — the ingest must never fail because of this. Bounded by a
  // short timeout so a hung git can't stall the ingest. Read BEFORE opening the
  // transaction so a slow git never holds a write lock.
  const finishedAt = Date.now();
  const gitHead = readGitHead(opts.repoRoot ?? process.cwd());

  // ONE transaction: record success AND clear the in-progress marker together.
  // These must not be separable — a crash between them would either leave a
  // completed index flagged broken (annoying) or, far worse, an unflagged index
  // carrying a fresh `last_ingest_at` it never earned.
  db.transaction(() => {
    db.setStat("last_ingest_at", String(finishedAt));
    if (gitHead) db.setStat("last_ingest_git_head", gitHead);
    // `last_ingest_nodes` records how many nodes the GRAPH held at the moment
    // this ingest succeeded — the live row count, NOT the native `done`
    // record's count. `checkIndexIntegrity` compares this against the current
    // row count, so it is precisely the "the index used to have content and now
    // has none" tripwire. The native count would be wrong for that purpose on an
    // incremental run (it counts only the re-parsed files' nodes, so a one-file
    // save would reset the watermark to ~5 — or to 0 for a file that defines
    // nothing — and a later wipe would go undetected). The native count is still
    // recorded, under a key that says what it is.
    // Only a declared full rebuild may LOWER the watermark — a scoped run's
    // live `counts()` can read 0 while a CONCURRENT process holds the graph
    // cleared, and committing that 0 disarms the empty-but-claims-content
    // detector. See `Db.recordNodeWatermark`.
    db.recordNodeWatermark(db.counts().nodes, opts.fullRebuild === true);
    db.setStat("last_ingest_native_nodes", String(nativeNodes));
    db.setStat("last_ingest_warnings", String(warnings));
    // Persisted so `doctor`/a later reader can see that this index is missing
    // files, rather than the fact living only in a log line that has scrolled.
    db.setStat("last_ingest_id_collisions", String(idCollisions));
    // Retracts ONLY this handle's token, so a concurrent ingest keeps its own
    // protection rather than being silently un-flagged by our success.
    db.endIngest();
  });

  if (idCollisions > 0) {
    // One line at the END, because the per-occurrence warnings above are easy to
    // lose in a long parse log. This means the graph is MISSING FILES.
    logger?.error("ingest finished with entity-id COLLISIONS — files are missing from the graph", {
      collisions: idCollisions,
      filesParsed: parsedFiles.size,
    });
  }

  // Reclaim TTL'd fleet memory. Expired notes were filtered out at READ time and
  // never deleted, so `fleet_memory` grew monotonically forever — and this
  // round's reindex fix now PRESERVES that table, so nothing reclaimed it at
  // all. A successful ingest is the natural hook: we already hold a writable
  // handle, and it is the one moment we know no rebuild is mid-flight.
  //
  // BOUNDED AND NOT A SURPRISE, deliberately:
  //   - only rows whose non-null TTL has ALREADY elapsed qualify — exactly the
  //     rows every reader already hides. Permanent notes (`ttl IS NULL`) are
  //     untouchable here.
  //   - rate-limited to once per PRUNE_INTERVAL_MS, so the watcher's
  //     per-file-save incremental ingests don't re-scan the table on every
  //     keystroke;
  //   - AFTER the success transaction and fully best-effort: a prune failure
  //     must never turn a good ingest into a failed one, or re-flag the index.
  try {
    const last = Number(db.getStat(FLEET_MEMORY_PRUNED_AT_KEY) ?? "0");
    const lastAt = Number.isFinite(last) && last > 0 ? last : 0;
    // `lastAt > finishedAt` means the stamp is in the FUTURE — a stepped-back
    // clock, or an index copied from a machine whose clock ran ahead. Treating
    // that as "recently pruned" would suppress the prune indefinitely, so a
    // future stamp prunes (and re-stamps to now) instead.
    if (lastAt > finishedAt || finishedAt - lastAt >= PRUNE_INTERVAL_MS) {
      const removed = pruneExpired(db, finishedAt);
      db.setStat(FLEET_MEMORY_PRUNED_AT_KEY, String(finishedAt));
      if (removed > 0) logger?.info("reclaimed expired fleet memory", { removed });
    }
  } catch (err) {
    logger?.warn("fleet-memory prune failed (non-fatal)", { error: (err as Error).message });
  }

  return {
    startedAt,
    finishedAt,
    filesTotal,
    filesDone,
    nodes: nodeCount,
    edges: aggregated.size,
    unresolvedEdges: unresolvedCount,
    warnings,
    nativeElapsedMs: nativeElapsedMs || finishedAt - startedAt,
    idCollisions,
  };
}

/** Convenience: blake3 hex digest of a byte string. */
export function blake3Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const out = blake3(bytes);
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}
