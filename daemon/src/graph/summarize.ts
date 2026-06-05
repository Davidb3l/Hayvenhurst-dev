/**
 * Node summarizer — heuristic default + LLM upgrade (mirrors `selectOracle`).
 *
 * `hayven summarize` replaces the `SUMMARY_PLACEHOLDER` in a node's markdown
 * body with a concise one-line summary. This module owns HOW that summary is
 * produced; it deliberately does NOT own the WRITE (the CLI routes the result
 * through the BL-12 LWW node-body path — `recordLww` / `PUT /api/nodes/:id/body`
 * — so summaries participate in Merkle sync like any other body edit).
 *
 * Two implementations behind one {@link NodeSummarizer} seam:
 *
 *   - {@link HeuristicSummarizer} (`heuristic-v1`) — the zero-config default,
 *     ALWAYS available. Deterministic, pure: derives a one-liner from the node's
 *     own metadata (kind + name + qualified name + signature/first source line).
 *     No model, no I/O beyond the optional source line the caller hands it.
 *
 *   - {@link LlmSummarizer} — the upgrade, selected ONLY when a tier-3 model is
 *     present (same gating as the conflict oracle). It prompts `hayven-native
 *     infer` (via the existing {@link runInfer}, injected as an {@link InferFn})
 *     for a one-sentence summary; a hard timeout / any infer error / unparseable
 *     output falls back to the heuristic. It NEVER blocks or throws into the
 *     caller — exactly the load-bearing safety contract of `LlmOracle`.
 *
 * Selection is via {@link selectSummarizer}, which mirrors `selectOracle` in
 * `conflict/oracle.ts`: heuristic for the zero-config / unknown-key / no-env
 * cases, LlmSummarizer only when (a) the configured model id is present on disk
 * and (b) a native binary is locatable. Selection itself spawns nothing.
 */
import { isModelPresent, modelDir } from "../models/registry.ts";
import { runInfer, type InferOptions, type InferResult } from "../native/infer.ts";
import type { Logger } from "../util/log.ts";
import type { GraphNode } from "./types.ts";

/** The input a summarizer reasons over: the node plus an optional source hint. */
export interface SummaryInput {
  node: GraphNode;
  /**
   * The first meaningful line of the node's source span / docstring, if the
   * caller could cheaply read it (signature line, docstring, etc.). Optional —
   * summarization must work from metadata alone when source is unavailable.
   */
  firstSourceLine?: string | undefined;
}

/** Produces a one-line markdown summary for a node. */
export interface NodeSummarizer {
  summarize(input: SummaryInput): Promise<SummaryResult>;
  readonly id: string; // provenance, e.g. "heuristic-v1" or "gemma4:e2b"
}

export interface SummaryResult {
  /** The one-line summary text (already trimmed, single line). */
  summary: string;
  /** Which summarizer actually produced it (heuristic on any LLM fallback). */
  summarizer: string;
}

/** Collapse to a single trimmed line; the body is a one-liner by contract. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The article a kind reads best with ("a function", "an interface").
 */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * Build the deterministic heuristic summary from node metadata + optional
 * source line. Exported for direct unit testing and reuse by the LLM fallback.
 *
 * Shape: "`<kind>` `<name>` — <qualified/signature context>[: <first line>]".
 * Pure: no I/O, no randomness, no time. Identical input → identical output.
 */
export function heuristicSummary(input: SummaryInput): string {
  const { node } = input;
  const kind = node.kind ?? "other";
  const name = node.name || node.id;

  const parts: string[] = [`\`${kind}\` \`${name}\``];

  // Add qualified-name context when it adds information beyond the bare name.
  const qn = node.qualified_name?.trim();
  if (qn && qn.length > 0 && qn !== name) {
    parts.push(`(${qn})`);
  }

  let summary = `${article(kind)} ${parts.join(" ")}`;

  // The first source/docstring line is the richest deterministic signal we
  // have without a model — fold it in when present and non-trivial.
  const firstLine = input.firstSourceLine ? oneLine(input.firstSourceLine) : "";
  if (firstLine.length >= 3) {
    // Cap so a runaway line can't blow up the one-liner.
    const clipped = firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
    summary += `: ${clipped}`;
  } else if (node.language && node.language !== "unknown") {
    summary += ` (${node.language})`;
  }

  return oneLine(summary);
}

