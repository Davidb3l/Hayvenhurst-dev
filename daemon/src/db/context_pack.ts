/**
 * `hayven context <symbol>` — the context-COST PACKER (Phase 0.0.4.5 pivot).
 *
 * The pivot doc (`docs/PHASE_0.0.4.5_PIVOT.md`) measured the one thing hayven
 * actually wins at: feeding an agent a graph-precise SLICE instead of whole
 * files cut re-sent context tokens 78–86%, and a model fixed a real bug from a
 * 311-token slice with all tests passing. This module assembles that slice.
 *
 * It is a LIBRARY first (the CLI in `cli/context.ts` is a thin wrapper) because
 * the integration that dodged every prior failure is: the BUILDER calls this to
 * assemble a prompt — an Agent-SDK app or a multi-agent harness that controls
 * context programmatically — NOT a tool the free-roaming agent must choose to
 * use (every measurement showed it greps instead).
 *
 * The pack, line-exact, is:
 *   1. HEADER  — the target file's leading import/comment block (so referenced
 *                symbols resolve in the slice).
 *   2. TARGET  — the target entity's body (file lines `range_start..range_end`).
 *   3. NEIGHBORS — the target's 1-hop DEPENDENCIES: the bodies of the symbols it
 *                CALLS (outgoing call edges), deduped, module nodes excluded
 *                (their "body" is the whole file). This is the cross-file slice
 *                — a callee in another file comes in as its own line-exact body.
 *
 * Everything is reused from the assets the pivot identified: node ranges
 * (`NodeRow.range_start/end`), the call/import edge graph (`db.outgoing`), and
 * `resolveNodeId` (the same fuzzy locator `refs`/`impact` use). No embeddings,
 * no model — exact-identifier, never-stale, line-exact.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { IMPORT_KIND, isCallKind, resolveNodeId } from "./graph_walk.ts";
import { collectImportedSymbols } from "./imported_symbol.ts";
import type { Db, NodeRow } from "./queries.ts";

/** One contiguous, line-exact slice of source in the pack. */
export interface ContextSlice {
  /** Why this slice is here. `"module-frame"` is a header run produced by
   *  {@link buildModuleFrame} (a whole-file module frame with no single target),
   *  distinguished from a single-symbol `"header"` run only by provenance. */
  role: "header" | "target" | "neighbor" | "module-frame";
  /** The node id this slice came from (`null` for a synthetic header slice). */
  id: string | null;
  /** The node kind (`"header"` for the synthetic header slice). */
  kind: string;
  /** Repo-relative source file. */
  file: string;
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based inclusive last line. */
  endLine: number;
  /** The sliced source text (no trailing newline). */
  text: string;
  /** For a neighbor: how it was reached from the target — `"call"` (an outgoing
   *  call edge), `"ref"` (a same-file entity named in the target body, e.g. a
   *  type used in the signature, which is not a call edge), or `"caller"` (an
   *  INCOMING call edge — a symbol that CALLS the target, opt-in via
   *  {@link ContextPackOptions.maxCallers}; surfaces load-bearing code supplied
   *  by the caller, e.g. a lambda passed to a higher-order target). */
  via?: "call" | "ref" | "caller";
  /** For a `"call"` neighbor: total call occurrences from the target into this
   *  symbol. For a `"caller"` neighbor: the incoming call edge weight. Absent for
   *  `"ref"` neighbors. */
  weight?: number;
  /** For a `"ref"` neighbor that was capped to the first N lines of its entity:
   *  the entity's TRUE last line (so callers can tell the slice is a head-of-body
   *  excerpt). Absent when the ref was included whole (or for non-ref slices). */
  truncatedFromEndLine?: number;
}

/** The assembled context pack for a symbol. */
export interface ContextPack {
  /** The resolved target node id. */
  symbol: string;
  /** The chosen id when `rawId` was fuzzy-resolved via the top FTS hit;
   *  `null` when it matched exactly (mirrors the `refs`/`impact` shape). */
  resolved: string | null;
  /** The slices, in pack order: header, target, then neighbors. */
  slices: ContextSlice[];
  /** Total source lines across all slices. */
  lineCount: number;
  /** Approximate token count (≈ chars/4 — a tokenizer-robust proxy, NOT exact;
   *  the cl100k ratios in the pivot measurement were within a few % of this). */
  estTokens: number;
  /** Non-fatal notes (e.g. a neighbor whose file couldn't be read). */
  notes: string[];
  /** Approximate token count of the target's WHOLE file (same `estimateTokens`
   *  chars/4 proxy as {@link estTokens}). `0` when the target has no readable
   *  file. The honest yardstick for {@link worthwhile}. */
  targetFileEstTokens: number;
  /** `true` when the pack is strictly smaller than just opening the target's
   *  whole file (`estTokens < targetFileEstTokens`); `false` when the pack is
   *  no smaller — i.e. shipping it buys nothing over the file. `true` when the
   *  target has no readable file (nothing better to fall back to). */
  worthwhile: boolean;
  /** LANE 3 (only set by {@link buildContextPackForChange}): `true` when the
   *  assembled pack was NOT smaller than the whole file, so the packer fell
   *  through and returned the whole file as a single slice instead — the
   *  never-worse-than-reading-the-file guarantee. Absent/false otherwise. */
  fellBackToWholeFile?: boolean;
}

/** Options for {@link buildContextPack}. */
export interface ContextPackOptions {
  /** Include 1-hop callee neighbors (default true). */
  neighbors?: boolean;
  /** Max neighbor slices, highest call-weight first (default 10). */
  maxNeighbors?: number;
  /** Max lines pulled into the module-scope header (default 120). */
  maxHeaderLines?: number;
  /** For `via:"ref"` neighbors that ARE included: cap the slice to the first N
   *  lines of the entity (default {@link DEFAULT_MAX_REF_SLICE_LINES}). Shows the
   *  declaration + opening shape (interface fields / member signatures) without
   *  deep method bodies. Does NOT affect callee (`via:"call"`) or target slices,
   *  and does NOT change the {@link MAX_REF_LINES} skip-entirely gate. */
  maxRefSliceLines?: number;
  /** OPT-IN 1-hop CALLER hop: max INCOMING-caller neighbors to inline (default
   *  `0` = no caller hop, so the pack is byte-identical to the pre-caller-hop
   *  behavior). When `> 0`, AFTER the callee + referenced-entity passes, up to
   *  this many symbols that CALL the target (incoming `isCallKind` edges) are
   *  added as `via:"caller"` slices, ranked by edge weight desc then id asc, with
   *  the SAME dangler/module/test/overlap/dedupe guards as the callee pass. This
   *  recovers cases where the target's real behavior is supplied by its caller (a
   *  higher-order function given a lambda, a callback wired at the call site) —
   *  for the escalation/sufficiency path, not the lean default pack. */
  maxCallers?: number;
  /** OPT-IN cross-file imported-symbol inclusion (default `false`). When `true`,
   *  identifiers NAMED in the target body that are imported from a local file but
   *  are NOT indexed nodes (a `const HANDLERS = {…}` dispatch table, a `CONFIG`
   *  object, a `type` alias) are extracted from their source file and added as
   *  `via:"ref"` slices — the cross-file non-node definitions the §4 ref pass
   *  (nodes only) structurally misses. Heuristic + bounded (see
   *  `imported_symbol.ts`); off by default so the lean pack stays byte-identical —
   *  for the escalation/sufficiency path. */
  importedSymbols?: boolean;
}

