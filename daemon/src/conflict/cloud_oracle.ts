/**
 * Layer C escalation — `CloudOracle` (Blocker A candidate (a), CLAUDE.md §"NEXT"
 * item 6a; PRD §2.3 / §7.3; docs/ORACLE_WARMTH_DECISION.md §10).
 *
 * WHY THIS EXISTS
 * ---------------
 * Blocker A came back STRUCTURAL for the LOCAL single-shot oracle: no prompt on a
 * 1–4B local Gemma beats the heuristic's ~45.8% held-out adjacent-benign
 * over-block gate (the lever is capability, not the prompt). The directive is to
 * change the LEVER. This adapter is the CEILING-CHECK: does ANY model — a cloud
 * frontier model fed the §7.3 framing + the REAL changed-entity bodies — clear
 * the gate? If yes, the local-vs-cloud product question reopens: the heuristic
 * stays the keyless/local default and this becomes an OPT-IN escalation seam,
 * consistent with PRD §2.3 ("local-first, cloud is the user's explicit choice").
 *
 * It implements the LOCKED `ClaimConflictOracle` seam (oracle.ts §17.3), so it is
 * a drop-in behind `selectOracle` exactly like `LlmOracle` — no rewiring of the
 * claim-registration path.
 *
 * BYO-KEY (no key bundled, no key ever logged):
 *   - `ANTHROPIC_API_KEY` present → Anthropic Messages API (default: a small/cheap
 *     model, `claude-3-5-haiku-latest`). Pinnable via `HAYVEN_CLOUD_MODEL`.
 *   - else `OPENAI_API_KEY` present → OpenAI Chat Completions (default `gpt-4o-mini`).
 *   - neither → the oracle NEVER calls the network; every `assess` is the injected
 *     `HeuristicOracle`'s verdict.
 *
 * LOAD-BEARING SAFETY (mirrors LlmOracle / §18.3–§18.4): a hard timeout bounds the
 * call, and ANY no-key / network error / non-2xx / unparseable response falls back
 * to the injected `HeuristicOracle`'s verdict (so `verdict.oracle === "heuristic-v1"`
 * and the discrimination harness counts it as a fallback EXACTLY like the LLM
 * path). The claim path is NEVER blocked on, nor thrown into by, the cloud call.
 *
 * The HTTP call is INJECTABLE (`fetchImpl`) so this unit-tests with a mocked fetch
 * — no real key, no network, deterministic.
 *
 * PRIVACY (PRD §2.3): when active, this sends real source bodies to a third-party
 * API. That is the user's explicit opt-in (they set the key + select the oracle);
 * it must NEVER be the zero-config default. `selectOracle` keeps the heuristic as
 * the default; this is only reachable behind an explicit `conflict.oracle: "cloud-*"`.
 */
import {
  HeuristicOracle,
  type ClaimConflictOracle,
  type ClaimContext,
  type ConflictVerdict,
} from "./oracle.ts";
import type { Logger } from "../util/log.ts";

/** Minimal fetch surface this oracle needs (matches the global `fetch`). Injected
 * so tests pass a mock; production binds the runtime `fetch` (Bun/Node 18+). */
export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Which cloud provider to use, decided by which key is present. */
type Provider = "anthropic" | "openai";

/**
 * Optional per-claim body context. Production hands the oracle only the
 * {@link ClaimContext} (intent + scope + neighbors). The discrimination bench can
 * ADDITIONALLY supply the REAL changed-entity source via this side-channel so the
 * frontier model gets what it actually needs to discriminate contract-vs-internal
 * edits — the whole point of candidate (a). Keyed by entity id; absent in
 * production (then the prompt carries intent+scope+neighbors only, still valid).
 */
export interface BodyContext {
  /** Map entity id → real source body (what the bench slices from disk). */
  bodies?: ReadonlyMap<string, string> | undefined;
  /** Human label of the focal symbol for each side, if known (for prompt clarity). */
  names?: ReadonlyMap<string, string> | undefined;
  /** Language of the focal symbol for each side, if known. */
  langs?: ReadonlyMap<string, string> | undefined;
}

export interface CloudOracleOptions {
  /** Fallback oracle for every no-key / error / timeout / unparseable path.
   * Defaults to a fresh {@link HeuristicOracle} (the shipping default). */
  fallback?: ClaimConflictOracle | undefined;
  /** Injected HTTP call (defaults to the global `fetch`). */
  fetchImpl?: FetchFn | undefined;
  /** Env accessor (defaults to `process.env`), so tests inject keys cleanly. */
  env?: Record<string, string | undefined> | undefined;
  /** Hard per-call timeout, ms (default 20000 — frontier calls + network). */
  timeoutMs?: number | undefined;
  /** Max completion tokens (default 96 — a YES/NO + one-sentence reason). */
  maxTokens?: number | undefined;
  logger?: Logger | undefined;
}

