/**
 * `impact --preview` engine — the PRE-EDIT "what breaks if I change this
 * contract" decision tool (ROADMAP Tier 3, the grep-can't-do-this differentiator
 * upgraded into a decision aid).
 *
 * `hayven impact <symbol>` already computes the TRANSITIVE blast radius (every
 * dependent reachable by BFS over incoming call/import edges). `--preview`
 * upgrades that flat list into a RANKED, GROUPED-BY-WHY report you can read
 * BEFORE editing a symbol's contract:
 *
 *   - DIRECT contract-breakers — depth-1 callers/importers. These are the
 *     entities that reference the symbol directly, so a change to its SIGNATURE
 *     (arity / params / return type / a visibility drop) is the highest-risk
 *     group: a `tsc` would light up here first. Ranked by blast radius (their own
 *     call-site weight into the symbol, then the size of the sub-tree that hangs
 *     off them, then depth).
 *   - TRANSITIVE dependents — depth ≥ 2. Affected only THROUGH the direct set
 *     (caller-of-a-caller). Lower / indirect risk: they break only if the change
 *     ripples past the direct boundary. Ranked by depth then sub-tree size.
 *
 * It also surfaces the symbol's CURRENT contract (arity / return type /
 * visibility) via the real tree-sitter signature index, so the report can say
 * "you are about to change `fn(arity=2, returns X, visibility=public)`". That
 * enrichment is BEST-EFFORT: when no native binary / no repoRoot is available it
 * degrades gracefully — `contract` is null and the graph-classification (the core
 * value) is unchanged.
 *
 * ADVISORY ONLY. A pure signature-diff + static-edge walk cannot see arrow-fn
 * class fields, decorators, dynamic dispatch, or re-exports, so this is a
 * "these LIKELY break — verify with `tsc`" aid, never a completeness guarantee.
 * The {@link ImpactPreview.advisory} string carries that caveat into every
 * surface.
 *
 * Pure + daemonless + testable: it takes a `Db` and reuses the already-built
 * `graph_walk` helpers (`impactOf`/`refsSummary`/`importersOf`/`callersOf`) and
 * the `native_signatures` machinery. The CLI and the HTTP route are thin wrappers.
 */
import {
  callersOf,
  impactOf,
  importersOf,
  MAX_IMPACT_DEPTH,
  refsSummary,
  resolveNodeId,
  type ImpactResult,
} from "./graph_walk.ts";
import type { Db } from "./queries.ts";
import {
  buildSignatureIndex,
  dbEntityResolver,
  nativeSignatureExtractor,
  type SignatureIndex,
} from "../conflict/native_signatures.ts";
import type { Signature } from "../conflict/contract_diff_oracle.ts";

/** The advisory caveat — the same string everywhere so the CLI, JSON, and HTTP
 *  surfaces all carry the honest "verify with tsc" framing + the known
 *  residual false-negatives a pure signature/static-edge analysis cannot see. */
export const PREVIEW_ADVISORY =
  "Advisory only — these dependents LIKELY break if the symbol's contract changes; " +
  "verify with `tsc` (or your typechecker). Residual false-negatives: arrow-function " +
  "class fields, decorators, dynamic dispatch, and re-exports are not followed.";

/** The symbol's CURRENT extracted contract, when a signature could be resolved. */
export interface ContractInfo {
  /** Declared formal-parameter count (receiver excluded). */
  arity: number;
  /** Per-parameter type/text, in order. */
  params: string[];
  /** Declared return type, or null. */
  returnType: string | null;
  /** Coarse visibility (a confirmed-private symbol can't break cross-file callers). */
  visibility: "public" | "private" | "unknown";
  /** A one-line human rendering, e.g. `fn(arity=2, returns: string, visibility: public)`. */
  summary: string;
}

/** One ranked DIRECT contract-breaker: a depth-1 caller/importer of the symbol. */
export interface DirectBreaker {
  id: string;
  /** Always 1 (direct = depth-1). Kept explicit so the JSON shape mirrors transitive. */
  depth: 1;
  /** How this dependent reaches the symbol: a caller (call edge), an importer
   *  (import edge), or both. Callers are the higher-risk signature-breakers. */
  via: "call" | "import" | "call+import";
  /** Total call occurrences into the symbol from this entity (0 for import-only). */
  callSites: number;
  /** Size of the dependent sub-tree that hangs off this breaker (its own
   *  transitive dependents within the walk) — the secondary blast-radius rank. */
  subtree: number;
}

