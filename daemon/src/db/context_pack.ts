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
 *
 * DECOMPOSED: this module now holds the public option/constant knobs and the
 * BUILDERS, and re-exports everything it has always exported. The pieces that
 * had already grown their own seams live beside it:
 *   - `pack_types.ts`       : `ContextSlice` / `ContextPack` / `ContextPackOptions`.
 *   - `pack_containment.ts` : the containment and admissibility gate.
 *   - `pack_slicing.ts`     : segmentation, module scoping, the file reader/slicer.
 *   - `pack_neighbors.ts`   : the shared neighbor passes: §3 callees, §4
 *                             referenced entities, §5 opt-in callers, §6 opt-in
 *                             cross-file imported symbols.
 * Consumers import from here exactly as before; nothing moved out of view.
 */
import { resolveNodeId } from "./graph_walk.ts";
import {
  addCalleeNeighbors,
  addCallerNeighbors,
  addImportedSymbolNeighbors,
  addRefNeighbors,
  type NeighborPassState,
} from "./pack_neighbors.ts";
import {
  computeModuleScope,
  makeFileReader,
  moduleScopeSegments,
  sliceNode,
} from "./pack_slicing.ts";
import type { ContextPack, ContextPackOptions, ContextSlice } from "./pack_types.ts";
import type { Db, NodeRow } from "./queries.ts";

// The packer's public surface is unchanged by the decomposition: every symbol
// this module exported before the carve is still exported from here, at the
// same name, so no consumer had to move an import.
export type { ContextPack, ContextPackOptions, ContextSlice } from "./pack_types.ts";
export {
  MAX_PACK_FILE_BYTES,
  containWithinRoot,
  isPackableFile,
  resolveRepoPath,
  resolveWithinRepo,
  type ResolvedRepoPath,
} from "./pack_containment.ts";

const DEFAULT_MAX_NEIGHBORS = 10;
/** Default for {@link ContextPackOptions.maxCallers}: `0` = NO caller hop. This
 *  is what keeps the default pack byte-identical to the pre-caller-hop behavior —
 *  the caller pass is skipped entirely unless the caller explicitly opts in. */
const DEFAULT_MAX_CALLERS = 0;
const DEFAULT_MAX_HEADER_LINES = 120;
/** A `via:"ref"` neighbor that IS included (body ≤ {@link MAX_REF_LINES}) is
 *  capped to this many LEADING lines — the declaration + opening shape (interface
 *  fields / class member signatures) — so a referenced type contributes its
 *  signature surface, not its deep method bodies. Line-exact: the slice is the
 *  real file lines `[start .. start+N-1]`; truncation is recorded in `notes`
 *  (and on the slice's `truncatedFromEndLine`), never injected into `text`.
 *  Overridable per call via `opts.maxRefSliceLines`. */
const DEFAULT_MAX_REF_SLICE_LINES = 12;

/**
 * Read a "how many" pack knob, falling back to `dflt` for anything that is not
 * an integer >= `min`.
 *
 * These knobs arrive from surfaces that own no validated numeric type — the MCP
 * tool arguments, and the daemon route's query string — and a negative one was
 * not merely ignored, it corrupted the OUTPUT: `maxRefSliceLines: -1000000`
 * produced slices with `endLine < startLine` (`[3, -999998]`), which then flowed
 * into the `order` continuation token a builder threads back, and made
 * `lineCount` hugely negative. `0` is meaningful for the caps (`maxNeighbors: 0`
 * = no neighbors, `maxCallers: 0` = no caller hop), so `min` defaults to 0 and
 * only the slice LENGTH knob raises it to 1.
 */
function countOpt(v: number | undefined, dflt: number, min = 0): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min ? v : dflt;
}