/** Default cheap/small models per provider (overridable via HAYVEN_CLOUD_MODEL). */
const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: "claude-3-5-haiku-latest",
  openai: "gpt-4o-mini",
};

/** Clip a body so the prompt stays well within a frontier context window and the
 * call stays cheap; the head of a symbol body carries its signature + the start
 * of its logic, which is what the contract/internal call turns on. */
function clip(body: string, max = 2400): string {
  return body.length <= max ? body : body.slice(0, max) + "\n…(truncated)";
}

/**
 * Render one side of the comparison. Uses the real body when the bench supplied it
 * (keyed by the claim's first scope entity id), else falls back to intent + scope
 * + neighbors — the exact production `ClaimContext`, still a valid (if thinner)
 * input. This keeps the adapter correct in BOTH the bench and production.
 */
function fmtSide(label: string, c: ClaimContext, bodyCtx?: BodyContext): string {
  const focal = c.scope[0];
  const name = (focal && bodyCtx?.names?.get(focal)) || focal || "(unknown symbol)";
  const lang = (focal && bodyCtx?.langs?.get(focal)) || "";
  const body = focal ? bodyCtx?.bodies?.get(focal) : undefined;
  const lines = [
    `${label}:`,
    `  intent: ${c.intent}`,
    `  scope: ${c.scope.join(", ") || "(none)"}`,
    `  graph neighbors: ${c.neighbors.join(", ") || "(none)"}`,
  ];
  if (body && body.trim().length > 0) {
    lines.push(`  source of ${name}${lang ? ` (${lang})` : ""}:`, "  ```", clip(body), "  ```");
  }
  return lines.join("\n");
}

/**
 * The §7.3-style adversarial-preview prompt, reframed default-NO and fed the real
 * bodies. Asks for the locked YES/NO verdict. (We deliberately use the default-NO
 * concrete-collision framing — the §9.3 V1 variant — because the §7.3 control is
 * the one measured to be YES-biased; on a frontier model the framing matters less,
 * but this is the honest "best prompt we'd actually ship" for the ceiling-check.)
 */
export function buildCloudPrompt(
  incoming: ClaimContext,
  adjacent: ClaimContext,
  bodyCtx?: BodyContext,
): string {
  return [
    "Two engineers are editing one codebase at the same time. Decide whether",
    "their edits CONCRETELY collide — i.e. whether one edit changes a function",
    "signature, exported type, or shared data shape that the OTHER edit's code",
    "actually depends on.",
    "",
    "Default to NO. Most concurrent edits are independent and must NOT be blocked.",
    "Answer YES only on a SPECIFIC, CONCRETE collision. If an edit only changes",
    "code INTERNAL to its own function (its public signature unchanged), it cannot",
    "break the other — that is NO.",
    "",
    fmtSide("EDIT A (already active)", adjacent, bodyCtx),
    "",
    fmtSide("EDIT B (my intended work)", incoming, bodyCtx),
    "",
    "Does EDIT B concretely collide with EDIT A? Reply with the single word YES",
    "or NO first, then one sentence naming the specific shared symbol if YES.",
  ].join("\n");
}

/**
 * Parse a frontier completion into a verdict. First explicit YES/NO token wins
 * (word-boundary, case-insensitive). Returns `null` when there is no recognizable
 * YES/NO — the caller maps that to the heuristic fallback. Mirrors
 * llm_oracle.ts::parseVerdict's calibration so provenance/confidence are
 * comparable across oracles.
 */
export function parseCloudVerdict(
  completion: string,
  oracleId: string,
): { conflict: boolean; reason: string; confidence: number; oracle: string } | null {
  const text = completion.trim();
  if (text.length === 0) return null;

  const m = text.match(/\b(yes|no)\b/i);
  if (!m) return null;
  const conflict = m[1]!.toLowerCase() === "yes";

  const after = text.slice((m.index ?? 0) + m[1]!.length).replace(/^[\s,.:;-]+/, "");
  const firstSentence = after.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  const hasReason = firstSentence.length >= 3;
  const reason = hasReason
    ? firstSentence
    : conflict
      ? "The frontier oracle judged the two work-scopes likely to break each other's assumptions."
      : "The frontier oracle judged the two work-scopes independent.";

  const confidence = hasReason ? 0.9 : 0.6;
  return { conflict, reason, confidence, oracle: oracleId };
}