/** One TRANSITIVE dependent: reached at depth ≥ 2, only through the direct set. */
export interface TransitiveDependent {
  id: string;
  /** BFS depth from the symbol (≥ 2). */
  depth: number;
  /** Size of the dependent sub-tree hanging off this node within the walk. */
  subtree: number;
}

export interface ImpactPreview {
  /** The resolved symbol id. */
  symbol: string;
  /** The chosen id when `rawId` was fuzzy-resolved via the top FTS hit; else null. */
  resolved: string | null;
  /** The symbol's current extracted contract, or null when no signature was
   *  found (no binary, not callable, or extraction failed) — the graph
   *  classification below is still complete in that case. */
  contract: ContractInfo | null;
  /** Highest-risk group: depth-1 callers/importers, ranked by blast radius. */
  directBreakers: DirectBreaker[];
  /** Lower-risk group: depth ≥ 2 dependents, ranked by depth then sub-tree size. */
  transitive: TransitiveDependent[];
  /** The effective depth cap applied to the walk. */
  depth: number;
  /** True when the BFS hit the depth cap with the frontier still expanding. */
  capped: boolean;
  /** The advisory caveat ({@link PREVIEW_ADVISORY}). */
  advisory: string;
}

export interface PreviewOptions {
  /** Repo root — required to slice entity bodies + build the signature index for
   *  contract enrichment. When omitted, contract is null (graph-only preview). */
  repoRoot?: string | undefined;
  /** Absolute path to `hayven-native`. When omitted (no binary), contract
   *  enrichment is skipped and `contract` is null — the graph path is unchanged. */
  binary?: string | undefined;
  /** Max BFS depth for the blast radius. Defaults to {@link MAX_IMPACT_DEPTH}. */
  depth?: number | undefined;
  /** Pre-built signature index (test injection / reuse). When supplied the
   *  engine uses it instead of building one from `binary`+`repoRoot`. */
  signatureIndex?: SignatureIndex | undefined;
}

/**
 * Count, for each node in the walk, how many OTHER hits sit transitively below
 * it — i.e. the size of its dependent sub-tree WITHIN this blast radius. We use
 * a single forward BFS over incoming edges restricted to the already-discovered
 * hit set (so it's bounded by the radius, not the whole graph). This is the
 * secondary blast-radius rank: a direct breaker that drags 40 transitive
 * dependents behind it is riskier than one that drags none.
 *
 * Cheap + approximate by design: we count reachable hit nodes via incoming
 * call/import edges, deduped, excluding the node itself. Cycles are bounded by
 * the visited set.
 */
function subtreeSizes(db: Db, root: string, hitIds: Set<string>): Map<string, number> {
  // Restrict traversal to nodes inside the blast radius (the symbol + its hits)
  // so we never wander outside the already-computed impact set.
  const inRadius = new Set<string>(hitIds);
  inRadius.add(root);
  const sizes = new Map<string, number>();

  for (const start of hitIds) {
    const seen = new Set<string>([start]);
    let frontier: string[] = [start];
    let count = 0;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const e of db.incoming(cur)) {
          // Only call/import edges are blast-radius edges (same filter impactOf
          // uses). `isCallKind`/`IMPORT_KIND` are re-derived cheaply here to
          // avoid importing internals beyond the public helpers.
          const isCall = e.kind === "call" || e.kind.endsWith("_call");
          const isImport = e.kind === "import";
          if (!isCall && !isImport) continue;
          if (!inRadius.has(e.src)) continue; // stay inside the radius
          if (seen.has(e.src)) continue;
          seen.add(e.src);
          next.push(e.src);
          count++;
        }
      }
      frontier = next;
    }
    sizes.set(start, count);
  }
  return sizes;
}

/**
 * Best-effort contract extraction for the symbol being previewed. Returns null
 * (graceful degrade) whenever the binary/repoRoot/index aren't available, the
 * node has no file, or no callable signature is found. Never throws.
 */
