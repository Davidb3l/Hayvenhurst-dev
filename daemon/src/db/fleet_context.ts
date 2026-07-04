/**
 * FLEET CONTEXT — dedup the context a fan-out of parallel agents shares.
 *
 * When an orchestrator spins up N sub-agents (the disjoint "lanes" pattern), each
 * independently re-reads the same shared files — the core modules, the config, the
 * contract every lane touches. With no shared context, that overlap is paid N
 * times. `fleetContext` computes each lane's slice pack ONCE, then splits the
 * slices into:
 *
 *   - SHARED — slices that ≥`sharedMinLanes` lanes need. Emit them ONCE, as a
 *     common prefix the orchestrator injects into every sub-agent (and, with prompt
 *     caching, pays for ~once instead of N times).
 *   - PER-LANE — the slices unique to each lane.
 *
 * The saving is the duplicated shared content removed: naive (every lane sends its
 * full pack, shared included) − deduped (shared once + Σ per-lane unique). That's
 * the fan-out overlap a shared briefing eliminates.
 *
 * Pure over the read DB: reuses {@link buildContextPackForSymbols} + the slice
 * primitives (`canonicalSlices`/`renderSliceBlock`/`compareSlices`) the packer and
 * `context_cache` already expose, so a lane's slices here are byte-identical to
 * what `hayven context` would hand that lane alone.
 */
import {
  canonicalSlices,
  compareSlices,
  deriveFenceLang,
  renderSliceBlock,
} from "./context_cache.ts";
import {
  buildContextPackForSymbols,
  estimateTokens,
  type ContextPackOptions,
  type ContextSlice,
} from "./context_pack.ts";
import type { Db } from "./queries.ts";

/** One lane of the fleet: an id + the symbols that lane will work on. */
export interface FleetLane {
  id: string;
  symbols: string[];
}

/** The slices unique to one lane, after the shared set is factored out. */
export interface FleetLaneResult {
  id: string;
  /** Slices only THIS lane needs (the shared ones live in {@link FleetContextResult.shared}). */
  uniqueSlices: ContextSlice[];
  /** Rendered unique slices (paste-ready), or "" when the lane is fully covered by shared. */
  uniqueText: string;
  /** Token proxy of {@link uniqueText}. */
  uniqueTokens: number;
  /** The shared-slice keys this lane relies on (so a caller can prove the lane is
   *  fully covered by shared ∪ unique). */
  usesShared: string[];
}

export interface FleetContextResult {
  /** The slices ≥`sharedMinLanes` lanes need — inject once into every sub-agent. */
  shared: { slices: ContextSlice[]; text: string; estTokens: number };
  perLane: FleetLaneResult[];
  stats: {
    lanes: number;
    sharedSlices: number;
    /** How many of {@link sharedSlices} were forced in as named exemplars (the
     *  "canonical pattern to copy" — see {@link FleetContextOptions.exemplars}). */
    exemplarSlices: number;
    /** Token proxy of just the exemplar block (the deliberate shared investment
     *  that replaces each lane reading another lane's reference file). */
    exemplarTokens: number;
    /** Σ of every lane's FULL pack (shared duplicated in each) — the no-dedup cost. */
    naiveTokens: number;
    /** shared once + Σ per-lane unique — the deduped cost. */
    dedupedTokens: number;
    savedTokens: number;
    savedPct: number;
  };
  notes: string[];
}

export type FleetContextOptions = ContextPackOptions & {
  /** A slice must be needed by at least this many lanes to be SHARED (default 2). */
  sharedMinLanes?: number;
  /**
   * Symbol ids to pin into the SHARED block as a CANONICAL REFERENCE, regardless
   * of how many lanes (if any) would otherwise need them. Finding from real
   * briefed fan-outs: harmonization lanes pull toward each other — a lane reads
   * ANOTHER lane's file just to copy the canonical pattern (the same error
   * string, the same field names). Naming that reference here emits its slice
   * ONCE, labeled "copy this; don't re-derive or peek at another lane", so no
   * lane needs to read a sibling's files. Honest cost: an exemplar no lane
   * already needed is net-new shared content (it lowers `savedPct`); the payoff
   * — avoided cross-lane whole-file reads — is real but outside this slice-only
   * token model, so it shows as `exemplarTokens` rather than inflating savings.
   */
  exemplars?: string[];
};

/** Header that labels the exemplar block so lanes copy it instead of peeking. */
const EXEMPLAR_HEADER =
  "## Canonical reference — copy this pattern; do NOT re-derive it or read another lane's files";

/** Stable per-slice identity: same file lines = same context (mirrors the packer). */
function key(s: ContextSlice): string {
  return `${s.file}:${s.startLine}-${s.endLine}`;
}

/** Render a slice group to a paste-ready block + its token proxy. */
function renderGroup(slices: ContextSlice[]): { text: string; estTokens: number } {
  if (slices.length === 0) return { text: "", estTokens: 0 };
  const text = slices.map((s) => renderSliceBlock(s, deriveFenceLang(s.file))).join("\n\n");
  return { text, estTokens: estimateTokens(text.length) };
}

