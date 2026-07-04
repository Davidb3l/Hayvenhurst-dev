/**
 * SURFACE #3 — PROVIDER ADAPTERS for the transparent context proxy.
 *
 * The packing core (`context_rewrite.ts::rewriteOneText`) is provider-agnostic: it
 * operates on a single text string, finding `<file path="…">` pastes and swapping
 * them for graph-precise slice packs. What differs between LLM vendors is only the
 * REQUEST SHAPE — where the conversation text lives in the JSON — and the ENDPOINT
 * path. Each adapter here binds the shared core to one vendor's wire format:
 *
 *   - anthropic — `POST /v1/messages`, `{ system, messages:[{role, content}] }`
 *   - openai    — `POST /v1/chat/completions`, `{ messages:[{role, content}] }`
 *   - gemini    — `POST …:generateContent`, `{ systemInstruction, contents:[{role, parts}] }`
 *
 * Each adapter exposes the same `rewrite(db, repoRoot, body)` contract returning a
 * {@link RewriteResult}, plus a `matchPath` (so the shell knows which requests to
 * rewrite) and a `defaultUpstream`. The intent (which symbols matter) is collected
 * from the vendor's user/system turns; the never-worse guarantee is the core's.
 */
import {
  inferIntentText,
  rewriteMessagesForContext,
  rewriteOneText,
  stripFileMarkers,
  summarizeStats,
  type FileRewriteStat,
  type MessagesRequest,
  type RewriteOptions,
  type RewriteResult,
} from "./context_rewrite.ts";
import {
  compactAnthropicHistory,
  emptyStats,
  type CompactOptions,
  type CompactStats,
} from "./history_compact.ts";
import { compactOpenAIHistory } from "./history_compact_openai.ts";
import { compactGeminiHistory, type GeminiRequest } from "./history_compact_gemini.ts";
import type { Db } from "../db/queries.ts";

/** The vendor-shaped result of a history-compaction pass. */
export interface CompactHistoryResult {
  body: unknown;
  stats: CompactStats;
  changed: boolean;
}

/** The id strings accepted by `hayven proxy --provider`. */
export type ProviderId = "anthropic" | "openai" | "gemini";

/** A vendor binding of the shared packing core. */
export interface ProxyProvider {
  id: ProviderId;
  /** Human label for the startup banner. */
  label: string;
  /** Canonical upstream base URL (no trailing slash); overridable via `--upstream`. */
  defaultUpstream: string;
  /** Does this request path belong to the vendor's chat endpoint? */
  matchPath(pathname: string): boolean;
  /** Rewrite the request body (provider-agnostic core, vendor-shaped walk). */
  rewrite(db: Db, repoRoot: string, body: unknown, opts?: RewriteOptions): RewriteResult;
  /** Infer the live-instruction intent text from this vendor's request shape
   *  (the signal history compaction slices older reads against). */
  collectIntent(body: unknown): string;
  /** Graph-aware history compaction over this vendor's message shape: compact
   *  OLDER native `Read` results to a task-relevant slice + recovery pointer,
   *  keeping the recency window intact. Tolerates a non-conforming body (returns
   *  unchanged). */
  compactHistory(
    db: Db,
    repoRoot: string,
    body: unknown,
    intentText: string,
    opts?: CompactOptions,
  ): CompactHistoryResult;
}

// ---------------------------------------------------------------------------
// Shared helpers for the OpenAI/Gemini bindings (Anthropic reuses its own
// `rewriteMessagesForContext`, which is already this core specialized).
// ---------------------------------------------------------------------------

/** A per-request rewrite session: a closure over the inferred intent that maps the
 *  core across every text it's handed, accumulating stats + a `changed` flag. */
