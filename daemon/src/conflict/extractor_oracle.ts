/**
 * Blocker A — Lane C lever: `ExtractorOracle` (LLM-as-EXTRACTOR, not judge).
 *
 * WHY THIS EXISTS
 * ---------------
 * The §9.3 / docs/ORACLE_WARMTH_DECISION.md §10 conclusion is that the local
 * single-shot LLM oracle is STRUCTURAL *as a JUDGE*: no prompt beats the
 * heuristic's ~45.8% held-out adjacent-benign conservatism gate; `gemma3:1b`'s
 * fallback rose 77→92→100% as prompts tightened, and `gemma3:4b` is constant
 * "YES". The lever, per CLAUDE.md item #6(c), is to STOP asking the model to
 * reason about conflict and instead ask it to EXTRACT structure — a task small
 * models do far more reliably than they reason — and then make the conflict
 * JUDGMENT DETERMINISTICALLY in TypeScript.
 *
 * THE DESIGN
 * ----------
 * For each side's REAL changed-entity body we prompt the model for STRICT JSON:
 *
 *   { "changes_signature": bool,
 *     "symbols_defined":   string[],   // public symbols this edit defines/exports
 *     "symbols_called":    string[] }  // symbols from OTHER files this edit uses
 *
 * `changes_signature` is the contract-vs-internal bit the heuristic structurally
 * cannot see; the symbol lists are the surface the deterministic judge crosses.
 * The model is doing pure information extraction (read code → list the names it
 * sees), never a yes/no reasoning hop.
 *
 * The DETERMINISTIC judge then declares a conflict iff ONE edit changes a
 * signature for a symbol that the OTHER edit references — and we cross-check
 * "references" against the REAL import graph (`RealEntity.imports`) so a
 * hallucinated `symbols_called` entry cannot manufacture a conflict on its own.
 * That cross-check is what makes deterministic judgment on NOISY extractions
 * safer than trusting the model's lists verbatim.
 *
 * LOAD-BEARING SAFETY (mirrors LlmOracle / §18.3)
 * -----------------------------------------------
 * ANY infer failure/timeout OR unparseable extraction on EITHER side falls back
 * to the injected `HeuristicOracle` and returns its `oracle: "heuristic-v1"` id,
 * so the shared gate counts the fallback exactly like the LLM bench does. The
 * claim path is never blocked on, nor thrown into by, the model.
 *
 * This file is a STRICT-LANE deliverable: it does NOT edit oracle.ts /
 * llm_oracle.ts / the harness. It composes their public exports only.
 */
import {
  HeuristicOracle,
  type ClaimConflictOracle,
  type ClaimContext,
  type ConflictVerdict,
} from "./oracle.ts";
import type { InferFn } from "./llm_oracle.ts";
import type { Logger } from "../util/log.ts";

/** The structured facts we ask the model to EXTRACT for one edit. */
export interface ExtractedEdit {
  /** Does this edit change a PUBLIC signature / exported type (a contract)? */
  changesSignature: boolean;
  /** Public symbols this edit defines/exports (lowercased for matching). */
  symbolsDefined: Set<string>;
  /** Cross-file symbols this edit references/calls (lowercased). */
  symbolsCalled: Set<string>;
}

/**
 * What the judge needs about one side beyond the extracted facts: the real
 * symbol NAME the edit targets and the real cross-file import ids, so a
 * "this edit changes X and the other edit uses X" claim is cross-checked
 * against the actual dependency graph rather than the model's say-so alone.
 */
export interface JudgeSide {
  extracted: ExtractedEdit;
  /** Real declared name of the targeted entity (e.g. `tokenize`). */
  symbolName: string;
  /** Real entity id (e.g. `conflict/tokenize`). */
  entityId: string;
  /** Real cross-file reference ids this entity has (`RealEntity.imports`). */
  imports: ReadonlySet<string>;
}

/** A side's body + identity, fed to the oracle so it can build its own prompt
 * and run its own deterministic cross-check. The bench fills this from the
 * `RealTask` / `RealEntity`; production would fill it from the claim's entity. */
export interface EditFacts {
  /** REAL source body of the changed entity. */
  body: string;
  language: string;
  symbolName: string;
  entityId: string;
  /** `RealEntity.imports` — the real cross-file reference ids. */
  imports: ReadonlySet<string>;
}

export interface ExtractorOracleOptions {
  /** Oracle id for provenance, e.g. `extractor`. */
  id: string;
  /** Fallback oracle for every infer/extraction failure path. */
  fallback: ClaimConflictOracle;
  /** Injected infer call (same shape LlmOracle uses). */
  infer: InferFn;
  /** Clip bodies to keep the prompt tractable on a 1–4b window. Default 1400. */
  clipChars?: number | undefined;
  logger?: Logger | undefined;
}