const DEFAULT_MAX_NEIGHBORS = 10;
/** Default for {@link ContextPackOptions.maxCallers}: `0` = NO caller hop. This
 *  is what keeps the default pack byte-identical to the pre-caller-hop behavior —
 *  the caller pass is skipped entirely unless the caller explicitly opts in. */
const DEFAULT_MAX_CALLERS = 0;
const DEFAULT_MAX_HEADER_LINES = 120;
/** A referenced entity (a type/class named in the target) is only inlined when
 *  its body is at most this many lines. A small interface/type alias is useful
 *  context; a 500-line class used merely as a parameter type would dominate the
 *  pack and defeat the slicing — the import line in the header already names it. */
const MAX_REF_LINES = 40;
/** A `via:"ref"` neighbor that IS included (body ≤ {@link MAX_REF_LINES}) is
 *  capped to this many LEADING lines — the declaration + opening shape (interface
 *  fields / class member signatures) — so a referenced type contributes its
 *  signature surface, not its deep method bodies. Line-exact: the slice is the
 *  real file lines `[start .. start+N-1]`; truncation is recorded in `notes`
 *  (and on the slice's `truncatedFromEndLine`), never injected into `text`.
 *  Overridable per call via `opts.maxRefSliceLines`. */
const DEFAULT_MAX_REF_SLICE_LINES = 12;

/** ≈4 chars/token — the cheap, tokenizer-robust proxy the pivot used to report
 *  ratios. Exact counts need a tokenizer; ratios hold either way. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** One contiguous run of module-scope lines (the "header"). */
interface Segment {
  start: number;
  end: number;
  text: string;
}

/**
 * Whether `line` is a "leading-decoration" line — a comment, attribute, or
 * decorator that, when it sits immediately above an entity, BELONGS to that
 * entity (Go/Rust/Python doc comments, Rust `#[...]` attributes, Python `@deco`
 * decorators) even though tree-sitter's node range starts at the `func`/`def`/
 * `fn` keyword and excludes it. The module-skeleton pass subtracts entity
 * BODIES; without absorbing these, every excluded entity's doc-comment block
 * leaks into the header as a junk fragment (measured: httprouter's `ServeHTTP`
 * pack carried 19 header slices that were almost entirely OTHER methods' doc
 * comments). Language-agnostic by line shape — no parser dependency.
 */
function isLeadingDecoration(line: string): boolean {
  const t = line.trim();
  if (t === "") return true; // blank line between a comment block and its entity
  return (
    t.startsWith("//") || // Go / Rust line comment
    t.startsWith("#[") || // Rust attribute
    t.startsWith("#!") || // Rust inner attribute / shebang
    t.startsWith("#") || // Python comment / Python decorator is `@` (below)
    t.startsWith("@") || // Python / TS decorator
    t.startsWith("/*") || // C-style block comment open
    t.startsWith("*/") || // block comment close
    t.startsWith("*") || // block-comment continuation / Rust `///`-adjacent
    t.startsWith("///") || // Rust doc comment
    t.startsWith("//!") // Rust inner doc comment
  );
}

/**
 * The file's MODULE SKELETON / FRAME: every top-level line that is NOT inside
 * any entity's body — imports, module-level `const`/`type`/`enum` declarations,
 * re-exports, the module docstring, the shell around functions. Returned as the
 * contiguous, non-blank runs left after subtracting EVERY entity body in the
 * file (including any in `subtractIds`, which the single-symbol header path also
 * passes the target through — it then re-adds the target separately as the
 * target slice).
 *
 * Why this and not just the leading import block: a target function routinely
 * references **module-level constants/types that are neither call edges nor
 * imports** (e.g. `const ENCODINGS = {…}` used inside the function). The old
 * import-only header omitted them, and an answerer given the slice would
 * hallucinate definitions for symbols that already existed (measured — see
 * `bench/context-pack-measure.ts` and `docs/PHASE_0.0.4.5_PIVOT.md` §5). The
 * skeleton captures them while STILL excluding every function body, so it stays
 * far smaller than the whole file. With no anchor (`anchorRanges` empty), the
 * whole frame is returned: every module-scope line, no entity bodies — exactly
 * the surface a module-level change (imports, `__all__`, module constants)
 * lands in.
 *
 * When the skeleton exceeds `maxLines`, the runs FARTHEST from the nearest
 * anchor (a target/root body) are dropped first (nearer module-scope context is
 * likelier relevant). With no anchors, the LAST runs are dropped first.
 *
 * @param subtractIds entity ids whose bodies to subtract — for the header path,
 *   the SET of "frame complement" entities (everything not re-added as a target).
 *   Every non-module node in the file is subtracted regardless; this set is the
 *   same node id(s) the caller will re-add as target slices, and is used only to
 *   anchor the distance-based trimming (their ranges are the anchors).
 */
