/**
 * Orchestrates a single ingest run.
 *
 * Drains the native binary's NDJSON stream, derives entity IDs, batches inserts
 * into SQLite (1000 records per transaction), resolves raw edge `dst_name`s to
 * entity IDs in a second pass, and writes markdown files in parallel.
 */
import { blake3 } from "@noble/hashes/blake3";

import { deriveEntityId, unresolvedEdgeId } from "./idScheme.ts";
import { writeNodeMarkdowns } from "./nodeWriter.ts";
import { normalizePosix, SpecifierResolver } from "./specifierResolve.ts";
import type { GraphEdge, GraphNode, RawEdge } from "./types.ts";
import type { Db } from "../db/queries.ts";
import { describeFailure, type ParseRun } from "../native/process.ts";
import type { NativeRecord } from "../native/protocol.ts";
import type { Logger } from "../util/log.ts";

const NODE_BATCH = 1000;
const EDGE_BATCH = 1000;

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
  const { db, nodesDir, run, logger } = opts;
  const startedAt = Date.now();

  const nodes: GraphNode[] = [];
  const rawEdges: RawEdge[] = [];

  /**
   * file → module name, populated as we see each file's synthetic `module`
   * node. Non-module entities in that file use the module name as their ID
   * prefix to disambiguate from same-named entities in sibling files.
   * The native binary guarantees the module record arrives before any
   * function/class/method record from the same file.
   */
  const moduleByFile = new Map<string, string>();

  let filesTotal = 0;
  let filesDone = 0;
  let warnings = 0;
  let nativeNodes = 0;
  let nativeEdges = 0;
  let nativeElapsedMs = 0;

  const nodeBuffer: GraphNode[] = [];
  const flushNodes = (): void => {
    if (nodeBuffer.length === 0) return;
    db.upsertNodes(nodeBuffer);
    nodeBuffer.length = 0;
  };

  for await (const rec of run.records) {
    handleRecord(rec);
  }

  function handleRecord(rec: NativeRecord): void {
    switch (rec.type) {
      case "start":
        filesTotal = rec.files_total;
        logger?.info("native ingest started", {
          files_total: rec.files_total,
          native_version: rec.version,
        });
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
        nodes.push(node);
        nodeBuffer.push(node);
        if (nodeBuffer.length >= NODE_BATCH) flushNodes();
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
        rawEdges.push({
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
  flushNodes();

  // Verify the native binary exited cleanly.
  const code = await run.wait();
  if (code !== 0) {
    throw new Error(describeFailure(code, run.recentStderr()));
  }

  // Resolve edges in a second pass.
  const { resolved, unresolved, sites } = resolveEdges(nodes, rawEdges, {
    repoRoot: opts.repoRoot ?? process.cwd(),
  });
  // Batch insert resolved + unresolved edges.
  const allEdges: GraphEdge[] = [...resolved, ...unresolved];
  if (allEdges.length > 0) {
    for (let i = 0; i < allEdges.length; i += EDGE_BATCH) {
      const batch = allEdges.slice(i, i + EDGE_BATCH);
      db.upsertEdges(batch);
    }
  }

  // Line-precise call sites. `runIngest` is the FULL-ingest path (it rebuilds
  // the whole graph), so mirror how edges are handled: clear the table, then
  // rewrite every site this run produced. (INCREMENTAL GAP: the `--files`
  // re-ingest path lives elsewhere and would instead call
  // `db.deleteCallSitesByFile(changedFiles)` + `insertCallSites(sites)` to
  // replace just the changed files' sites; that integration is left to the
  // watcher path — here we always do the authoritative full clear+rewrite.)
  db.clearCallSites();
  if (sites.length > 0) {
    for (let i = 0; i < sites.length; i += EDGE_BATCH) {
      db.insertCallSites(sites.slice(i, i + EDGE_BATCH));
    }
  }

  // Write markdown files in parallel.
  await writeNodeMarkdowns(nodesDir, nodes, new Map(), opts.markdownConcurrency ?? 16);

  // Stash stats.
  const finishedAt = Date.now();
  db.setStat("last_ingest_at", String(finishedAt));
  // Record the git HEAD the index was built against, for the freshness lane
  // (it READS this stat; we only WRITE it). BEST-EFFORT + SAFE: if git is
  // unavailable, errors, times out, or this isn't a git repo, we silently skip
  // it — the ingest must never fail because of this. Bounded by a short timeout
  // so a hung git can't stall the ingest.
  const gitHead = readGitHead(opts.repoRoot ?? process.cwd());
  if (gitHead) db.setStat("last_ingest_git_head", gitHead);
  // `nativeNodes` is the node count from the native `done` record — store it
  // under a key that names what it is. (It was previously written under a
  // `…native_version` key, a copy-paste mismatch: the value is a count, not a
  // version, and nothing read it.)
  db.setStat("last_ingest_nodes", String(nativeNodes));
  db.setStat("last_ingest_warnings", String(warnings));

  return {
    startedAt,
    finishedAt,
    filesTotal,
    filesDone,
    nodes: nodes.length,
    edges: allEdges.length,
    unresolvedEdges: unresolved.length,
    warnings,
    nativeElapsedMs: nativeElapsedMs || finishedAt - startedAt,
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
 *      c. all other edges — same-file lookup, then global qn, then unique name.
 *   3. Unresolved edges get id `?:<dst_name>`.
 */
export function resolveEdges(
  nodes: GraphNode[],
  rawEdges: RawEdge[],
  options?: ResolveEdgesOptions,
): { resolved: GraphEdge[]; unresolved: GraphEdge[]; sites: CallSite[] } {
  const now = Date.now();
  const byFileName = new Map<string, string>();
  // Per-file index keyed by an entity's QUALIFIED name. The native extractor
  // sets an edge's `src_name` to the enclosing definition's `qualified_name`
  // (extract.rs `enclosing_definition(...).qualified_name`), NOT its bare
  // `name`: a method/nested arrow has `src_name="thing/resolve"` or
  // `"Cls.method"` while its node `name` is just `"resolve"`/`"method"`. Keying
  // the src lookup only by `name` (the historic behavior) silently DROPPED every
  // call whose enclosing definition was a method or nested function. We key by
  // qualified_name and fall back to it when the bare-name lookup misses.
  const byFileQn = new Map<string, string>();
  const byQualified = new Map<string, string | typeof AMBIGUOUS>();
  const byName = new Map<string, string | typeof AMBIGUOUS>();
  const byId = new Set<string>();

  for (const n of nodes) {
    byFileName.set(`${n.file}::${n.name}`, n.id);
    byFileQn.set(`${n.file}::${n.qualified_name}`, n.id);
    byId.add(n.id);
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
    if (n.kind === "module") continue;
    const existingQn = byQualified.get(n.qualified_name);
    if (existingQn === undefined) byQualified.set(n.qualified_name, n.id);
    else if (existingQn !== n.id) byQualified.set(n.qualified_name, AMBIGUOUS);

    const existing = byName.get(n.name);
    if (existing === undefined) byName.set(n.name, n.id);
    else if (existing !== n.id) byName.set(n.name, AMBIGUOUS);
  }

  // Module-specifier resolver (file → module id, with alias/relative probing).
  const specResolver = new SpecifierResolver(nodes, options?.repoRoot ?? "");

  // Per-file index of import `local` binding → resolved module id, for Tier-2
  // member-call resolution. Built lazily/once over rawEdges. `aliases` maps a
  // LOCAL binding (`ca`) to the originally-exported `imported` name
  // (`checkAccess`) for `import { checkAccess as ca }`, so a call to the alias
  // resolves to `<module>/checkAccess` rather than the non-existent
  // `<module>/ca`. Absent/empty when the import has no aliases (the common case).
  const importsByFile = new Map<
    string,
    Array<{ local: string[]; spec: string; aliases?: Map<string, string> }>
  >();
  for (const e of rawEdges) {
    if (e.kind === "import" && e.local && e.local.length > 0) {
      let arr = importsByFile.get(e.src_file);
      if (!arr) {
        arr = [];
        importsByFile.set(e.src_file, arr);
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

  const resolved: GraphEdge[] = [];
  const unresolved: GraphEdge[] = [];
  // Per-occurrence call sites: one per RESOLVED call edge that carried 1-based
  // line/col over the wire. The `edges` table sums occurrences into `weight`;
  // this list preserves each occurrence's exact location for `refs --sites`.
  const sites: CallSite[] = [];

  /** Generic name-based resolution (same-file → global qn → unique name). */
  const resolveByName = (srcFile: string, dstName: string): string | null => {
    const sameFile = byFileName.get(`${srcFile}::${dstName}`);
    if (sameFile) return sameFile;
    const qn = byQualified.get(dstName);
    // NB: the ambiguity sentinel is a literal string; exclude it explicitly so
    // an ambiguous dst never resolves to a bogus "ambiguous" entity id.
    if (typeof qn === "string" && qn !== AMBIGUOUS) return qn;
    const named = byName.get(dstName);
    if (typeof named === "string" && named !== AMBIGUOUS) return named;
    return null;
  };

  for (const e of rawEdges) {
    // The extractor sets `src_name` to the enclosing definition's
    // qualified_name (extract.rs). For a top-level function that equals its
    // bare name (the `byFileName` hit); for a method/nested arrow it's the
    // qualified form (`thing/resolve`, `Cls.method`) → use the qn-keyed index.
    let srcId =
      byFileName.get(`${e.src_file}::${e.src_name}`) ??
      byFileQn.get(`${e.src_file}::${e.src_name}`);
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
        continue;
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
        }
      }
      // Fall back to the generic name resolution if the member didn't resolve.
      if (!dstId) dstId = resolveByName(e.src_file, e.dst_name);
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
          // function→module edge — so a miss stays unresolved (honest).
          const direct = `${moduleId}/${exported}`;
          if (byId.has(direct)) dstId = direct;
        }
      }
      // Fall back to the generic name resolution if the import binding didn't
      // pin a target (keeps unique-name bare calls working as before).
      if (!dstId) dstId = resolveByName(e.src_file, e.dst_name);
    } else {
      dstId = resolveByName(e.src_file, e.dst_name);
    }

    if (dstId) {
      resolved.push({
        src: srcId,
        dst: dstId,
        kind: e.kind,
        weight: e.weight ?? 1,
        last_seen: now,
      });
      // Per-occurrence call site: record (file, line, col) for a RESOLVED call
      // edge whenever the native side carried line/col. One edge record == one
      // call occurrence, so this is exactly that occurrence's position; the
      // file is the edge's `src_file`. Absent line/col (import edges, older
      // binaries) → no site, gracefully.
      if (
        isCallEdgeKind(e.kind) &&
        typeof e.line === "number" &&
        Number.isFinite(e.line) &&
        typeof e.col === "number" &&
        Number.isFinite(e.col)
      ) {
        sites.push({
          dst: dstId,
          src: srcId,
          kind: e.kind,
          file: e.src_file,
          line: e.line,
          col: e.col,
        });
      }
    } else {
      unresolved.push({
        src: srcId,
        dst: unresolvedEdgeId(e.dst_name),
        kind: e.kind,
        weight: e.weight ?? 1,
        last_seen: now,
      });
    }
  }

  return { resolved, unresolved, sites };
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
 */
export function reresolveAllEdges(db: Db): number {
  // 1. Build the global indexes from EVERY node currently in the graph. The
  //    SQL cache (CRDT-derived but authoritative for graph reads) is the cheap
  //    source — `nodes(name, qualified_name)` is what `resolveEdges` indexed
  //    in-pass at ingest time.
  const byQualified = new Map<string, string | typeof AMBIGUOUS>();
  const byName = new Map<string, string | typeof AMBIGUOUS>();
  const allNodes = db.handle
    .query<{ id: string; name: string; qualified_name: string; kind: string }, []>(
      "SELECT id, name, qualified_name, kind FROM nodes",
    )
    .all();
  for (const n of allNodes) {
    // Mirror resolveEdges: a `module` node is never a call/reference dst-by-name
    // (it's an import target), so excluding it keeps a function named after its
    // own file (`sympify` in `sympify.py`) from being shadowed into AMBIGUOUS.
    if (n.kind === "module") continue;
    const existingQn = byQualified.get(n.qualified_name);
    if (existingQn === undefined) byQualified.set(n.qualified_name, n.id);
    else if (existingQn !== n.id) byQualified.set(n.qualified_name, AMBIGUOUS);

    const existing = byName.get(n.name);
    if (existing === undefined) byName.set(n.name, n.id);
    else if (existing !== n.id) byName.set(n.name, AMBIGUOUS);
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
  const unresolved = db.handle
    .query<UnresolvedRow, [string]>(
      "SELECT src, dst, kind, weight, last_seen FROM edges WHERE dst LIKE ?",
    )
    .all(`${UNRESOLVED_PREFIX}%`);

  const rewrites: Array<{ row: UnresolvedRow; newDst: string }> = [];
  for (const e of unresolved) {
    // Guard: only `?:`-prefixed dsts (LIKE '?:%' is exact for our ids, but the
    // `?` is a SQL-LIKE wildcard-free literal here; keep the slice precise).
    if (!e.dst.startsWith(UNRESOLVED_PREFIX)) continue;
    const name = e.dst.slice(UNRESOLVED_PREFIX.length);
    const qn = byQualified.get(name);
    const named = byName.get(name);
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
