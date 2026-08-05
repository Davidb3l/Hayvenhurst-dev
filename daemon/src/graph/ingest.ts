/**
 * Orchestrates a single ingest run.
 *
 * Drains the native binary's NDJSON stream, derives entity IDs, batches inserts
 * into SQLite (1000 records per transaction), resolves raw edge `dst_name`s to
 * entity IDs in a second pass, and writes markdown files in parallel.
 */
import { blake3 } from "@noble/hashes/blake3";

import { deriveEntityId, unresolvedEdgeId } from "./idScheme.ts";
import { pruneOrphanNodeMarkdowns, writeNodeMarkdowns } from "./nodeWriter.ts";
import { normalizePosix, SpecifierResolver } from "./specifierResolve.ts";
import { WorkspaceMap } from "./workspace.ts";
import type { GraphEdge, GraphNode, RawEdge } from "./types.ts";
import { pruneExpired } from "../db/fleet_memory.ts";
import { IngestSpill, type Db } from "../db/queries.ts";
import { describeFailure, type ParseRun } from "../native/process.ts";
import type { NativeRecord } from "../native/protocol.ts";
import type { Logger } from "../util/log.ts";

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

/** Aliased import binding (`import { a as b }` → {local:"b",imported:"a"}). */
type ImportAliasPair = { local: string; imported: string };

/**
 * {@link RawEdge} plus the additive multi-segment receiver chain
 * (`api.client.search()` → `["api","client"]`, ROOT→immediate-object) and the
 * aliased-import `{local, imported}` pairs (`import { a as b }`). Kept as a
 * local extension rather than fields on `RawEdge` because `graph/types.ts`
 * is owned by another lane; resolveEdges reads them back via the same
 * structural shape, so old payloads (no chain / no aliases) are unaffected. See
 * protocol.ts `EdgeRecord.{receiver_chain,import_aliases}` and proto.rs
 * `Record::Edge.{receiver_chain,import_aliases}`.
 */
type RawEdgeWithChain = RawEdge & {
  receiver_chain?: string[];
  import_aliases?: ImportAliasPair[];
};

/**
 * Sentinel marking a `dst_name` that maps to more than one distinct entity id
 * in the global qualified-name / name indexes. Resolving an edge to an
 * arbitrary one of several candidates would invent a false call edge, so an
 * ambiguous dst is treated as UNRESOLVED (`?:<name>`) instead. Kept as a unique
 * symbol-like literal so a real entity id can never collide with it.
 */
const AMBIGUOUS = "\0ambiguous" as const;

/**
 * A single RESOLVED call OCCURRENCE with its 1-based (file, line, col). One per
 * resolved call edge that carried line/col over the wire. `dst` is the called
 * symbol (the `refs --sites` lookup key), `src` the caller entity, `file` the
 * call site's file (the edge's `src_file`). Persisted to the `call_sites` table.
 */
export interface CallSite {
  dst: string;
  src: string;
  kind: string;
  file: string;
  line: number;
  col: number;
}

/** A call edge kind: `static_call`, `trace_call`, any `*_call`, or bare `call`.
 *  Kept local to avoid a graph→db import cycle; mirrors graph_walk.isCallKind. */
function isCallEdgeKind(kind: string): boolean {
  return kind === "call" || kind.endsWith("_call");
}

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
        const moduleName =
          rec.kind === "module" ? undefined : moduleByFile.get(rec.file);
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

export interface ResolveEdgesOptions {
  /**
   * Absolute repo root, used to locate `tsconfig.json` for alias-import
   * (`~/x`) specifier resolution. When omitted, alias resolution is skipped
   * (relative imports still resolve); pass `process.cwd()` for the default.
   */
  repoRoot?: string;
}