function computeModuleScope(
  db: Db,
  file: string,
  lines: string[],
  opts: { anchorRanges?: Array<[number, number]>; maxLines: number },
): Segment[] {
  const { maxLines } = opts;
  const anchorRanges = opts.anchorRanges ?? [];
  const n = lines.length;
  const covered = new Uint8Array(n + 2);
  const mark = (s: number, e: number): void => {
    for (let l = Math.max(1, s); l <= Math.min(n, e); l++) covered[l] = 1;
  };
  /** Extend `start` upward over the contiguous block of comment/attribute/
   *  decorator/blank lines immediately above an entity — those decorations
   *  belong to it, not to module scope, so they must be subtracted from the
   *  header too (else every excluded entity's doc-comment leaks in). Stops at
   *  the first non-decoration line or another entity's body. Returns the
   *  absorbed start line. */
  const withLeadingDecoration = (start: number): number => {
    let s = start;
    while (s - 1 >= 1 && !covered[s - 1] && isLeadingDecoration(lines[s - 2] ?? "")) {
      s--;
    }
    return s;
  };

  // Subtract EVERY non-module entity body in the file (frame = everything left).
  // The single-symbol header path subtracts its target here too and re-adds it
  // separately as the target slice — byte-identical to the prior behavior.
  const rows = db.handle
    .query<
      { id: string; kind: string; range_start: number; range_end: number },
      [string]
    >("SELECT id, kind, range_start, range_end FROM nodes WHERE file = ?")
    .all(file);
  for (const r of rows) {
    if (r.kind === "module") continue;
    mark(withLeadingDecoration(r.range_start), r.range_end);
  }

  const segs: Segment[] = [];
  let l = 1;
  while (l <= n) {
    if (covered[l]) {
      l++;
      continue;
    }
    const start = l;
    while (l <= n && !covered[l]) l++;
    const end = l - 1;
    const text = lines.slice(start - 1, end).join("\n");
    if (text.trim() !== "") segs.push({ start, end, text });
  }

  let total = segs.reduce((a, s) => a + (s.end - s.start + 1), 0);
  if (total > maxLines) {
    // Distance to the NEAREST anchor range (a target/root body). With no
    // anchors, sort by position so the trailing runs drop first.
    const dist = (s: Segment): number => {
      if (anchorRanges.length === 0) return s.start;
      let best = Infinity;
      for (const [as, ae] of anchorRanges) {
        const d = s.end < as ? as - s.end : s.start > ae ? s.start - ae : 0;
        if (d < best) best = d;
      }
      return best;
    };
    const drop = new Set<Segment>();
    for (const s of [...segs].sort((a, b) => dist(b) - dist(a))) {
      if (total <= maxLines) break;
      drop.add(s);
      total -= s.end - s.start + 1;
    }
    return segs.filter((s) => !drop.has(s));
  }
  return segs;
}

/**
 * The target file's MODULE SKELETON anchored to a single target — every
 * top-level line outside an entity body, with the distance-based trimming
 * anchored to the target's range. Thin wrapper over {@link computeModuleScope};
 * preserves the exact single-symbol header behavior byte-for-byte.
 */
function moduleScopeSegments(
  db: Db,
  target: NodeRow,
  lines: string[],
  maxLines: number,
): Segment[] {
  return computeModuleScope(db, target.file ?? "", lines, {
    anchorRanges: [[target.range_start, target.range_end]],
    maxLines,
  });
}

/** A tiny per-call file cache: neighbors frequently share the target's file, so
 *  read each file at most once. Returns the file's lines, or `null` if it can't
 *  be read (deleted, binary, outside the repo). */
function makeFileReader(repoRoot: string) {
  const cache = new Map<string, string[] | null>();
  return (file: string): string[] | null => {
    if (cache.has(file)) return cache.get(file) ?? null;
    let lines: string[] | null = null;
    try {
      const abs = isAbsolute(file) ? file : join(repoRoot, file);
      lines = readFileSync(abs, "utf8").split("\n");
    } catch {
      lines = null;
    }
    cache.set(file, lines);
    return lines;
  };
}

/** Slice a node's body out of its file using its 1-based inclusive line range.
 *  Returns `null` when the node has no file, the file can't be read, or the
 *  range is degenerate. */
function sliceNode(
  node: NodeRow,
  role: ContextSlice["role"],
  read: (file: string) => string[] | null,
): ContextSlice | null {
  if (!node.file) return null;
  const lines = read(node.file);
  if (!lines) return null;
  const start = Math.max(1, node.range_start);
  const end = Math.min(lines.length, node.range_end);
  if (end < start) return null;
  const text = lines.slice(start - 1, end).join("\n");
  return {
    role,
    id: node.id,
    kind: node.kind,
    file: node.file,
    startLine: start,
    endLine: end,
    text,
  };
}

/** Whether a node is a whole-file "module" entity whose body is the entire file
 *  — we never inline these as neighbors (that defeats the slicing). */
function isModuleNode(node: NodeRow): boolean {
  return node.kind === "module";
}

/** Whether a node KIND is a "type-like" declaration — a class/interface/struct/
 *  enum/type-alias, all of which the parser emits as `kind:"class"` across the
 *  supported languages. These are the only entities the REFERENCED-entity pass
 *  (§4) should inline: the pass exists to surface a TYPE named in the target's
 *  signature whose body is neither a callee nor an import line. Methods and
 *  free functions are excluded — admitting them matched any same-file symbol
 *  that merely shared a common name with the target (sibling `convert`/`from`/
 *  `is` methods), which is noise, not a referenced type. */
function isTypeLikeKind(kind: string): boolean {
  return kind === "class";
}

/** Whether `n`'s line range overlaps `target`'s in the SAME file — i.e. `n` is
 *  nested inside (or straddles) the target body, so its text is already in the
 *  target slice and must not be added again as a neighbor. */
function overlapsTarget(n: NodeRow, target: NodeRow): boolean {
  return (
    n.file === target.file &&
    n.range_start <= target.range_end &&
    n.range_end >= target.range_start
  );
}

/** Whether a file is a test/spec file. Source never legitimately *depends on* a
 *  test, so a call edge resolving into one is noise (an ambiguous-name
 *  mis-resolution) — we exclude such neighbors when the target is real source. */