function makeSession(db: Db, repoRoot: string, intentText: string, opts?: RewriteOptions) {
  const perFile: FileRewriteStat[] = [];
  let changed = false;
  const rewrite = (text: string): string => {
    const r = rewriteOneText(db, repoRoot, text, intentText, opts);
    perFile.push(...r.stats);
    if (r.changed) changed = true;
    return r.text;
  };
  return {
    rewrite,
    result(originalBody: unknown, newBody: unknown): RewriteResult {
      return {
        body: (changed ? newBody : originalBody) as RewriteResult["body"],
        stats: summarizeStats(perFile),
        changed,
      };
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Map a fn over an OpenAI/Anthropic-style `content` (a string OR an array of
 *  `{type:"text", text}` parts), rebuilding rather than mutating. */
function mapStringOrTextParts(content: unknown, fn: (t: string) => string): unknown {
  if (typeof content === "string") return fn(content);
  if (Array.isArray(content)) {
    return content.map((part) =>
      isRecord(part) && part["type"] === "text" && typeof part["text"] === "string"
        ? { ...part, text: fn(part["text"]) }
        : part,
    );
  }
  return content;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions — POST /v1/chat/completions
// ---------------------------------------------------------------------------

function collectOpenAIIntent(body: Record<string, unknown>): string {
  const out: string[] = [];
  const msgs = body["messages"];
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!isRecord(m)) continue;
      if (m["role"] !== "user" && m["role"] !== "system") continue;
      const c = m["content"];
      if (typeof c === "string") out.push(stripFileMarkers(c));
      else if (Array.isArray(c)) {
        for (const p of c)
          if (isRecord(p) && typeof p["text"] === "string") out.push(stripFileMarkers(p["text"]));
      }
    }
  }
  return out.join("\n").trim();
}

function rewriteOpenAI(
  db: Db,
  repoRoot: string,
  raw: unknown,
  opts?: RewriteOptions,
): RewriteResult {
  if (!isRecord(raw) || !Array.isArray(raw["messages"])) {
    return { body: raw as RewriteResult["body"], stats: summarizeStats([]), changed: false };
  }
  const session = makeSession(db, repoRoot, collectOpenAIIntent(raw), opts);
  const messages = (raw["messages"] as unknown[]).map((m) =>
    isRecord(m) ? { ...m, content: mapStringOrTextParts(m["content"], session.rewrite) } : m,
  );
  return session.result(raw, { ...raw, messages });
}

// ---------------------------------------------------------------------------
// Google Gemini — POST …/models/<model>:generateContent (+ streamGenerateContent)
// ---------------------------------------------------------------------------

function geminiPartsText(parts: unknown, fn: (t: string) => string): unknown {
  if (!Array.isArray(parts)) return parts;
  return parts.map((p) =>
    isRecord(p) && typeof p["text"] === "string" ? { ...p, text: fn(p["text"]) } : p,
  );
}

function collectGeminiIntent(body: Record<string, unknown>): string {
  const out: string[] = [];
  const sys = body["systemInstruction"];
  if (isRecord(sys) && Array.isArray(sys["parts"])) {
    for (const p of sys["parts"])
      if (isRecord(p) && typeof p["text"] === "string") out.push(stripFileMarkers(p["text"]));
  }
  const contents = body["contents"];
  if (Array.isArray(contents)) {
    for (const c of contents) {
      if (!isRecord(c) || c["role"] === "model") continue; // skip model (assistant) turns
      if (Array.isArray(c["parts"]))
        for (const p of c["parts"])
          if (isRecord(p) && typeof p["text"] === "string") out.push(stripFileMarkers(p["text"]));
    }
  }
  return out.join("\n").trim();
}

function rewriteGemini(
  db: Db,
  repoRoot: string,
  raw: unknown,
  opts?: RewriteOptions,
): RewriteResult {
  if (!isRecord(raw) || !Array.isArray(raw["contents"])) {
    return { body: raw as RewriteResult["body"], stats: summarizeStats([]), changed: false };
  }
  const session = makeSession(db, repoRoot, collectGeminiIntent(raw), opts);
  const contents = (raw["contents"] as unknown[]).map((c) =>
    isRecord(c) ? { ...c, parts: geminiPartsText(c["parts"], session.rewrite) } : c,
  );
  return session.result(raw, { ...raw, contents });
}

// ---------------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------------

export const PROVIDERS: Record<ProviderId, ProxyProvider> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic Messages API",
    defaultUpstream: "https://api.anthropic.com",
    matchPath: (p) => p === "/v1/messages",
    rewrite: (db, repoRoot, body, opts) =>
      rewriteMessagesForContext(db, repoRoot, body as MessagesRequest, opts),
    collectIntent: (body) => inferIntentText(body as MessagesRequest),
    compactHistory: (db, repoRoot, body, intent, opts) =>
      isRecord(body) && Array.isArray((body as MessagesRequest).messages)
        ? compactAnthropicHistory(db, repoRoot, body as MessagesRequest, intent, opts)
        : { body, stats: emptyStats(), changed: false },
  },
  openai: {
    id: "openai",
    label: "OpenAI Chat Completions",
    defaultUpstream: "https://api.openai.com",
    matchPath: (p) => p === "/v1/chat/completions",
    rewrite: rewriteOpenAI,
    collectIntent: (body) => (isRecord(body) ? collectOpenAIIntent(body) : ""),
    compactHistory: (db, repoRoot, body, intent, opts) =>
      compactOpenAIHistory(db, repoRoot, body, intent, opts),
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini generateContent",
    defaultUpstream: "https://generativelanguage.googleapis.com",
    // The model name is in the path: …/models/<model>:generateContent (or
    // :streamGenerateContent) — match by the action suffix, not an exact path.
    matchPath: (p) => p.endsWith(":generateContent") || p.endsWith(":streamGenerateContent"),
    rewrite: rewriteGemini,
    collectIntent: (body) => (isRecord(body) ? collectGeminiIntent(body) : ""),
    compactHistory: (db, repoRoot, body, intent, opts) =>
      isRecord(body) && Array.isArray((body as GeminiRequest).contents)
        ? compactGeminiHistory(db, repoRoot, body as GeminiRequest, intent, opts)
        : { body, stats: emptyStats(), changed: false },
  },
};

/** Resolve a `--provider` id to its adapter, or `undefined` if unknown. */
export function providerById(id: string): ProxyProvider | undefined {
  return (PROVIDERS as Record<string, ProxyProvider>)[id];
}