/** ≈4 chars/token — the cheap, tokenizer-robust proxy the pivot used to report
 *  ratios. Exact counts need a tokenizer; ratios hold either way. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
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
  const maxNeighbors = countOpt(opts.maxNeighbors, DEFAULT_MAX_NEIGHBORS);
  const maxHeaderLines = countOpt(opts.maxHeaderLines, DEFAULT_MAX_HEADER_LINES);
  const maxRefSliceLines = countOpt(
    opts.maxRefSliceLines,
    DEFAULT_MAX_REF_SLICE_LINES,
    1,
  );
  const maxCallers = countOpt(opts.maxCallers, DEFAULT_MAX_CALLERS);
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

  // 3 + 4. NEIGHBOR PASSES — callee dependencies then referenced type-like
  //    entities. Both are the SHARED implementation (see {@link NeighborPassState}),
  //    run here over a single-element root set. The omission-note suffix is the
  //    one output difference from the multi-root entry point and is passed
  //    explicitly rather than flattened.
  const passState: NeighborPassState = {
    db,
    read,
    slices,
    notes,
    roots: [target],
    rootIds: new Set([target.id]),
    addedIds: new Set([target.id]),
    maxNeighbors,
  };
  if (includeNeighbors && maxNeighbors > 0) {
    addCalleeNeighbors(passState, "unresolved/module");
  }
  if (includeNeighbors && maxNeighbors > 0 && target.file) {
    addRefNeighbors(passState, {
      rootText: targetSlice?.text ?? "",
      rootFiles: [target.file],
      maxRefSliceLines,
    });
  }

  // 5 + 6. OPT-IN PASSES: the caller hop then cross-file imported symbols, both
  //    the SHARED implementation over the same single-element root set. Neither
  //    is gated on `includeNeighbors`/`maxNeighbors`: they carry their own knobs
  //    (`maxCallers`, `importedSymbols`) and are skipped entirely when those are
  //    at their defaults, which is what keeps the default pack byte-identical to
  //    the pre-caller-hop behavior.
  addCallerNeighbors(passState, maxCallers);
  if (importedSymbols) {
    addImportedSymbolNeighbors(passState, {
      repoRoot,
      rootTexts: new Map([[target.id, targetSlice?.text ?? ""]]),
      maxSymbols: maxNeighbors,
    });
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
  const maxLines = countOpt(opts.maxLines, DEFAULT_MAX_HEADER_LINES);
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
 * The OPT-IN passes are honored here too: `maxCallers` adds the §5 caller hop
 * and `importedSymbols` adds the §6 cross-file imported-symbol pass, both over
 * the whole root set and both sharing one cap. They used to be accepted and
 * silently dropped on this path, so an opted-in caller got nothing back and no
 * note saying why; the passes now live in `pack_neighbors.ts` beside §3/§4 so
 * the two entry points cannot drift apart on them again.
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
  const maxNeighbors = countOpt(opts.maxNeighbors, DEFAULT_MAX_NEIGHBORS);
  const maxHeaderLines = countOpt(opts.maxHeaderLines, DEFAULT_MAX_HEADER_LINES);
  const maxRefSliceLines = countOpt(
    opts.maxRefSliceLines,
    DEFAULT_MAX_REF_SLICE_LINES,
    1,
  );
  const maxCallers = countOpt(opts.maxCallers, DEFAULT_MAX_CALLERS);
  const importedSymbols = opts.importedSymbols === true;

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

  // 3 + 4. NEIGHBOR PASSES — the SAME shared implementation the single-target
  //    entry point uses, run over the full root set. Dedupe set starts at every
  //    id already a slice (the roots); the (file,range) overlap test inside the
  //    passes keeps a callee that IS a root (or nested in one) from re-entering.
  const passState: NeighborPassState = {
    db,
    read,
    slices,
    notes,
    roots,
    rootIds,
    addedIds: new Set<string>(rootIds),
    maxNeighbors,
  };
  if (includeNeighbors && maxNeighbors > 0) {
    addCalleeNeighbors(passState, "unresolved/module/dup");
    // Refs are searched against the CONCATENATION of every root body, and
    // scanned same-file over each root file (sorted) before going cross-file.
    addRefNeighbors(passState, {
      rootText: roots.map((r) => targetSlices.get(r.id)?.text ?? "").join("\n"),
      rootFiles: [...rootsByFile.keys()].sort(),
      maxRefSliceLines,
    });
  }

  // 5 + 6. OPT-IN PASSES: the caller hop then cross-file imported symbols, the
  //    SAME shared implementation the single-target entry point runs, here over
  //    the full root set: caller weights are summed across roots and both passes
  //    share ONE cap, so an N-root pack stays as bounded as a 1-root one. These
  //    options were previously ACCEPTED and silently discarded on this path.
  //    Like on the single-target path they are NOT gated on `includeNeighbors`/
  //    `maxNeighbors`; they carry their own knobs, and at those knobs' defaults
  //    neither pass emits anything, so a pack built without them is unchanged.
  addCallerNeighbors(passState, maxCallers);
  if (importedSymbols) {
    addImportedSymbolNeighbors(passState, {
      repoRoot,
      rootTexts: new Map(
        roots.map((r) => [r.id, targetSlices.get(r.id)?.text ?? ""] as const),
      ),
      maxSymbols: maxNeighbors,
    });
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
  // Read here only to tell the LANE 3 fallback whether opt-in sections were
  // requested; `opts` itself is forwarded whole to the multi-root builder, which
  // is where both passes actually run.
  const maxCallers = countOpt(opts.maxCallers, DEFAULT_MAX_CALLERS);
  const importedSymbols = opts.importedSymbols === true;

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
  /**
   * Entity coverage for this file as a bitmap over `1..maxEntityEnd`, built ONCE
   * in O(rows + lines).
   *
   * BOUND — the scan below used to ask "is line L inside any entity?" by walking
   * `rows` for EVERY line of EVERY region, i.e. O(regions × lines × entities).
   * That survived the gap-fill clamp and was independently measured at 76
   * SECONDS for 1024 whole-file regions against a 20k-line / 5k-entity file —
   * every one of those regions schema-valid and accepted by the MCP wire. Same
   * permanent wedge of the synchronous single-process stdio server, reached
   * through the other loop. The bitmap makes the scan O(lines).
   *
   * `range_end` comes from the index, so a corrupt/stale row could claim an
   * absurd end and turn the allocation itself into the DoS; cap it. Lines past
   * the cap answer "module scope", which is the inclusive (never-lose-context)
   * direction.
   */
  const MAX_COVERAGE_LINES = 10_000_000;
  const maxEntityEnd = Math.min(
    MAX_COVERAGE_LINES,
    rows.reduce((m, r) => Math.max(m, r.range_end), 0),
  );
  const insideEntity = new Uint8Array(maxEntityEnd + 2);
  for (const r of rows) {
    const from = Math.max(1, r.range_start);
    const to = Math.min(maxEntityEnd, r.range_end);
    for (let L = from; L <= to; L++) insideEntity[L] = 1;
  }
  /** Mark every line in [lo,hi] that is NOT inside ANY entity → if any remains,
   *  the region touches true module scope and needs the frame. */
  const regionTouchesModuleScope = (lo: number, hi: number): boolean => {
    // A line below 1 or past the last entity is outside every entity, so it IS
    // the answer — return without walking the range at all. (This also keeps a
    // hugely negative `lo` from becoming its own unbounded loop.)
    if (lo < 1 || hi > maxEntityEnd) return true;
    for (let L = lo; L <= hi; L++) if (!insideEntity[L]) return true;
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
        // Through `countOpt` like every other read of this knob — reading the
        // raw option here was a hole in the guard (a negative/fractional
        // `maxHeaderLines` reached `computeModuleScope` untouched on this path).
        maxLines: countOpt(opts.maxHeaderLines, DEFAULT_MAX_HEADER_LINES),
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
    // BOUND — clamp every region to the file's real line span, then MERGE the
    // clamped spans before walking lines. Two failure modes this closes, both
    // reachable from `hayven mcp`'s client-supplied `regions` arg:
    //   - one huge `endLine` (a client using MAX_SAFE_INTEGER as a "whole file"
    //     sentinel) walked the whole range against a 10-line file — measured at
    //     197s for 2e10, ~years for 2^53, with the synchronous stdio server
    //     pegged and unable to answer another call;
    //   - many overlapping regions multiplied the per-line `covered()` scan.
    // After clamp+merge the per-line work is bounded by the FILE's length no
    // matter what the caller sends, so a future caller cannot reintroduce this.
    const spans: Array<[number, number]> = [];
    for (const region of regions) {
      const lo = Math.max(1, Math.min(region.startLine, region.endLine));
      const hi = Math.min(fileLines.length, Math.max(region.startLine, region.endLine));
      // NaN/Infinity fall out here: every comparison against them is false.
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) spans.push([lo, hi]);
    }
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [lo, hi] of spans) {
      const last = merged[merged.length - 1];
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else merged.push([lo, hi]);
    }
    const uncovered: number[] = [];
    for (const [lo, hi] of merged) {
      for (let L = lo; L <= hi; L++) if (!covered(L)) uncovered.push(L);
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
      // HONESTY NOTE for the opt-in passes. The fallback replaces the assembled
      // slices with ONE file, and the §5 caller / §6 imported-symbol slices are
      // exactly the ones that can live in OTHER files, so an opted-in caller can
      // get back a pack with none of what it opted into. That is a real loss of
      // information, not just of tokens: "never worse than reading the file" is a
      // TOKEN guarantee, and it was written when every slice came from the target
      // file or a cheap same-file dep.
      //
      // The fallback rule itself is deliberately NOT changed here: `worthwhile`
      // already governs packs built with no options at all, so re-deciding when
      // it fires would move output for callers who never asked for any of this.
      // Saying so in `notes` is the part that is safe and is strictly better than
      // the silent drop. Only reachable when an option was actually passed, so a
      // no-options pack is unaffected.
      if (maxCallers > 0 || importedSymbols) {
        notes.push(
          `the opt-in caller/imported-symbol slices were dropped by that fallback (the whole file is returned instead)`,
        );
      }
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
