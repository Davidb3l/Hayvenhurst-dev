/**
 * SOURCE SEGMENTATION AND MODULE SCOPING: the layer that turns a file plus a
 * set of entity ranges into the line-exact runs the pack is assembled from: the
 * module skeleton/frame (`computeModuleScope`), its single-target wrapper
 * (`moduleScopeSegments`), the per-call file reader, and the node-body slicer.
 *
 * Carved out of `context_pack.ts` verbatim. It sits ABOVE the containment gate
 * (it reads files only through `resolveWithinRepo`/`isPackableFile`) and BELOW
 * the neighbor passes and the builders, both of which slice through it.
 */
import { readFileSync } from "node:fs";

import { isPackableFile, resolveWithinRepo } from "./pack_containment.ts";
import type { ContextSlice } from "./pack_types.ts";
import type { Db, NodeRow } from "./queries.ts";

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
export function computeModuleScope(
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
export function moduleScopeSegments(
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
 *  be read (deleted, binary, too large, not a regular file, or — see
 *  {@link resolveWithinRepo} — outside the repo or denied). */
export function makeFileReader(repoRoot: string) {
  const cache = new Map<string, string[] | null>();
  return (file: string): string[] | null => {
    if (cache.has(file)) return cache.get(file) ?? null;
    let lines: string[] | null = null;
    const abs = resolveWithinRepo(repoRoot, file);
    if (abs !== null && isPackableFile(abs)) {
      try {
        lines = readFileSync(abs, "utf8").split("\n");
      } catch {
        lines = null;
      }
    }
    cache.set(file, lines);
    return lines;
  };
}

/** Slice a node's body out of its file using its 1-based inclusive line range.
 *  Returns `null` when the node has no file, the file can't be read, or the
 *  range is degenerate. */
export function sliceNode(
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
