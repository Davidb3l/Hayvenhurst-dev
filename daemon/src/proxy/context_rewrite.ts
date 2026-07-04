/**
 * SURFACE #3 — the transparent context proxy's PURE REWRITE CORE.
 *
 * What it is. A single pure function, {@link rewriteMessagesForContext}, that
 * takes an Anthropic Messages API request body and returns a (possibly) rewritten
 * one in which WHOLE-FILE content the agent pasted into the conversation is
 * replaced, in place, by a graph-precise slice pack — the same `contextForSymbols`
 * pack Surfaces #1 (library) and #2 (MCP) produce, only here the agent never
 * asked for it. The proxy INFERS which symbols matter from the live instruction
 * and swaps the file body for just those slices (plus their 1-hop deps).
 *
 * Why this is the third, distinct surface. #1 is the builder calling the library;
 * #2 is an MCP host calling a tool — both are EXPLICIT (the caller names the
 * file/symbols). #3 is TRANSPARENT: it sits in the request path and has to INFER
 * intent because nothing named the symbols. That inference is the whole job here.
 *
 * The transparency contract (deliberately narrow, low false-positive). We only
 * touch content wrapped in an explicit, documented marker:
 *
 *     <file path="src/foo.ts">…the whole file…</file>   (single or double quotes)
 *
 * — the XML-tag convention Anthropic's own prompting guidance recommends for
 * documents. Anything not in that shape is passed through untouched. This is the
 * PROTOCOL-LEVEL whole-file fallback: when in doubt we change nothing, so the
 * proxy is never worse than not being there.
 *
 * The never-worse guarantee, at three levels:
 *   1. unrecognized content            → untouched (no marker).
 *   2. marker present but we can't beat it (file not indexed, the wrapped body
 *      isn't actually the file, no in-file symbol matched the intent, or the pack
 *      isn't smaller) → the original `<file>` block is left byte-for-byte intact.
 *   3. only when a graph pack is strictly SMALLER than the file body do we swap —
 *      and the swapped-in block is clearly labelled so the agent (and a human
 *      reading the transcript) sees it is a slice, not the raw file.
 *
 * Pure + deterministic: no I/O beyond reading the indexed repo's files off disk
 * (read-only) and querying the read DB. The thin HTTP forwarding shell lives in
 * `server.ts`; this module is what the tests drive directly.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { contextForSymbols } from "../db/context_helper.ts";
import { estimateTokens } from "../db/context_pack.ts";
import type { Db } from "../db/queries.ts";
import { resolveTaskToSymbols } from "../db/task_resolve.ts";

// ---------------------------------------------------------------------------
// The minimal Anthropic Messages API request shape we read/rewrite. Everything
// we don't touch is preserved via an index signature (we never drop fields).
// ---------------------------------------------------------------------------

/** A `text` content block (the only block kind we ever rewrite). */
export interface TextBlock {
  type: "text";
  text: string;
  [k: string]: unknown;
}

/** Any content block; only `type:"text"` is inspected, the rest pass through. */
export type ContentBlock = TextBlock | { type: string; [k: string]: unknown };

/** One message. `content` is either a bare string or an array of blocks — both
 *  shapes are valid Messages API and both are handled. */
export interface Message {
  role: string;
  content: string | ContentBlock[];
  [k: string]: unknown;
}

/** The request body. Only `messages` (+ optional `system`) are read; all other
 *  fields (model, max_tokens, tools, …) are preserved untouched. */