/**
 * Default summarizer: deterministic, zero-dependency, always available.
 */
export class HeuristicSummarizer implements NodeSummarizer {
  readonly id = "heuristic-v1";

  // `async` only to satisfy the Promise-returning interface; the body is a pure
  // synchronous function — no await, no I/O, no randomness, no time.
  async summarize(input: SummaryInput): Promise<SummaryResult> {
    return { summary: heuristicSummary(input), summarizer: this.id };
  }
}

/** The infer call, narrowed to what the summarizer needs (mirrors LlmOracle). */
export type InferFn = (prompt: string) => Promise<InferResult>;

export interface LlmSummarizerOptions {
  /** Summarizer id (the configured model id), e.g. `gemma4:e2b`. Provenance. */
  id: string;
  /** Fallback for every error / timeout / unparseable / empty path. */
  fallback: NodeSummarizer;
  /** The (injected) infer call. */
  infer: InferFn;
  logger?: Logger | undefined;
}

/**
 * Default wall-clock budget for a single summarize inference.
 *
 * Summarize is a BATCH / offline operation — unlike the latency-sensitive Layer-C
 * conflict oracle (which keeps a short budget so the claim path stays snappy), a
 * summary run can afford to wait. The budget must cover a real COLD GGUF load +
 * generation on the CPU backend: measured ~8.6s for `gemma3:1b` here, and more
 * for `gemma3:4b` / slower hardware. The previous 4s default ALWAYS timed out and
 * silently fell back to the heuristic, so the real LLM summary never landed. 120s
 * is generous headroom — normal inference finishes well under it; it only bounds a
 * genuinely-stuck child. Override per-call via `opts.timeoutMs` if needed.
 */
export const SUMMARIZE_INFER_TIMEOUT_MS = 120_000;

/**
 * Build a production infer fn binding {@link runInfer} to a binary + model dir.
 * temp 0.0 = deterministic; a small max-tokens cap keeps a one-sentence summary
 * fast. Mirrors `llm_oracle.makeInferFn` but with a batch-appropriate timeout.
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
      timeoutMs: opts.timeoutMs ?? SUMMARIZE_INFER_TIMEOUT_MS,
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
}

/**
 * The summarization prompt. Renders the node's metadata + optional source line
 * as plain text and asks for a single sentence. Deterministic shape so the
 * model gets a stable instruction.
 */
export function buildPrompt(input: SummaryInput): string {
  const { node } = input;
  const lines = [
    "You are documenting one code entity for a code-intelligence graph.",
    "",
    `kind: ${node.kind}`,
    `name: ${node.name}`,
  ];
  if (node.qualified_name && node.qualified_name !== node.name) {
    lines.push(`qualified name: ${node.qualified_name}`);
  }
  if (node.language && node.language !== "unknown") lines.push(`language: ${node.language}`);
  if (node.file) lines.push(`file: ${node.file}`);
  const firstLine = input.firstSourceLine ? oneLine(input.firstSourceLine) : "";
  if (firstLine.length > 0) lines.push(`first source line: ${firstLine}`);
  lines.push(
    "",
    "Write ONE concise sentence describing what this entity is and does. " +
      "No preamble, no markdown, just the sentence.",
  );
  return lines.join("\n");
}

/**
 * Parse a model completion into a one-line summary, or `null` when the output
 * is unusable (empty / too short) — the caller maps `null` to the heuristic
 * fallback. Keeps only the first sentence and collapses whitespace.
 */
export function parseSummary(completion: string): string | null {
  const text = oneLine(completion);
  if (text.length < 3) return null;
  // Keep the first sentence; cap length so a runaway completion can't bloat the
  // node body.
  const firstSentence = text.split(/(?<=[.!?])\s/)[0]?.trim() ?? text;
  const out = firstSentence.length > 280 ? `${firstSentence.slice(0, 277)}…` : firstSentence;
  return out.length >= 3 ? out : null;
}

/**
 * LLM upgrade. Reads the node through a local Tier-3 model for a richer
 * one-sentence summary. LOAD-BEARING SAFETY (mirrors LlmOracle): a hard timeout
 * bounds the call, and ANY error / timeout / unparseable / empty output falls
 * back to the injected heuristic. Never blocks on, nor throws into, the caller.
 */
export class LlmSummarizer implements NodeSummarizer {
  readonly id: string;
  private readonly fallback: NodeSummarizer;
  private readonly infer: InferFn;
  private readonly logger?: Logger | undefined;

