/**
 * SURFACE #3 — GRAPH-AWARE HISTORY COMPACTION for the transparent proxy.
 *
 * The single biggest token cost in an agent/orchestrator LOOP isn't any one file
 * paste — it's the RE-SEND: every turn re-sends the whole growing transcript, so a
 * file read on turn 3 is paid for again on turns 4, 5, … 40. The per-marker slicer
 * (`context_rewrite.ts`) shrinks a file ONCE; nothing compacts the stale copies
 * piling up in history. This module does.
 *
 * Two ideas, one pass:
 *  - DETECT file content that is NOT `<file>`-wrapped — specifically native
 *    `Read` tool results (Anthropic `tool_use{name:"Read", input.file_path}` →
 *    `tool_result{tool_use_id}`). That's how real agents (Claude Code, etc.) put
 *    files into the conversation; the `<file>` marker never sees them.
 *  - COMPACT the STALE ones. A RECENCY WINDOW keeps the last `keepRecentMessages`
 *    messages byte-for-byte intact (the agent's live working set is never touched);
 *    OLDER file reads are replaced by the slice relevant to the current task
 *    (graph-aware — `contextForSymbols` over the inferred intent ∩ that file) plus a
 *    one-line recovery pointer, or a bare pointer when nothing resolves. We only
 *    swap when the compacted form is strictly SMALLER (never-worse on bytes), and
 *    the pointer always names the path + omitted size so the agent can re-read.
 *
 * Scope: this file handles the Anthropic message shape; the OpenAI and Gemini
 * shapes get their own sibling compactors (`history_compact_openai.ts`,
 * `history_compact_gemini.ts`) that reuse the exported core here. All three are
 * wired behind `provider.compactHistory` in `providers.ts`. Opt-in: off unless
 * the proxy is launched with the flag, since
 * compaction is deliberately lossy on OLD context (it trades recoverable detail
 * for tokens, the same trade a manual `/compact` makes — just graph-aware).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { contextForSymbols } from "../db/context_helper.ts";
import { estimateTokens } from "../db/context_pack.ts";
import type { Db } from "../db/queries.ts";
import { resolveTaskToSymbols } from "../db/task_resolve.ts";
import type { ContentBlock, Message, MessagesRequest, RewriteOptions } from "./context_rewrite.ts";

/** Tool names whose result is "the contents of a file" we can compact. Shared by
 *  every provider's compactor so the detection set is identical across vendors. */
export const READ_TOOL_NAMES = new Set(["Read", "read_file", "view", "cat"]);

/** Tool names whose call MODIFIES a file. When a file the agent is actively
 *  editing has its original Read aged out of the recency window, plain
 *  intent-only compaction can drop the very code being changed — forcing a
 *  re-read. We scan ALL messages for these tool_use/tool_call blocks, collect the
 *  modified file_paths, and bias the compacted slice toward those files' symbols
 *  so the agent's live working code stays in context. Shared across vendors so
 *  the edit-detection set is identical everywhere (`input.file_path`/`input.path`
 *  for Anthropic; the JSON-string `arguments.{file_path,path}` for OpenAI; the
 *  `functionCall.args.{file_path,path}` for Gemini). */
export const EDIT_TOOL_NAMES = new Set([
  "Edit",
  "Write",
  "str_replace",
  "str_replace_editor",
  "str_replace_based_edit_tool",
  "create",
  "NotebookEdit",
]);

export interface CompactOptions extends RewriteOptions {
  /** How many trailing messages to keep byte-for-byte intact (the live working
   *  set). Older messages are eligible for compaction. Default 8. */
  keepRecentMessages?: number;
  /** Repo-relative-or-raw file paths the agent has EDITED/WRITTEN anywhere in the
   *  transcript (collected by the provider walker from {@link EDIT_TOOL_NAMES}
   *  tool calls). When compacting an OLD read of a file in this set, the slice is
   *  biased toward that file's own symbols (in ADDITION to the intent-resolved
   *  ones) so the actively-edited code survives compaction instead of being
   *  reduced to a pointer. OPT-IN: when absent/empty, compaction is byte-identical
   *  to the intent-only behavior. The never-worse-on-bytes guarantee is preserved
   *  — adding edited symbols can only make the slice LARGER, and we still only
   *  swap when the result is strictly smaller than the original read. */
  editedFiles?: Set<string>;
}

/** Per-file compaction outcome (for honest stats). */
export interface CompactStat {
  path: string;
  kind: "slice" | "pointer";
  tokensBefore: number;
  tokensAfter: number;
}

export interface CompactStats {
  occurrencesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  perFile: CompactStat[];
}

export interface CompactResult {
  body: MessagesRequest;
  stats: CompactStats;
  changed: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Flatten a tool_result `content` (string | block array) to plain text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) && typeof b["text"] === "string" ? b["text"] : ""))
      .join("");
  }
  return "";
}