/**
 * Second-pass edge resolution.
 *
 * Strategy:
 *   1. Build indexes: by (file, name), by qualified_name (global), by name
 *      (global), and a `file → moduleId` index via {@link SpecifierResolver}.
 *   2. For each raw edge:
 *      a. `import` edges — `dst_name` is a MODULE SPECIFIER, never an entity
 *         name. Resolve it to the target module's entity id (relative `./x`,
 *         tsconfig alias `~/x`, with extension/`/index` probing). Bare/external
 *         specifiers (`preact`, `node:fs`) stay unresolved (correct).
 *      b. `static_call` edges WITH a `receiver` (Tier-2 member call
 *         `recv.method()`) — find the same-file import whose `local` binding
 *         includes the chain ROOT (`receiver`, or `receiver_chain[0]` for a
 *         multi-segment chain `api.client.search()`), resolve that import's
 *         specifier to a module id, then try a ladder of candidate ids:
 *           - chain `api.client.search` → `<mod>/client/search`, `<mod>/search`;
 *           - single `api.search`       → `<mod>/api/search`, `<mod>/search`;
 *           - bare component `<Stats/>` (receiver === dst_name, no member) →
 *             the module id itself (the Astro template usage IS the import).
 *         Falls back to the name lookups below if none match. (Cross-lane
 *         contract fields, absent on older payloads → this branch degrades to
 *         the single-receiver path and nothing else changes.)
 *      c. all other edges — same-file lookup, then qn, then unique name.
 *   3. Unresolved edges get id `?:<dst_name>`.
 *
 * PACKAGE SCOPING (monorepo P1 — bench/monorepo-astro-RESULTS.md §2c): the
 * qn/name indexes are scoped to the WORKSPACE PACKAGE a node's file belongs to
 * (via {@link WorkspaceMap.packageForFile}; a non-workspace repo is one
 * implicit package, so single-repo behavior is byte-identical). Global
 * name-match across package boundaries was a coin flip on a real monorepo: it
 * invented edges (`playwright.config.js`'s `defineConfig` — imported from
 * `@playwright/test` — attributed to astro's `defineConfig`) and, whenever a
 * name legitimately recurred across packages, went AMBIGUOUS and found nothing.
 * The rules now are:
 *   - name-match resolves WITHIN the source file's package only;
 *   - CROSS-package resolution requires an IMPORT-EDGE WITNESS: when the
 *     callee/receiver-root is bound by an import that resolves to an in-repo
 *     module, the symbol may resolve inside THAT package (ladder first, then a
 *     name-match scoped to the target package);
 *   - a callee bound by an import that resolves EXTERNALLY (npm pkg) never
 *     falls back to name-match at all — the witness says the symbol is not
 *     ours, so inventing an in-repo edge would be a false positive.
 */
export function resolveEdges(
  nodes: GraphNode[],
  rawEdges: RawEdge[],
  options?: ResolveEdgesOptions,
): { resolved: GraphEdge[]; unresolved: GraphEdge[]; sites: CallSite[] } {
  const resolver = new EdgeResolver(options?.repoRoot ?? "");
  for (const n of nodes) resolver.addNode(n);
  resolver.sealNodes();
  for (const e of rawEdges) resolver.addImportEdge(e);

  const now = Date.now();
  const resolved: GraphEdge[] = [];
  const unresolved: GraphEdge[] = [];
  // Per-occurrence call sites: one per RESOLVED call edge that carried 1-based
  // line/col over the wire. The `edges` table sums occurrences into `weight`;
  // this list preserves each occurrence's exact location for `refs --sites`.
  const sites: CallSite[] = [];
  for (const e of rawEdges) {
    const out = resolver.resolveOne(e, now);
    if (out === null) continue;
    if (out.resolved) resolved.push(out.edge);
    else unresolved.push(out.edge);
    if (out.site !== null) sites.push(out.site);
  }
  return { resolved, unresolved, sites };
}

/** One raw edge's resolution outcome — see {@link EdgeResolver.resolveOne}. */
export interface EdgeOutcome {
  edge: GraphEdge;
  /** True when `edge.dst` is a real entity id; false when it is `?:<dst_name>`. */
  resolved: boolean;
  /** The per-occurrence call site, when this is a resolved call edge that
   *  carried line/col; `null` otherwise. */
  site: CallSite | null;
}

/**
 * The edge-resolution engine, in INCREMENTAL form: feed nodes one at a time,
 * seal, feed the import edges, then resolve raw edges one at a time.
 *
 * WHY A CLASS (KNOWN_ISSUES #2): `runIngest` used to accumulate the whole
 * repo's `GraphNode[]` and `RawEdge[]` in heap purely so it could hand both to
 * one big `resolveEdges(nodes, rawEdges)` call, and heap therefore grew
 * linearly with repo size. It can now build the indexes as node records arrive
 * and resolve edges as they are replayed from the on-disk spill, holding no
 * record collection at all.
 *
 * The split is deliberately a REFACTOR, NOT A REWRITE. Everything below is the
 * original single-function body, cut at its existing phase boundaries, and the
 * exported {@link resolveEdges} is now a thin loop over this class. There is
 * exactly ONE implementation of resolution, so the streaming ingest path and
 * every existing `resolveEdges` unit test exercise the same code — which is the
 * only real defence against the failure mode this rework risks, namely a
 * second, subtly-different resolver that invents or loses edges silently.
 *
 * PHASE ORDER MATTERS and is enforced:
 *   1. {@link addNode} for EVERY node in the graph. The per-package ambiguity
 *      sentinel is only correct over the COMPLETE node set — a name seen once
 *      looks unique until the second definition arrives — so no edge may be
 *      resolved before the last node is in.
 *   2. {@link sealNodes} builds the {@link SpecifierResolver} over the node
 *      projections and releases them.
 *   3. {@link addImportEdge} for every raw edge (it filters to imports itself),
 *      building the per-file import-witness table.
 *   4. {@link resolveOne} per raw edge.
 */