export interface MessagesRequest {
  messages: Message[];
  system?: string | ContentBlock[];
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Stats — what the proxy did, so the shell can log honest savings.
// ---------------------------------------------------------------------------

/** Why a detected `<file>` marker was or wasn't rewritten. */
export type FileAction =
  | "packed" // replaced with a strictly-smaller graph pack
  | "not-indexed" // file has no entity nodes in the index
  | "not-whole-file" // wrapped body isn't the on-disk file (partial/edited paste)
  | "no-intent" // no in-file symbol matched the inferred intent
  | "not-smaller" // a pack resolved but wasn't smaller than the file — kept file
  | "unreadable"; // path escaped repo / file missing on disk

/** Per-marker outcome. */
export interface FileRewriteStat {
  path: string;
  action: FileAction;
  /** chars/4 token proxy of the original wrapped body. */
  tokensBefore: number;
  /** token proxy of the replacement (== tokensBefore when not packed). */
  tokensAfter: number;
  /** `tokensBefore - tokensAfter` (0 unless packed). */
  savedTokens: number;
  /** The in-file symbols the intent resolved to (only when `packed`). */
  symbols?: string[];
}

/** Aggregate outcome for the whole request. */
export interface RewriteStats {
  filesDetected: number;
  filesPacked: number;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  perFile: FileRewriteStat[];
}

/** The rewrite result: the (possibly) new body, the stats, and whether anything
 *  changed (so the shell can skip re-serializing an untouched body). */
export interface RewriteResult {
  body: MessagesRequest;
  stats: RewriteStats;
  changed: boolean;
}

/** Options — the intent-resolution breadth and the packer knobs to forward. */
export interface RewriteOptions {
  /** Max symbols the intent resolver may pick PER request (default 6). The
   *  per-file intersection narrows this to that file's symbols. */
  maxSymbols?: number;
  /** Forwarded to the packer: include 1-hop callee/ref neighbors (default true —
   *  the deps are the value, and they still net-save vs the whole file). */
  neighbors?: boolean;
  /** Forwarded to the packer: cap neighbor slices. */
  maxNeighbors?: number;
}

// ---------------------------------------------------------------------------
// File-marker scanning.
// ---------------------------------------------------------------------------

/** Matches `<file path="…">BODY</file>` (single OR double quotes), non-greedy
 *  body, across newlines. Capture 1 = path, capture 2 = body. The `[^>]*` after
 *  the quoted path tolerates extra attributes without swallowing the close `>`. */
const FILE_MARKER = /<file\s+path=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/file>/g;

/** One scanned marker within a text block: its full matched text (so we can do an
 *  exact string replace), the path, and the wrapped body. */
interface ScannedMarker {
  whole: string;
  path: string;
  body: string;
}

/** Find every `<file>` marker in a text block. */
function scanMarkers(text: string): ScannedMarker[] {
  const out: ScannedMarker[] = [];
  // `matchAll` with a global regex — each match is independent (no lastIndex
  // foot-gun since we don't reuse the regex object across calls concurrently).
  for (const m of text.matchAll(FILE_MARKER)) {
    out.push({ whole: m[0], path: (m[1] ?? m[2]) as string, body: m[3] ?? "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Intent text extraction.
// ---------------------------------------------------------------------------

/** Pull the human INSTRUCTION text out of a message's content — the prose that
 *  isn't itself a pasted file. This is the intent signal. */
function instructionText(content: Message["content"]): string {
  if (typeof content === "string") return stripMarkers(content);
  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(stripMarkers(block.text));
  }
  return parts.join("\n");
}

/** Remove `<file>…</file>` regions so a file's own text can't pollute the intent
 *  signal (we want the instruction, not the code). */
function stripMarkers(text: string): string {
  return text.replace(FILE_MARKER, " ");
}

/** Public alias of {@link stripMarkers} for the per-provider intent collectors in
 *  `providers.ts` (OpenAI / Gemini build their intent text from their own
 *  message shapes, stripping pasted file bodies the same way). */
export function stripFileMarkers(text: string): string {
  return stripMarkers(text);
}

/**
 * The inferred intent: the latest user instruction + the system prompt prose.
 * The LAST user turn is weighted by being concatenated last is irrelevant to the
 * bag-of-words FTS resolver — what matters is we include the live instruction and
 * the standing system task, and EXCLUDE pasted file bodies. Bounded by nature
 * (resolveTaskToSymbols is the synchronous model-free FTS path).
 */
export function inferIntentText(body: MessagesRequest): string {
  const parts: string[] = [];
  if (typeof body.system === "string") parts.push(stripMarkers(body.system));
  else if (Array.isArray(body.system)) {
    for (const b of body.system) if (isTextBlock(b)) parts.push(stripMarkers(b.text));
  }
  // Walk user messages newest-first; include their instruction prose. Assistant
  // turns are the model's own words, not the human's intent — skip them.
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i]!;
    if (msg.role === "user") parts.push(instructionText(msg.content));
  }
  return parts.join("\n").trim();
}

function isTextBlock(b: ContentBlock): b is TextBlock {
  return b.type === "text" && typeof (b as TextBlock).text === "string";
}

// ---------------------------------------------------------------------------
// The per-file decision: can we beat this whole-file paste with a graph pack?
// ---------------------------------------------------------------------------

/** The entity ids defined in a file (excluding the module node). Empty ⇒ the
 *  file isn't indexed as code we can slice. */
function fileSymbolIds(db: Db, file: string): Set<string> {
  const rows = db.handle
    .query<{ id: string }, [string]>(
      "SELECT id FROM nodes WHERE file = ? AND kind != 'module'",
    )
    .all(file);
  return new Set(rows.map((r) => r.id));
}

/** Resolve a path attribute to a repo-relative file, refusing anything that
 *  escapes the repo root (path-traversal / absolute-path hygiene). Returns the
 *  repo-relative path (the form the index stores) or null. */
function toRepoRelative(repoRoot: string, rawPath: string): string | null {
  const rootAbs = resolve(repoRoot);
  const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootAbs, rawPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null; // escaped repo
  const rel = abs.slice(rootAbs.length).replace(/^[\\/]+/, "");
  return rel.length > 0 ? rel : null;
}

/** Decide + (if worth it) build the replacement for one `<file>` marker. Pure
 *  apart from the read-only file read + DB query. Returns the new block text and
 *  the stat; `null` newText means "leave the marker untouched". */
function rewriteOneMarker(
  db: Db,
  repoRoot: string,
  marker: ScannedMarker,
  intentText: string,
  opts: Required<RewriteOptions>,
): { newText: string | null; stat: FileRewriteStat } {
  const tokensBefore = estimateTokens(marker.body.length);
  const base = (action: FileAction): FileRewriteStat => ({
    path: marker.path,
    action,
    tokensBefore,
    tokensAfter: tokensBefore,
    savedTokens: 0,
  });

  const rel = toRepoRelative(repoRoot, marker.path);
  if (!rel) return { newText: null, stat: base("unreadable") };

  let onDisk: string;
  try {
    onDisk = readFileSync(resolve(repoRoot, rel), "utf8");
  } catch {
    return { newText: null, stat: base("unreadable") };
  }

  // Whole-file check: the on-disk file must appear, intact, inside the wrapped
  // body (tolerates a header/footer the harness added, rejects partial/edited
  // pastes — which we must NOT misrepresent as the file).
  const fileTrim = onDisk.trim();
  if (fileTrim.length < 40 || !marker.body.includes(fileTrim)) {
    return { newText: null, stat: base("not-whole-file") };
  }

  const inFile = fileSymbolIds(db, rel);
  if (inFile.size === 0) return { newText: null, stat: base("not-indexed") };

  // INTENT: resolve the instruction to symbols, keep only this file's. Over-fetch
  // (×3) because the resolver ranks across the whole repo; the intersection trims.
  const resolved = resolveTaskToSymbols(db, intentText, opts.maxSymbols * 3);
  const symbols = resolved.filter((id) => inFile.has(id)).slice(0, opts.maxSymbols);
  if (symbols.length === 0) return { newText: null, stat: base("no-intent") };

  const pack = contextForSymbols(db, repoRoot, symbols, {
    neighbors: opts.neighbors,
    maxNeighbors: opts.maxNeighbors,
  });
  if (!pack) return { newText: null, stat: base("no-intent") };

  const tokensAfter = estimateTokens(pack.text.length);
  if (tokensAfter >= tokensBefore) {
    // A pack that isn't smaller is no win — keep the file (never-worse).
    return { newText: null, stat: base("not-smaller") };
  }

  // Build the replacement, keeping the SAME `<file path="…">` wrapper so the
  // harness's downstream parsing is undisturbed, but labelling the body so it is
  // honestly a slice, not the raw file.
  const note =
    `[hayven context proxy] graph-precise slices of ${marker.path} for ` +
    `${symbols.join(", ")} — ~${tokensAfter} tok (was ~${tokensBefore} for the whole file). ` +
    `Ask for more of this file by name if you need it.`;
  // Use a FUNCTION replacement: a string replacement would interpret `$`
  // patterns ($&, $$, $`, $') in the sliced code and silently corrupt it.
  const replacement = `\n${note}\n\n${pack.text}\n`;
  const newWhole = marker.whole.replace(marker.body, () => replacement);

  return {
    newText: newWhole,
    stat: {
      path: marker.path,
      action: "packed",
      tokensBefore,
      tokensAfter,
      savedTokens: tokensBefore - tokensAfter,
      symbols,
    },
  };
}

// ---------------------------------------------------------------------------
// The public entry point.
// ---------------------------------------------------------------------------

export const DEFAULT_REWRITE_OPTS: Required<RewriteOptions> = {
  maxSymbols: 6,
  neighbors: true,
  maxNeighbors: 10,
};

/** The outcome of rewriting ONE text string: the (maybe) new text, whether it
 *  changed, and the per-marker stats. The provider-agnostic unit every transport
 *  (Anthropic / OpenAI / Gemini) maps over its own text fields. */
export interface TextRewrite {
  text: string;
  changed: boolean;
  stats: FileRewriteStat[];
}

/**
 * Rewrite a SINGLE text string: swap each `<file path="…">` whole-file paste it
 * contains for a graph-precise slice pack inferred from `intentText`, when a
 * smaller pack exists. PROVIDER-AGNOSTIC — the request shape (where this text
 * lives) is the transport's concern; this is the shared packing core.
 */
export function rewriteOneText(
  db: Db,
  repoRoot: string,
  text: string,
  intentText: string,
  options: RewriteOptions = {},
): TextRewrite {
  const opts = { ...DEFAULT_REWRITE_OPTS, ...options };
  const markers = scanMarkers(text);
  if (markers.length === 0) return { text, changed: false, stats: [] };
  const stats: FileRewriteStat[] = [];
  let out = text;
  let changed = false;
  for (const marker of markers) {
    const { newText, stat } = rewriteOneMarker(db, repoRoot, marker, intentText, opts);
    stats.push(stat);
    if (newText !== null) {
      // Function replacement — never let `$` patterns in the pack be reinterpreted.
      out = out.replace(marker.whole, () => newText);
      changed = true;
    }
  }
  return { text: out, changed, stats };
}

/** Roll up per-file stats into the request-level {@link RewriteStats}. */
export function summarizeStats(perFile: FileRewriteStat[]): RewriteStats {
  const tokensBefore = perFile.reduce((a, s) => a + s.tokensBefore, 0);
  const tokensAfter = perFile.reduce((a, s) => a + s.tokensAfter, 0);
  return {
    filesDetected: perFile.length,
    filesPacked: perFile.filter((s) => s.action === "packed").length,
    tokensBefore,
    tokensAfter,
    savedTokens: tokensBefore - tokensAfter,
    perFile,
  };
}

/**
 * Rewrite an ANTHROPIC Messages API request body, swapping whole-file
 * `<file path="…">` pastes for graph-precise slice packs wherever a smaller pack
 * can be inferred from the live instruction. Never-worse: anything we can't
 * confidently beat is left byte-for-byte intact. Returns a NEW body (input not
 * mutated), the savings stats, and a `changed` flag.
 *
 * This is the Anthropic transport binding of the provider-agnostic core; the
 * OpenAI / Gemini bindings live in `providers.ts`. The intent is computed ONCE
 * from the whole conversation ({@link inferIntentText}).
 */
export function rewriteMessagesForContext(
  db: Db,
  repoRoot: string,
  body: MessagesRequest,
  options: RewriteOptions = {},
): RewriteResult {
  const perFile: FileRewriteStat[] = [];
  let changed = false;
  const intentText = inferIntentText(body);

  const rewriteText = (text: string): string => {
    const r = rewriteOneText(db, repoRoot, text, intentText, options);
    perFile.push(...r.stats);
    if (r.changed) changed = true;
    return r.text;
  };

  const messages: Message[] = body.messages.map((msg) => {
    if (typeof msg.content === "string") return { ...msg, content: rewriteText(msg.content) };
    const content = msg.content.map((block) =>
      isTextBlock(block) ? { ...block, text: rewriteText(block.text) } : block,
    );
    return { ...msg, content };
  });

  const newBody: MessagesRequest = { ...body, messages };
  const stats = summarizeStats(perFile);
  return { body: changed ? newBody : body, stats, changed };
}
