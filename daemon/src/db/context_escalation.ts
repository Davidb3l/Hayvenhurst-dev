/**
 * The CONTEXT-ESCALATION LADDER on top of {@link buildContextPack}.
 *
 * `buildContextPack` (the Phase 0.0.4.5 cost-packer) gives ONE rung of context:
 * the target's body + its module skeleton + 1-hop callee/ref neighbors. That is
 * the cheapest precise slice. But a token-constrained orchestrator wants a
 * DETERMINISTIC way to climb to richer context only when the cheap rung proves
 * insufficient — without guessing how much to fetch.
 *
 * This module builds that climb as an ordered ladder of {@link ContextRung}s,
 * cheapest→richest, each one strictly a superset of context-coverage over the
 * previous, plus a {@link EscalationResult.recommended} rung (the cheapest rung
 * still smaller than the honest "just open every file" baseline):
 *
 *   pack  →  pack-2hop  →  whole-file
 *   (1-hop slice)  (1-hop + each callee's own 1-hop)  (full text of every file touched)
 *
 * Everything is reused from the packer: its `ContextSlice` shape, its
 * `estimateTokens` chars/4 proxy, and a second `buildContextPack` call per
 * `via:"call"` neighbor for the 2-hop rung. No embeddings, no model — the same
 * exact-identifier, line-exact slices the packer produces, just laddered.
 *
 * A rung that adds NO new `(file,startLine,endLine)` slice over the previous rung
 * is OMITTED (e.g. a self-contained function whose 2-hop == 1-hop), so the ladder
 * never offers a "richer" rung that costs more for nothing. The `pack` and
 * `whole-file` rungs are always kept as the honest endpoints.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  buildContextPack,
  estimateTokens,
  type ContextPack,
  type ContextSlice,
  type ContextPackOptions,
} from "./context_pack.ts";
import { Db } from "./queries.ts";

/** The three rungs of the ladder, cheapest→richest. */
export type RungLevel = "pack" | "pack-2hop" | "whole-file";

/** One rung of the escalation ladder: a deduped set of slices + its cost. */
export interface ContextRung {
  /** Which rung this is. */
  level: RungLevel;
  /** The rung's slices, in pack order. For `"whole-file"` each source file is
   *  ONE slice with `role:"target"`. */
  slices: ContextSlice[];
  /** Distinct repo-relative files referenced by this rung's slices. */
  files: string[];
  /** Approximate token count for the rung (`estimateTokens(totalChars)` — the
   *  same chars/4 proxy {@link buildContextPack} uses). */
  estTokens: number;
}

/** The assembled ladder for one symbol. */
export interface EscalationResult {
  /** The resolved target node id (mirrors {@link ContextPack.symbol}). */
  symbol: string;
  /** The chosen id when `rawId` was fuzzy-resolved; `null` when it matched
   *  exactly (mirrors {@link ContextPack.resolved}). */
  resolved: string | null;
  /** The rungs, cheapest→richest. A rung that adds NO new slice vs the previous
   *  rung is omitted; the `pack` and `whole-file` rungs are always present. */
  rungs: ContextRung[];
  /** The cheapest rung whose `estTokens` is strictly less than the whole-file
   *  rung's; the whole-file rung itself when none qualifies (the tiny-file case
   *  where the pack is already ≥ the whole file). */
  recommended: ContextRung;
  /** Non-fatal notes (the recommendation rationale, any per-file read failure). */
  notes: string[];
}

/** Options for {@link buildEscalatingContext} — the packer's options plus a cap
 *  on how far up the ladder to build. */
export type EscalationOptions = ContextPackOptions & {
  /** Build no rung richer than this (default builds all three). `"pack"` →
   *  only the pack rung; `"pack-2hop"` → pack + 2hop (no whole-file). */
  maxRung?: RungLevel;
};

/** The ladder order, used both to compare `maxRung` and to keep rungs ordered. */
const RUNG_ORDER: RungLevel[] = ["pack", "pack-2hop", "whole-file"];

/** The dedup key for a slice: a slice is the SAME context iff it covers the same
 *  file lines. (Two rungs reaching the same callee body must not double-count it.) */
function sliceKey(s: ContextSlice): string {
  return `${s.file}:${s.startLine}-${s.endLine}`;
}

/** Sum the chars across slices → `estimateTokens`. The rung's cost proxy. */
function rungTokens(slices: ContextSlice[]): number {
  let chars = 0;
  for (const s of slices) chars += s.text.length;
  return estimateTokens(chars);
}

/** Distinct repo-relative files across a rung's slices, first-seen order. */
function rungFiles(slices: ContextSlice[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const s of slices) {
    if (!seen.has(s.file)) {
      seen.add(s.file);
      files.push(s.file);
    }
  }
  return files;
}

/** Assemble a {@link ContextRung} from a level + its (already-deduped) slices. */
function makeRung(level: RungLevel, slices: ContextSlice[]): ContextRung {
  return {
    level,
    slices,
    files: rungFiles(slices),
    estTokens: rungTokens(slices),
  };
}