  constructor(opts: LlmSummarizerOptions) {
    this.id = opts.id;
    this.fallback = opts.fallback;
    this.infer = opts.infer;
    this.logger = opts.logger;
  }

  async summarize(input: SummaryInput): Promise<SummaryResult> {
    const prompt = buildPrompt(input);

    let result: InferResult;
    try {
      result = await this.infer(prompt);
    } catch (err) {
      // runInfer resolves a result rather than throwing, but a mocked/alternate
      // fn might throw — treat as a fallback path regardless.
      this.logger?.warn("LlmSummarizer infer threw — falling back to heuristic", {
        error: (err as Error).message,
      });
      return this.fallback.summarize(input);
    }

    if (!result.ok) {
      this.logger?.warn("LlmSummarizer infer failed — falling back to heuristic", {
        error: result.error ?? "(unknown)",
      });
      return this.fallback.summarize(input);
    }

    const parsed = parseSummary(result.completion);
    if (parsed === null) {
      this.logger?.warn("LlmSummarizer output unusable — falling back to heuristic", {
        completion: result.completion.slice(0, 120),
      });
      return this.fallback.summarize(input);
    }

    return { summary: parsed, summarizer: this.id };
  }
}

/**
 * What {@link selectSummarizer} needs to construct an {@link LlmSummarizer}.
 * Mirrors `OracleEnv`: all optional, so with none of it selection can only ever
 * return the zero-config heuristic.
 */
export interface SummarizerEnv {
  /** `.hayven` home, for `isModelPresent` / `modelDir`. */
  hayvenDir?: string | undefined;
  /** Resolve the `hayven-native` binary, or `null` if unavailable. */
  locateBinary?: (() => string | null) | undefined;
  /** Registry presence check (injected for tests). Defaults to the real one. */
  isModelPresent?: ((hayvenDir: string, id: string) => boolean) | undefined;
  /** Registry model-DIR resolver (injected for tests). Defaults to the real one. */
  modelDir?: ((hayvenDir: string, id: string) => string | null) | undefined;
  logger?: Logger | undefined;
}

/**
 * Summarizer selection seam — mirrors `selectOracle` (§17.3 / §18.4). Returns an
 * {@link LlmSummarizer} ONLY when the configured model id is (a) present on disk
 * and (b) a native binary is locatable, constructed with a heuristic fallback so
 * every model error/timeout degrades gracefully. Otherwise returns the heuristic
 * (the zero-config default, and the unknown-key / no-env cases). Spawns nothing.
 *
 * The model id is read from `config.models.tier3.model` (the reflex tier the
 * Layer C oracle also uses); pass `{ model }` directly to override.
 */
export function selectSummarizer(
  config?: { model?: string | undefined; models?: { tier3?: { model?: string } } },
  env?: SummarizerEnv,
): NodeSummarizer {
  const heuristic = new HeuristicSummarizer();
  const key = config?.model ?? config?.models?.tier3?.model;

  // No configured model id → zero-config heuristic default.
  if (key === undefined || key.length === 0) return heuristic;

  // Without an env we cannot resolve/verify a model — degrade to heuristic.
  if (!env) return heuristic;

  const hayvenDir = env.hayvenDir;
  const present = env.isModelPresent ?? isModelPresent;
  const resolveDir = env.modelDir ?? modelDir;
  if (hayvenDir === undefined || !present(hayvenDir, key)) {
    env.logger?.info("summarizer: model not present — using heuristic", { model: key });
    return heuristic;
  }

  const binary = env.locateBinary?.() ?? null;
  const resolvedModel = resolveDir(hayvenDir, key);
  if (binary === null || resolvedModel === null) {
    env.logger?.info("summarizer: native binary or model path unavailable — using heuristic", {
      model: key,
      hasBinary: binary !== null,
      hasModel: resolvedModel !== null,
    });
    return heuristic;
  }

  env.logger?.info("summarizer: using LlmSummarizer", { model: key, modelDir: resolvedModel });
  return new LlmSummarizer({
    id: key,
    fallback: heuristic,
    infer: makeInferFn({
      binary,
      modelDir: resolvedModel,
      ...(env.logger ? { logger: env.logger } : {}),
    }),
    ...(env.logger ? { logger: env.logger } : {}),
  });
}
