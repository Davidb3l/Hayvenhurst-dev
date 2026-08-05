/**
 * The context packer's PUBLIC SHAPES: the slice, the assembled pack, and the
 * pack options. These live in their own leaf module (no imports, no runtime
 * code) so every layer of the packer (containment, slicing, the neighbor
 * passes, the builders) can name them without importing back through
 * `context_pack.ts`, which would make a cycle out of what is only a type.
 * `context_pack.ts` re-exports all three, so its consumers are unchanged.
 */
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