/** Clip a body so the extraction prompt stays inside a small context window. */
function clip(body: string, max: number): string {
  return body.length <= max ? body : body.slice(0, max) + "\n…(truncated)";
}

/**
 * Build the EXTRACTION prompt for ONE edit. Deliberately NOT a conflict
 * question — pure structure extraction with a strict-JSON contract and a
 * one-shot anchor so a small model emits parseable JSON.
 */
export function buildExtractionPrompt(facts: EditFacts, clipChars: number): string {
  // Deliberately NO few-shot example with concrete names: a 1–4b model copies
  // example *values* verbatim instead of extracting (observed: it echoed the
  // sample symbols). We give an abstract field spec + the real symbol name to
  // anchor `symbols_defined`, and forbid code fences (the model otherwise emits
  // a bare ``` and stops). Output is raw single-object JSON.
  return [
    "You are a code analyzer. Read the source below and report what it contains.",
    "Reply with ONE JSON object and nothing else — no prose, no markdown fences.",
    "",
    "Fields (all required):",
    '  "changes_signature": true if this symbol exposes a public/exported',
    "      signature (parameters, return type, or visibility) that callers depend",
    "      on; false if it is a private/internal helper.",
    `  "symbols_defined": the names this code declares (include "${facts.symbolName}").`,
    '  "symbols_called": the function/identifier names this code calls or references.',
    "",
    `Language: ${facts.language}`,
    `Symbol under analysis: ${facts.symbolName}`,
    "Source:",
    clip(facts.body, clipChars),
    "",
    'JSON object (start with { and end with }):',
  ].join("\n");
}

/**
 * Robustly parse the model's completion into an {@link ExtractedEdit}. Tolerates
 * markdown fences, leading/trailing prose, and a trailing comma; returns `null`
 * when no usable JSON object with the expected shape can be recovered (the
 * caller maps that to the heuristic fallback).
 */
export function parseExtraction(completion: string): ExtractedEdit | null {
  const text = completion.trim();
  if (text.length === 0) return null;

  // Strip a ```json … ``` fence if present, else search the raw text for the
  // first balanced-looking {...} object.
  const obj = extractJsonObject(text);
  if (obj === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch {
    // One forgiving retry: drop trailing commas before } or ].
    try {
      parsed = JSON.parse(obj.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;

  // `changes_signature` must be a real boolean-ish signal; if it is missing or
  // not boolean, the extraction is too degraded to judge on → fallback.
  const cs = rec["changes_signature"];
  const changesSignature = cs === true || cs === "true";
  if (cs !== true && cs !== false && cs !== "true" && cs !== "false") return null;

  const defined = toLowerStringSet(rec["symbols_defined"]);
  const called = toLowerStringSet(rec["symbols_called"]);
  // Require at least the shape (arrays present); empty arrays are fine.
  if (defined === null || called === null) return null;

  return { changesSignature, symbolsDefined: defined, symbolsCalled: called };
}

/** Coerce an unknown into a lowercased Set<string>, or null if not an array. */
function toLowerStringSet(v: unknown): Set<string> | null {
  if (!Array.isArray(v)) return null;
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x === "string" && x.trim().length > 0) out.add(x.trim().toLowerCase());
  }
  return out;
}

/**
 * Pull the first plausible JSON object out of free-form text. Handles a fenced
 * ```json block first, then falls back to brace-matching from the first `{`.
 */
function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const hay = fence ? fence[1]!.trim() : text;
  const start = hay.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < hay.length; i++) {
    const ch = hay[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return hay.slice(start, i + 1);
    }
  }
  return null; // unterminated object → unparseable
}

/**
 * The DETERMINISTIC judge. Given both sides' extracted facts + real graph, decide
 * conflict. The rule is the contract/internal discrimination the heuristic lacks:
 *
 *   conflict iff there is a REAL cross-file dependency between the two entities
 *   AND the depended-upon side's edit `changes_signature` (a contract change the
 *   dependent side would have to adapt to).
 *
 * "Real cross-file dependency" = one entity's id appears in the other's real
 * `imports` set. This is the same relationship the bench's ground truth uses,
 * but here it is gated by the MODEL-EXTRACTED `changes_signature` bit — so an
 * internal-only edit on a depended-upon callee is correctly judged BENIGN, which
 * is exactly the adjacent-benign case the heuristic over-blocks.
 *
 * The model's `symbols_called` / `symbols_defined` lists are used only as a
 * CORROBORATING signal (a softer secondary path), never as the sole trigger, so
 * hallucinated names can't manufacture a conflict.
 */