/** Build the provider-specific request (url, headers, body) for one prompt. */
function buildRequest(
  provider: Provider,
  apiKey: string,
  model: string,
  prompt: string,
  maxTokens: number,
): { url: string; headers: Record<string, string>; body: string } {
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    };
  }
  // openai
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  };
}

/** Extract the completion text from a provider's JSON response. Returns "" when
 * the shape is unexpected (→ unparseable → fallback). */
function extractCompletion(provider: Provider, raw: string): string {
  try {
    const j = JSON.parse(raw) as unknown;
    if (provider === "anthropic") {
      // { content: [{ type: "text", text: "..." }, ...] }
      const content = (j as { content?: Array<{ type?: string; text?: string }> }).content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
        .trim();
    }
    // openai: { choices: [{ message: { content: "..." } }] }
    const choices = (j as { choices?: Array<{ message?: { content?: string } }> }).choices;
    const txt = choices?.[0]?.message?.content;
    return typeof txt === "string" ? txt.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Cloud/frontier escalation oracle. Drop-in `ClaimConflictOracle`. Picks the
 * provider from whichever BYO key is present; on no key / any failure, returns the
 * injected heuristic's verdict (so the harness tallies a fallback identically to
 * the local LLM path).
 */
export class CloudOracle implements ClaimConflictOracle {
  readonly id: string;
  private readonly provider: Provider | null;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly fallback: ClaimConflictOracle;
  private readonly fetchImpl: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly logger?: Logger | undefined;
  /** Per-assess body side-channel; set by {@link withBodies} for the bench. */
  private bodyCtx: BodyContext | undefined;

  constructor(opts: CloudOracleOptions = {}) {
    const env = opts.env ?? (process.env as Record<string, string | undefined>);
    this.fallback = opts.fallback ?? new HeuristicOracle();
    this.fetchImpl =
      opts.fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as FetchFn)(url, init));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxTokens = opts.maxTokens ?? 96;
    this.logger = opts.logger;

    const anthropic = env["ANTHROPIC_API_KEY"];
    const openai = env["OPENAI_API_KEY"];
    if (anthropic && anthropic.trim()) {
      this.provider = "anthropic";
      this.apiKey = anthropic.trim();
    } else if (openai && openai.trim()) {
      this.provider = "openai";
      this.apiKey = openai.trim();
    } else {
      this.provider = null;
      this.apiKey = null;
    }
    const override = env["HAYVEN_CLOUD_MODEL"]?.trim();
    this.model = override || (this.provider ? DEFAULT_MODEL[this.provider] : "(none)");
    this.id = this.provider ? `cloud-${this.provider}-${this.model}` : "cloud-disabled";
  }

  /** True when a usable BYO key was found (a real network call is possible). */
  get enabled(): boolean {
    return this.provider !== null && this.apiKey !== null;
  }

  /**
   * Attach a real-body side-channel for the NEXT assess calls (used by the
   * discrimination bench so the frontier model sees actual source). Returns
   * `this` for fluent use; no-op in production where bodies aren't supplied.
   */
  withBodies(ctx: BodyContext): this {
    this.bodyCtx = ctx;
    return this;
  }

  async assess(incoming: ClaimContext, adjacent: ClaimContext): Promise<ConflictVerdict> {
    if (!this.enabled || this.provider === null || this.apiKey === null) {
      // No BYO key → never touch the network; degrade to the heuristic exactly
      // like the LLM path's fallback (oracle stays "heuristic-v1").
      return this.fallback.assess(incoming, adjacent);
    }

    const prompt = buildCloudPrompt(incoming, adjacent, this.bodyCtx);
    const req = buildRequest(this.provider, this.apiKey, this.model, prompt, this.maxTokens);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let raw: string;
    try {
      const res = await this.fetchImpl(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger?.warn("CloudOracle non-2xx — falling back to heuristic", {
          provider: this.provider,
          status: res.status,
        });
        return this.fallback.assess(incoming, adjacent);
      }
      raw = await res.text();
    } catch (err) {
      this.logger?.warn("CloudOracle request failed — falling back to heuristic", {
        provider: this.provider,
        error: (err as Error).message,
      });
      return this.fallback.assess(incoming, adjacent);
    } finally {
      clearTimeout(timer);
    }

    const completion = extractCompletion(this.provider, raw);
    const parsed = parseCloudVerdict(completion, this.id);
    if (parsed === null) {
      this.logger?.warn("CloudOracle output unparseable — falling back to heuristic", {
        provider: this.provider,
        completion: completion.slice(0, 120),
      });
      return this.fallback.assess(incoming, adjacent);
    }
    return parsed;
  }
}
