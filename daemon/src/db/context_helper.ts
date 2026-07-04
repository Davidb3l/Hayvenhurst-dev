/**
 * SURFACE #1 — the public SDK/library context contract.
 *
 * `contextForChange` and `contextForSymbols` are the two entry points every other
 * adoption surface wraps (the MCP server, the transparent proxy). They take the
 * SAME slice packs the packer already assembles (`db/context_pack.ts`) and render
 * them under ONE extra rule that the plain cache-stable renderer
 * (`db/context_cache.ts`) does NOT enforce: **APPEND-ONLY, NEVER-REWRITE**.
 *
 * Why a second rule. `renderStablePacks` gives byte-identical output for the SAME
 * slice SET in any order — perfect for re-asking the IDENTICAL query. But a real
 * builder GROWS its context: it packs `{A}`, then later `{A, B}` (a second changed
 * region, an escalation hop, another symbol). Under the total `(file,line)` order,
 * B's slices sort into the MIDDLE, shifting every byte after the insertion point —
 * which invalidates the cached prompt prefix from that point on (Anthropic's cache
 * needs a byte-identical prefix). The append-only rule fixes exactly this: slices
 * already emitted KEEP their position and bytes, and genuinely-new slices are only
 * ever appended at the END. So as the input grows, the prior render stays a strict
 * byte PREFIX of the new one — the whole prefix is a cache hit; only the appended
 * tail is uncached.
 *
 * The contract, precisely:
 *   - Pass the previous result back as `opts.prior`. The new render preserves the
 *     MAXIMAL leading run of `prior.order` whose spans are still present AND whose
 *     content is unchanged, then appends everything else in the SAME canonical
 *     order the total renderer uses (so the appended tail is itself deterministic,
 *     independent of how the builder assembled the pack).
 *   - `stablePrefixBytes` is the honest cache boundary: the byte length of the
 *     deliberately preserved leading slices (slice-aligned — NOT a raw common-byte
 *     count, which could catch incidental markdown overlap past the last kept
 *     slice). `priorFullyPreserved` is `true` exactly when every prior slice was
 *     kept — i.e. the whole prior render is a byte prefix of the new one (a pure
 *     append, or no growth at all).
 *   - HONESTY about the one case append-only cannot win: if a span that was in the
 *     prior render had its underlying file edited across the cache TTL (its bytes
 *     changed) — or was removed because the change/symbol set SHRANK — the prefix
 *     can no longer be preserved past that slice. The contract then preserves
 *     everything BEFORE it and re-renders from it onward; `priorFullyPreserved`
 *     goes `false` and `stablePrefixBytes` reports exactly how much survived.
 *     Correctness (the slice must reflect current source) always wins over cache
 *     affinity — we never ship stale bytes to keep a hit.
 *   - With NO `prior`, the output is BYTE-IDENTICAL to `renderStablePacks` of the
 *     same pack (append-only is a strict generalization of the total order).
 *
 * No embeddings, no model, no run-varying data in the bytes — the same exact,
 * line-exact slices, rendered for incremental cache reuse.
 */
import { createHash } from "node:crypto";

import {
  canonicalSlices,
  compareSlices,
  deriveFenceLang,
  renderSliceBlock,
  sliceKey,
} from "./context_cache.ts";
import {
  buildContextPackForChange,
  buildContextPackForSymbols,
  estimateTokens,
  type ChangeRegion,
  type ContextPackOptions,
  type ContextSlice,
} from "./context_pack.ts";
import type { Db } from "./queries.ts";

/** A compact, serializable identity for one rendered slice — the CONTINUATION
 *  TOKEN that carries render order across calls. Pass the whole
 *  {@link StableContextResult} (which holds `order`) back as `opts.prior`; this
 *  is the per-slice element of that order. */
export interface SliceRef {
  /** Why the slice is in the pack (mirrors {@link ContextSlice.role}). */
  role: ContextSlice["role"];
  /** Repo-relative source file. */
  file: string;
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based inclusive last line. */
  endLine: number;
  /** Neighbor provenance, when present (mirrors {@link ContextSlice.via}). */
  via?: ContextSlice["via"];
  /** Edge weight, when present (mirrors {@link ContextSlice.weight}). */
  weight?: number;
  /** sha256 of the slice's RENDERED block (header + fence + text) — the unit of
   *  cache bytes. A later call compares this against the freshly-rendered block
   *  for the same span to detect that the underlying source changed across the
   *  TTL (which honestly ends the preserved prefix at that slice). */
  blockHash: string;
}

