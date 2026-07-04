/**
 * Layer C — adversarial claim-preview seam. ARCHITECTURE.md §17.3.
 *
 * The `ClaimConflictOracle` interface is the LOCKED commitment (§17.3); the
 * implementation behind it is swappable. The Week 7 shipping default is the
 * deterministic, zero-dependency {@link HeuristicOracle}. A future `LlmOracle`
 * (PRD §7.3 / §8 Tier-3 model) is a drop-in implementing the same interface,
 * selected by the `conflict.oracle` config key via {@link selectOracle} — no
 * rewiring of the claim-registration path.
 */
import { isModelPresent, modelDir } from "../models/registry.ts";
import type { Logger } from "../util/log.ts";
import { LlmOracle, makeInferFn } from "./llm_oracle.ts";
import { ContractDiffClaimOracle } from "./contract_diff_oracle.ts";
import {
  buildSignatureIndex,
  dbEdgeIndex,
  dbEntityResolver,
  nativeSignatureExtractor,
  type DbLike,
} from "./native_signatures.ts";

/** Could two intended work-scopes break each other's assumptions? */
export interface ClaimConflictOracle {
  assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict>;
  readonly id: string; // e.g. "heuristic-v1"
}

export interface ClaimContext {
  readonly scope: readonly string[]; // entity IDs
  readonly intent: string; // claim intent text
  readonly neighbors: readonly string[]; // adjacent entity IDs from the graph
}

export interface ConflictVerdict {
  conflict: boolean;
  reason: string; // one sentence
  confidence: number; // 0..1; heuristic uses coarse bands
  oracle: string; // provenance: which oracle answered
}

/**
 * Stopwords + very-short tokens dropped during tokenization. Kept tiny and
 * code-flavored: the goal is to drop connective noise from intent prose so
 * that shared *identifiers* dominate the overlap signal.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "add", "adding", "fix", "fixing", "update",
  "updating", "refactor", "refactoring", "into", "from", "this", "that",
  "make", "use", "using", "support", "handle", "handling", "new", "old",
  "via", "onto", "over", "under", "when", "while", "then", "than", "also",
]);

/** Minimum token length kept after lowercasing/splitting (drops `a`, `to`...). */
const MIN_TOKEN_LEN = 3;

/**
 * Documented tokenization for the heuristic: lowercase, split on any run of
 * non-alphanumeric characters (so `auth/login_handler` → `auth`, `login`,
 * `handler`), drop stopwords and tokens shorter than {@link MIN_TOKEN_LEN}.
 * Deterministic and pure — no I/O, no randomness, no time.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function tokenizeAll(parts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of parts) for (const t of tokenize(p)) out.add(t);
  return out;
}

function sharesNeighbor(incoming: ClaimContext, adjacent: ClaimContext): boolean {
  // Two scopes "share a graph neighbor" when one's neighbor set touches the
  // other's scope, or their neighbor sets intersect.
  const incScope = new Set(incoming.scope);
  const adjScope = new Set(adjacent.scope);
  for (const n of incoming.neighbors) if (adjScope.has(n)) return true;
  for (const n of adjacent.neighbors) if (incScope.has(n)) return true;
  const incNeighbors = new Set(incoming.neighbors);
  for (const n of adjacent.neighbors) if (incNeighbors.has(n)) return true;
  return false;
}

function countSharedTokens(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Default oracle (`heuristic-v1`): deterministic, zero deps, pure function of
 * the two contexts. `conflict = true` when the two scopes share a graph
 * neighbor AND their intents/scopes touch overlapping surface — i.e. shared
 * identifier tokens between one claim's intent+scope and the other's
 * scope+neighbors.
 *
 * Coarse confidence bands:
 *   - 0.8  strong overlap  — 2+ shared identifier tokens (+ shared neighbor)
 *   - 0.5  weak overlap    — exactly 1 shared identifier token (+ shared neighbor)
 *   - 0.0  no conflict     — no shared neighbor, or no shared surface tokens
 */
export class HeuristicOracle implements ClaimConflictOracle {
  readonly id = "heuristic-v1";

  // `async` only to satisfy the Promise-returning interface; the body is a
  // pure, synchronous function — no `await`, no I/O, no randomness, no time.
  async assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict> {
    if (!sharesNeighbor(incoming, adjacent)) {
      return {
        conflict: false,
        reason: "Scopes are adjacent by module prefix only and share no graph neighbor.",
        confidence: 0,
        oracle: this.id,
      };
    }

    // Surface of each claim = intent tokens ∪ scope tokens; the other side's
    // comparison surface also folds in its graph neighbors' tokens.
    const incSurface = tokenizeAll([incoming.intent, ...incoming.scope]);
    const adjSurface = tokenizeAll([adjacent.intent, ...adjacent.scope, ...adjacent.neighbors]);
    const shared = countSharedTokens(incSurface, adjSurface);

    if (shared === 0) {
      return {
        conflict: false,
        reason: "Scopes share a graph neighbor but their intents and scopes use no common identifiers.",
        confidence: 0,
        oracle: this.id,
      };
    }

    const confidence = shared >= 2 ? 0.8 : 0.5;
    return {
      conflict: true,
      reason:
        `Scopes share a graph neighbor and ${shared} overlapping identifier ` +
        `token${shared === 1 ? "" : "s"}, so the two work-scopes likely touch the same surface.`,
      confidence,
      oracle: this.id,
    };
  }
}

