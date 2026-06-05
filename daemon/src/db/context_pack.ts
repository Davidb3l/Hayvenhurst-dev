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
import type { Db, NodeRow } from "./queries.ts";

/** One contiguous, line-exact slice of source in the pack. */
export interface ContextSlice {
  /** Why this slice is here. */
  role: "header" | "target" | "neighbor";
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
   *  call edge) or `"ref"` (a same-file entity named in the target body, e.g. a
   *  type used in the signature, which is not a call edge). */
  via?: "call" | "ref";
  /** For a `"call"` neighbor: total call occurrences from the target into this
   *  symbol. Absent for `"ref"` neighbors. */
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
}

const DEFAULT_MAX_NEIGHBORS = 10;
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
 * The target file's MODULE SKELETON: every top-level line that is NOT inside
 * another entity's body — imports, module-level `const`/`type`/`enum`
 * declarations, re-exports, the shell around functions. Returned as the
 * contiguous, non-blank runs left after subtracting every other entity body
 * (and the target's own body, which is added separately as the target slice).
 *
 * Why this and not just the leading import block: a target function routinely
 * references **module-level constants/types that are neither call edges nor
 * imports** (e.g. `const ENCODINGS = {…}` used inside the function). The old
 * import-only header omitted them, and an answerer given the slice would
 * hallucinate definitions for symbols that already existed (measured — see
 * `bench/context-pack-measure.ts` and `docs/PHASE_0.0.4.5_PIVOT.md` §5). The
 * skeleton captures them while STILL excluding every other function body, so it
 * stays far smaller than the whole file.
 *
 * When the skeleton exceeds `maxLines`, the runs FARTHEST from the target are
 * dropped first (nearer module-scope context is likelier relevant).
 */
function moduleScopeSegments(
  db: Db,
  target: NodeRow,
  lines: string[],
  maxLines: number,
): Segment[] {
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

  const rows = db.handle
    .query<
      { id: string; kind: string; range_start: number; range_end: number },
      [string]
    >("SELECT id, kind, range_start, range_end FROM nodes WHERE file = ?")
    .all(target.file ?? "");
  for (const r of rows) {
    if (r.id === target.id || r.kind === "module") continue;
    mark(withLeadingDecoration(r.range_start), r.range_end);
  }
  mark(withLeadingDecoration(target.range_start), target.range_end); // added separately as the target slice

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
    const dist = (s: Segment): number =>
      s.end < target.range_start
        ? target.range_start - s.end
        : s.start - target.range_end;
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