export class EdgeResolver {
  private readonly ws: WorkspaceMap;
  private specResolver: SpecifierResolver | null = null;
  /**
   * Minimal `{id, kind, file}` projections of every node, kept ONLY until
   * {@link sealNodes} builds the SpecifierResolver from them (its constructor
   * reads exactly those three fields — one pass for `module` nodes, one for the
   * whole-graph id set, one for the dotted-import index). Retaining the full
   * `GraphNode`s instead cost 85 MB of a 235 MB peak heap on a 92k-node fixture,
   * for four fields (`name`, `qualified_name`, `ast_hash`, `range`) that
   * resolution never reads. Released at seal.
   */
  private nodeStubs: GraphNode[] = [];
  private readonly byFileName = new Map<string, string>();
  // Per-file index keyed by an entity's QUALIFIED name. The native extractor
  // sets an edge's `src_name` to the enclosing definition's `qualified_name`
  // (extract.rs `enclosing_definition(...).qualified_name`), NOT its bare
  // `name`: a method/nested arrow has `src_name="thing/resolve"` or
  // `"Cls.method"` while its node `name` is just `"resolve"`/`"method"`. Keying
  // the src lookup only by `name` (the historic behavior) silently DROPPED every
  // call whose enclosing definition was a method or nested function. We key by
  // qualified_name and fall back to it when the bare-name lookup misses.
  private readonly byFileQn = new Map<string, string>();
  // PACKAGE-SCOPED qn/name indexes: keyed `<pkg>\0<name>` so uniqueness (and
  // the AMBIGUOUS sentinel) is judged WITHIN a package, never across packages.
  // Two benefits on a monorepo: a name duplicated across packages no longer
  // poisons every package's lookup into AMBIGUOUS (false-negative fix), and a
  // name can never resolve into a foreign package without an import witness
  // (false-positive fix). Non-workspace repos have one package ("") — the maps
  // then degenerate to exactly the old global maps.
  private readonly byQualified = new Map<string, string | typeof AMBIGUOUS>();
  private readonly byName = new Map<string, string | typeof AMBIGUOUS>();
  private readonly byId = new Set<string>();
  /** id → owning package dir, for import-witnessed cross-package lookups. */
  private readonly pkgById = new Map<string, string>();
  private readonly pkgCache = new Map<string, string>();

  constructor(private readonly repoRoot: string) {
    // The workspace package map is loaded EAGERLY here rather than pulled off
    // `SpecifierResolver.workspace` later, because the per-package node indexes
    // below are built as nodes stream in — long before the resolver exists. The
    // same instance is then injected into the SpecifierResolver at seal, so both
    // sides still agree on package identity exactly as they did when one
    // function owned both. `WorkspaceMap.load` is a pure read of the repo's
    // workspace manifests; it does not depend on the node set.
    this.ws = WorkspaceMap.load(repoRoot);
  }

  /** Workspace package dir owning `file` ("" = root/implicit package). */
  private pkgOf(file: string): string {
    let pkg = this.pkgCache.get(file);
    if (pkg === undefined) {
      pkg = this.ws.packageForFile(file);
      this.pkgCache.set(file, pkg);
    }
    return pkg;
  }

  private static pkgKey(pkg: string, name: string): string {
    return `${pkg}\0${name}`;
  }

  /** Every entity id fed to {@link addNode}. Also the markdown orphan-sweep
   *  keep-set, which used to be `nodes.map((n) => n.id)`. */
  get ids(): ReadonlySet<string> {
    return this.byId;
  }

