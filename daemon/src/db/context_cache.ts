/**
 * Cache-stable pack rendering (Phase 0.0.4.5 follow-on — the cache-affinity win).
 *
 * Anthropic's prompt cache has a ~5-minute TTL: any gap re-sends the prompt
 * prefix at FULL price unless the prefix is BYTE-identical to the cached one.
 * Hayvenhurst's context packs (`db/context_pack.ts`) are embedding-free and
 * deterministic, so we can render them in a TOTAL deterministic order and place
 * the result in a cacheable prompt PREFIX — turning the determinism the pivot
 * already bought us into a measurable cache-affinity property: the same
 * symbol+graph yields byte-identical text across the TTL, so the prefix stays a
 * cache hit (the win for token-constrained orchestrators that re-issue packs).
 *
 * This module makes that rendering CANONICAL. Three things matter and are
 * load-bearing for the cache property:
 *   1. TOTAL ordering — slices are emitted sorted by `(file, startLine, endLine,
 *      role)`, INDEPENDENT of the input slice/pack order, so re-running the
 *      builder (which may rank neighbors by call-weight, a run-varying order)
 *      can never change the rendered bytes.
 *   2. DEDUP — overlapping slices across packs collapse to one (first after
 *      sorting wins), so combining packs is order-insensitive AND idempotent.
 *   3. NO run-varying data — no timestamps, no absolute paths, no estimated
 *      counts inside the text. Only repo-relative files + 1-based line ranges.
 *
 * The `contentKey` (sha256 of the rendered text) lets a builder decide cache
 * reuse cheaply; `cachePrefixKey(symbols, graphVersion)` is the complementary
 * up-front key — a builder can compute it from (the symbols it's about to pack,
 * the current graph version) BEFORE rendering, to decide whether a previously
 * cached prefix can be reused at all.
 */
import { createHash } from "node:crypto";

import { type ContextPack, type ContextSlice } from "./context_pack.ts";

/** A canonical, byte-stable render of one-or-more packs, plus its content key. */
export interface StableRender {
  /** Canonical, byte-stable rendered context block (suitable for a cacheable
   *  prompt prefix). Re-rendering the same symbol+graph yields identical bytes. */
  text: string;
  /** sha256 hex of `text` — the cache-reuse decision key for a builder. */
  contentKey: string;
  /** Cheap token proxy (chars/4, the same proxy `context_pack.ts` uses). */
  estTokens: number;
}

/** Role rank for the TOTAL slice ordering: header before target before
 *  neighbor. A stable tie-break after `(file, startLine, endLine)` so two
 *  slices that somehow share a range still sort deterministically. */
const ROLE_RANK: Record<ContextSlice["role"], number> = {
  header: 0,
  "module-frame": 0,
  target: 1,
  neighbor: 2,
};

/** Derive a fenced-code-block language token from a file's extension. Returns
 *  the empty string for anything unrecognised (an empty info-string is still a
 *  valid fence — the determinism is what matters, not syntax highlighting). */
export function deriveFenceLang(file: string): string {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts")) return "typescript";
  if (file.endsWith(".py")) return "python";
  if (file.endsWith(".rs")) return "rust";
  if (file.endsWith(".go")) return "go";
  return "";
}

/** The stable dedup key for a slice — its repo-relative file + 1-based inclusive
 *  line range. Two slices with the same key are the same span (so the same
 *  symbol reached via two packs collapses to one). Exported so the append-only
 *  contract ({@link file://./context_helper.ts}) keys prior-vs-new slices the
 *  SAME way this module dedups them. */
export function sliceKey(
  s: Pick<ContextSlice, "file" | "startLine" | "endLine">,
): string {
  return `${s.file}:${s.startLine}-${s.endLine}`;
}

/**
 * The TOTAL deterministic slice order: `(file asc, startLine asc, endLine asc,
 * role rank)`. This is INDEPENDENT of the input order — the comparator never
 * looks at array position — so reordering the input slices (or the input packs)
 * cannot change the output, which is exactly the cache-survivability property.
 */
export function compareSlices(a: ContextSlice, b: ContextSlice): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  if (a.endLine !== b.endLine) return a.endLine - b.endLine;
  if (a.role !== b.role) return ROLE_RANK[a.role] - ROLE_RANK[b.role];
  // FINAL tie-break on text: two slices can share the same (file,start,end,role)
  // but carry DIFFERENT text — e.g. the same span packed at two different times
  // across the cache TTL, after the file was edited. Without this, `Array.sort`
  // is stable, so dedup would keep whichever variant came FIRST in the input,
  // making the render input-order-dependent and defeating the byte-stability the
  // whole module promises. Ordering on text picks a deterministic winner.
  if (a.text !== b.text) return a.text < b.text ? -1 : 1;
  // Same span + role + text, but DIFFERENT provenance — `via`/`weight` are part
  // of the rendered HEADER, so two such slices render different bytes. They reach
  // here as the same dedup key (file:start-end), so without a tie-break here dedup
  // keeps whichever came first in INPUT order and the render becomes input-order-
  // dependent again. This is reachable: the same callee body can arrive as a
  // `via:"call"` neighbor from one pack and a `via:"ref"` neighbor from another
  // when packs are combined. Order on (via, weight) so the winner is deterministic.
  const aVia = a.via ?? "";
  const bVia = b.via ?? "";
  if (aVia !== bVia) return aVia < bVia ? -1 : 1;
  const aW = a.weight ?? -1;
  const bW = b.weight ?? -1;
  if (aW !== bW) return aW - bW;
  return 0;
}

