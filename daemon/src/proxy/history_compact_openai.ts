/**
 * SURFACE #3 — GRAPH-AWARE HISTORY COMPACTION for the OpenAI Chat Completions
 * wire shape.
 *
 * Sibling of the Anthropic compactor (`history_compact.ts`): same algorithm — a
 * recency window keeps the live working set byte-for-byte intact, OLDER native
 * file reads are replaced by the task-relevant graph slice (+ recovery pointer)
 * or a bare pointer, and we only swap when the compacted form is strictly
 * SMALLER (never-worse). The graph-aware decision itself lives once in
 * `compactOneRead`; this module only walks the OpenAI message shape to find the
 * older read RESULTS and feed them through it.
 *
 * The OpenAI shape differs from Anthropic in two ways:
 *  - A tool CALL is an ASSISTANT message carrying `tool_calls: [{ id, type,
 *    function: { name, arguments } }]`, where `arguments` is a JSON *string* we
 *    must parse to recover the file path (`arguments.path` / `.file_path`).
 *  - A tool RESULT is its OWN message `{ role: "tool", tool_call_id, content }`,
 *    where `content` is the file text (a string) — not a `tool_result` block
 *    nested inside a user turn.
 * So we map `tool_call.id → path` for READ calls, then compact each
 * `role:"tool"` message in the OLD zone whose `tool_call_id` maps to a read.
 *
 * Opt-in + deliberately lossy on OLD context — same trade a manual `/compact`
 * makes, just graph-aware. Input is never mutated; we rebuild objects.
 */
import { estimateTokens } from "../db/context_pack.ts";
import type { Db } from "../db/queries.ts";
import {
  type CompactOptions,
  type CompactResult,
  type CompactStat,
  type CompactStats,
  compactOneRead,
  EDIT_TOOL_NAMES,
  emptyStats,
  READ_TOOL_NAMES,
  recencyCutoff,
  summarizeCompaction,
} from "./history_compact.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Pull a file path out of an OpenAI tool-call's `arguments` (a JSON STRING).
 *  Reads typically pass `{ "path": "…" }` or `{ "file_path": "…" }`. */
function pathFromArguments(args: unknown): string | null {
  if (typeof args !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null; // malformed arguments — can't recover a path, leave it
  }
  if (!isRecord(parsed)) return null;
  const p = parsed["path"] ?? parsed["file_path"];
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Flatten a `role:"tool"` message's `content` (a string, or — defensively — an
 *  array of `{type:"text", text}` parts) to plain text. */
function toolMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && typeof b["text"] === "string" ? b["text"] : ""))
      .join("");
  }
  return "";
}

/**
 * Compact stale native file reads in an OpenAI Chat Completions request's
 * history. Recent messages (the last `keepRecentMessages`) are untouched; older
 * `role:"tool"` results paired with a `Read` tool-call are compacted to a
 * task-relevant slice + recovery pointer (or a bare pointer). Returns a NEW
 * body; the input is never mutated.
 */
export function compactOpenAIHistory(
  db: Db,
  repoRoot: string,
  body: unknown,
  intentText: string,
  opts: CompactOptions = {},
): CompactResult {
  // Tolerate a non-conforming body the same way the OpenAI rewrite binding does.
  if (!isRecord(body) || !Array.isArray(body["messages"])) {
    return { body: body as CompactResult["body"], stats: emptyStats(), changed: false };
  }
  const msgs = body["messages"] as unknown[];
  const cutoff = recencyCutoff(msgs.length, opts);
  const perFile: CompactStat[] = [];
  if (cutoff <= 0) {
    return { body: body as CompactResult["body"], stats: emptyStats(), changed: false };
  }

  // 1. Map every Read tool_call id → its file path AND collect every EDIT/WRITE
  //    file path (scan ALL messages; a tool_call in an old assistant turn pairs
  //    with a tool result we may compact, and an edit ANYWHERE flags that file's
  //    symbols for retention — #5). The path lives in the JSON-string
  //    `function.arguments` for both. The edited set is seeded with any
  //    caller-supplied `opts.editedFiles`.
  const readPathById = new Map<string, string>();
  const editedFiles = new Set<string>(opts.editedFiles ?? []);
  for (const m of msgs) {
    if (!isRecord(m) || !Array.isArray(m["tool_calls"])) continue;
    for (const tc of m["tool_calls"]) {
      if (!isRecord(tc) || typeof tc["id"] !== "string") continue;
      const fn = tc["function"];
      if (!isRecord(fn) || typeof fn["name"] !== "string") continue;
      if (READ_TOOL_NAMES.has(fn["name"])) {
        const path = pathFromArguments(fn["arguments"]);
        if (path) readPathById.set(tc["id"], path);
      } else if (EDIT_TOOL_NAMES.has(fn["name"])) {
        const path = pathFromArguments(fn["arguments"]);
        if (path) editedFiles.add(path);
      }
    }
  }
  if (readPathById.size === 0) {
    return { body: body as CompactResult["body"], stats: emptyStats(), changed: false };
  }
  const optsWithEdits: CompactOptions =
    editedFiles.size > 0 ? { ...opts, editedFiles } : opts;

  // 2. Walk OLD messages; compact each `role:"tool"` result paired with a Read.
  let changed = false;
  const newMessages = msgs.map((m, i) => {
    if (i >= cutoff || !isRecord(m) || m["role"] !== "tool") return m;
    if (typeof m["tool_call_id"] !== "string") return m;
    const path = readPathById.get(m["tool_call_id"]);
    if (!path) return m;
    const original = toolMessageText(m["content"]);
    if (original.length === 0) return m;

    const compacted = compactOneRead(db, repoRoot, path, original, intentText, optsWithEdits);
    if (!compacted) return m;

    const before = estimateTokens(original.length);
    const after = estimateTokens(compacted.text.length);
    perFile.push({ path, kind: compacted.kind, tokensBefore: before, tokensAfter: after });
    changed = true;
    // Replace the tool message's content with the compacted text (string form).
    return { ...m, content: compacted.text };
  });

  return {
    body: (changed ? { ...body, messages: newMessages } : body) as CompactResult["body"],
    stats: summarizeCompaction(perFile),
    changed,
  };
}