  /** PHASE 1 — index one node. Must be called for EVERY node in the graph
   *  before any edge is resolved (see the class doc on the ambiguity sentinel). */
  addNode(n: GraphNode): void {
    const { byFileName, byFileQn, byQualified, byName, byId, pkgById } = this;
    const pkgKey = EdgeResolver.pkgKey;
    // `{id, kind, file}` is the entire SpecifierResolver contract — see
    // {@link nodeStubs}. Order is preserved, so the resolver it builds at seal
    // is identical to one built from the full node array.
    this.nodeStubs.push({ id: n.id, kind: n.kind, file: n.file } as GraphNode);
    byFileName.set(`${n.file}::${n.name}`, n.id);
    byFileQn.set(`${n.file}::${n.qualified_name}`, n.id);
    byId.add(n.id);
    const pkg = this.pkgOf(n.file);
    pkgById.set(n.id, pkg);
    // A `module` node is resolved as an IMPORT target via the SpecifierResolver,
    // never as a call/reference `dst` by NAME (you import a module; you call a
    // symbol). Excluding modules from the GLOBAL name indexes prevents a module
    // from colliding with a same-named callable — e.g. a function named after its
    // own file (`def sympify` in `sympify.py`, module qn `sympify`, function qn
    // `sympify`). With the module included, that name went AMBIGUOUS and every
    // call `sympify(...)` fell through to `?:sympify` (unresolved), so `refs` on
    // the function found zero callers. The module stays in `byFileName`/
    // `byFileQn`/`byId` (it's a valid same-file lookup + a real import target);
    // only the by-NAME call-resolution indexes skip it.
    if (n.kind === "module") return;
    const qnKey = pkgKey(pkg, n.qualified_name);
    const existingQn = byQualified.get(qnKey);
    if (existingQn === undefined) byQualified.set(qnKey, n.id);
    else if (existingQn !== n.id) byQualified.set(qnKey, AMBIGUOUS);

    const nameKey = pkgKey(pkg, n.name);
    const existing = byName.get(nameKey);
    if (existing === undefined) byName.set(nameKey, n.id);
    else if (existing !== n.id) byName.set(nameKey, AMBIGUOUS);
  }

  /**
   * PHASE 2 — no more nodes. Builds the module-specifier resolver (file →
   * module id, with alias/relative/workspace probing) over the node
   * projections, then releases them.
   */
  sealNodes(): void {
    if (this.specResolver !== null) return;
    this.specResolver = new SpecifierResolver(this.nodeStubs, this.repoRoot, this.ws);
    // The stubs exist only to construct the resolver above; holding them past
    // this point would reinstate exactly the per-node retention this class was
    // written to remove. The strings they referenced that resolution still
    // needs (ids) are retained by `byId`/`pkgById` and by the resolver's own
    // index, so this frees the objects, not the data.
    this.nodeStubs = [];
  }

  private specs(): SpecifierResolver {
    if (this.specResolver === null) {
      // A programming error, not a data error: resolving before the node set is
      // complete would silently mis-resolve (the ambiguity sentinel and the
      // file→module index would both be partial), which is precisely the class
      // of bug this rework must not introduce. Fail loudly instead.
      throw new Error("EdgeResolver.resolveOne called before sealNodes()");
    }
    return this.specResolver;
  }

  // Per-file index of import `local` binding → resolved module id, for Tier-2
  // member-call resolution. Built lazily/once over rawEdges. `aliases` maps a
  // LOCAL binding (`ca`) to the originally-exported `imported` name
  // (`checkAccess`) for `import { checkAccess as ca }`, so a call to the alias
  // resolves to `<module>/checkAccess` rather than the non-existent
  // `<module>/ca`. Absent/empty when the import has no aliases (the common case).
  private readonly importsByFile = new Map<
    string,
    Array<{ local: string[]; spec: string; aliases?: Map<string, string> }>
  >();

  /** PHASE 3 — offer one raw edge to the import-witness table. Non-import edges
   *  and imports with no `local` bindings are ignored, so callers can simply
   *  replay every raw edge through it (which is what the old inline loop did). */
  addImportEdge(e: RawEdge): void {
    if (e.kind === "import" && e.local && e.local.length > 0) {
      let arr = this.importsByFile.get(e.src_file);
      if (!arr) {
        arr = [];
        this.importsByFile.set(e.src_file, arr);
      }
      const aliasPairs = (e as RawEdgeWithChain).import_aliases;
      let aliases: Map<string, string> | undefined;
      if (aliasPairs && aliasPairs.length > 0) {
        aliases = new Map<string, string>();
        for (const p of aliasPairs) aliases.set(p.local, p.imported);
      }
      arr.push({ local: e.local, spec: e.dst_name, ...(aliases ? { aliases } : {}) });
    }
  }

  /** Qn-then-name lookup WITHIN one package (no same-file preference). */
  private lookupInPackage(pkg: string, dstName: string): string | null {
    const qn = this.byQualified.get(EdgeResolver.pkgKey(pkg, dstName));
    // NB: the ambiguity sentinel is a literal string; exclude it explicitly so
    // an ambiguous dst never resolves to a bogus "ambiguous" entity id.
    if (typeof qn === "string" && qn !== AMBIGUOUS) return qn;
    const named = this.byName.get(EdgeResolver.pkgKey(pkg, dstName));
    if (typeof named === "string" && named !== AMBIGUOUS) return named;
    return null;
  }