/**
 * Build a deduped fleet briefing for `lanes`. Each lane's symbols are packed once;
 * slices needed by ≥`sharedMinLanes` lanes become the shared prefix, the rest stay
 * per-lane. Returns the shared block, the per-lane unique blocks, and the
 * naive-vs-deduped token accounting.
 */
export function fleetContext(
  db: Db,
  repoRoot: string,
  lanes: FleetLane[],
  options: FleetContextOptions = {},
): FleetContextResult {
  const { sharedMinLanes, exemplars, ...packOpts } = options;
  const threshold = Math.max(2, sharedMinLanes ?? 2);
  const notes: string[] = [];

  // 1. Pack each lane once; canonicalize its slices (dedup within the lane).
  const laneSlices: { id: string; slices: ContextSlice[] }[] = [];
  for (const lane of lanes) {
    const pack = buildContextPackForSymbols(db, repoRoot, lane.symbols, packOpts);
    const slices = pack ? canonicalSlices(pack.slices) : [];
    if (!pack || slices.length === 0) {
      notes.push(`lane \`${lane.id}\` resolved no slices`);
    }
    laneSlices.push({ id: lane.id, slices });
  }

  // 2. Count, per slice key, how many DISTINCT lanes need it. Keep one canonical
  //    slice object per key (the first seen — they're byte-identical by key).
  const laneCount = new Map<string, number>();
  const canonByKey = new Map<string, ContextSlice>();
  for (const { slices } of laneSlices) {
    const seenInLane = new Set<string>();
    for (const s of slices) {
      const k = key(s);
      if (!canonByKey.has(k)) canonByKey.set(k, s);
      if (!seenInLane.has(k)) {
        seenInLane.add(k);
        laneCount.set(k, (laneCount.get(k) ?? 0) + 1);
      }
    }
  }

  // 3. SHARED = keys needed by ≥ threshold lanes.
  const sharedKeys = new Set<string>();
  for (const [k, n] of laneCount) if (n >= threshold) sharedKeys.add(k);

  // 3b. EXEMPLARS — pin named canonical references into shared, even if no lane
  //     needed them. Pack each once; force its slices into the shared set, and
  //     remember which keys are exemplar-origin so they render under their own
  //     "copy this, don't peek at a sibling lane" header.
  const exemplarKeys = new Set<string>();
  for (const sym of exemplars ?? []) {
    const pack = buildContextPackForSymbols(db, repoRoot, [sym], packOpts);
    const slices = pack ? canonicalSlices(pack.slices) : [];
    if (!pack || slices.length === 0) {
      notes.push(`exemplar \`${sym}\` resolved no slices`);
      continue;
    }
    for (const s of slices) {
      const k = key(s);
      if (!canonByKey.has(k)) canonByKey.set(k, s);
      exemplarKeys.add(k);
      sharedKeys.add(k);
    }
  }

  // Render exemplars (labeled) ahead of the lane-shared slices; `shared.slices`
  // carries all of them (exemplars first) for callers that introspect.
  const exemplarSlices = [...exemplarKeys].map((k) => canonByKey.get(k)!).sort(compareSlices);
  const laneSharedSlices = [...sharedKeys]
    .filter((k) => !exemplarKeys.has(k))
    .map((k) => canonByKey.get(k)!)
    .sort(compareSlices);
  const sharedSlices = [...exemplarSlices, ...laneSharedSlices];
  const exemplarRender = renderGroup(exemplarSlices);
  const laneSharedRender = renderGroup(laneSharedSlices);
  const sharedText = [
    exemplarSlices.length > 0 ? `${EXEMPLAR_HEADER}\n\n${exemplarRender.text}` : "",
    laneSharedRender.text,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  const sharedRender = { text: sharedText, estTokens: estimateTokens(sharedText.length) };

  // 4. PER-LANE = each lane's slices not in shared.
  const perLane: FleetLaneResult[] = laneSlices.map(({ id, slices }) => {
    const unique = slices.filter((s) => !sharedKeys.has(key(s)));
    const usesShared = slices.filter((s) => sharedKeys.has(key(s))).map(key);
    const r = renderGroup(unique);
    return { id, uniqueSlices: unique, uniqueText: r.text, uniqueTokens: r.estTokens, usesShared };
  });

  // 5. Accounting: naive = every lane sends its FULL pack (shared duplicated);
  //    deduped = shared once + Σ per-lane unique.
  const naiveTokens = laneSlices.reduce((a, { slices }) => a + renderGroup(slices).estTokens, 0);
  const dedupedTokens =
    sharedRender.estTokens + perLane.reduce((a, l) => a + l.uniqueTokens, 0);
  const savedTokens = naiveTokens - dedupedTokens;

  return {
    shared: { slices: sharedSlices, text: sharedRender.text, estTokens: sharedRender.estTokens },
    perLane,
    stats: {
      lanes: lanes.length,
      sharedSlices: sharedSlices.length,
      exemplarSlices: exemplarSlices.length,
      exemplarTokens: exemplarRender.estTokens,
      naiveTokens,
      dedupedTokens,
      savedTokens,
      savedPct: naiveTokens > 0 ? (savedTokens / naiveTokens) * 100 : 0,
    },
    notes,
  };
}