function extractContract(
  db: Db,
  id: string,
  opts: PreviewOptions,
): ContractInfo | null {
  const node = db.getNode(id);
  if (!node || !node.file) return null;

  // Build (or reuse) a signature index. Requires both a binary and a repoRoot;
  // if either is missing we degrade to "no contract".
  let index: SignatureIndex | undefined = opts.signatureIndex;
  if (!index) {
    if (!opts.binary || !opts.repoRoot) return null;
    try {
      index = buildSignatureIndex({ binary: opts.binary, root: opts.repoRoot });
    } catch {
      return null;
    }
  }

  let sig: Signature | null = null;
  try {
    // The native extractor resolves first via the index (by file::qualified),
    // then optionally a per-body parse. We slice the real body from the repo so
    // the per-body fallback has source; if repoRoot is absent the resolver
    // yields an empty body and the index lookup still works.
    const resolver = opts.repoRoot
      ? dbEntityResolver(db, opts.repoRoot)
      : undefined;
    const entity = resolver?.resolve(id);
    const extractor = nativeSignatureExtractor({
      binary: opts.binary ?? "",
      index,
      // Avoid a spawn-per-call in the hot path; the index is the source of truth.
      perBodyFallback: false,
    });
    sig = extractor.signatureOf({
      body: entity?.body ?? "",
      language: node.language ?? "unknown",
      kind: node.kind,
      name: node.name,
      file: node.file,
      qualifiedName: node.qualified_name,
    });
  } catch {
    return null;
  }
  if (!sig || !sig.hasCallable) return null;

  const ret = sig.returnType ? `returns: ${sig.returnType}` : "returns: (none)";
  return {
    arity: sig.arity,
    params: sig.params,
    returnType: sig.returnType,
    visibility: sig.visibility,
    summary: `${sig.name}(arity=${sig.arity}, ${ret}, visibility: ${sig.visibility})`,
  };
}

/**
 * Compute the pre-edit impact preview for `id`. Resolves the symbol, extracts
 * its current contract (best-effort), computes the transitive blast radius, then
 * CLASSIFIES every dependent into DIRECT contract-breakers (depth-1) vs
 * TRANSITIVE (depth ≥ 2) and RANKS each group by blast radius.
 *
 * Returns null only when the symbol id cannot be resolved at all.
 */
export function previewImpact(
  db: Db,
  id: string,
  opts: PreviewOptions = {},
): ImpactPreview | null {
  const resolved = resolveNodeId(db, id);
  if (!resolved) return null;
  const symbol = resolved.id;

  const maxDepth = opts.depth ?? MAX_IMPACT_DEPTH;
  const impact: ImpactResult = impactOf(db, symbol, maxDepth);

  const hitIds = new Set(impact.hits.map((h) => h.id));
  const sizes = subtreeSizes(db, symbol, hitIds);

  // Per-direct-dependent call/import attribution. `refsSummary` gives us the
  // depth-1 set with caller/importer split + per-edge weights (call-site count
  // into the symbol). We fold callers + importers into a single direct row keyed
  // by entity id, recording whether it reaches via call, import, or both.
  const callerWeight = new Map<string, number>();
  for (const e of callersOf(db, symbol)) {
    callerWeight.set(e.src, (callerWeight.get(e.src) ?? 0) + e.weight);
  }
  const importerSet = new Set<string>(importersOf(db, symbol).map((e) => e.src));

  const directBreakers: DirectBreaker[] = [];
  const transitive: TransitiveDependent[] = [];
  for (const h of impact.hits) {
    const subtree = sizes.get(h.id) ?? 0;
    if (h.depth === 1) {
      const callSites = callerWeight.get(h.id) ?? 0;
      const isCaller = callerWeight.has(h.id);
      const isImporter = importerSet.has(h.id);
      const via: DirectBreaker["via"] =
        isCaller && isImporter ? "call+import" : isCaller ? "call" : "import";
      directBreakers.push({ id: h.id, depth: 1, via, callSites, subtree });
    } else {
      transitive.push({ id: h.id, depth: h.depth, subtree });
    }
  }

  // RANK direct breakers by blast radius: call-site count into the symbol (the
  // textual occurrences a signature change must touch) DESC, then the size of
  // the sub-tree they drag behind them DESC, then id for stable output. Callers
  // naturally outrank import-only dependents because import-only has callSites=0.
  directBreakers.sort(
    (a, b) =>
      b.callSites - a.callSites ||
      b.subtree - a.subtree ||
      a.id.localeCompare(b.id),
  );
  // RANK transitive by proximity (shallower = closer to the change) then by
  // sub-tree size DESC, then id.
  transitive.sort(
    (a, b) => a.depth - b.depth || b.subtree - a.subtree || a.id.localeCompare(b.id),
  );

  const contract = extractContract(db, symbol, opts);

  return {
    symbol,
    resolved: resolved.resolved ? symbol : null,
    contract,
    directBreakers,
    transitive,
    depth: impact.depth,
    capped: impact.capped,
    advisory: PREVIEW_ADVISORY,
  };
}