  /**
   * Generic name-based resolution: same-file → same-PACKAGE qn → same-package
   * unique name. Scoped to the source file's package — cross-package hits
   * require the import-witness paths below, never bare name luck.
   */
  private resolveByName(srcFile: string, dstName: string): string | null {
    const sameFile = this.byFileName.get(`${srcFile}::${dstName}`);
    if (sameFile) return sameFile;
    return this.lookupInPackage(this.pkgOf(srcFile), dstName);
  }

  /**
   * PHASE 4 — resolve ONE raw edge. `now` is the `last_seen` stamp; callers pass
   * a single value captured once per run so a whole ingest's edges share it
   * (the previous `const now = Date.now()` at the top of `resolveEdges`).
   *
   * Returns `null` when the edge is DROPPED (its source is not in the index).
   */
  resolveOne(e: RawEdge, now: number): EdgeOutcome | null {
    const specResolver = this.specs();
    const importsByFile = this.importsByFile;
    const byId = this.byId;
    const pkgById = this.pkgById;
    // The extractor sets `src_name` to the enclosing definition's
    // qualified_name (extract.rs). For a top-level function that equals its
    // bare name (the `byFileName` hit); for a method/nested arrow it's the
    // qualified form (`thing/resolve`, `Cls.method`) → use the qn-keyed index.
    let srcId =
      this.byFileName.get(`${e.src_file}::${e.src_name}`) ??
      this.byFileQn.get(`${e.src_file}::${e.src_name}`);
    if (!srcId) {
      // The native extractor uses the file path as `src_name` when a call (or
      // nested import) has no NAMEABLE enclosing definition — e.g. a bare call
      // inside an anonymous arrow callback passed to a builder
      // (`fields: (t) => ({ resolve: async (...) => { fn() } })`). That synthetic
      // `src_name` is the one place a non-entity name reaches `resolveEdges`, so
      // the index lookups miss and the edge would be DROPPED entirely — the
      // bare-call-in-anonymous-scope bug. Attribute such an edge to the file's
      // MODULE node instead (the same fallback the extractor already uses for
      // module-scope imports), reusing the authoritative file→moduleId index the
      // SpecifierResolver built. This also self-heals any older/foreign payload
      // that carries a file-path `src_name` without a native rebuild.
      if (e.src_name === e.src_file) {
        srcId = specResolver.fileIndex.get(normalizePosix(e.src_file)) ?? undefined;
      }
      if (!srcId) {
        // The source itself isn't in our index — skip silently; the native
        // binary shouldn't emit edges for unknown sources, but be defensive.
        return null;
      }
    }

    let dstId: string | null = null;

    if (e.kind === "import") {
      // TIER-1: `dst_name` is a module specifier — resolve to a module entity.
      dstId = specResolver.resolve(e.src_file, e.dst_name);
    } else if (e.kind === "static_call" && e.receiver) {
      // TIER-2: member call `receiver.dst_name(...)`. Bind the chain ROOT to an
      // imported module, then resolve the member within it. The ROOT is
      // `receiver_chain[0]` for a multi-segment chain (`api.client.search()`),
      // else the immediate `receiver` (`api.search()`). Older payloads carry no
      // chain → the single-receiver path below is unchanged.
      const chain = (e as RawEdgeWithChain).receiver_chain;
      const root = chain && chain.length > 0 ? chain[0]! : e.receiver;
      const imports = importsByFile.get(e.src_file);
      const match = imports?.find((imp) => imp.local.includes(root));
      // True when the receiver ROOT is bound by an import that resolves
      // EXTERNALLY (npm pkg): the witness says the member is not in-repo, so
      // name-match fallbacks are suppressed (no invented edges).
      let externallyBound = false;
      if (match) {
        const moduleId = specResolver.resolve(e.src_file, match.spec);
        if (moduleId) {
          // Build the candidate id ladder, most specific first.
          const candidates: string[] = [];
          if (chain && chain.length > 1) {
            // `api.client.search` → intermediate segments after the ROOT, then
            // the member: `<mod>/client/search`. The ROOT itself maps to the
            // module, so it's dropped from the path.
            const inner = chain.slice(1).join("/");
            candidates.push(`${moduleId}/${inner}/${e.dst_name}`);
          } else {
            // Single receiver `api.search` → `<mod>/api/search` (the historic
            // `<mod>/<receiver>/<member>` form). If the receiver is an aliased
            // import (`import { obj as o }; o.search()`), also try the original
            // exported name (`<mod>/obj/search`).
            candidates.push(`${moduleId}/${e.receiver}/${e.dst_name}`);
            const exportedRecv = match.aliases?.get(e.receiver);
            if (exportedRecv && exportedRecv !== e.receiver) {
              candidates.push(`${moduleId}/${exportedRecv}/${e.dst_name}`);
            }
          }
          // A member directly under the module (`<mod>/search`). For a namespace
          // import (`import * as ns from "m"; ns.fn()`) the receiver `ns` binds
          // to the module, so this `<mod>/fn` candidate is exactly the resolution
          // (no alias needed — `local` already binds `ns` to the module).
          candidates.push(`${moduleId}/${e.dst_name}`);
          // Astro template component usage (`<Stats/>`): the whole expression IS
          // the imported binding (no member access — receiver === dst_name and
          // no chain), so it resolves to the imported MODULE itself.
          if (!chain && e.receiver === e.dst_name) candidates.push(moduleId);
          for (const cand of candidates) {
            if (byId.has(cand)) {
              dstId = cand;
              break;
            }
          }
          // IMPORT-WITNESSED cross-package fallback: the receiver's import
          // pins the target module — if the id ladder missed, try the member
          // name WITHIN the target module's package only.
          if (!dstId) {
            dstId = this.lookupInPackage(pkgById.get(moduleId) ?? "", e.dst_name);
          }
        } else {
          externallyBound = true;
        }
      }
      // Fall back to same-file/same-package name resolution — unless the
      // receiver is witnessed as an EXTERNAL import (then a name-match hit
      // would be a false cross-package edge; stay unresolved, honest).
      if (!dstId && !externallyBound) dstId = this.resolveByName(e.src_file, e.dst_name);
    } else if (e.kind === "static_call") {
      // BARE call `fn(...)` (no receiver). The global name lookups handle the
      // common case where the callee name is unique, but they MISS when:
      //   - the name is ambiguous (same name defined in several files) yet the
      //     import in THIS file pins which one is meant, or
      //   - the callee isn't directly named anywhere reachable by the global
      //     index but is re-exported through the imported module.
      // So prefer the same import→module resolution the import edge used: if
      // `dst_name` is a local binding introduced by an import in this file,
      // resolve that import's specifier to a module id and look for the symbol
      // under it (`<module>/<dst_name>`). This reuses the SpecifierResolver, so
      // parent-relative (`../lib/x`), `.ts`-extension, alias (`~/x`) and
      // barrel/`index` specifiers all resolve consistently with import edges.
      const imports = importsByFile.get(e.src_file);
      const match = imports?.find((imp) => imp.local.includes(e.dst_name));
      // True when the callee is bound by an import that resolves EXTERNALLY
      // (`import { defineConfig } from "@playwright/test"`): the witness says
      // the symbol is not in-repo. Falling through to name-match here is what
      // invented the measured astro false positive (playwright's/vitest's
      // `defineConfig` attributed to astro's) — suppressed instead.
      let externallyBound = false;
      if (match) {
        const moduleId = specResolver.resolve(e.src_file, match.spec);
        if (moduleId) {
          // The symbol under the module is the ORIGINALLY-exported name. For an
          // aliased import (`import { checkAccess as ca }`, dst_name `ca`) the
          // real entity keeps its export name `checkAccess`, so map the local
          // alias back to it via the import's alias table; a non-aliased import
          // uses `dst_name` directly. (Previously the alias case was left
          // unresolved because the export name wasn't recoverable from the
          // local binding alone — now the native side carries the pair.)
          const exported = match.aliases?.get(e.dst_name) ?? e.dst_name;
          // Only accept a target that is a REAL entity defined under the
          // resolved module (`<module>/<exported>`). We deliberately do NOT fall
          // back to the bare module node — that would invent a misleading
          // function→module edge.
          const direct = `${moduleId}/${exported}`;
          if (byId.has(direct)) dstId = direct;
          // IMPORT-WITNESSED cross-package fallback: the import pins the
          // target module, but the symbol may live deeper than `<module>/<name>`
          // (re-exported through a barrel — `astro/config` re-exports
          // `defineConfig` from core). The witness licenses a name-match
          // scoped to the TARGET module's package (unique-within-package only).
          if (!dstId) {
            dstId = this.lookupInPackage(pkgById.get(moduleId) ?? "", exported);
          }
        } else {
          externallyBound = true;
        }
      }
      // Fall back to same-file/same-package name resolution if no import
      // binding pinned a target (keeps unique-name bare calls working as
      // before) — unless the binding is witnessed EXTERNAL (stay unresolved).
      if (!dstId && !externallyBound) dstId = this.resolveByName(e.src_file, e.dst_name);
    } else {
      dstId = this.resolveByName(e.src_file, e.dst_name);
    }

    if (dstId) {
      // Per-occurrence call site: record (file, line, col) for a RESOLVED call
      // edge whenever the native side carried line/col. One edge record == one
      // call occurrence, so this is exactly that occurrence's position; the
      // file is the edge's `src_file`. Absent line/col (import edges, older
      // binaries) → no site, gracefully.
      const site: CallSite | null =
        isCallEdgeKind(e.kind) &&
        typeof e.line === "number" &&
        Number.isFinite(e.line) &&
        typeof e.col === "number" &&
        Number.isFinite(e.col)
          ? {
              dst: dstId,
              src: srcId,
              kind: e.kind,
              file: e.src_file,
              line: e.line,
              col: e.col,
            }
          : null;
      return {
        edge: {
          src: srcId,
          dst: dstId,
          kind: e.kind,
          weight: e.weight ?? 1,
          last_seen: now,
        },
        resolved: true,
        site,
      };
    }
    return {
      edge: {
        src: srcId,
        dst: unresolvedEdgeId(e.dst_name),
        kind: e.kind,
        weight: e.weight ?? 1,
        last_seen: now,
      },
      resolved: false,
      site: null,
    };
  }
}