/**
 * Whether a REAL dependency edge directly connects the two scopes — some entity
 * in one scope is an immediate call/import neighbor of some entity in the other.
 * Computable from the {@link ClaimContext}s alone: each context carries its
 * scope's one-hop `neighbors` (from `scopeNeighbors`), so a direct edge exists
 * iff a neighbor of one lands in the other's scope. (This is the "neighbor in
 * other scope" half of {@link sharesNeighbor}; it deliberately EXCLUDES the
 * shared-common-neighbor case — two siblings that both call a third entity are
 * NOT contract-coupled to each other.)
 */
function directEdge(a: ClaimContext, b: ClaimContext): boolean {
  const aScope = new Set(a.scope);
  const bScope = new Set(b.scope);
  for (const n of a.neighbors) if (bScope.has(n)) return true;
  for (const n of b.neighbors) if (aScope.has(n)) return true;
  return false;
}

/**
 * Graph-adjacency oracle (`graph-adjacency`) — E2, the "BL-13 killer" candidate
 * (docs/COORDINATION_ENTERPRISE_EXPERIMENTS.md). The heuristic over-blocks
 * because it fires on shared IDENTIFIER TOKENS between graph-connected scopes —
 * and two functions in one module share module-name tokens whether or not they
 * actually interact. This oracle drops the token signal entirely and rules on
 * STRUCTURE ALONE: `conflict = true` iff a real call/import EDGE directly couples
 * the two scopes (a genuine caller/callee contract dependency), else `false`.
 *
 * Trade (measured in bench/graph-precise-conflict.ts): it stops blocking
 * merely-co-located and shared-callee benign pairs (the bulk of the heuristic's
 * conservatism), at the cost of missing the rare *shared-module invariant*
 * conflict that has no dependency edge (already invisible to any static signal,
 * and to the heuristic's neighbor gate too). Deterministic, zero-dep, needs no
 * model or entity bodies — unlike contract-diff it does not read signatures, so
 * it runs anywhere the graph is loaded.
 */
export class GraphAdjacencyOracle implements ClaimConflictOracle {
  readonly id = "graph-adjacency";
  // `async` only to satisfy the interface; pure + synchronous, no I/O.
  async assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict> {
    if (directEdge(incoming, adjacent)) {
      return {
        conflict: true,
        reason:
          "A resolved call/import edge directly couples the two scopes, so a " +
          "contract change on one can break the other.",
        confidence: 0.7,
        oracle: this.id,
      };
    }
    return {
      conflict: false,
      reason: "No direct call/import edge couples the two scopes.",
      confidence: 0,
      oracle: this.id,
    };
  }
}

/** The deterministic graph-adjacency oracle id (E2). Selectable via
 * `config.conflict.oracle === "graph-adjacency"`; needs no binary/model/bodies. */
export const GRAPH_ADJACENCY_ORACLE_ID = "graph-adjacency";

/**
 * What {@link selectOracle} needs to construct an {@link LlmOracle} (§18.4):
 * the `.hayven` home (model-presence + path resolution), a native-binary
 * locator, and — for tests — injectable registry/infer hooks. All optional:
 * with none of it, selection can only ever return the zero-config heuristic,
 * which preserves the legacy `selectOracle(config?)` behavior verbatim.
 */
export interface OracleEnv {
  /** `.hayven` home, for `isModelPresent` / `modelDir`. */
  hayvenDir?: string | undefined;
  /** Resolve the `hayven-native` binary, or `null` if unavailable. */
  locateBinary?: (() => string | null) | undefined;
  /** Registry presence check (injected for tests). Defaults to the real one. */
  isModelPresent?: ((hayvenDir: string, id: string) => boolean) | undefined;
  /** Registry model-DIR resolver (injected for tests). Defaults to the real one. */
  modelDir?: ((hayvenDir: string, id: string) => string | null) | undefined;
  /** Live entity/edge index for the OPT-IN `contract-diff` oracle. When absent,
   * the contract-diff key degrades to the heuristic (it has no real graph to
   * diff). */
  db?: DbLike | undefined;
  /** Repo root, for slicing real entity bodies in the contract-diff oracle. */
  repoRoot?: string | undefined;
  /** Languages the signature index should parse (default: all supported). */
  parseLanguages?: string[] | undefined;
  logger?: Logger | undefined;
}

