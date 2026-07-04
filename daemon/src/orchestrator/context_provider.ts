/**
 * The ORCHESTRATOR CONTEXT PROVIDER — the integration that makes the packer
 * indispensable instead of optional.
 *
 * Every measurement in the pivot showed the same thing: a free-roaming agent
 * will `grep` even with the packer installed, because reaching for a tool is a
 * choice it doesn't make. So we stop trying to win the agent's tool-choice. The
 * RLM orchestrator (the thing that decomposes work and ASSEMBLES each sub-agent's
 * prompt) is the real "builder" the pivot named — and it controls context
 * programmatically. This module is what that builder calls: given the symbols a
 * sub-agent needs, it returns a single cache-stable context block to drop into
 * the prompt. The sub-agent is BORN with packed context instead of being told to
 * go read files — context the agent can't decline.
 *
 * It composes the two shipped lanes:
 *   - `buildEscalatingContext` (`db/context_escalation.ts`) — the pack → 2-hop →
 *     whole-file ladder + a recommended rung. We pick a rung per symbol, by a
 *     token BUDGET when given (the Pro-plan constraint: the richest rung that
 *     still fits) or the `recommended` rung otherwise.
 *   - `renderStablePacks` (`db/context_cache.ts`) — canonical, byte-stable
 *     rendering so the block sits in a cacheable prompt prefix and survives
 *     Anthropic's 5-minute cache TTL (the cache-affinity win).
 *
 * No embeddings, no model — the same exact-identifier, line-exact slices the
 * packer produces, selected to a budget and rendered for cache reuse.
 */
import {
  buildEscalatingContext,
  type ContextRung,
  type RungLevel,
} from "../db/context_escalation.ts";
import {
  cachePrefixKey,
  renderStablePacks,
} from "../db/context_cache.ts";
import {
  estimateTokens,
  type ContextPack,
  type ContextPackOptions,
} from "../db/context_pack.ts";
import { Db } from "../db/queries.ts";

/** Options for {@link assembleSubAgentContext} — the packer's options plus the
 *  budget/ladder/cache controls the orchestrator cares about. */
export type SubAgentContextOptions = ContextPackOptions & {
  /** Don't build any rung richer than this (forwarded to the ladder). */
  maxRung?: RungLevel;
  /** A PER-SYMBOL token budget — NOT a budget for the whole emitted block. When
   *  set, each symbol independently gets the RICHEST rung whose RENDERED cost is
   *  ≤ this; if even the cheapest rung exceeds it, the cheapest is used and
   *  `overBudget` is flagged. The final block dedups slices ACROSS symbols, so the
   *  emitted block is NOT bounded by `budgetTokens × symbolCount` (it can be
   *  larger if symbols are independent, smaller if they share bodies). To gate on
   *  the real total, read {@link SubAgentContext.estTokens} (the honest chars/4
   *  proxy of the deduped block) after assembling. When unset, use each symbol's
   *  `recommended` rung. */
  budgetTokens?: number;
  /** Graph version string folded into {@link SubAgentContext.prefixKey} so a
   *  builder can decide up-front cache reuse; bump it to invalidate. */
  graphVersion?: string;
  /** ESCALATION override (the escalate-on-failure control). When set, EVERY
   *  symbol is assembled at exactly this rung level — the richest BUILT rung whose
   *  ladder index is ≤ `level` (so a symbol whose `pack-2hop` was omitted falls
   *  back to `pack` at `level:"pack-2hop"`). Takes precedence over `budgetTokens`
   *  and `recommended`. The intended use: a builder runs the cheap pack, and if the
   *  sub-agent's attempt fails its oracle, re-assembles at {@link nextRungLevel} and
   *  retries — turning a 1-hop insufficiency (e.g. a slice that misses an inline
   *  callback) into a recovered pass via the whole-file rung. Unset → budget/
   *  recommended selection (unchanged). */
  level?: RungLevel;
};

/** The rung ladder, cheapest→richest — the order escalation climbs. */
export const RUNG_LEVELS: readonly RungLevel[] = ["pack", "pack-2hop", "whole-file"];

/** The next-richer rung to escalate to after a failed attempt, or `null` when
 *  already at the top (whole-file — nothing left to climb; the builder should
 *  fall back to its own strategy, e.g. grep, or give up). */
export function nextRungLevel(level: RungLevel): RungLevel | null {
  const i = RUNG_LEVELS.indexOf(level);
  return i >= 0 && i < RUNG_LEVELS.length - 1 ? RUNG_LEVELS[i + 1]! : null;
}