function isTestFile(file: string | null): boolean {
  return (
    !!file && (/\.(test|spec)\.[cm]?[tj]sx?$/.test(file) || /(^|\/)__tests__\//.test(file))
  );
}

/** True when `name` appears as a whole identifier in `text` (so `Foo` does not
 *  match `Foobar`/`barFoo`). Identifier-boundary lookaround rather than `\b` so
 *  `$`-containing identifiers behave; `name` is regex-escaped defensively. */
function referencesName(text: string, name: string): boolean {
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(text);
}

/**
 * Assemble the minimal precise context pack for a symbol.
 *
 * Returns `null` only when the symbol can't be resolved to any node at all.
 * Individual slices that can't be produced (unreadable file, module neighbor)
 * are skipped with a note rather than failing the whole pack.
 */
export function buildContextPack(
  db: Db,
  repoRoot: string,
  rawId: string,
  opts: ContextPackOptions = {},
): ContextPack | null {
  const includeNeighbors = opts.neighbors !== false;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;
  const maxHeaderLines = opts.maxHeaderLines ?? DEFAULT_MAX_HEADER_LINES;
  const maxRefSliceLines = opts.maxRefSliceLines ?? DEFAULT_MAX_REF_SLICE_LINES;
  const maxCallers = opts.maxCallers ?? DEFAULT_MAX_CALLERS;
  const importedSymbols = opts.importedSymbols === true;

  const resolved = resolveNodeId(db, rawId);
  if (!resolved) return null;
  const target = db.getNode(resolved.id);
  if (!target) return null;

  const read = makeFileReader(repoRoot);
  const slices: ContextSlice[] = [];
  const notes: string[] = [];

  // 1. HEADER — the target file's MODULE SKELETON (imports + module-level
  //    const/type declarations + the shell around entities), i.e. every
  //    top-level line outside another entity's body. Emitted as one header
  //    slice per contiguous run so line numbers stay exact. Captures the
  //    module-scope symbols the target references that are neither callees nor
  //    imports (the boundary the §5 measurement found).
  if (target.file) {
    const lines = read(target.file);
    if (lines) {
      for (const seg of moduleScopeSegments(db, target, lines, maxHeaderLines)) {
        slices.push({
          role: "header",
          id: null,
          kind: "header",
          file: target.file,
          startLine: seg.start,
          endLine: seg.end,
          text: seg.text,
        });
      }
    } else {
      notes.push(`could not read target file \`${target.file}\``);
    }
  }

  // 2. TARGET — the entity body.
  const targetSlice = sliceNode(target, "target", read);
  if (targetSlice) slices.push(targetSlice);
  else notes.push(`could not slice target body for \`${target.id}\``);

  // 3. NEIGHBORS — 1-hop callee dependencies (outgoing call edges), highest
  //    call-weight first, deduped, modules excluded. A callee in another file
  //    arrives as its own line-exact body — the cross-file slice.
  if (includeNeighbors && maxNeighbors > 0) {
    const byCallee = new Map<string, number>();
    for (const e of db.outgoing(target.id)) {
      if (!isCallKind(e.kind) || e.dst === target.id) continue;
      byCallee.set(e.dst, (byCallee.get(e.dst) ?? 0) + e.weight);
    }
    const ranked = [...byCallee.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    let added = 0;
    for (const [calleeId, weight] of ranked) {
      if (added >= maxNeighbors) break;
      const callee = db.getNode(calleeId);
      // Skip danglers (edge to an unresolved id), whole-file modules, and
      // call edges that mis-resolved into a test file (not a real dependency).
      if (!callee || isModuleNode(callee)) continue;
      if (isTestFile(callee.file) && !isTestFile(target.file)) continue;
      if (overlapsTarget(callee, target)) continue; // nested in target → already shown
      const slice = sliceNode(callee, "neighbor", read);
      if (!slice) continue;
      slice.via = "call";
      slice.weight = weight;
      slices.push(slice);
      added++;
    }
    if (ranked.length > added) {
      notes.push(
        `${ranked.length - added} more callee(s) omitted (cap ${maxNeighbors}, or unresolved/module)`,
      );
    }
    // Note import edges deliberately: the header already carries the import
    // statements textually, so we don't inline imported modules' bodies.
    void IMPORT_KIND;
  }

  // 4. REFERENCED ENTITIES — indexed entities (types/interfaces/classes/
  //    functions) NAMED in the target body but not already included as callees.
  //    Types aren't call edges and the skeleton subtracts entity bodies, so a
  //    target whose signature uses a type (a same-file `ServeStaticOptions` OR
  //    an imported `MiddlewareHandler`) would otherwise lack its definition.
  //    Same-file refs run first, then cross-file (resolved via the file's
  //    module-import edges → imported module files). Shared `maxNeighbors` cap.
  if (includeNeighbors && maxNeighbors > 0 && target.file) {
    const addedIds = new Set(
      slices.map((s) => s.id).filter((x): x is string => x !== null),
    );
    const targetText = targetSlice?.text ?? "";
    let refAdded = 0;
    /** Try to add one entity row as a `via:"ref"` neighbor; returns true if added. */
    const tryAddRef = (r: { id: string; name: string; kind: string }): boolean => {
      if (r.id === target.id || r.kind === "module") return false;
      // ONLY type-like entities (classes/interfaces/structs/enums/type-aliases —
      // all `kind:"class"` in this schema) are valid refs. The ref pass exists to
      // surface a TYPE named in the target's signature/body whose definition is
      // neither a callee nor an import-statement line. Admitting `method`/
      // `function` entities here matched any same-file symbol that merely SHARES
      // a common name with the target (e.g. nine sibling `convert` methods for a
      // target also named `convert`, or `from`/`is`/`drop` in Rust) — pure noise,
      // since real calls already arrive via the callee pass. (Measured: this
      // dropped 8–10 junk ref slices per pack on click/anyhow.)
      if (!isTypeLikeKind(r.kind)) return false;
      if (addedIds.has(r.id)) return false;
      if (!referencesName(targetText, r.name)) return false;
      const node = db.getNode(r.id);
      if (!node) return false;
      if (overlapsTarget(node, target)) return false; // nested in target → already shown
      if (isTestFile(node.file) && !isTestFile(target.file)) return false;
      // Skip huge entities (a big class used only as a type) — they'd dominate
      // the pack; the header's import line already names them.
      if (node.range_end - node.range_start + 1 > MAX_REF_LINES) return false;
      const slice = sliceNode(node, "neighbor", read);
      if (!slice) return false;
      slice.via = "ref";
      // Leaner ref slices: a referenced type contributes its declaration +
      // opening shape (interface fields / member signatures), not deep method
      // bodies. Cap to the FIRST N lines of the entity, LINE-EXACT — the slice
      // text stays the real file lines [startLine .. startLine+N-1]; the
      // truncation is recorded in notes + on the slice, never inside text.
      // (Never applies to callee/target slices; composes with the MAX_REF_LINES
      // skip-entirely gate above — only refs that ARE included are capped.)
      const fullEnd = slice.endLine;
      const sliceLen = slice.endLine - slice.startLine + 1;
      if (sliceLen > maxRefSliceLines) {
        const newEnd = slice.startLine + maxRefSliceLines - 1;
        const lines = read(node.file ?? "");
        if (lines) {
          slice.endLine = newEnd;
          slice.text = lines.slice(slice.startLine - 1, newEnd).join("\n");
          slice.truncatedFromEndLine = fullEnd;
          notes.push(
            `ref \`${r.id}\` truncated to first ${maxRefSliceLines} of ${sliceLen} lines`,
          );
        }
      }
      slices.push(slice);
      addedIds.add(r.id);
      refAdded++;
      return true;
    };
    const entitiesIn = (file: string) =>
      db.handle
        .query<{ id: string; name: string; kind: string }, [string]>(
          "SELECT id, name, kind FROM nodes WHERE file = ?",
        )
        .all(file)
        .sort((a, b) => a.id.localeCompare(b.id));

    // 4a. Same-file referenced entities.
    for (const r of entitiesIn(target.file)) {
      if (refAdded >= maxNeighbors) break;
      tryAddRef(r);
    }

    // 4b. Cross-file referenced entities: resolve the target file's module node,
    //     follow its import edges to imported module files, and inline any entity
    //     therein named in the target body (e.g. an imported type used in the
    //     signature). Each imported entity comes in as its own line-exact body.
    if (refAdded < maxNeighbors) {
      const moduleNode = db.handle
        .query<{ id: string }, [string]>(
          "SELECT id FROM nodes WHERE file = ? AND kind = 'module' LIMIT 1",
        )
        .get(target.file);
      if (moduleNode) {
        const importedFiles = new Set<string>();
        for (const e of db.outgoing(moduleNode.id)) {
          if (e.kind !== IMPORT_KIND) continue;
          const imp = db.getNode(e.dst);
          if (imp?.file && imp.file !== target.file) importedFiles.add(imp.file);
        }
        for (const f of [...importedFiles].sort()) {
          if (refAdded >= maxNeighbors) break;
          for (const r of entitiesIn(f)) {
            if (refAdded >= maxNeighbors) break;
            tryAddRef(r);
          }
        }
      }
    }
  }

  // 5. CALLERS — OPT-IN 1-hop INCOMING-caller neighbors (default OFF). Mirrors
  //    the §3 callee pass exactly — same dangler/module/test/overlap guards,
  //    same weight-desc-then-id-asc ranking — but over `db.incoming` (symbols
  //    that CALL the target) and tagged `via:"caller"`. This recovers the case
  //    the callee/ref passes structurally CAN'T: a target whose load-bearing
  //    behavior is supplied BY its caller (a higher-order function handed a
  //    lambda, a callback wired at the call site). Dedupes by id against every
  //    slice already added (header has id:null, so only target/callee/ref ids
  //    collide). Skipped entirely when maxCallers is 0/undefined → the default
  //    pack is byte-identical to the pre-caller-hop behavior.
  if (maxCallers > 0) {
    const addedIds = new Set(
      slices.map((s) => s.id).filter((x): x is string => x !== null),
    );
    const byCaller = new Map<string, number>();
    for (const e of db.incoming(target.id)) {
      if (!isCallKind(e.kind) || e.src === target.id) continue;
      byCaller.set(e.src, (byCaller.get(e.src) ?? 0) + e.weight);
    }
    const ranked = [...byCaller.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    let added = 0;
    for (const [callerId, weight] of ranked) {
      if (added >= maxCallers) break;
      const caller = db.getNode(callerId);
      // Same guards as the callee pass: skip danglers (edge from an unresolved
      // id), whole-file modules, call edges from a test file (not a real
      // dependency when the target is real source), and any caller already in
      // the slice set (dedupe by id against everything added so far).
      if (!caller || isModuleNode(caller)) continue;
      if (isTestFile(caller.file) && !isTestFile(target.file)) continue;
      if (overlapsTarget(caller, target)) continue; // straddles target → already shown
      if (addedIds.has(callerId)) continue; // already a target/callee/ref slice
      const slice = sliceNode(caller, "neighbor", read);
      if (!slice) continue;
      slice.via = "caller";
      slice.weight = weight;
      slices.push(slice);
      addedIds.add(callerId);
      added++;
    }
    if (ranked.length > added) {
      notes.push(
        `${ranked.length - added} more caller(s) omitted (cap ${maxCallers}, or unresolved/module/dup)`,
      );
    }
  }

  // 6. IMPORTED SYMBOLS — OPT-IN cross-file non-node definitions (default OFF).
  //    The §4 ref pass only inlines indexed type-like NODES; a target that names
  //    an imported `const`/object/`type` (a dispatch table, a CONFIG) defined in
  //    another file has no node, so it's invisible to every rung. When opted in,
  //    `collectImportedSymbols` text-extracts those declarations from the target
  //    file's imported source files and returns them as `via:"ref"` slices.
  //    Skipped entirely when off → the default pack is byte-identical.
  if (importedSymbols && target.file) {
    const addedIds = new Set(
      slices.map((s) => s.id).filter((x): x is string => x !== null),
    );
    const extra = collectImportedSymbols(
      db,
      repoRoot,
      target,
      targetSlice?.text ?? "",
      addedIds,
      { maxSymbols: maxNeighbors },
    );
    for (const s of extra) slices.push(s);
    if (extra.length > 0) {
      notes.push(`+${extra.length} cross-file imported symbol(s) (opt-in)`);
    }
  }

  let lineCount = 0;
  let chars = 0;
  for (const s of slices) {
    lineCount += s.endLine - s.startLine + 1;
    chars += s.text.length;
  }
  const estTokens = estimateTokens(chars);

  // "Worthwhile" signal — an honest, additive check that the precise pack is
  // actually cheaper than just opening the target's WHOLE file. We measured
  // packs that come out >= the file (a heavily-referenced target), where
  // shipping the pack buys nothing. Same chars/4 proxy as estTokens. When the
  // target has no readable file there's nothing better to fall back to → 0/true.
  let targetFileEstTokens = 0;
  if (target.file) {
    const lines = read(target.file);
    if (lines) targetFileEstTokens = estimateTokens(lines.join("\n").length);
  }
  const worthwhile = targetFileEstTokens === 0 || estTokens < targetFileEstTokens;
  if (!worthwhile) {
    notes.push(
      `pack (~${estTokens} tok) is not smaller than the target file (~${targetFileEstTokens} tok) — consider using the whole file`,
    );
  }

  return {
    symbol: target.id,
    resolved: resolved.resolved ? target.id : null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
  };
}

/** Compute lineCount / estTokens / targetFileEstTokens / worthwhile for an
 *  assembled slice set, the SAME way {@link buildContextPack} does, and tack on
 *  the not-worthwhile note. `anchorFile` is the file whose whole-file token
 *  count is the worthwhile yardstick (the first root's file). */
function finalizePack(
  slices: ContextSlice[],
  notes: string[],
  read: (file: string) => string[] | null,
  anchorFile: string | null,
): {
  lineCount: number;
  estTokens: number;
  targetFileEstTokens: number;
  worthwhile: boolean;
} {
  let lineCount = 0;
  let chars = 0;
  for (const s of slices) {
    lineCount += s.endLine - s.startLine + 1;
    chars += s.text.length;
  }
  const estTokens = estimateTokens(chars);
  let targetFileEstTokens = 0;
  if (anchorFile) {
    const lines = read(anchorFile);
    if (lines) targetFileEstTokens = estimateTokens(lines.join("\n").length);
  }
  const worthwhile = targetFileEstTokens === 0 || estTokens < targetFileEstTokens;
  if (!worthwhile) {
    notes.push(
      `pack (~${estTokens} tok) is not smaller than the target file (~${targetFileEstTokens} tok) — consider using the whole file`,
    );
  }
  return { lineCount, estTokens, targetFileEstTokens, worthwhile };
}

/**
 * LANE 1 — the file's MODULE FRAME: the contiguous runs of top-level lines NOT
 * inside ANY entity body (functions/methods/classes) — imports, module-level
 * assignments, `__all__`, the module docstring, the shell. This is exactly
 * {@link computeModuleScope} with NO single target (every entity body is
 * subtracted; nothing is re-added as a "target").
 *
 * Closes the **MISS_MODULE_LEVEL** caveat: a change to a module-scope line
 * (an import, `MAC = sys.platform...`, `__all__`, a module constant) has no
 * enclosing entity, so {@link buildContextPack} on the "smallest enclosing
 * entity" misses it. The module frame IS that surface — the changed module-scope
 * lines fall inside the frame.
 *
 * Slices have role `"module-frame"`. estTokens/lineCount/targetFileEstTokens/
 * worthwhile are computed identically to {@link buildContextPack}. Returns null
 * only when the file can't be read (nothing to frame).
 */
export function buildModuleFrame(
  db: Db,
  repoRoot: string,
  file: string,
  opts: { maxLines?: number; anchorRanges?: Array<[number, number]> } = {},
): ContextPack | null {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_HEADER_LINES;
  const read = makeFileReader(repoRoot);
  const lines = read(file);
  if (!lines) return null;

  const slices: ContextSlice[] = [];
  const notes: string[] = [];
  // With no anchor → the whole module frame; trimming (if over maxLines) drops
  // trailing runs first. With anchor ranges (the changed regions), trimming
  // keeps the module-scope runs NEAREST the change — so a small inter-entity gap
  // line a straddle change touches is retained instead of trimmed away.
  for (const seg of computeModuleScope(db, file, lines, {
    maxLines,
    anchorRanges: opts.anchorRanges,
  })) {
    slices.push({
      role: "module-frame",
      id: null,
      kind: "module-frame",
      file,
      startLine: seg.start,
      endLine: seg.end,
      text: seg.text,
    });
  }
  const { lineCount, estTokens, targetFileEstTokens, worthwhile } = finalizePack(
    slices,
    notes,
    read,
    file,
  );
  return {
    symbol: file,
    resolved: null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
  };
}

/**
 * LANE 2 — a MULTI-ROOT context pack: the union of each resolved root's TARGET
 * slice + its 1-hop callee/ref dependencies, DEDUPED across roots (by node id
 * AND by overlapping (file,range) so a callee that is also a root isn't
 * double-included), with ONE shared module skeleton per file (the skeleton
 * subtracts ALL entity bodies; each root is added back as its own target slice).
 *
 * Closes the **MISS_STRADDLE** caveat: a change spanning/adding multiple
 * entities has no single enclosing entity, but IS covered when every straddled
 * entity is a root. Ranking/caps: `maxNeighbors` applies across the COMBINED dep
 * set (not per-root) so the pack stays bounded. Deterministic order: roots in
 * input order, then deps weight-desc then id-asc. The dangler/module/test/
 * overlap guards from {@link buildContextPack} are reused.
 *
 * Returns null only if NO id resolves. A single-element `rawIds` produces a pack
 * equivalent to {@link buildContextPack} for that id.
 */
export function buildContextPackForSymbols(
  db: Db,
  repoRoot: string,
  rawIds: string[],
  opts: ContextPackOptions = {},
): ContextPack | null {
  const includeNeighbors = opts.neighbors !== false;
  const maxNeighbors = opts.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;
  const maxHeaderLines = opts.maxHeaderLines ?? DEFAULT_MAX_HEADER_LINES;
  const maxRefSliceLines = opts.maxRefSliceLines ?? DEFAULT_MAX_REF_SLICE_LINES;

  const read = makeFileReader(repoRoot);
  const slices: ContextSlice[] = [];
  const notes: string[] = [];

  // Resolve roots, preserving input order, deduped by node id.
  const roots: NodeRow[] = [];
  const rootIds = new Set<string>();
  for (const raw of rawIds) {
    const resolved = resolveNodeId(db, raw);
    if (!resolved) continue;
    if (rootIds.has(resolved.id)) continue;
    const node = db.getNode(resolved.id);
    if (!node) continue;
    rootIds.add(resolved.id);
    roots.push(node);
  }
  if (roots.length === 0) return null;

  // Group roots by file so each file gets ONE shared module skeleton (subtract
  // ALL entity bodies; the roots in that file are re-added as target slices).
  const rootsByFile = new Map<string, NodeRow[]>();
  for (const r of roots) {
    if (!r.file) continue;
    if (!rootsByFile.has(r.file)) rootsByFile.set(r.file, []);
    rootsByFile.get(r.file)!.push(r);
  }

  // 1. SHARED MODULE SKELETON per file (header runs). Anchored to ALL the file's
  //    roots so trimming keeps runs near any root.
  // 2. TARGET slices — every root's body, in input order.
  // To keep header-then-target-then-neighbors order AND group per file the way
  // buildContextPack does (header[file], target, …), we emit per-file headers
  // first, then targets in input order, then the combined neighbor set.
  for (const [file, fileRoots] of rootsByFile) {
    const lines = read(file);
    if (!lines) {
      notes.push(`could not read root file \`${file}\``);
      continue;
    }
    const anchorRanges = fileRoots.map(
      (r): [number, number] => [r.range_start, r.range_end],
    );
    for (const seg of computeModuleScope(db, file, lines, {
      anchorRanges,
      maxLines: maxHeaderLines,
    })) {
      slices.push({
        role: "header",
        id: null,
        kind: "header",
        file,
        startLine: seg.start,
        endLine: seg.end,
        text: seg.text,
      });
    }
  }

  // TARGET slices in INPUT order.
  const targetSlices = new Map<string, ContextSlice>();
  for (const root of roots) {
    const slice = sliceNode(root, "target", read);
    if (slice) {
      slices.push(slice);
      targetSlices.set(root.id, slice);
    } else {
      notes.push(`could not slice target body for \`${root.id}\``);
    }
  }

  // Dedupe set: every id already a slice (roots), plus an (file,range) overlap
  // test so a callee that IS a root (or nested in one) is not re-added.
  const addedIds = new Set<string>(rootIds);
  const overlapsAnyRoot = (n: NodeRow): boolean =>
    roots.some((r) => overlapsTarget(n, r));

  if (includeNeighbors && maxNeighbors > 0) {
    // 3. NEIGHBORS — 1-hop callee deps across ALL roots, weight-summed, ranked
    //    weight-desc then id-asc, ONE shared cap.
    const byCallee = new Map<string, number>();
    for (const root of roots) {
      for (const e of db.outgoing(root.id)) {
        if (!isCallKind(e.kind) || rootIds.has(e.dst)) continue;
        byCallee.set(e.dst, (byCallee.get(e.dst) ?? 0) + e.weight);
      }
    }
    const ranked = [...byCallee.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    let added = 0;
    for (const [calleeId, weight] of ranked) {
      if (added >= maxNeighbors) break;
      if (addedIds.has(calleeId)) continue;
      const callee = db.getNode(calleeId);
      if (!callee || isModuleNode(callee)) continue;
      if (isTestFile(callee.file) && !roots.some((r) => isTestFile(r.file))) continue;
      if (overlapsAnyRoot(callee)) continue; // nested in/overlapping a root → already shown
      const slice = sliceNode(callee, "neighbor", read);
      if (!slice) continue;
      slice.via = "call";
      slice.weight = weight;
      slices.push(slice);
      addedIds.add(calleeId);
      added++;
    }
    if (ranked.length > added) {
      notes.push(
        `${ranked.length - added} more callee(s) omitted (cap ${maxNeighbors}, or unresolved/module/dup)`,
      );
    }

    // 4. REFERENCED ENTITIES — type-like entities named in ANY root body but not
    //    already included. Same-file then cross-file; shared cap with callees is
    //    NOT applied (mirrors buildContextPack, which gives refs their own
    //    maxNeighbors budget). Dedupe across roots via addedIds.
    const combinedTargetText = roots
      .map((r) => targetSlices.get(r.id)?.text ?? "")
      .join("\n");
    let refAdded = 0;
    const tryAddRef = (r: { id: string; name: string; kind: string }): boolean => {
      if (rootIds.has(r.id) || r.kind === "module") return false;
      if (!isTypeLikeKind(r.kind)) return false;
      if (addedIds.has(r.id)) return false;
      if (!referencesName(combinedTargetText, r.name)) return false;
      const node = db.getNode(r.id);
      if (!node) return false;
      if (overlapsAnyRoot(node)) return false;
      if (isTestFile(node.file) && !roots.some((rr) => isTestFile(rr.file))) return false;
      if (node.range_end - node.range_start + 1 > MAX_REF_LINES) return false;
      const slice = sliceNode(node, "neighbor", read);
      if (!slice) return false;
      slice.via = "ref";
      const fullEnd = slice.endLine;
      const sliceLen = slice.endLine - slice.startLine + 1;
      if (sliceLen > maxRefSliceLines) {
        const newEnd = slice.startLine + maxRefSliceLines - 1;
        const lns = read(node.file ?? "");
        if (lns) {
          slice.endLine = newEnd;
          slice.text = lns.slice(slice.startLine - 1, newEnd).join("\n");
          slice.truncatedFromEndLine = fullEnd;
          notes.push(
            `ref \`${r.id}\` truncated to first ${maxRefSliceLines} of ${sliceLen} lines`,
          );
        }
      }
      slices.push(slice);
      addedIds.add(r.id);
      refAdded++;
      return true;
    };
    const entitiesIn = (file: string) =>
      db.handle
        .query<{ id: string; name: string; kind: string }, [string]>(
          "SELECT id, name, kind FROM nodes WHERE file = ?",
        )
        .all(file)
        .sort((a, b) => a.id.localeCompare(b.id));

    // 4a. Same-file refs — over each root file (deduped).
    for (const file of [...rootsByFile.keys()].sort()) {
      if (refAdded >= maxNeighbors) break;
      for (const r of entitiesIn(file)) {
        if (refAdded >= maxNeighbors) break;
        tryAddRef(r);
      }
    }
    // 4b. Cross-file refs via each root file's module-import edges.
    if (refAdded < maxNeighbors) {
      const importedFiles = new Set<string>();
      for (const file of rootsByFile.keys()) {
        const moduleNode = db.handle
          .query<{ id: string }, [string]>(
            "SELECT id FROM nodes WHERE file = ? AND kind = 'module' LIMIT 1",
          )
          .get(file);
        if (!moduleNode) continue;
        for (const e of db.outgoing(moduleNode.id)) {
          if (e.kind !== IMPORT_KIND) continue;
          const imp = db.getNode(e.dst);
          if (imp?.file && !rootsByFile.has(imp.file)) importedFiles.add(imp.file);
        }
      }
      for (const f of [...importedFiles].sort()) {
        if (refAdded >= maxNeighbors) break;
        for (const r of entitiesIn(f)) {
          if (refAdded >= maxNeighbors) break;
          tryAddRef(r);
        }
      }
    }
    void IMPORT_KIND;
  }

  const anchorFile = roots[0]?.file ?? null;
  const { lineCount, estTokens, targetFileEstTokens, worthwhile } = finalizePack(
    slices,
    notes,
    read,
    anchorFile,
  );
  return {
    symbol: roots.map((r) => r.id).join(","),
    resolved: null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
  };
}

/** A changed region in a file (1-based inclusive lines). */
export interface ChangeRegion {
  startLine: number;
  endLine: number;
}

/**
 * Convenience builder-facing "I'm changing these regions" API. Classifies each
 * region against the file's non-module entities:
 *
 *   - A region CONTAINED in a single entity → that entity (the SMALLEST
 *     enclosing node) is a root.
 *   - A region that STRADDLES (spans/adds across) >1 entity, or partly outside
 *     any entity → EVERY entity it overlaps becomes a root (the multi-root path
 *     covers each straddled body), and — if any line of the region also falls
 *     OUTSIDE every entity (true module scope) — the module frame is added too.
 *     This is what closes MISS_STRADDLE.
 *   - A region that overlaps NO entity at all (a pure module-level change:
 *     imports, `__all__`, a module constant) → "module-level", served by the
 *     module frame. This closes MISS_MODULE_LEVEL.
 *
 * The pack is {@link buildContextPackForSymbols} over the collected root entity
 * ids MERGED with {@link buildModuleFrame} IFF any region needs module scope.
 * Merged slices are deduped by (file,startLine,endLine). Returns null only when
 * nothing resolves (no entity root AND no readable module frame).
 */
export function buildContextPackForChange(
  db: Db,
  repoRoot: string,
  file: string,
  regions: ChangeRegion[],
  opts: ContextPackOptions = {},
): ContextPack | null {
  // Classify each region against the file's non-module nodes.
  const rows = db.handle
    .query<
      { id: string; kind: string; range_start: number; range_end: number },
      [string]
    >("SELECT id, kind, range_start, range_end FROM nodes WHERE file = ?")
    .all(file)
    .filter((r) => r.kind !== "module");
  const entityIds: string[] = [];
  const seen = new Set<string>();
  let anyModuleLevel = false;
  /** Mark every line in [lo,hi] that is NOT inside ANY entity → if any remains,
   *  the region touches true module scope and needs the frame. */
  const regionTouchesModuleScope = (lo: number, hi: number): boolean => {
    for (let L = lo; L <= hi; L++) {
      let inside = false;
      for (const r of rows) {
        if (r.range_start <= L && r.range_end >= L) {
          inside = true;
          break;
        }
      }
      if (!inside) return true;
    }
    return false;
  };
  for (const region of regions) {
    const lo = Math.min(region.startLine, region.endLine);
    const hi = Math.max(region.startLine, region.endLine);
    // (1) smallest entity that fully CONTAINS the region.
    let best: { id: string; span: number } | null = null;
    for (const r of rows) {
      if (r.range_start <= lo && r.range_end >= hi) {
        const span = r.range_end - r.range_start;
        if (!best || span < best.span) best = { id: r.id, span };
      }
    }
    if (best) {
      if (!seen.has(best.id)) {
        seen.add(best.id);
        entityIds.push(best.id);
      }
      continue;
    }
    // (2) STRADDLE / partial — every entity the region overlaps is a root.
    const overlapping = rows.filter(
      (r) => r.range_start <= hi && r.range_end >= lo,
    );
    for (const r of overlapping) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        entityIds.push(r.id);
      }
    }
    // (3) module scope — pure module-level (no overlap) OR a straddle whose span
    //     also covers lines outside every entity → also add the frame.
    if (overlapping.length === 0 || regionTouchesModuleScope(lo, hi)) {
      anyModuleLevel = true;
    }
  }

  const entityPack =
    entityIds.length > 0
      ? buildContextPackForSymbols(db, repoRoot, entityIds, opts)
      : null;
  const framePack = anyModuleLevel
    ? buildModuleFrame(db, repoRoot, file, {
        maxLines: opts.maxHeaderLines,
        // Anchor frame-trimming to the changed regions so the module-scope runs
        // a (straddle) change touches — e.g. a gap line between two entities —
        // are retained instead of trimmed away in a large file.
        anchorRanges: regions.map(
          (r): [number, number] => [
            Math.min(r.startLine, r.endLine),
            Math.max(r.startLine, r.endLine),
          ],
        ),
      })
    : null;

  if (!entityPack && !framePack) return null;

  // Merge: entity-pack slices first (header/target/neighbors), then the module
  // frame's runs that aren't already covered. Dedupe by (file,start,end).
  const read = makeFileReader(repoRoot);
  const slices: ContextSlice[] = [];
  const notes: string[] = [];
  const sliceKey = (s: ContextSlice): string => `${s.file}:${s.startLine}:${s.endLine}`;
  const seenSlices = new Set<string>();
  const pushAll = (pack: ContextPack | null): void => {
    if (!pack) return;
    for (const s of pack.slices) {
      const k = sliceKey(s);
      if (seenSlices.has(k)) continue;
      seenSlices.add(k);
      slices.push(s);
    }
    for (const n of pack.notes) if (!notes.includes(n)) notes.push(n);
  };
  pushAll(entityPack);
  pushAll(framePack);

  // GAP-FILL — a straddle region can sweep lines that live between two entities
  // and were absorbed as one entity's leading decoration (blank/comment lines
  // above a def), so they end up in neither a target slice nor the frame. Add
  // the minimal real-line runs needed to cover every changed region line, so the
  // pack is genuinely SUFFICIENT for the change. Line-exact (real file lines),
  // tagged "module-frame" (they're inter-entity module scope).
  const fileLines = read(file);
  if (fileLines) {
    const covered = (L: number): boolean =>
      slices.some((s) => s.file === file && s.startLine <= L && s.endLine >= L);
    const uncovered: number[] = [];
    for (const region of regions) {
      const lo = Math.min(region.startLine, region.endLine);
      const hi = Math.max(region.startLine, region.endLine);
      for (let L = lo; L <= hi; L++) {
        if (L >= 1 && L <= fileLines.length && !covered(L)) uncovered.push(L);
      }
    }
    uncovered.sort((a, b) => a - b);
    let i = 0;
    while (i < uncovered.length) {
      const start = uncovered[i]!;
      let end = start;
      while (i + 1 < uncovered.length && uncovered[i + 1] === end + 1) {
        end = uncovered[++i]!;
      }
      i++;
      const text = fileLines.slice(start - 1, end).join("\n");
      const k = `${file}:${start}:${end}`;
      if (!seenSlices.has(k)) {
        seenSlices.add(k);
        slices.push({
          role: "module-frame",
          id: null,
          kind: "module-frame",
          file,
          startLine: start,
          endLine: end,
          text,
        });
      }
    }
  }

  const anchorFile = entityPack?.slices[0]?.file ?? framePack?.slices[0]?.file ?? file;
  const fin = finalizePack(slices, notes, read, anchorFile);
  let { lineCount, estTokens, worthwhile } = fin;
  const targetFileEstTokens = fin.targetFileEstTokens;

  // LANE 3 — the never-worse-than-the-file guarantee. When the assembled pack is
  // NOT smaller than just reading the whole file (a change-set that spans most of
  // a small file), fall through and return the WHOLE FILE as a single slice. The
  // whole file is the minimal context that is still lossless + sufficient, and
  // this makes the builder contract unconditional: calling the packer is NEVER
  // worse than reading the file. By construction the returned pack is always
  // `estTokens <= targetFileEstTokens`.
  let fellBackToWholeFile = false;
  if (!worthwhile) {
    const lines = read(file);
    if (lines) {
      const text = lines.join("\n");
      slices.length = 0; // replace the (too-large) assembled slices in place
      slices.push({
        role: "target",
        id: null,
        kind: "whole-file",
        file,
        startLine: 1,
        endLine: lines.length,
        text,
      });
      lineCount = lines.length;
      estTokens = estimateTokens(text.length);
      worthwhile = false; // == the file: no slicing savings, but minimal + correct
      fellBackToWholeFile = true;
      notes.push(
        `pack was not smaller than \`${file}\` — returned the whole file (lossless, never worse than reading it)`,
      );
    }
  }

  return {
    symbol: [...entityIds, ...(anyModuleLevel ? [`${file}::module-frame`] : [])].join(
      ",",
    ),
    resolved: null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
    fellBackToWholeFile,
  };
}
