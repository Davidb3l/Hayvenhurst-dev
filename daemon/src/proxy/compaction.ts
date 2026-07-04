/**
 * GRAPH-AWARE HISTORY COMPACTION — the stable library surface for HARNESS BUILDERS.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * What this is
 * ──────────────────────────────────────────────────────────────────────────
 * The compaction core (`history_compact*.ts`) is a set of PURE functions: given
 * an agent request body + the inferred task intent, they return a NEW body in
 * which OLD native file-read results (older than a recency window) are replaced
 * by a graph-precise slice of the code relevant to the task — plus a recovery
 * pointer — and only when the result is strictly SMALLER (never-worse on bytes).
 * The live working set (the last `keepRecentMessages`) is never touched.
 *
 * That core normally runs inside the transparent `hayven proxy` process. This
 * module is the SAME core re-exported as one documented surface so a harness
 * builder (an Agent-SDK loop, a multi-agent orchestrator, a custom proxy) can
 * compact a transcript WITHOUT running the proxy process at all. Nothing here is
 * new behavior — it is a curated, stable re-export of the existing functions and
 * types, so callers depend on `proxy/compaction.ts` rather than reaching into the
 * individual `history_compact*` files.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Usage (Anthropic Messages shape)
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   import { openProjectDb } from "@hayvenhurst/daemon/src/cli/_shared.ts";
 *   import { compactAnthropicHistory } from "@hayvenhurst/daemon/src/proxy/compaction.ts";
 *
 *   // 1. Open the indexed repo's read DB (branch-aware; daemonless). Or, if you
 *   //    already have a path: `new Db(".hayven/index.sqlite")` from db/queries.ts.
 *   const repoRoot = "/path/to/indexed/repo";
 *   const db = openProjectDb(repoRoot);
 *
 *   // 2. Compact the transcript before sending it upstream. `intentText` is the
 *   //    current task (e.g. the latest user instruction) — the slice is resolved
 *   //    against it. `editedFiles` is OPTIONAL: pass the paths your harness knows
 *   //    the agent has edited so their code is retained even when the task drifts
 *   //    (the walker ALSO auto-detects Edit/Write tool calls in the transcript,
 *   //    so this is only needed for edits tracked out-of-band).
 *   const { body: compacted, stats, changed } = compactAnthropicHistory(
 *     db,
 *     repoRoot,
 *     body,                                        // the Anthropic request body
 *     intentText,                                  // the live task / instruction
 *     { keepRecentMessages: 8, editedFiles: new Set(["src/auth.ts"]) },
 *   );
 *
 *   // 3. Send the (possibly) smaller body. `changed` is false when nothing beat
 *   //    the original — in that case `compacted === body` (byte-identical).
 *   await fetch(upstream, { method: "POST", body: JSON.stringify(compacted) });
 *   console.log(`saved ~${stats.savedTokens} tokens across ${stats.occurrencesCompacted} reads`);
 *
 * For the OpenAI Chat Completions shape use {@link compactOpenAIHistory}; for the
 * Gemini `generateContent` shape use {@link compactGeminiHistory}. All three take
 * the same `(db, repoRoot, body, intentText, opts)` signature and the same
 * {@link CompactOptions} — only the body shape differs.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Guarantees
 * ──────────────────────────────────────────────────────────────────────────
 *  - Never-worse on bytes: a read is only compacted when the replacement is
 *    strictly smaller than the original; otherwise the block is left intact.
 *  - Input is never mutated: a NEW body is returned (the same reference when
 *    nothing changed, so you can skip re-serializing).
 *  - Opt-in edited-symbol retention: with no `editedFiles` and no Edit/Write tool
 *    calls in the transcript, the output is byte-identical to intent-only
 *    compaction.
 *  - Pure + deterministic: the only I/O is reading the indexed repo's files off
 *    disk (read-only) and querying the read DB.
 */
export {
  compactAnthropicHistory,
  compactOneRead,
  EDIT_TOOL_NAMES,
  editPathFromInput,
  emptyStats,
  READ_TOOL_NAMES,
  recencyCutoff,
  summarizeCompaction,
} from "./history_compact.ts";
export type {
  CompactOptions,
  CompactResult,
  CompactStat,
  CompactStats,
} from "./history_compact.ts";

export { compactOpenAIHistory } from "./history_compact_openai.ts";

export { compactGeminiHistory } from "./history_compact_gemini.ts";
export type {
  GeminiCompactResult,
  GeminiContent,
  GeminiPart,
  GeminiRequest,
} from "./history_compact_gemini.ts";

export type {
  ContentBlock,
  Message,
  MessagesRequest,
  RewriteOptions,
  TextBlock,
} from "./context_rewrite.ts";