/**
 * BL-10 — cross-graph unresolved-edge re-resolution.
 *
 * An incremental `--files` ingest only resolves edges within the changed file
 * set, so a caller in an *unchanged* file that referenced a now-renamed/moved
 * entity keeps its stale `?:<name>` edge until the next full ingest. This is
 * the §10 Q4 "always re-resolve unresolved edges" path: a cheap in-memory pass
 * over the WHOLE node set, run after every incremental batch.
 *
 * We re-resolve only the `?:`-prefixed (unresolved) edges already in the SQL
 * cache — resolved edges are left untouched (an entity that *went away* leaves
 * a dangling dst, a tolerated state per §7 / `deleteNodesByFile`). For each
 * `?:<name>` edge we look the name up against the global qualified-name and
 * bare-name indexes built from every node now in the graph; the same-file
 * lookup isn't available (the original `src_file`/`dst_name` context isn't
 * persisted), but the global lookups are exactly what closes the cross-file
 * rename gap. Ambiguous names (>1 distinct id) stay unresolved rather than
 * resolve to a bogus candidate (mirrors {@link resolveEdges}).
 *
 * Rewriting an edge's `dst` changes its `(src, dst, kind)` primary key, so we
 * delete the old `?:` row and upsert the resolved one inside one transaction.
 * Idempotent: a second pass finds no `?:` edges that newly resolve and is a
 * no-op. Returns the number of edges re-resolved.
 *
 * PACKAGE SCOPING mirrors {@link resolveEdges}: when `repoRoot` is provided,
 * the name indexes are scoped per workspace package and a `?:` edge only
 * re-resolves WITHIN its source node's package (cross-package edges belong to
 * the import-witnessed ingest paths, which this cheap pass cannot re-run).
 * Without a `repoRoot` — or in a non-workspace repo — everything is one
 * implicit package and behavior is unchanged.
 *
 * IMPORT EDGES ARE EXCLUDED. An unresolved `import` edge's dst is `?:` plus a
 * module SPECIFIER (`?:config`, `?:preact`), not an entity name — the main
 * resolver only ever resolves imports through the SpecifierResolver and
 * deliberately leaves external specifiers unresolved ("a wrong resolution is
 * worse than an orphan"). Name-matching a specifier here rewired a repo's
 * import of the npm package `config` onto a local function named `config`,
 * polluting refs/importers/impact until the next full reingest. Imports stay
 * unresolved until a full/file reingest re-runs the SpecifierResolver.
 */