/** The append-only, cache-stable context result — the stable result shape every
 *  Surface-#1 caller receives. */
export interface StableContextResult {
  /** The rendered context block to embed in a prompt prefix. When built with a
   *  `prior`, its first {@link stablePrefixBytes} bytes equal `prior.text`. */
  text: string;
  /** sha256 hex of {@link text} — the cache-reuse decision key. */
  contentKey: string;
  /** chars/4 token proxy of {@link text} (the same proxy the packer uses). */
  estTokens: number;
  /** The slices in render order — the continuation token. Pass the whole result
   *  back as `opts.prior` on the next, larger call to enforce append-only. */
  order: SliceRef[];
  /** The honest, SLICE-ALIGNED cache boundary: the byte length of the leading
   *  slices preserved from `prior` (deliberately kept, not an incidental common-
   *  byte count). `0` when there was no `prior` or the first prior slice changed.
   *  Equals `prior.text`'s byte length on a pure append. */
  stablePrefixBytes: number;
  /** `true` when the ENTIRE prior render was preserved as a prefix (a pure
   *  append, or no growth at all); `false` when an edited/removed prior slice
   *  forced a partial re-render. Always `true` when there was no `prior`. */
  priorFullyPreserved: boolean;
  /** Non-fatal notes carried up from the underlying pack (unresolved symbols,
   *  truncations, whole-file fallback, etc.). */
  notes: string[];
}

/** Options for {@link contextForChange} / {@link contextForSymbols}: the packer's
 *  options plus the append-only continuation + an optional fence-language hook. */
export type StableContextOptions = ContextPackOptions & {
  /** The previous result to extend. When set, the render is APPEND-ONLY against
   *  it: the maximal unchanged leading run of `prior.order` is preserved and new
   *  slices are appended. Omit for a fresh (total-order-equivalent) render. */
  prior?: StableContextResult;
  /** Override the fenced-code-block language token per file (defaults to the
   *  extension map in {@link deriveFenceLang}). Must be deterministic — it feeds
   *  the rendered bytes. */
  fenceLangFor?: (file: string) => string;
};

/** Render a canonicalized slice set under the append-only rule. Shared by both
 *  public entry points so `change` and `symbols` continuations are interchangeable
 *  (a `prior` from either can extend a render from the other — the rule keys on
 *  slice identity, not on how the slice was produced). */
