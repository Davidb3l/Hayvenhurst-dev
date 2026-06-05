/**
 * Blocker A — candidate (b): DETERMINISTIC contract-diff oracle.
 *
 * WHY THIS EXISTS
 * ---------------
 * The shipping `HeuristicOracle` (oracle.ts) over-blocks adjacent-benign
 * concurrent claims (~45.8% held-out conservatism) because its only signal is
 * *token overlap* between the two intents/scopes. Token overlap cannot tell a
 * **contract** change (one that breaks callers — a new param, a changed return
 * type, a visibility drop) from an **internal** change (a body rewrite whose
 * public surface is untouched). The single-shot local LLM came back STRUCTURAL
 * on this same gate, so the directive is: change the LEVER, not the prompt.
 *
 * THE LEVER (deterministic, local, NO LLM)
 * ----------------------------------------
 * A conflict between two concurrent edits on DISTINCT entities exists iff:
 *   (1) one edit changes a CONTRACT (the public signature / exported type of
 *       its target entity), AND
 *   (2) the OTHER entity REALLY DEPENDS on that target via the real reference /
 *       call graph (a cross-file reference edge, or a native `static_call`).
 * An internal edit on a callee you depend on is benign; a contract edit on a
 * callee nobody calls is benign. Only the (contract-change ∧ real-dependency)
 * intersection conflicts. This is the principled AST/type-signature + call-graph
 * signal the token heuristic structurally cannot be.
 *
 * SIGNAL SOURCES (disclosed; none of them read ground truth)
 * ----------------------------------------------------------
 *  A. Contract-change-ness of an edit is derived from BOTH:
 *       - the claim `intent` text (signature-change language vs
 *         internal/refactor language) — parsed deterministically here, NOT
 *         handed to us as the `edit` enum; and
 *       - the target entity's EXTRACTED SIGNATURE from its REAL `body`
 *         (arity / params / return type / visibility), per language — used to
 *         confirm the entity actually exposes a public contract that *could*
 *         break (a body with no callable/exported surface cannot be a contract
 *         dependency, so a "contract" claim on it is downgraded).
 *  B. The dependency edge is the REAL cross-file reference graph:
 *       - `target.imports` (the reconstructed src→dst reference set the bench
 *         carries on each entity), and/or
 *       - the native parser's `static_call` / `import` edges between the two
 *         target symbols (opt-in; see {@link NativeCallGraph}).
 *
 * It NEVER reads `s.conflict`, `s.klass`, or the raw `s.*.edit` enum — those are
 * ground truth / the very thing this lever must derive for itself.
 *
 * The oracle is a pure function of the two {@link ContractTask}s plus an
 * optional dependency oracle. It can shell out to `hayven-native parse` for the
 * call graph, but the default (imports-based) path needs no subprocess at all.
 */

/** Minimal entity shape this oracle needs — a structural subset of the bench's
 * `RealEntity` (so the bench can pass its entities verbatim) and of anything the
 * daemon could synthesize from its index. */
export interface ContractEntity {
  readonly id: string;
  readonly name: string;
  readonly kind: string; // function | method | class | module
  readonly language: string; // typescript | javascript | python | rust | go | ...
  readonly file: string;
  readonly module: string;
  readonly body: string; // REAL source of the entity
  readonly imports: ReadonlySet<string>; // real cross-file reference dst ids
}

/** Minimal task shape — the claimed entity plus the claim's intent/scope text. */
export interface ContractTask {
  readonly target: ContractEntity;
  readonly scope: readonly string[];
  readonly intent: string;
}