/** Resolve a path attribute to a repo-relative file, refusing repo escapes. */
function toRepoRelative(repoRoot: string, rawPath: string): string | null {
  const rootAbs = resolve(repoRoot);
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootAbs, rawPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null;
  const rel = abs.slice(rootAbs.length).replace(/^[\\/]+/, "");
  return rel.length > 0 ? rel : null;
}

/** Is the repo-relative file `rel` among the agent's EDITED files? The edited set
 *  may hold raw paths (absolute or relative, possibly with `./` prefixes), so we
 *  normalize each to repo-relative and compare. A raw path that escapes the repo
 *  normalizes to `null` and never matches. */
function fileWasEdited(repoRoot: string, rel: string, edited: Set<string>): boolean {
  if (edited.size === 0) return false;
  // Fast path: exact string hit (the common case — the same path string the
  // read used was the one edited).
  if (edited.has(rel)) return true;
  for (const raw of edited) {
    if (toRepoRelative(repoRoot, raw) === rel) return true;
  }
  return false;
}

/** Pull a file path out of an EDIT/WRITE tool_use `input` object. Different edit
 *  tools name the field differently (`file_path` for Claude Code's Edit/Write,
 *  `path` for str_replace_editor-style tools), so we accept either. Shared so the
 *  Anthropic walker and any caller normalizing an already-parsed input agree on
 *  the field set. */
export function editPathFromInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const p = input["file_path"] ?? input["path"];
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** The entity ids defined in a file (excluding the module node). */
function fileSymbolIds(db: Db, file: string): Set<string> {
  const rows = db.handle
    .query<{ id: string }, [string]>(
      "SELECT id FROM nodes WHERE file = ? AND kind != 'module'",
    )
    .all(file);
  return new Set(rows.map((r) => r.id));
}

/**
 * Build the compacted replacement text for ONE older file read. Returns the new
 * text + which kind it is, or `null` when we can't beat the original (never-worse).
 *
 * PROVIDER-AGNOSTIC: the per-vendor compactors (`compactAnthropicHistory` here,
 * `compactOpenAIHistory` / `compactGeminiHistory` in sibling files) all walk their
 * own message shape to find older read results, then call THIS to decide the
 * replacement. The graph-aware slice + recovery-pointer logic lives here, once.
 */
export function compactOneRead(
  db: Db,
  repoRoot: string,
  rawPath: string,
  originalText: string,
  intentText: string,
  opts: CompactOptions,
): { text: string; kind: "slice" | "pointer" } | null {
  const lines = originalText.split("\n").length;
  const rel = toRepoRelative(repoRoot, rawPath);

  // Try a graph-aware SLICE first: the part of the file relevant to the task.
  if (rel) {
    const inFile = fileSymbolIds(db, rel);
    if (inFile.size > 0) {
      const maxSymbols = opts.maxSymbols ?? 6;
      const resolved = resolveTaskToSymbols(db, intentText, maxSymbols * 3);
      const intentSymbols = resolved.filter((id) => inFile.has(id));

      // #5 — RETAIN EDITED SYMBOLS. If this very file (F) was EDITED later in the
      // transcript, bias the slice toward F's OWN symbols (the code the agent is
      // actively changing) IN ADDITION to the intent-resolved ones — so an
      // aged-out read of an actively-edited file keeps its working code instead of
      // being reduced to intent-only symbols (or a bare pointer). The union is
      // capped at `maxSymbols`, intent symbols first (the task is still the
      // primary signal), then F's symbols fill the remaining budget. When F was
      // not edited (or no editedFiles were supplied) this is a no-op and the
      // symbol set is byte-identical to the intent-only behavior.
      const isEdited = !!opts.editedFiles && fileWasEdited(repoRoot, rel, opts.editedFiles);
      const ordered: string[] = [...intentSymbols];
      if (isEdited) {
        for (const id of inFile) {
          if (!ordered.includes(id)) ordered.push(id);
        }
      }
      const symbols = ordered.slice(0, maxSymbols);
      if (symbols.length > 0) {
        const pack = contextForSymbols(db, repoRoot, symbols, {
          neighbors: opts.neighbors ?? false, // history compaction: just the relevant slices, no neighbor fan-out
          maxNeighbors: opts.maxNeighbors,
        });
        if (pack) {
          const text =
            `[hayven: older read of ${rawPath} compacted to the slice relevant to your task ` +
            `(was ~${lines} lines; re-read the file for the full text)]\n\n${pack.text}`;
          if (text.length < originalText.length) return { text, kind: "slice" };
        }
      }
    }
  }

  // Fall back to a bare recovery POINTER — drops the stale bytes, names the path.
  const pointer = `[hayven: older read of ${rawPath} (~${lines} lines) elided from older context to save tokens — re-read the file if you need it]`;
  if (pointer.length < originalText.length) return { text: pointer, kind: "pointer" };
  return null; // already small — leave it
}