function renderAppendOnly(
  slices: ContextSlice[],
  prior: StableContextResult | undefined,
  notes: string[],
  fenceLangFor?: (file: string) => string,
): StableContextResult {
  const lang = (file: string): string =>
    fenceLangFor ? fenceLangFor(file) : deriveFenceLang(file);

  // 1. CANONICALIZE the new set: dedup by span, one deterministic winner per
  //    (file,start,end). Same function the total renderer uses → a no-prior
  //    render is byte-identical to renderStablePacks of the same pack.
  const canon = canonicalSlices(slices);
  const byKey = new Map<string, ContextSlice>();
  const blockByKey = new Map<string, string>();
  const hashByKey = new Map<string, string>();
  for (const s of canon) {
    const k = sliceKey(s);
    const block = renderSliceBlock(s, lang(s.file));
    byKey.set(k, s);
    blockByKey.set(k, block);
    hashByKey.set(k, createHash("sha256").update(block).digest("hex"));
  }

  // 2. KEEP — the maximal leading run of prior.order still present AND unchanged.
  //    The FIRST prior ref that's gone (set shrank) or whose content changed
  //    (file edited across the TTL) ends the preserved prefix: never-rewrite means
  //    everything before it is byte-stable; it and the rest fall into the tail.
  const ordered: ContextSlice[] = [];
  const consumed = new Set<string>();
  if (prior) {
    for (const ref of prior.order) {
      const k = sliceKey(ref);
      const cur = byKey.get(k);
      if (!cur) break; // span removed → prefix break
      if (hashByKey.get(k) !== ref.blockHash) break; // content changed → prefix break
      ordered.push(cur);
      consumed.add(k);
    }
  }
  const keepCount = ordered.length; // preserved leading slices (KEEP run length)

  // 3. APPEND — every remaining slice (leftover prior refs past the break +
  //    genuinely-new spans), in canonical order so the appended TAIL is itself
  //    deterministic regardless of the builder's assembly order.
  const tail = canon.filter((s) => !consumed.has(sliceKey(s)));
  tail.sort(compareSlices);
  ordered.push(...tail);

  // 4. RENDER in the chosen order (reusing each slice's already-computed block).
  const text = ordered.map((s) => blockByKey.get(sliceKey(s))!).join("\n\n");
  const contentKey = createHash("sha256").update(text).digest("hex");
  const estTokens = ordered.length > 0 ? estimateTokens(text.length) : estimateTokens(0);

  // 5. The honest cache boundary, SLICE-ALIGNED: the bytes of the deliberately
  //    preserved KEEP run (the first `keepCount` blocks). We report this rather
  //    than the raw longest-common-byte prefix because two unrelated renders can
  //    share incidental leading bytes (e.g. both blocks open with `### `) past the
  //    last preserved slice — real at the byte level but not a boundary the
  //    contract guarantees or a builder should trust. The KEEP run, by
  //    construction, renders byte-identical to prior's leading blocks, so on a pure
  //    append this equals `prior.text`'s byte length; on a break it's exactly the
  //    surviving slices' bytes (0 when the very first prior slice changed/vanished).
  let stablePrefixBytes = 0;
  if (keepCount > 0) {
    const keptBlocks = ordered
      .slice(0, keepCount)
      .map((s) => blockByKey.get(sliceKey(s))!)
      .join("\n\n");
    stablePrefixBytes = Buffer.byteLength(keptBlocks, "utf8");
  }
  // The full prior render survives as a prefix exactly when EVERY prior slice was
  // kept (none removed, none edited). With no prior there was nothing to preserve.
  const priorFullyPreserved = prior ? keepCount === prior.order.length : true;

  const order: SliceRef[] = ordered.map((s) => {
    const ref: SliceRef = {
      role: s.role,
      file: s.file,
      startLine: s.startLine,
      endLine: s.endLine,
      blockHash: hashByKey.get(sliceKey(s))!,
    };
    if (s.via !== undefined) ref.via = s.via;
    if (s.weight !== undefined) ref.weight = s.weight;
    return ref;
  });

  return { text, contentKey, estTokens, order, stablePrefixBytes, priorFullyPreserved, notes };
}

/**
 * The public "I'm changing these regions of this file" contract. Builds the
 * change pack ({@link buildContextPackForChange} — smallest-enclosing-entity /
 * straddle / module-frame classification + the never-worse-than-the-file Lane-3
 * guarantee) and renders it under the append-only rule.
 *
 * Returns `null` only when nothing resolves (no entity root AND no readable
 * module frame) — exactly the null condition of the underlying builder.
 *
 * Append-only across a growing change set: pass the previous result as
 * `opts.prior` and the new render extends it without rewriting the preserved
 * prefix (see the module doc).
 */
export function contextForChange(
  db: Db,
  repoRoot: string,
  file: string,
  regions: ChangeRegion[],
  opts: StableContextOptions = {},
): StableContextResult | null {
  const { prior, fenceLangFor, ...packOpts } = opts;
  const pack = buildContextPackForChange(db, repoRoot, file, regions, packOpts);
  if (!pack) return null;
  return renderAppendOnly(pack.slices, prior, [...pack.notes], fenceLangFor);
}

/**
 * The public "I need context for these symbols" contract. Builds the multi-root
 * pack ({@link buildContextPackForSymbols} — each resolved root's body + its
 * 1-hop callee/ref deps, deduped across roots, one shared module skeleton per
 * file) and renders it under the append-only rule.
 *
 * Returns `null` only when NO id resolves (the underlying builder's null
 * condition). Append-only across a growing symbol set works exactly as in
 * {@link contextForChange} — pass the prior result as `opts.prior`.
 */
export function contextForSymbols(
  db: Db,
  repoRoot: string,
  symbols: string[],
  opts: StableContextOptions = {},
): StableContextResult | null {
  const { prior, fenceLangFor, ...packOpts } = opts;
  const pack = buildContextPackForSymbols(db, repoRoot, symbols, packOpts);
  if (!pack) return null;
  return renderAppendOnly(pack.slices, prior, [...pack.notes], fenceLangFor);
}