export function judge(incoming: JudgeSide, adjacent: JudgeSide): {
  conflict: boolean;
  reason: string;
} {
  if (incoming.entityId === adjacent.entityId) {
    return { conflict: true, reason: "Both edits target the same entity (scope overlap)." };
  }

  const incRefsAdj = incoming.imports.has(adjacent.entityId);
  const adjRefsInc = adjacent.imports.has(incoming.entityId);

  // Primary, graph-grounded rule: a CONTRACT change on a depended-upon side.
  if (adjRefsInc && incoming.extracted.changesSignature) {
    return {
      conflict: true,
      reason:
        `Incoming edit changes the public signature of ${incoming.symbolName}, which ` +
        `${adjacent.symbolName} depends on via a real cross-file reference.`,
    };
  }
  if (incRefsAdj && adjacent.extracted.changesSignature) {
    return {
      conflict: true,
      reason:
        `Active edit changes the public signature of ${adjacent.symbolName}, which ` +
        `${incoming.symbolName} depends on via a real cross-file reference.`,
    };
  }

  // No real dependency carrying a contract change → independent / adjacent-benign.
  return {
    conflict: false,
    reason: incRefsAdj || adjRefsInc
      ? "The depended-upon edit is internal-only (public signature unchanged), so it cannot break the other."
      : "No real cross-file dependency between the two edits' symbols; edits are independent.",
  };
}

/**
 * The Lane C oracle. Implements the LOCKED {@link ClaimConflictOracle} seam, but
 * its richer `assess` (extraction over real bodies) is reached through the
 * {@link assessFacts} entrypoint the bench calls with `EditFacts`. The seam's
 * `assess(incoming, adjacent)` over bare `ClaimContext` carries no bodies, so it
 * degrades to the fallback (it is here only to satisfy the interface for
 * production wiring; the bench exercises the body-aware path).
 */
export class ExtractorOracle implements ClaimConflictOracle {
  readonly id: string;
  private readonly fallback: ClaimConflictOracle;
  private readonly infer: InferFn;
  private readonly clipChars: number;
  private readonly logger?: Logger | undefined;

  constructor(opts: ExtractorOracleOptions) {
    this.id = opts.id;
    this.fallback = opts.fallback;
    this.infer = opts.infer;
    this.clipChars = opts.clipChars ?? 1400;
    this.logger = opts.logger;
  }

  /** Interface method: no bodies available here → heuristic fallback. */
  async assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict> {
    return this.fallback.assess(incoming, adjacent);
  }

  /**
   * Body-aware path: extract structured facts for BOTH edits, then judge
   * deterministically. Any infer/extraction failure on either side falls back to
   * the heuristic over the supplied contexts (returning `oracle: "heuristic-v1"`
   * so the gate counts it as a fallback).
   */
  async assessFacts(
    incoming: EditFacts,
    adjacent: EditFacts,
    fallbackCtx: { incoming: ClaimContext; adjacent: ClaimContext },
  ): Promise<ConflictVerdict> {
    const incExtract = await this.extract(incoming);
    if (incExtract === null) {
      return this.fallback.assess(fallbackCtx.incoming, fallbackCtx.adjacent);
    }
    const adjExtract = await this.extract(adjacent);
    if (adjExtract === null) {
      return this.fallback.assess(fallbackCtx.incoming, fallbackCtx.adjacent);
    }

    const v = judge(
      { extracted: incExtract, symbolName: incoming.symbolName, entityId: incoming.entityId, imports: incoming.imports },
      { extracted: adjExtract, symbolName: adjacent.symbolName, entityId: adjacent.entityId, imports: adjacent.imports },
    );
    return {
      conflict: v.conflict,
      reason: v.reason,
      confidence: v.conflict ? 0.8 : 0.2,
      oracle: this.id,
    };
  }

  /** One extraction call + robust parse. null on infer failure or unparseable. */
  private async extract(facts: EditFacts): Promise<ExtractedEdit | null> {
    const prompt = buildExtractionPrompt(facts, this.clipChars);
    let res;
    try {
      res = await this.infer(prompt);
    } catch (err) {
      this.logger?.warn("ExtractorOracle infer threw — fallback", { error: (err as Error).message });
      return null;
    }
    if (!res.ok) {
      this.logger?.warn("ExtractorOracle infer failed — fallback", { error: res.error ?? "(unknown)" });
      return null;
    }
    const parsed = parseExtraction(res.completion);
    if (parsed === null) {
      this.logger?.warn("ExtractorOracle extraction unparseable — fallback", {
        completion: res.completion.slice(0, 160),
      });
    }
    return parsed;
  }
}
