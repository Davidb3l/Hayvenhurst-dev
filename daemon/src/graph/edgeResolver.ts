/**
 * Edge resolution: the `dst_name` → entity-id second pass, its incremental
 * {@link EdgeResolver} form, and the cross-graph re-resolution sweep.
 * Extracted verbatim from `ingest.ts`; no behavior changes.
 */
import { unresolvedEdgeId } from "./idScheme.ts";
import { PackageScopedNameIndex } from "./nameIndex.ts";
import { normalizePosix, SpecifierResolver } from "./specifierResolve.ts";
import { WorkspaceMap } from "./workspace.ts";
import type { GraphEdge, GraphNode, RawEdge } from "./types.ts";
import type { Db } from "../db/queries.ts";

/** Aliased import binding (`import { a as b }` → {local:"b",imported:"a"}). */
export type ImportAliasPair = { local: string; imported: string };

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
export type RawEdgeWithChain = RawEdge & {
  receiver_chain?: string[];
  import_aliases?: ImportAliasPair[];
};

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
  // The package-scoped qn/name indexes, shared verbatim with
  // reresolveAllEdges. See {@link PackageScopedNameIndex} for the key format,
  // the module exclusion, and the ambiguity rule. This class feeds it EVERY
  // node in the graph, which is what makes its AMBIGUOUS verdict complete.
  private readonly names = new PackageScopedNameIndex();
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

  /** Every entity id fed to {@link addNode}. Also the markdown orphan-sweep
   *  keep-set, which used to be `nodes.map((n) => n.id)`. */
  get ids(): ReadonlySet<string> {
    return this.byId;
  }

  /** PHASE 1 — index one node. Must be called for EVERY node in the graph
   *  before any edge is resolved (see the class doc on the ambiguity sentinel). */
  addNode(n: GraphNode): void {
    const { byFileName, byFileQn, byId, pkgById } = this;
    // `{id, kind, file}` is the entire SpecifierResolver contract — see
    // {@link nodeStubs}. Order is preserved, so the resolver it builds at seal
    // is identical to one built from the full node array.
    this.nodeStubs.push({ id: n.id, kind: n.kind, file: n.file } as GraphNode);
    byFileName.set(`${n.file}::${n.name}`, n.id);
    byFileQn.set(`${n.file}::${n.qualified_name}`, n.id);
    byId.add(n.id);
    const pkg = this.pkgOf(n.file);
    pkgById.set(n.id, pkg);
    // Only the by-NAME portion is shared. Everything above (nodeStubs,
    // byFileName, byFileQn, byId, pkgById) is this class's alone and still runs
    // for EVERY node, modules included: a module is a valid same-file lookup
    // and a real import target. The shared index drops modules itself; see
    // {@link PackageScopedNameIndex.add} for why (the `sympify` case).
    this.names.add(pkg, n);
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
    return this.names.lookup(pkg, dstName);
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
 * the §10 Q4 "always re-resolve unresolved edges" path, run after every
 * incremental batch, so it is BOUNDED BY THE UNRESOLVED SET, not the graph:
 *   1. fetch the `?:` (non-import) edges first, cheap via the `edges_dst`
 *      prefix index. Zero rows (the overwhelmingly common warm-graph case)
 *      returns immediately without touching `nodes` at all;
 *   2. otherwise materialize ONLY the nodes whose `name` or `qualified_name`
 *      matches one of the unresolved names (chunked IN lists), plus the edges'
 *      src nodes for package scoping, never the whole node table. On a
 *      100k-node monorepo the old whole-table `SELECT` built three JS maps of
 *      the entire graph per one-file save.
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
  // 1. Fetch the currently-unresolved (`?:`) edges FIRST; the `edges_dst`
  //    index makes the prefix scan cheap, and on a warm graph the answer is
  //    almost always "none", in which case we return without reading a single
  //    node row. Order matters: this function runs after EVERY incremental
  //    batch (a one-file save), so its idle cost is what the watcher pays per
  //    keystroke.
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
  if (unresolved.length === 0) return 0;

  // 2. Build the per-package indexes from ONLY the candidate nodes: the ones
  //    whose `name` or `qualified_name` matches an unresolved name. The
  //    AMBIGUOUS computation is unchanged by the restriction: for any name we
  //    will actually look up, EVERY node carrying it (by name or qn) is in the
  //    candidate fetch, so per-package multiplicity for that key is exactly
  //    what the old whole-table scan computed. Chunked IN lists mirror the
  //    bound-parameter chunking in db/queries.ts (`deleteCallSitesByFile`).
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
  const CHUNK = 500;

  const names = new Set<string>();
  for (const e of unresolved) {
    if (e.dst.startsWith(UNRESOLVED_PREFIX)) names.add(e.dst.slice(UNRESOLVED_PREFIX.length));
  }

  interface CandidateRow {
    id: string;
    name: string;
    qualified_name: string;
    kind: string;
    file: string;
  }
  // De-duplicated by id: a node whose `name` AND `qualified_name` both match
  // (the common top-level-function case) comes back once per chunk membership,
  // and double-counting it would fabricate an AMBIGUOUS verdict.
  const candidates = new Map<string, CandidateRow>();
  const nameList = [...names];
  for (let i = 0; i < nameList.length; i += CHUNK) {
    const chunk = nameList.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.handle
      .query<CandidateRow, string[]>(
        `SELECT id, name, qualified_name, kind, file FROM nodes ` +
          `WHERE name IN (${placeholders}) OR qualified_name IN (${placeholders})`,
      )
      .all(...chunk, ...chunk);
    for (const r of rows) candidates.set(r.id, r);
  }

  // Package scoping needs the SRC side too: `pkgById` is looked up by each
  // edge's src id (which need not be a candidate; it is usually a plain
  // resolved caller), so fetch those nodes' files in a second small IN query
  // keyed by id (the primary key). A src that no longer exists stays absent and
  // falls back to the root package below, exactly as before.
  /** src entity id → its file's package, to scope each edge's lookup. */
  const pkgById = new Map<string, string>();
  const srcIds = [...new Set(unresolved.map((e) => e.src))];
  for (let i = 0; i < srcIds.length; i += CHUNK) {
    const chunk = srcIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.handle
      .query<{ id: string; file: string }, string[]>(
        `SELECT id, file FROM nodes WHERE id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const r of rows) pkgById.set(r.id, pkgOf(r.file));
  }

  // Same index, same rules, same key format as EdgeResolver's, literally the
  // same class. The only difference is the node population fed in: the
  // candidate subset rather than the whole graph, which is sound because every
  // node carrying a name we will look up is in that subset (see step 2 above).
  const nameIndex = new PackageScopedNameIndex();
  for (const n of candidates.values()) nameIndex.add(pkgOf(n.file), n);

  // 3. Compute the id each unresolved edge now resolves to.
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
    const dstId = nameIndex.lookup(pkg, name);
    // Defensive: never resolve an edge to point at itself (a self-loop from a
    // name that now matches the very entity emitting the call is meaningless).
    if (dstId !== null && dstId !== e.src) {
      rewrites.push({ row: e, newDst: dstId });
    }
  }
  if (rewrites.length === 0) return 0;

  // 4. Rewrite atomically: drop the `?:` row, upsert the resolved edge.
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
