/**
 * SURFACE #3 — GRAPH-AWARE HISTORY COMPACTION for the GEMINI wire shape.
 *
 * Same algorithm as the Anthropic compactor (`history_compact.ts`,
 * {@link compactAnthropicHistory}) — keep the last `keepRecentMessages` turns
 * byte-for-byte, replace OLDER native file reads with the task-relevant graph
 * slice (or a recovery pointer) — only the wire shape differs. The reusable,
 * provider-agnostic compaction DECISION (`compactOneRead`) and the accounting
 * (`recencyCutoff` / `summarizeCompaction` / `emptyStats`) are shared from
 * `history_compact.ts`; this file only knows how to walk a Gemini request.
 *
 * Gemini's shape (vs Anthropic's `tool_use`/`tool_result`):
 *  - A request is `{ contents: [...] }`; each turn is `{ role:"user"|"model",
 *    parts:[...] }`.
 *  - A function CALL is a part `{ functionCall: { name, args } }` in a
 *    `role:"model"` turn — `args` is an OBJECT, the path typically `args.path`
 *    or `args.file_path`.
 *  - A function RESPONSE is a part `{ functionResponse: { name, response } }` in
 *    a `role:"user"` turn — `response` is an OBJECT and the file text lives under
 *    one of `content`/`result`/`output`/`text` (a string).
 *  - There are NO call ids. We pair a response to its read by the function NAME
 *    (∈ {@link READ_TOOL_NAMES}) and RECENCY: the most recent preceding
 *    `functionCall` of that name carries the path.
 *
 * Never-worse / never-mutate, exactly as the Anthropic path: we only swap when
 * `compactOneRead` returns something strictly smaller, and we rebuild every
 * object we change rather than mutating the input body.
 */
import { estimateTokens } from "../db/context_pack.ts";
import type { Db } from "../db/queries.ts";
import {
  type CompactOptions,
  type CompactResult,
  type CompactStat,
  compactOneRead,
  EDIT_TOOL_NAMES,
  emptyStats,
  READ_TOOL_NAMES,
  recencyCutoff,
  summarizeCompaction,
} from "./history_compact.ts";

// ---------------------------------------------------------------------------
// The minimal Gemini request shape we read/rewrite. Everything we don't touch
// is preserved via index signatures (we never drop fields).
// ---------------------------------------------------------------------------

/** One part inside a turn. Only `functionCall` / `functionResponse` parts are
 *  inspected; every other part shape passes through untouched. */
export interface GeminiPart {
  functionCall?: { name?: string; args?: Record<string, unknown>; [k: string]: unknown };
  functionResponse?: { name?: string; response?: Record<string, unknown>; [k: string]: unknown };
  [k: string]: unknown;
}

/** One Gemini turn. */
export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
  [k: string]: unknown;
}

/** The Gemini `generateContent` request body. Only `contents` is read/rewritten;
 *  all other fields (model, generationConfig, tools, …) are preserved. */
export interface GeminiRequest {
  contents: GeminiContent[];
  [k: string]: unknown;
}

/** A Gemini-shaped {@link CompactResult}. */
export interface GeminiCompactResult extends Omit<CompactResult, "body"> {
  body: GeminiRequest;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The first string-valued response field among the conventional file-text keys,
 *  with its key so the compacted text can be written back to THAT same key (we
 *  must preserve the rest of the response object). `null` when none is a string. */
const RESPONSE_TEXT_KEYS = ["content", "result", "output", "text"] as const;
function responseTextField(
  response: Record<string, unknown>,
): { key: string; text: string } | null {
  for (const key of RESPONSE_TEXT_KEYS) {
    const v = response[key];
    if (typeof v === "string") return { key, text: v };
  }
  return null;
}

/** Extract a read's path from a `functionCall` part's `args` object. Tries the
 *  conventional keys (`path`, then `file_path`); `null` when neither is a string. */
function callPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  if (typeof args["path"] === "string") return args["path"];
  if (typeof args["file_path"] === "string") return args["file_path"];
  return null;
}

/**
 * Compact stale native file reads in a Gemini request's history. Recent turns
 * (the last `keepRecentMessages`) are untouched; older read `functionResponse`
 * parts are compacted to a task-relevant slice + recovery pointer (or a bare
 * pointer). Returns a NEW body; input is not mutated.
 */