/** Which rung was chosen for one symbol, and why. */
export interface SymbolChoice {
  /** The resolved target node id (mirrors the pack's `symbol`). */
  symbol: string;
  /** The chosen id when the input was fuzzy-resolved; `null` when exact. */
  resolved: string | null;
  /** The rung selected for this symbol. */
  rung: RungLevel;
  /** The chosen rung's RENDERED token count (chars/4 of the emitted block for
   *  this symbol — headers + fences included, the cost actually paid), not the
   *  raw slice-text estimate. This is what the budget decision was made against. */
  estTokens: number;
  /** True when a budget was set but even the cheapest rung exceeded it (so the
   *  cheapest was used anyway — the orchestrator may want to split the task). */
  overBudget: boolean;
}

/** The assembled, cache-stable context for ONE sub-agent prompt. */
export interface SubAgentContext {
  /** The cache-stable rendered block to embed in the sub-agent prompt. */
  contextBlock: string;
  /** sha256 of `contextBlock` — the cache-reuse decision key. */
  contentKey: string;
  /** A stable key over (resolved symbols, graphVersion) for an UP-FRONT cache
   *  decision before rendering. */
  prefixKey: string;
  /** chars/4 proxy token count of `contextBlock`. */
  estTokens: number;
  /** Per-symbol rung choices. */
  symbols: SymbolChoice[];
  /** Non-fatal notes (unresolved symbols, budget overflows, ladder notes). */
  notes: string[];
}

/** Pick the rung to ship for one symbol's ladder, honoring a token budget.
 *
 *  `cost(rung)` is the RENDERED token count (the bytes actually emitted into the
 *  prompt — headers + fences included), NOT `rung.estTokens` (which counts only
 *  raw slice text and undercounts the real cost by ~1.5–2.3×). Budgeting against
 *  the rendered cost is what makes "the richest rung that fits" true for the
 *  block the orchestrator actually pays to send. */
function chooseRung(
  rungs: ContextRung[],
  recommended: ContextRung,
  budgetTokens: number | undefined,
  cost: (rung: ContextRung) => number,
  level: RungLevel | undefined,
): { rung: ContextRung; overBudget: boolean; estTokens: number } {
  // ESCALATION override wins over budget/recommended: ship the richest BUILT rung
  // whose ladder index is ≤ the requested level. `rungs` is cheapest→richest, so
  // the last one within the cap is the richest-that-fits-the-cap. (`pack` is index
  // 0 and always present, so `best` is always assigned.)
  if (level !== undefined) {
    const cap = RUNG_LEVELS.indexOf(level);
    let best = rungs[0]!;
    for (const r of rungs) {
      if (RUNG_LEVELS.indexOf(r.level) <= cap) best = r;
    }
    return { rung: best, overBudget: false, estTokens: cost(best) };
  }
  if (budgetTokens === undefined) {
    return { rung: recommended, overBudget: false, estTokens: cost(recommended) };
  }
  // rungs are cheapest→richest, so the LAST one that fits is the richest-that-fits.
  let best: ContextRung | undefined;
  for (const r of rungs) {
    if (cost(r) <= budgetTokens) best = r;
  }
  if (best) return { rung: best, overBudget: false, estTokens: cost(best) };
  // Nothing fits — ship the cheapest rung and flag it (the orchestrator should
  // probably split this sub-task rather than blow the budget).
  return { rung: rungs[0]!, overBudget: true, estTokens: cost(rungs[0]!) };
}

/** Wrap a chosen rung's slices as a {@link ContextPack} so it can flow through
 *  {@link renderStablePacks} (which reads only `.slices`, but we fill the rest
 *  honestly). */
function rungAsPack(symbol: string, resolved: string | null, rung: ContextRung): ContextPack {
  let lineCount = 0;
  for (const s of rung.slices) lineCount += s.endLine - s.startLine + 1;
  return {
    symbol,
    resolved,
    slices: rung.slices,
    lineCount,
    estTokens: rung.estTokens,
    notes: [],
    targetFileEstTokens: 0,
    worthwhile: true,
  };
}

/**
 * Assemble the cache-stable context block for a sub-agent that needs `symbols`.
 *
 * For each symbol: build its escalation ladder, pick a rung (richest-that-fits a
 * `budgetTokens` cap, else `recommended`), and collect that rung as a pack. All
 * chosen packs are rendered through {@link renderStablePacks} into ONE canonical,
 * deduped, byte-stable block — so the same symbols at the same graph version
 * always produce identical bytes (a cache hit across the TTL).
 *
 * BUDGET IS PER-SYMBOL, NOT TOTAL. `budgetTokens` caps EACH symbol's chosen rung
 * independently; the final block then dedups slices across symbols. So the emitted
 * block is NOT bounded by `budgetTokens × symbolCount` — it can exceed the
 * operator's intended total (independent symbols) or come in under it (symbols
 * that share bodies). The returned {@link SubAgentContext.estTokens} is the honest
 * chars/4 proxy of the FINAL deduped block; a caller that needs a hard total cap
 * must check it after assembling (and re-split or drop symbols if it's too big).
 *
 * A symbol that doesn't resolve is skipped with a note (never throws). With no
 * resolvable symbols the block is empty and `symbols` is `[]`.
 *
 * ESCALATE-ON-FAILURE LOOP (`opts.level` + {@link nextRungLevel}). The cheapest
 * 1-hop pack can be INSUFFICIENT on indirection-heavy code (e.g. a slice that
 * misses an inline callback the bug lives in). The recovery is to climb the
 * ladder only when the cheap rung actually fails the builder's oracle:
 *
 *   let level: RungLevel | null = "pack";
 *   while (level) {
 *     const ctx = assembleSubAgentContext(db, root, task, { level });
 *     const verdict = await runSubAgent(ctx.contextBlock); // builder owns this
 *     if (verdict.passed) break;
 *     level = nextRungLevel(level);   // climb: pack → pack-2hop → whole-file → null
 *   }
 *
 * The builder owns the answerer + the pass/fail signal; this module just yields
 * the rung's context and the next rung to try. Each step is cache-stable, so a
 * re-assembly at the same level is a cache hit.
 */