export function reresolveAllEdges(db: Db, repoRoot?: string): number {
  // 1. Build the per-package indexes from EVERY node currently in the graph.
  //    The SQL cache (CRDT-derived but authoritative for graph reads) is the
  //    cheap source — `nodes(name, qualified_name)` is what `resolveEdges`
  //    indexed in-pass at ingest time.
  const ws = WorkspaceMap.load(repoRoot ?? "");
  const pkgCache = new Map<string, string>();
  const pkgOf = (file: string): string => {
    let pkg = pkgCache.get(file);
    if (pkg === undefined) {
      pkg = ws.packageForFile(file);
      pkgCache.set(file, pkg);
    }
    return pkg;
  };
  const pkgKey = (pkg: string, name: string): string => `${pkg}\0${name}`;

  const byQualified = new Map<string, string | typeof AMBIGUOUS>();
  const byName = new Map<string, string | typeof AMBIGUOUS>();
  /** src entity id → its file's package, to scope each edge's lookup. */
  const pkgById = new Map<string, string>();
  const allNodes = db.handle
    .query<{ id: string; name: string; qualified_name: string; kind: string; file: string }, []>(
      "SELECT id, name, qualified_name, kind, file FROM nodes",
    )
    .all();
  for (const n of allNodes) {
    const pkg = pkgOf(n.file);
    pkgById.set(n.id, pkg);
    // Mirror resolveEdges: a `module` node is never a call/reference dst-by-name
    // (it's an import target), so excluding it keeps a function named after its
    // own file (`sympify` in `sympify.py`) from being shadowed into AMBIGUOUS.
    if (n.kind === "module") continue;
    const qnKey = pkgKey(pkg, n.qualified_name);
    const existingQn = byQualified.get(qnKey);
    if (existingQn === undefined) byQualified.set(qnKey, n.id);
    else if (existingQn !== n.id) byQualified.set(qnKey, AMBIGUOUS);

    const nameKey = pkgKey(pkg, n.name);
    const existing = byName.get(nameKey);
    if (existing === undefined) byName.set(nameKey, n.id);
    else if (existing !== n.id) byName.set(nameKey, AMBIGUOUS);
  }

  // 2. Collect the currently-unresolved (`?:`) edges and the id each now
  //    resolves to. The `edges_dst` index makes the prefix scan cheap.
  interface UnresolvedRow {
    src: string;
    dst: string;
    kind: string;
    weight: number;
    last_seen: number | null;
  }
  // `kind != 'import'` mirrors the doc-block exclusion above: an import's
  // `?:` payload is a module specifier, which the name indexes must never see.
  // Only `import` is excluded — every other EdgeKind carries an entity name.
  const unresolved = db.handle
    .query<UnresolvedRow, [string]>(
      "SELECT src, dst, kind, weight, last_seen FROM edges WHERE dst LIKE ? AND kind != 'import'",
    )
    .all(`${UNRESOLVED_PREFIX}%`);

  const rewrites: Array<{ row: UnresolvedRow; newDst: string }> = [];
  for (const e of unresolved) {
    // Guard: only `?:`-prefixed dsts (LIKE '?:%' is exact for our ids, but the
    // `?` is a SQL-LIKE wildcard-free literal here; keep the slice precise).
    if (!e.dst.startsWith(UNRESOLVED_PREFIX)) continue;
    // Belt-and-suspenders with the SQL filter: never name-resolve an import's
    // specifier, even if a future query change drops the WHERE clause.
    if (e.kind === "import") continue;
    const name = e.dst.slice(UNRESOLVED_PREFIX.length);
    // Scope the lookup to the SOURCE node's package (an unknown src — deleted
    // node — falls back to the root package, matching resolveEdges' default).
    const pkg = pkgById.get(e.src) ?? "";
    const qn = byQualified.get(pkgKey(pkg, name));
    const named = byName.get(pkgKey(pkg, name));
    let dstId: string | null = null;
    if (typeof qn === "string" && qn !== AMBIGUOUS) dstId = qn;
    else if (typeof named === "string" && named !== AMBIGUOUS) dstId = named;
    // Defensive: never resolve an edge to point at itself (a self-loop from a
    // name that now matches the very entity emitting the call is meaningless).
    if (dstId !== null && dstId !== e.src) {
      rewrites.push({ row: e, newDst: dstId });
    }
  }
  if (rewrites.length === 0) return 0;

  // 3. Rewrite atomically: drop the `?:` row, upsert the resolved edge.
  //    Changing `dst` changes the (src, dst, kind) primary key, so this is a
  //    delete + insert, not an UPDATE.
  const del = db.handle.query("DELETE FROM edges WHERE src = ? AND dst = ? AND kind = ?");
  db.transaction(() => {
    for (const { row, newDst } of rewrites) {
      del.run(row.src, row.dst, row.kind);
      db.upsertEdge({
        src: row.src,
        dst: newDst,
        kind: row.kind as GraphEdge["kind"],
        weight: row.weight,
        last_seen: Date.now(),
      });
    }
  });
  return rewrites.length;
}

/** Prefix marking an unresolved edge dst — kept in lockstep with `unresolvedEdgeId`. */
const UNRESOLVED_PREFIX = "?:";

/** Convenience: blake3 hex digest of a byte string. */
export function blake3Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const out = blake3(bytes);
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}
