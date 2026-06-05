/**
 * Layer C upgrade — `LlmOracle` (ARCHITECTURE.md §18.4, PRD §7.3).
 *
 * Implements the LOCKED `ClaimConflictOracle` seam (§17.3) by reading *intent*
 * through a local Tier-3 model: it builds the PRD §7.3 prompt, spawns
 * `hayven-native infer` (§18.1), and parses a YES/NO + one-sentence reason into
 * a calibrated {@link ConflictVerdict}. Because it reads intent, it
 * distinguishes contract-changing edits from internal ones — the discrimination
 * the deterministic `HeuristicOracle` structurally cannot make (retires BL-13).
 *
 * LOAD-BEARING SAFETY (§18.3 / §18.4): a hard timeout bounds the call, and ANY
 * error / timeout / unparseable output falls back to the injected
 * `HeuristicOracle`'s verdict. The claim path is NEVER blocked on, nor thrown
 * into by, the model. `verdict.oracle` records which oracle actually answered.
 *
 * The infer spawn is INJECTABLE (mirrors `verify.ts`) so this unit-tests with a
 * mocked infer fn — no native binary, no model weights.
 */
import {
  HeuristicOracle,
  type ClaimConflictOracle,
  type ClaimContext,
  type ConflictVerdict,
} from "./oracle.ts";
import { runInfer, type InferOptions, type InferResult } from "../native/infer.ts";
import type { Logger } from "../util/log.ts";

/**
 * The infer call, narrowed to what the oracle needs. Injected so tests pass a
 * mock (a plain async fn returning {@link InferResult}); production binds
 * {@link runInfer} with the resolved binary + model path.
 */
export type InferFn = (prompt: string) => Promise<InferResult>;

export interface LlmOracleOptions {
  /** Oracle id (the configured model id), e.g. `gemma4:e2b`. Provenance. */
  id: string;
  /** Fallback oracle for every error/timeout/unparseable path. */
  fallback: ClaimConflictOracle;
  /** The (injected) infer call. */
  infer: InferFn;
  logger?: Logger | undefined;
}

/**
 * Build a production infer fn binding {@link runInfer} to a binary + model path.
 * temp 0.0 = deterministic; a small max-tokens cap keeps the YES/NO + sentence
 * fast (PRD §7.3 targets ~200 ms).
 */
export function makeInferFn(
  opts: Pick<InferOptions, "binary" | "modelDir"> & {
    maxTokens?: number | undefined;
    timeoutMs?: number | undefined;
    logger?: Logger | undefined;
  },
): InferFn {
  return (prompt: string) =>
    runInfer(prompt, {
      binary: opts.binary,
      modelDir: opts.modelDir,
      temp: 0.0,
      maxTokens: opts.maxTokens ?? 64,
      timeoutMs: opts.timeoutMs ?? 2000,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
}

/**
 * The PRD §7.3 adversarial preview prompt. Renders both claim contexts as
 * plain text so the model reads intent + scope + graph neighbors, then asks the
 * locked YES/NO question.
 */
export function buildPrompt(incoming: ClaimContext, adjacent: ClaimContext): string {
  const fmt = (c: ClaimContext): string =>
    [
      `  intent: ${c.intent}`,
      `  scope: ${c.scope.join(", ") || "(none)"}`,
      `  graph neighbors: ${c.neighbors.join(", ") || "(none)"}`,
    ].join("\n");

  return [
    "You are reviewing two concurrent code-change claims on one codebase.",
    "",
    "Claim A (already active):",
    fmt(adjacent),
    "",
    "My intended work:",
    fmt(incoming),
    "",
    "Read claim A and my intended work — is there a plausible way our edits " +
      "break each other's assumptions or produce inconsistent state? " +
      "Begin your reply with the single word YES or NO, then give one " +
      "sentence of justification.",
  ].join("\n");
}

/**
 * Parse a model completion into a verdict. Returns `null` when the output has
 * no recognizable YES/NO — the caller maps that to the heuristic fallback.
 *
 * Confidence calibration (coarse, deterministic from the parsed shape):
 *   - 0.9  a clear YES/NO with a non-trivial one-sentence reason
 *   - 0.6  a YES/NO with no usable reason (weaker signal)
 * (The heuristic's own bands apply on fallback.)
 */
export function parseVerdict(
  completion: string,
  oracleId: string,
): { conflict: boolean; reason: string; confidence: number; oracle: string } | null {
  const text = completion.trim();
  if (text.length === 0) return null;

  // First explicit YES/NO token wins (word-boundary, case-insensitive) so a
  // leading verdict isn't shadowed by the word appearing later in the reason.
  const m = text.match(/\b(yes|no)\b/i);
  if (!m) return null;
  const conflict = m[1]!.toLowerCase() === "yes";

  // Reason = the remainder after the verdict token, cleaned to one sentence.
  const after = text.slice((m.index ?? 0) + m[1]!.length).replace(/^[\s,.:;-]+/, "");
  const firstSentence = after.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  const hasReason = firstSentence.length >= 3;
  const reason = hasReason
    ? firstSentence
    : conflict
      ? "The model judged the two work-scopes likely to break each other's assumptions."
      : "The model judged the two work-scopes independent.";

  const confidence = hasReason ? 0.9 : 0.6;
  return { conflict, reason, confidence, oracle: oracleId };
}

export class LlmOracle implements ClaimConflictOracle {
  readonly id: string;
  private readonly fallback: ClaimConflictOracle;
  private readonly infer: InferFn;
  private readonly logger?: Logger | undefined;

  constructor(opts: LlmOracleOptions) {
    this.id = opts.id;
    this.fallback = opts.fallback;
    this.infer = opts.infer;
    this.logger = opts.logger;
  }

  async assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict> {
    const prompt = buildPrompt(incoming, adjacent);

    let result: InferResult;
    try {
      result = await this.infer(prompt);
    } catch (err) {
      // The infer fn itself should never throw (runInfer resolves a result),
      // but a mocked/alternate fn might — treat as a fallback path regardless.
      this.logger?.warn("LlmOracle infer threw — falling back to heuristic", {
        error: (err as Error).message,
      });
      return this.fallbackVerdict(incoming, adjacent);
    }

    if (!result.ok) {
      this.logger?.warn("LlmOracle infer failed — falling back to heuristic", {
        error: result.error ?? "(unknown)",
      });
      return this.fallbackVerdict(incoming, adjacent);
    }

    const parsed = parseVerdict(result.completion, this.id);
    if (parsed === null) {
      this.logger?.warn("LlmOracle output unparseable — falling back to heuristic", {
        completion: result.completion.slice(0, 120),
      });
      return this.fallbackVerdict(incoming, adjacent);
    }

    return parsed;
  }

  /** The heuristic's verdict, with `oracle` already naming the heuristic. */
  private async fallbackVerdict(
    incoming: ClaimContext,
    adjacent: ClaimContext,
  ): Promise<ConflictVerdict> {
    return this.fallback.assess(incoming, adjacent);
  }
}