export function compactGeminiHistory(
  db: Db,
  repoRoot: string,
  body: GeminiRequest,
  intentText: string,
  opts: CompactOptions = {},
): GeminiCompactResult {
  const contents = body.contents;
  const cutoff = recencyCutoff(contents.length, opts);
  const perFile: CompactStat[] = [];
  if (cutoff <= 0) {
    return { body, stats: emptyStats(), changed: false };
  }

  // 1. Track the latest path seen per read-function NAME from `functionCall`
  //    parts (scan ALL turns in order; Gemini has no ids, so the most recent
  //    preceding call of a name carries the path for that name's responses).
  //    We record the path AT THE TURN it is read so an OLD response pairs with
  //    the call that preceded it — we re-derive the map as we walk in step 2.
  let sawReadCall = false;
  // Collect EDIT/WRITE file paths in the same pre-pass (#5 — retain edited
  // symbols). Seeded with any caller-supplied `opts.editedFiles`.
  const editedFiles = new Set<string>(opts.editedFiles ?? []);
  for (const turn of contents) {
    if (!Array.isArray(turn.parts)) continue;
    for (const p of turn.parts) {
      const fc = isRecord(p) ? (p["functionCall"] as GeminiPart["functionCall"]) : undefined;
      if (!fc || typeof fc.name !== "string") continue;
      if (READ_TOOL_NAMES.has(fc.name)) {
        sawReadCall = true;
      } else if (EDIT_TOOL_NAMES.has(fc.name)) {
        const path = callPath(fc.args);
        if (path) editedFiles.add(path);
      }
    }
  }
  if (!sawReadCall) return { body, stats: emptyStats(), changed: false };
  const optsWithEdits: CompactOptions =
    editedFiles.size > 0 ? { ...opts, editedFiles } : opts;

  // 2. Walk turns in order, maintaining the latest path per read-name. In OLD
  //    turns (index < cutoff) compact each read `functionResponse` part.
  const latestPathByName = new Map<string, string>();
  let changed = false;
  const newContents: GeminiContent[] = contents.map((turn, i) => {
    if (!Array.isArray(turn.parts)) return turn;

    let turnChanged = false;
    const newParts: GeminiPart[] = turn.parts.map((p): GeminiPart => {
      if (!isRecord(p)) return p;

      // A read call updates the latest-path map (regardless of recency — a call
      // in a recent turn can still name the path for an old response, though in
      // practice the call precedes its response).
      const fc = p["functionCall"] as GeminiPart["functionCall"] | undefined;
      if (fc && typeof fc.name === "string" && READ_TOOL_NAMES.has(fc.name)) {
        const path = callPath(fc.args);
        if (path) latestPathByName.set(fc.name, path);
        return p;
      }

      // Only OLD turns are eligible for compaction; recent ones stay full.
      if (i >= cutoff) return p;

      const fr = p["functionResponse"] as GeminiPart["functionResponse"] | undefined;
      if (!fr || typeof fr.name !== "string" || !READ_TOOL_NAMES.has(fr.name)) return p;
      if (!isRecord(fr.response)) return p;

      const path = latestPathByName.get(fr.name);
      if (!path) return p;

      const field = responseTextField(fr.response);
      if (!field || field.text.length === 0) return p;

      const compacted = compactOneRead(db, repoRoot, path, field.text, intentText, optsWithEdits);
      if (!compacted) return p;

      const before = estimateTokens(field.text.length);
      const after = estimateTokens(compacted.text.length);
      perFile.push({ path, kind: compacted.kind, tokensBefore: before, tokensAfter: after });
      changed = true;
      turnChanged = true;

      // Write the compacted text back to the SAME response key; preserve the
      // rest of the response object and the rest of the part.
      return {
        ...p,
        functionResponse: {
          ...fr,
          response: { ...fr.response, [field.key]: compacted.text },
        },
      };
    });

    return turnChanged ? { ...turn, parts: newParts } : turn;
  });

  return {
    body: changed ? { ...body, contents: newContents } : body,
    stats: summarizeCompaction(perFile),
    changed,
  };
}