/** The opt-in deterministic contract-diff oracle id (ARCHITECTURE.md §17.3 /
 * CLAUDE.md item 6 (b)). NOT the shipping default — selecting it requires
 * `config.conflict.oracle === "contract-diff"` AND a locatable native binary +
 * a live Db; otherwise selection degrades to the heuristic. Flipping the default
 * is a separate, deliberate decision (CHANGELOG + conflict_rate sign-off) owned
 * by the main session. */
export const CONTRACT_DIFF_ORACLE_ID = "contract-diff";

/**
 * Oracle selection seam (§17.3 / §18.4). Returns an {@link LlmOracle} ONLY when
 * `config.conflict.oracle` names a model id that is (a) present on disk
 * (`isModelPresent`) and (b) a native binary is locatable — constructed with a
 * {@link HeuristicOracle} fallback so every model error/timeout degrades
 * gracefully. Otherwise returns the heuristic (the zero-config default, and the
 * `heuristic-v1` / unknown-key cases). Selection itself spawns nothing.
 */
export function selectOracle(
  config?: { conflict?: { oracle?: string } },
  env?: OracleEnv,
): ClaimConflictOracle {
  const key = config?.conflict?.oracle ?? "heuristic-v1";

  // The heuristic is the explicit, the unknown-key, and the zero-config default.
  if (key === "heuristic-v1") return new HeuristicOracle();

  // Deterministic graph-adjacency oracle (E2) — pure structural rule, no binary,
  // model, or entity bodies required. Selected only when explicitly named.
  if (key === GRAPH_ADJACENCY_ORACLE_ID) return new GraphAdjacencyOracle();

  // OPT-IN deterministic contract-diff oracle (CLAUDE.md item 6 (b)). Selected
  // only when the config explicitly names it. Requires a locatable native binary
  // (for the real tree-sitter signatures) AND a live Db (for the real entity +
  // edge index); without either it degrades to the heuristic — the safe fallback
  // — so the zero-config / no-binary path is unchanged. The shipping DEFAULT is
  // NOT flipped here (that's a separate, signed-off decision the main session
  // owns).
  if (key === CONTRACT_DIFF_ORACLE_ID) {
    if (!env) return new HeuristicOracle();
    const binary = env.locateBinary?.() ?? null;
    if (binary === null || env.db === undefined || env.repoRoot === undefined) {
      env.logger?.info(
        "conflict oracle: contract-diff requested but native binary / Db / repoRoot unavailable — using heuristic",
        { hasBinary: binary !== null, hasDb: env.db !== undefined, hasRepoRoot: env.repoRoot !== undefined },
      );
      return new HeuristicOracle();
    }
    try {
      // One repo-wide signature parse, reused across every claim assess (the
      // production lookup is O(1) by file::qualifiedName; no per-claim spawn).
      const index = buildSignatureIndex({
        binary,
        root: env.repoRoot,
        ...(env.parseLanguages ? { languages: env.parseLanguages } : {}),
      });
      env.logger?.info("conflict oracle: using contract-diff", {
        signatures: index.size,
        repoRoot: env.repoRoot,
      });
      return new ContractDiffClaimOracle({
        id: CONTRACT_DIFF_ORACLE_ID,
        resolver: dbEntityResolver(env.db, env.repoRoot),
        edgeIndex: dbEdgeIndex(env.db),
        // Index-only in the hot path: no per-body temp-file spawn per claim.
        signatureExtractor: nativeSignatureExtractor({ binary, index, perBodyFallback: false }),
      });
    } catch (err) {
      env.logger?.warn("conflict oracle: contract-diff init failed — using heuristic", {
        error: (err as Error).message,
      });
      return new HeuristicOracle();
    }
  }

  // Any other key is treated as a candidate model id. Without an env (legacy
  // callers / existing tests) we cannot resolve a model, so degrade to heuristic.
  if (!env) return new HeuristicOracle();

  const hayvenDir = env.hayvenDir;
  const present = env.isModelPresent ?? isModelPresent;
  const resolveDir = env.modelDir ?? modelDir;
  if (hayvenDir === undefined || !present(hayvenDir, key)) {
    env.logger?.info("conflict oracle: model not present — using heuristic", { oracle: key });
    return new HeuristicOracle();
  }

  const binary = env.locateBinary?.() ?? null;
  const resolvedModel = resolveDir(hayvenDir, key);
  if (binary === null || resolvedModel === null) {
    env.logger?.info("conflict oracle: native binary or model path unavailable — using heuristic", {
      oracle: key,
      hasBinary: binary !== null,
      hasModel: resolvedModel !== null,
    });
    return new HeuristicOracle();
  }

  env.logger?.info("conflict oracle: using LlmOracle", { oracle: key, modelDir: resolvedModel });
  return new LlmOracle({
    id: key,
    fallback: new HeuristicOracle(),
    infer: makeInferFn({
      binary,
      modelDir: resolvedModel,
      ...(env.logger ? { logger: env.logger } : {}),
    }),
    ...(env.logger ? { logger: env.logger } : {}),
  });
}