/**
 * Build the escalation ladder for ONE symbol.
 *
 * Returns `null` only when the symbol doesn't resolve to any pack at all (the
 * `pack` rung's {@link buildContextPack} returned `null`). Individual problems
 * — a 2-hop neighbor that re-resolves to nothing, a file that can't be read for
 * the whole-file rung — are surfaced as {@link EscalationResult.notes}, never
 * thrown.
 */
export function buildEscalatingContext(
  db: Db,
  repoRoot: string,
  rawId: string,
  opts: EscalationOptions = {},
): EscalationResult | null {
  const maxRung = opts.maxRung ?? "whole-file";
  const maxRungIdx = RUNG_ORDER.indexOf(maxRung);
  // Strip our own `maxRung` before forwarding to the packer (it ignores unknown
  // keys, but keep the forwarded options clean and explicit).
  const { maxRung: _omit, ...packOpts } = opts;
  void _omit;

  const notes: string[] = [];

  // --- Rung 1: "pack" — the packer's own 1-hop slice. The ladder's floor.
  const pack = buildContextPack(db, repoRoot, rawId, packOpts);
  if (!pack) return null; // unresolved symbol → the whole ladder is null.

  const rungs: ContextRung[] = [];
  const packSlices = pack.slices;
  rungs.push(makeRung("pack", packSlices));

  // The running dedup set: a richer rung must add a NEW (file,start,end) slice or
  // it's omitted. Seed with the pack rung's keys.
  const seenKeys = new Set(packSlices.map(sliceKey));

  // --- Rung 2: "pack-2hop" — the pack rung PLUS one more hop. For each pack
  //     neighbor reached by a CALL edge, fetch ITS pack and merge the new slices.
  //     Deduped across the whole rung; `opts.maxNeighbors` (if set) is the
  //     per-hop cap the packer already applies on each sub-call. Omitted when it
  //     adds nothing (a self-contained function: 2-hop == 1-hop).
  let twoHopSlices: ContextSlice[] = packSlices;
  if (maxRungIdx >= RUNG_ORDER.indexOf("pack-2hop")) {
    const merged = [...packSlices];
    const mergedKeys = new Set(seenKeys);
    // Walk only the pack rung's CALL-edge neighbors — the slices whose `via` is a
    // call and that carry a resolvable node id. (A `via:"ref"` neighbor is a
    // referenced type, not a dependency to expand; a `null` id can't be re-packed.)
    for (const s of packSlices) {
      if (s.role !== "neighbor" || s.via !== "call" || s.id === null) continue;
      const sub = buildContextPack(db, repoRoot, s.id, packOpts);
      if (!sub) continue; // a neighbor that no longer resolves — skip, no throw.
      for (const subSlice of sub.slices) {
        const k = sliceKey(subSlice);
        if (mergedKeys.has(k)) continue;
        mergedKeys.add(k);
        merged.push(subSlice);
      }
    }
    twoHopSlices = merged;
    // Only keep the rung if it added at least one NEW slice over the pack rung.
    if (merged.length > packSlices.length) {
      rungs.push(makeRung("pack-2hop", merged));
      for (const k of mergedKeys) seenKeys.add(k);
    } else {
      notes.push(
        "pack-2hop omitted: adds no new context over the pack rung (self-contained 1-hop)",
      );
    }
  }

  // --- Rung 3: "whole-file" — the honest baseline: the FULL text of every file
  //     the pack-2hop rung touches. One slice per file, `role:"target"`. Always
  //     kept (it's the ceiling), capped by `maxRung`.
  let wholeFileRung: ContextRung | null = null;
  if (maxRungIdx >= RUNG_ORDER.indexOf("whole-file")) {
    const wholeSlices: ContextSlice[] = [];
    // Files referenced by the richest rung built so far (pack-2hop if present,
    // else the pack rung). First-seen order for stable output.
    for (const file of rungFiles(twoHopSlices)) {
      let content: string;
      try {
        // Resolve the path EXACTLY as the packer's `makeFileReader` does — an
        // absolute `file` is read as-is, only a relative one is joined to
        // `repoRoot`. Joining an already-absolute path would double the root
        // (`repoRoot + "/abs/path"`) and the read would ENOENT, silently
        // dropping a file the pack rung read fine — yielding an empty
        // whole-file rung that the recommendation logic would then prefer.
        content = readFileSync(isAbsolute(file) ? file : join(repoRoot, file), "utf8");
      } catch (err) {
        notes.push(
          `could not read \`${file}\` for the whole-file rung: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      // Don't count a trailing newline as an extra (empty) line — `"a\nb\n"`
      // is 2 content lines, not 3 — so `endLine` is the real last content line.
      const parts = content.split("\n");
      const lineCount =
        parts.length > 0 && parts[parts.length - 1] === ""
          ? parts.length - 1
          : parts.length;
      wholeSlices.push({
        role: "target",
        id: null,
        kind: "file",
        file,
        startLine: 1,
        endLine: lineCount,
        text: content,
      });
    }
    wholeFileRung = makeRung("whole-file", wholeSlices);
    rungs.push(wholeFileRung);
  }

  // --- recommended: the cheapest rung whose estTokens is strictly less than the
  //     whole-file rung's; the whole-file rung itself when none qualifies (the
  //     tiny-file case where the precise pack is already ≥ the whole file, so
  //     there's no cheaper-AND-sufficient rung to prefer). When the ladder was
  //     capped below whole-file, the richest built rung stands in as the ceiling.
  // A whole-file rung that read NONE of its files (every read failed — the file
  // was deleted between the pack read and this one, or is otherwise unreadable)
  // is an EMPTY rung: 0 slices, 0 tok. It is not an honest ceiling — preferring
  // it would recommend a rung carrying none of the target's context over a
  // perfectly good (non-empty) pack rung. Treat such a degenerate rung as "no
  // usable ceiling" and fall through to the cheapest non-empty built rung.
  const usableCeiling = wholeFileRung && wholeFileRung.slices.length > 0;
  const ceiling = wholeFileRung ?? rungs[rungs.length - 1]!;
  let recommended = ceiling;
  if (wholeFileRung && usableCeiling) {
    // rungs are cheapest→richest by construction, so the first qualifier is the
    // cheapest. Exclude the ceiling itself from the cheaper-than comparison.
    for (const r of rungs) {
      if (r === wholeFileRung) break;
      if (r.estTokens < wholeFileRung.estTokens) {
        recommended = r;
        break;
      }
    }
    if (recommended === wholeFileRung) {
      notes.push(
        `recommended the whole-file rung (~${wholeFileRung.estTokens} tok): no cheaper rung beats it — the precise pack is not smaller than the files it touches (tiny-file case)`,
      );
    } else {
      notes.push(
        `recommended the \`${recommended.level}\` rung (~${recommended.estTokens} tok) — the cheapest rung below the whole-file baseline (~${wholeFileRung.estTokens} tok)`,
      );
    }
  } else if (wholeFileRung) {
    // The whole-file rung was built but is EMPTY (every file unreadable). It's no
    // ceiling, so recommend the cheapest non-empty built rung instead — never the
    // empty whole-file rung, which carries no context at all.
    recommended = rungs.find((r) => r.slices.length > 0) ?? rungs[0]!;
    notes.push(
      `recommended the \`${recommended.level}\` rung (~${recommended.estTokens} tok) — the whole-file rung read none of its files (unreadable), so it is not a usable baseline`,
    );
  } else {
    // Capped below whole-file (no ceiling to beat). "Recommended" means the
    // cheapest sufficient rung everywhere else, so honor that intent: recommend
    // the CHEAPEST built rung, not the richest (recommending the priciest option
    // under a cost cap would invert the word's meaning for a caller who capped
    // the ladder precisely to save tokens).
    recommended = rungs[0]!;
    notes.push(
      `recommended the \`${recommended.level}\` rung (~${recommended.estTokens} tok) — the cheapest rung built under maxRung:"${maxRung}" (no whole-file baseline to compare against)`,
    );
  }

  return {
    symbol: pack.symbol,
    resolved: pack.resolved,
    rungs,
    recommended,
    notes,
  };
}

/** The outcome of fitting an escalation ladder to a token budget. */
export interface BudgetedRung {
  /** The chosen rung — the RICHEST whose `estTokens` fits the budget, or the
   *  cheapest rung (`pack`) when even that overflows. */
  rung: ContextRung;
  /** `true` when `rung.estTokens <= budget`; `false` when nothing fit and we fell
   *  back to the cheapest rung (which is still over budget — the honest floor). */
  fits: boolean;
  /** The budget asked for (echoed for the caller's logging). */
  budget: number;
}

/**
 * Wire the escalation ladder to a TOKEN BUDGET — the piece a budget-aware
 * orchestrator needs but `buildEscalatingContext` didn't expose. Given a result
 * and a budget, pick the RICHEST rung that fits (`estTokens <= budget`), so the
 * caller spends its context allowance on the most useful slices it can afford
 * without overflowing. When even the cheapest rung is over budget, return it with
 * `fits:false` rather than nothing — the honest "this is the smallest I have, and
 * it's still N tokens" signal, which the caller can act on (skip, or accept the
 * overflow).
 *
 * Pure selector over an already-built {@link EscalationResult} — no DB work.
 */
export function selectRungForBudget(result: EscalationResult, budget: number): BudgetedRung {
  // rungs are cheapest→richest; walk richest→cheapest and take the first that fits.
  for (let i = result.rungs.length - 1; i >= 0; i--) {
    const rung = result.rungs[i]!;
    if (rung.estTokens <= budget) return { rung, fits: true, budget };
  }
  // Nothing fit — the cheapest rung is the honest floor (still over budget).
  return { rung: result.rungs[0]!, fits: false, budget };
}