export function assembleSubAgentContext(
  db: Db,
  repoRoot: string,
  task: { symbols: string[] },
  opts: SubAgentContextOptions = {},
): SubAgentContext {
  const { maxRung, budgetTokens, graphVersion, level, ...packOpts } = opts;
  const notes: string[] = [];
  const choices: SymbolChoice[] = [];
  const packs: ContextPack[] = [];
  const resolvedIds: string[] = [];

  for (const sym of task.symbols) {
    const ladder = buildEscalatingContext(db, repoRoot, sym, { ...packOpts, maxRung });
    if (!ladder) {
      notes.push(`symbol \`${sym}\` did not resolve — skipped`);
      continue;
    }
    // Rendered cost of a rung = the bytes actually emitted (headers + fences),
    // so the budget decision matches what the orchestrator pays to send.
    const renderedCost = (r: ContextRung): number =>
      renderStablePacks([rungAsPack(ladder.symbol, ladder.resolved, r)]).estTokens;
    const { rung, overBudget, estTokens } = chooseRung(
      ladder.rungs,
      ladder.recommended,
      budgetTokens,
      renderedCost,
      level,
    );
    if (overBudget) {
      notes.push(
        `symbol \`${ladder.symbol}\`: even the cheapest rung (~${estTokens} rendered tok) exceeds the budget (${budgetTokens} tok) — shipped it anyway; consider splitting this sub-task`,
      );
    }
    for (const n of ladder.notes) notes.push(`[${ladder.symbol}] ${n}`);
    choices.push({
      symbol: ladder.symbol,
      resolved: ladder.resolved,
      rung: rung.level,
      estTokens,
      overBudget,
    });
    packs.push(rungAsPack(ladder.symbol, ladder.resolved, rung));
    resolvedIds.push(ladder.symbol);
  }

  const render = renderStablePacks(packs);
  // DEDUP the resolved ids before they key the prefix. Two DIFFERENT raw inputs
  // can legitimately resolve to the SAME node id (an exact id plus a fuzzy name
  // that the top FTS hit lands on the same node, or a caller passing duplicates).
  // The rendered block already dedups by slice across symbols, so the SAME
  // resolved-symbol SET yields byte-identical `contextBlock`/`contentKey`. The
  // up-front `prefixKey` must track that SET, not the input multiplicity — else a
  // duplicate hands the builder a different prefixKey for an identical block (a
  // false cache MISS, the inverse of the false-hit the versionTag guards).
  const distinctResolvedIds = [...new Set(resolvedIds)];
  // Fold EVERY input that can change the chosen block's bytes into the version
  // component: the SAME symbols at the same graph can produce DIFFERENT blocks
  // under different budgets/caps (a different rung is chosen) OR different packer
  // options (maxNeighbors/maxHeaderLines/maxRefSliceLines/neighbors change which
  // slices a rung even contains), so a prefixKey that omitted any of them would
  // collide and hand a builder a false cache hit for the wrong block's bytes.
  // `packOpts` is serialized with a FIXED key order so the tag is deterministic
  // (object spread/property order must never leak into the key).
  const packOptsTag = JSON.stringify({
    neighbors: packOpts.neighbors ?? null,
    maxNeighbors: packOpts.maxNeighbors ?? null,
    maxHeaderLines: packOpts.maxHeaderLines ?? null,
    maxRefSliceLines: packOpts.maxRefSliceLines ?? null,
  });
  const versionTag = `${graphVersion ?? "unknown"}|budget=${budgetTokens ?? "none"}|maxRung=${maxRung ?? "whole-file"}|level=${level ?? "none"}|packOpts=${packOptsTag}`;
  return {
    contextBlock: render.text,
    contentKey: render.contentKey,
    prefixKey: cachePrefixKey(distinctResolvedIds, versionTag),
    estTokens: render.text.length > 0 ? render.estTokens : estimateTokens(0),
    symbols: choices,
    notes,
  };
}