/**
 * Sort (canonical order) + dedup (first occurrence after sorting wins) a flat
 * list of slices. Shared by both render entry points so a single pack and a
 * combined set of packs go through the identical canonicalisation.
 */
export function canonicalSlices(slices: ContextSlice[]): ContextSlice[] {
  // Sort a COPY — never mutate the caller's pack. The sort is total, so the
  // result is a function of the slice SET, not the input order.
  const sorted = [...slices].sort(compareSlices);
  const seen = new Set<string>();
  const out: ContextSlice[] = [];
  for (const s of sorted) {
    const key = sliceKey(s);
    if (seen.has(key)) continue; // first after sorting wins → order-insensitive dedup
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Render ONE slice as a fenced block with a STABLE, deterministic header. The
 * header carries only run-INVARIANT facts — repo-relative file, 1-based line
 * range, role, and (when present) the `via`/`weight` provenance — never a
 * timestamp, absolute path, or estimated count. Shape:
 *
 *   ### {file}:{start}-{end} ({role}[ via {via}][ weight {n}])
 *   ```{lang}
 *   {text}
 *   ```
 *
 * `via`/`weight` are appended only when the slice actually carries them, so a
 * header slice and a callee neighbor render their own stable, distinguishable
 * provenance without any run-varying noise.
 *
 * Exported so the append-only contract ({@link file://./context_helper.ts})
 * renders each slice's block with the IDENTICAL byte format — the property that
 * makes a no-prior append-only render byte-for-byte equal to the total-order
 * render here.
 */
export function renderSliceBlock(s: ContextSlice, lang: string): string {
  let provenance = s.role as string;
  if (s.via !== undefined) provenance += ` via ${s.via}`;
  if (s.weight !== undefined) provenance += ` weight ${s.weight}`;
  const head = `### ${s.file}:${s.startLine}-${s.endLine} (${provenance})`;
  return `${head}\n\`\`\`${lang}\n${s.text}\n\`\`\``;
}

/**
 * Render a canonicalised slice list to the final `StableRender`. Blocks are
 * joined with a single blank line (`\n\n`); the text is the cache-prefix
 * payload, `contentKey` its sha256, `estTokens` the chars/4 proxy.
 */
function renderCanonical(
  slices: ContextSlice[],
  fenceLangFor?: (file: string) => string,
): StableRender {
  const lang = (file: string): string =>
    fenceLangFor ? fenceLangFor(file) : deriveFenceLang(file);
  const text = slices.map((s) => renderSliceBlock(s, lang(s.file))).join("\n\n");
  const contentKey = createHash("sha256").update(text).digest("hex");
  const estTokens = Math.ceil(text.length / 4);
  return { text, contentKey, estTokens };
}

/**
 * Render ONE pack to a byte-stable string for a cacheable prompt prefix.
 *
 * Slices are emitted in the TOTAL deterministic order and deduped, so the same
 * symbol+graph always yields byte-identical text (cache-survivable across the
 * TTL) regardless of the order the builder happened to assemble the pack in.
 */
export function renderStablePack(
  pack: ContextPack,
  fenceLangFor?: (file: string) => string,
): StableRender {
  return renderCanonical(canonicalSlices(pack.slices), fenceLangFor);
}

/**
 * Combine multiple packs into one canonical, deduped, ORDER-INSENSITIVE block.
 *
 * All input slices are pooled, then sorted + deduped by the same total order as
 * {@link renderStablePack}. Because the order is a function of the slice SET (not
 * the pack/array order), `renderStablePacks(packs)` and `renderStablePacks` of
 * the same packs in any other order produce IDENTICAL bytes — the property a
 * multi-pack cacheable prefix needs.
 */
export function renderStablePacks(
  packs: ContextPack[],
  fenceLangFor?: (file: string) => string,
): StableRender {
  const pooled: ContextSlice[] = [];
  for (const p of packs) pooled.push(...p.slices);
  return renderCanonical(canonicalSlices(pooled), fenceLangFor);
}

/**
 * A stable cache-prefix key for `(symbols, graph-version)` so a builder can
 * decide cache reuse BEFORE rendering. Deterministic regardless of the input
 * symbol order — symbols are sorted before hashing — so the same set of symbols
 * at the same graph version always yields the same key, while a graph-version
 * bump invalidates it.
 */
export function cachePrefixKey(symbols: string[], graphVersion: string): string {
  const payload = JSON.stringify([...symbols].sort()) + "@" + graphVersion;
  return createHash("sha256").update(payload).digest("hex");
}