/**
 * Compact stale native file reads in an Anthropic request's history. Recent
 * messages (the last `keepRecentMessages`) are untouched; older `Read` tool
 * results are compacted to a task-relevant slice + recovery pointer (or a bare
 * pointer). Returns a NEW body; input is not mutated.
 */
export function compactAnthropicHistory(
  db: Db,
  repoRoot: string,
  body: MessagesRequest,
  intentText: string,
  opts: CompactOptions = {},
): CompactResult {
  const keepRecent = Math.max(0, opts.keepRecentMessages ?? 8);
  const msgs = body.messages;
  const cutoff = msgs.length - keepRecent;
  const perFile: CompactStat[] = [];
  if (cutoff <= 0) {
    return { body, stats: emptyStats(), changed: false };
  }

  // 1. Map every Read tool_use id → its file_path AND collect every EDIT/WRITE
  //    file_path (scan ALL messages; a tool_use in an old assistant turn pairs
  //    with a tool_result we may compact, and an edit ANYWHERE — including AFTER
  //    the read — flags that file's symbols for retention). The edited set is
  //    seeded with any caller-supplied `opts.editedFiles` so a harness can inject
  //    edits it tracked out-of-band.
  const readPathById = new Map<string, string>();
  const editedFiles = new Set<string>(opts.editedFiles ?? []);
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!isRecord(b) || b["type"] !== "tool_use" || typeof b["name"] !== "string") continue;
      const name = b["name"];
      if (READ_TOOL_NAMES.has(name)) {
        if (
          typeof b["id"] === "string" &&
          isRecord(b["input"]) &&
          typeof (b["input"] as Record<string, unknown>)["file_path"] === "string"
        ) {
          readPathById.set(b["id"], (b["input"] as Record<string, unknown>)["file_path"] as string);
        }
      } else if (EDIT_TOOL_NAMES.has(name)) {
        const editPath = editPathFromInput(b["input"]);
        if (editPath) editedFiles.add(editPath);
      }
    }
  }
  if (readPathById.size === 0) return { body, stats: emptyStats(), changed: false };

  // The opts the per-read decision sees, with the collected edited set merged in.
  const optsWithEdits: CompactOptions =
    editedFiles.size > 0 ? { ...opts, editedFiles } : opts;

  // 2. Walk OLD messages; compact tool_result blocks paired with a Read.
  let changed = false;
  const newMessages: Message[] = msgs.map((m, i) => {
    if (i >= cutoff || !Array.isArray(m.content)) return m;
    const content = m.content.map((b): ContentBlock => {
      if (
        !isRecord(b) ||
        b["type"] !== "tool_result" ||
        typeof b["tool_use_id"] !== "string"
      ) {
        return b as ContentBlock;
      }
      const path = readPathById.get(b["tool_use_id"] as string);
      if (!path) return b as ContentBlock;
      const original = toolResultText(b["content"]);
      if (original.length === 0) return b as ContentBlock;

      const compacted = compactOneRead(db, repoRoot, path, original, intentText, optsWithEdits);
      if (!compacted) return b as ContentBlock;

      const before = estimateTokens(original.length);
      const after = estimateTokens(compacted.text.length);
      perFile.push({ path, kind: compacted.kind, tokensBefore: before, tokensAfter: after });
      changed = true;
      // Replace the tool_result content with the compacted text (string form).
      return { ...b, content: compacted.text } as ContentBlock;
    });
    return { ...m, content };
  });

  return {
    body: changed ? { ...body, messages: newMessages } : body,
    stats: summarizeCompaction(perFile),
    changed,
  };
}

/** The recency boundary: messages at index < this are OLD (eligible to compact);
 *  the last `keepRecentMessages` (default 8) are the live working set, untouched.
 *  Shared by every provider's compactor so the window means the same everywhere. */
export function recencyCutoff(messageCount: number, opts: CompactOptions = {}): number {
  return messageCount - Math.max(0, opts.keepRecentMessages ?? 8);
}

/** Roll up per-occurrence stats into a {@link CompactStats}. Shared by all the
 *  per-provider compactors so the accounting is identical. */
export function summarizeCompaction(perFile: CompactStat[]): CompactStats {
  const tokensBefore = perFile.reduce((a, s) => a + s.tokensBefore, 0);
  const tokensAfter = perFile.reduce((a, s) => a + s.tokensAfter, 0);
  return {
    occurrencesCompacted: perFile.length,
    tokensBefore,
    tokensAfter,
    savedTokens: tokensBefore - tokensAfter,
    perFile,
  };
}

export function emptyStats(): CompactStats {
  return { occurrencesCompacted: 0, tokensBefore: 0, tokensAfter: 0, savedTokens: 0, perFile: [] };
}