export interface ContractVerdict {
  conflict: boolean;
  reason: string;
  confidence: number;
  oracle: string;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. SIGNATURE EXTRACTION — the REAL tree-sitter AST/type signal.
 *
 *    The hardened detector no longer parses the entity's first line with a
 *    regex. It consumes `hayven-native parse --signatures` (see
 *    `native/src/parse/signature.rs`), which emits, per definition, the
 *    contract derived from the actual tree-sitter AST: parameter arity,
 *    per-parameter types, return type, and visibility. A {@link Signature} is
 *    that record in TS form.
 *
 *    Two extractor shapes implement {@link SignatureExtractor}:
 *      - {@link nativeSignatureExtractor} — the production path: shells out via
 *        `daemon/src/conflict/native_signatures.ts` (a repo-wide index and/or a
 *        per-body parse). REQUIRES the native binary.
 *      - a caller-supplied stub, for tests.
 *
 *    When NO extractor is available the entity is treated CONSERVATIVELY as a
 *    possibly-public callable (`visibility:"unknown"`, `hasCallable:true`) so we
 *    never UNDER-detect a contract that could break a caller — but the daemon's
 *    seam keeps the {@link HeuristicOracle} as the real fallback in that case,
 *    rather than running this detector blind.
 * ════════════════════════════════════════════════════════════════════════════ */

export interface Signature {
  /** The declared symbol name. */
  name: string;
  /** Declared formal-parameter count (receiver self/cls excluded). */
  arity: number;
  /** Per-parameter type text (or raw param text when unannotated), in order. */
  params: string[];
  /** Return-type text if the language/decl carries one, else null. */
  returnType: string | null;
  /** Coarse visibility: a symbol with no public/exported surface cannot be a
   * cross-file contract dependency. `unknown` is treated as "could be public". */
  visibility: "public" | "private" | "unknown";
  /** True when a real callable/typed contract was found. */
  hasCallable: boolean;
}

/** What the oracle needs to obtain a real signature for an entity. The native
 * implementation lives in `native_signatures.ts`; tests can supply a stub. */
export interface SignatureExtractor {
  /** Resolve the real signature of an entity, or null when it has no callable
   * contract / can't be parsed. */
  signatureOf(entity: { body: string; language: string; kind: string; name: string; file?: string; qualifiedName?: string }): Signature | null;
}

/** The conservative signature returned when no extractor can resolve an entity:
 * treat it as a possibly-public callable so a "contract" claim is not silently
 * downgraded (we'd rather over- than under-detect a breakable contract). */
function conservativeSignature(name: string): Signature {
  return { name, arity: 0, params: [], returnType: null, visibility: "unknown", hasCallable: true };
}

/**
 * TRUE before/after signature diff: given two extracted signatures of the SAME
 * entity (before an edit and after), decide whether the edit changed the public
 * CONTRACT. This is the genuine "contract diff" — used by the ceiling bench
 * where a real before/after body exists. Arity, parameter shape, return type, or
 * a visibility *drop* (public→private) all break callers.
 */
export function signatureChangedContract(before: Signature, after: Signature): boolean {
  if (before.arity !== after.arity) return true;
  if ((before.returnType ?? "") !== (after.returnType ?? "")) return true;
  // Parameter token shape (names/types) changed at a fixed arity (e.g. a type
  // narrowed, a param renamed in a positional+typed language). Compare joined.
  if (before.params.join("|") !== after.params.join("|")) return true;
  // Visibility drop: a public symbol becoming private breaks external callers.
  if (before.visibility === "public" && after.visibility === "private") return true;
  return false;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2. CONTRACT-CHANGE DETECTION from the claim INTENT (deterministic NLP).
 *    We DERIVE whether an edit touches the public contract — we are NOT handed
 *    the `edit` enum. Signature-change language ⇒ contract; explicit
 *    internal/refactor language ⇒ internal; ambiguous ⇒ fall to the signature
 *    surface (no public callable ⇒ internal).
 * ════════════════════════════════════════════════════════════════════════════ */

const CONTRACT_PHRASES = [
  "signature",
  "return type",
  "return value",
  "parameter",
  "param ",
  "argument",
  "arity",
  "exported type",
  "public api",
  "public interface",
  "rename",
  "remove the",
  "add a field",
  "change the type",
  "callers must adapt",
  "breaking change",
  "interface",
];

const INTERNAL_PHRASES = [
  "internal implementation",
  "internal logic",
  "public signature is unchanged",
  "signature is unchanged",
  "signature unchanged",
  "without changing",
  "local variable",
  "rename a local",
  "refactor the internal",
  "no api change",
  "behavior-preserving",
  "behaviour-preserving",
];

/** Tri-state: does this claim's INTENT indicate a contract-affecting edit? */
export function intentIndicatesContractChange(intent: string): "contract" | "internal" | "ambiguous" {
  const t = intent.toLowerCase();
  const internal = INTERNAL_PHRASES.some((p) => t.includes(p));
  const contract = CONTRACT_PHRASES.some((p) => t.includes(p));
  // An explicit "signature unchanged" overrides incidental contract words.
  if (internal && !contract) return "internal";
  if (internal && contract) {
    // "change the public signature ... unchanged" can't both hold; prefer the
    // most specific assertion. "signature is unchanged" is the strongest signal.
    if (/\bsignature (is )?unchanged\b/.test(t) || t.includes("internal implementation")) return "internal";
    return "contract";
  }
  if (contract) return "contract";
  return "ambiguous";
}

/** Resolve an entity's real signature via the extractor, or the conservative
 * possibly-public callable when no extractor is supplied or it can't parse the
 * entity. Centralized so every caller treats "no extractor" identically. */
function signatureFor(
  target: ContractEntity,
  extractor: SignatureExtractor | undefined,
): Signature {
  if (extractor) {
    const sig = extractor.signatureOf({
      body: target.body,
      language: target.language,
      kind: target.kind,
      name: target.name,
      file: target.file,
    });
    if (sig) return sig;
  }
  return conservativeSignature(target.name);
}

/** Combine intent + REAL extracted signature into a final contract-change
 * decision for ONE edit. A "contract" intent on an entity with NO public
 * callable surface is downgraded to internal (it can't break a cross-file
 * caller). When no extractor is available the signature is the conservative
 * possibly-public callable, so the intent signal dominates. */
export function isContractEdit(task: ContractTask, extractor?: SignatureExtractor): boolean {
  const fromIntent = intentIndicatesContractChange(task.intent);
  const sig = signatureFor(task.target, extractor);
  const couldBePublic = sig.visibility !== "private";

  if (fromIntent === "internal") return false;
  if (fromIntent === "contract") return couldBePublic; // gate on real surface
  // Ambiguous: call it a contract change when the entity exposes a callable
  // contract that COULD be public. We gate on `couldBePublic` (visibility !==
  // "private") rather than `visibility === "public"`: `"unknown"` is the SAFE
  // extraction-failure default (a sig we couldn't pin down), and treating it as
  // internal here would UNDER-block a real contract break when extraction is
  // imperfect (the weak-signature languages: JS, Go-multireturn, Rust
  // `pub(crate)`, arrow-fns). Only a CONFIRMED-private surface downgrades to
  // internal. This keeps us conservative against the benign case (no callable ⇒
  // internal) while staying default-SAFE (don't silently miss a breakable
  // contract just because the extractor returned `unknown`).
  return sig.hasCallable && couldBePublic;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3. REAL DEPENDENCY EDGE between the two targets (the call graph).
 *    A dependency is confirmed by the UNION of three real sources (any one is
 *    sufficient — union ⇒ strictly more recall, never fewer escapes):
 *      - the reconstructed `imports` set the entity carries (cross-file refs),
 *      - the daemon's REAL static edge index (`Db.outgoing`/`incoming`, the
 *        `static_call`/`import` edges the native parser already populates) —
 *        supplied as an {@link EdgeIndex}, and
 *      - an optional native call-graph corroboration ({@link NativeCallGraph}).
 * ════════════════════════════════════════════════════════════════════════════ */

/** Directional dependency check over the reconstructed reference graph: does
 * `from` really reference `to`? */
function importsDepend(from: ContractEntity, to: ContractEntity): boolean {
  return from.imports.has(to.id);
}

/**
 * The daemon's REAL static edge index (the `outgoing`/`incoming` edges materialized
 * from the native parser's `static_call`/`import` records, exposed by `Db` and
 * `GET /api/neighbors`). The contract-diff oracle unions this with the
 * reconstructed `imports` set so a dependency the token reconstruction missed
 * (but the parser recorded) still fires. Pure w.r.t. the oracle — injected.
 */
export interface EdgeIndex {
  /** True iff a real static edge exists from entity id `fromId` to `toId`
   * (either direction of the daemon's outgoing ∪ incoming union, matching the
   * adjacency neighbor lookup). */
  dependsOn(fromId: string, toId: string): boolean;
}

/**
 * Optional native call-graph dependency oracle. When supplied, a dependency is
 * confirmed if the native parser recorded a real `static_call` or `import` edge
 * from `from`'s file/definition to `to`'s declared `name`. Used to corroborate
 * (and, in the ceiling bench, to demonstrate) the AST-level edge rather than the
 * token-reconstructed one.
 */
export interface NativeCallGraph {
  /** True iff a real call/import edge exists from `from` to `to`. */
  dependsOn(from: ContractEntity, to: ContractEntity): boolean;
}

/* ════════════════════════════════════════════════════════════════════════════
 * 4. THE ORACLE.
 * ════════════════════════════════════════════════════════════════════════════ */

export interface ContractDiffOptions {
  /** The REAL signature extractor (native tree-sitter parse). When omitted, the
   * detector falls back to the conservative possibly-public signature so it
   * never under-detects; the daemon seam keeps the heuristic as the real
   * fallback when the native binary is unavailable. */
  signatureExtractor?: SignatureExtractor | undefined;
  /** The daemon's REAL static edge index (`Db.outgoing`/`incoming`). Unioned
   * with the reconstructed imports set for the dependency check. */
  edgeIndex?: EdgeIndex | undefined;
  /** Optional native call-graph corroboration. When set, a dependency counts if
   * ANY of the imports set / edge index / native graph confirms it (union —
   * strictly more recall, never fewer escapes). */
  callGraph?: NativeCallGraph | undefined;
  id?: string;
}

export class ContractDiffOracle {
  readonly id: string;
  private readonly callGraph: NativeCallGraph | undefined;
  private readonly edgeIndex: EdgeIndex | undefined;
  private readonly signatureExtractor: SignatureExtractor | undefined;

  constructor(opts: ContractDiffOptions = {}) {
    this.id = opts.id ?? "contract-diff-v1";
    this.callGraph = opts.callGraph;
    this.edgeIndex = opts.edgeIndex;
    this.signatureExtractor = opts.signatureExtractor;
  }

  /** Does `from` really depend on `to` (imports set ∪ real Db edge index ∪
   * optional native graph)? */
  private depends(from: ContractEntity, to: ContractEntity): boolean {
    if (importsDepend(from, to)) return true;
    if (this.edgeIndex && this.edgeIndex.dependsOn(from.id, to.id)) return true;
    if (this.callGraph && this.callGraph.dependsOn(from, to)) return true;
    return false;
  }

  /**
   * Assess two concurrent claims. Conflict iff one edit changes a contract AND
   * the OTHER entity really depends on that target. Same-entity edits (overlap)
   * always conflict — that's a hard collision, not a contract question.
   */
  assess(incoming: ContractTask, adjacent: ContractTask): ContractVerdict {
    // Hard overlap: editing the same entity concurrently always conflicts.
    if (incoming.target.id === adjacent.target.id) {
      return {
        conflict: true,
        reason: "Both claims edit the same entity (scope overlap).",
        confidence: 1,
        oracle: this.id,
      };
    }

    const incContract = isContractEdit(incoming, this.signatureExtractor);
    const adjContract = isContractEdit(adjacent, this.signatureExtractor);

    // (incoming changes a contract) AND (adjacent depends on incoming.target)
    const incBreaksAdj = incContract && this.depends(adjacent.target, incoming.target);
    // (adjacent changes a contract) AND (incoming depends on adjacent.target)
    const adjBreaksInc = adjContract && this.depends(incoming.target, adjacent.target);

    if (incBreaksAdj || adjBreaksInc) {
      const dir = incBreaksAdj ? `${incoming.target.name} → ${adjacent.target.name}` : `${adjacent.target.name} → ${incoming.target.name}`;
      return {
        conflict: true,
        reason:
          `A contract change on ${incBreaksAdj ? incoming.target.name : adjacent.target.name} ` +
          `breaks a real dependent (${dir}).`,
        confidence: 0.85,
        oracle: this.id,
      };
    }

    // Same-module double-contract collision: two CONTRACT edits to distinct
    // symbols in the SAME source file have no caller/callee edge, but they edit
    // the same file's public surface concurrently — a likely textual/merge
    // collision on the module's exported shape. This is still a CONTRACT-gated
    // rule (both sides must be contract edits), so purely-internal concurrent
    // edits to the same file stay benign — preserving the adjacent-benign win.
    if (incContract && adjContract && incoming.target.module === adjacent.target.module) {
      return {
        conflict: true,
        reason:
          "Two concurrent public-contract changes to distinct symbols in the same " +
          `module (${incoming.target.module}) — likely collision on the module surface.`,
        confidence: 0.6,
        oracle: this.id,
      };
    }

    // No contract-on-a-real-dependency intersection ⇒ benign concurrent work.
    return {
      conflict: false,
      reason:
        "Neither edit changes a public contract that the other entity actually " +
        "depends on (internal edits and/or no real reference edge).",
      confidence: 0.7,
      oracle: this.id,
    };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. ClaimConflictOracle ADAPTER — the production seam.
 *    `selectOracle` (oracle.ts) hands the claim route a {@link ClaimContext}
 *    pair (scope = entity ids, intent, neighbors). This adapter resolves each
 *    scoped entity id to a {@link ContractEntity} via an injected resolver (the
 *    daemon's `Db`), then runs {@link ContractDiffOracle.assess} over the
 *    entity pairs and returns the strongest verdict. It implements the same
 *    async {@link ClaimConflictOracle} contract the heuristic does.
 * ════════════════════════════════════════════════════════════════════════════ */

/** What the adapter needs from the daemon to turn a claim scope into entities. */
export interface EntityResolver {
  /** Resolve an entity id to the fields the contract-diff oracle needs, or null
   * when the id is unknown (the adapter then skips it). `imports` is optional —
   * the {@link EdgeIndex} is the real cross-file dependency source in production. */
  resolve(id: string): {
    id: string;
    name: string;
    kind: string;
    language: string;
    file: string;
    module: string;
    body: string;
    imports?: ReadonlySet<string>;
  } | null;
}

/** Minimal shapes mirrored from oracle.ts so this module stays import-light
 * (oracle.ts imports the implementations from here, not vice-versa). */
interface ClaimCtx {
  readonly scope: readonly string[];
  readonly intent: string;
  readonly neighbors: readonly string[];
}
interface Verdict {
  conflict: boolean;
  reason: string;
  confidence: number;
  oracle: string;
}

export interface ContractDiffClaimOptions extends ContractDiffOptions {
  resolver: EntityResolver;
}

/**
 * The opt-in production oracle. Resolves both claims' scopes to real entities
 * and runs the deterministic contract-diff over each cross pair, returning the
 * highest-confidence conflicting verdict (or the benign verdict when none
 * conflict). When an entity id cannot be resolved (e.g. a synthetic claim over a
 * not-yet-indexed symbol) it is skipped — if NEITHER side resolves to any real
 * entity the adapter abstains with a benign verdict (the caller's seam keeps the
 * heuristic as the real fallback for the no-binary case).
 */
export class ContractDiffClaimOracle {
  readonly id: string;
  private readonly inner: ContractDiffOracle;
  private readonly resolver: EntityResolver;

  constructor(opts: ContractDiffClaimOptions) {
    this.id = opts.id ?? "contract-diff";
    this.inner = new ContractDiffOracle({ ...opts, id: this.id });
    this.resolver = opts.resolver;
  }

  private entitiesFor(ctx: ClaimCtx): ContractEntity[] {
    const out: ContractEntity[] = [];
    for (const id of ctx.scope) {
      const r = this.resolver.resolve(id);
      if (!r) continue;
      out.push({
        id: r.id,
        name: r.name,
        kind: r.kind,
        language: r.language,
        file: r.file,
        module: r.module,
        body: r.body,
        imports: r.imports ?? new Set<string>(),
      });
    }
    return out;
  }

  // `async` only to satisfy the Promise-returning interface; the body is pure
  // beyond the (cached) signature/edge lookups injected at construction.
  async assess(incoming: ClaimCtx, adjacent: ClaimCtx): Promise<Verdict> {
    const incEnts = this.entitiesFor(incoming);
    const adjEnts = this.entitiesFor(adjacent);

    if (incEnts.length === 0 || adjEnts.length === 0) {
      return {
        conflict: false,
        reason:
          "Contract-diff abstained: a claim scope did not resolve to any indexed " +
          "entity (no real signature/edge to diff).",
        confidence: 0,
        oracle: this.id,
      };
    }

    let best: ContractVerdict | null = null;
    for (const ie of incEnts) {
      for (const ae of adjEnts) {
        const v = this.inner.assess(
          { target: ie, scope: incoming.scope as string[], intent: incoming.intent },
          { target: ae, scope: adjacent.scope as string[], intent: adjacent.intent },
        );
        if (v.conflict && (best === null || v.confidence > best.confidence)) best = v;
      }
    }

    if (best) return best;
    return {
      conflict: false,
      reason:
        "Neither edit changes a public contract that the other entity actually " +
        "depends on (contract-diff).",
      confidence: 0.7,
      oracle: this.id,
    };
  }
}
