// Pure matching + reachability logic for the orphan-chunk pruner
// (`hayven:prune-orphan-chunks` in astro.config.mjs). Kept free of fs so the
// exact regexes the build relies on are unit-testable; this logic once
// silently deleted the entire client bundle when Astro 7 changed chunk name
// shapes (see the NOTE below and commit 85d232c), so it stays under test.
//
// NOTE: the name may contain DOTS. Astro 5 emitted hash-only chunks
// (`P4Fj0MHm.js`); Astro 7's default naming emits `<name>.<hash>.js`
// (`SearchBox.BC2z29UO.js`). A dot-less character class matches the former
// and NOTHING in the latter, which made every HTML root come back empty,
// marked every chunk unreachable, and deleted the entire client bundle: a
// viewer that renders as dead static HTML while the build exits 0. Keep both
// shapes matchable.
const NAME = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*";

// Matches `_a/<chunk>.js` references in built HTML.
export const chunkRe = () => new RegExp(`_a\\/(${NAME}\\.js)`, "g");
// Matches quoted `./<chunk>.js` / `_a/<chunk>.js` import specifiers in built JS.
export const localRe = () => new RegExp(`["'](?:\\.\\/|_a\\/)(${NAME}\\.js)["']`, "g");

/**
 * @param {string} src
 * @param {RegExp} re
 * @returns {Set<string>}
 */
export function matchAll(src, re) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const m of src.matchAll(re)) if (m[1]) out.add(m[1]);
  return out;
}

/** Chunk names referenced by an HTML page (reachability roots). */
export function htmlChunkRefs(html) {
  return matchAll(html, chunkRe());
}

/** Chunk names imported by a JS chunk's source. */
export function localImportRefs(jsSource) {
  return matchAll(jsSource, localRe());
}

/**
 * BFS from the HTML roots through each chunk's imports; anything in
 * `assetFiles` not reached is an orphan.
 *
 * @param {string[]} assetFiles  `_a/*.js` filenames present on disk
 * @param {string[]} htmlSources contents of every built HTML page
 * @param {(name: string) => string} readChunk  returns a chunk's JS source
 * @returns {{ reachable: Set<string>, orphans: string[] }}
 */
export function computeOrphans(assetFiles, htmlSources, readChunk) {
  const roots = new Set();
  for (const html of htmlSources) {
    for (const c of htmlChunkRefs(html)) roots.add(c);
  }
  const reachable = new Set();
  const stack = [...roots];
  while (stack.length) {
    const c = stack.pop();
    if (reachable.has(c) || !assetFiles.includes(c)) continue;
    reachable.add(c);
    for (const dep of localImportRefs(readChunk(c))) stack.push(dep);
  }
  return { reachable, orphans: assetFiles.filter((f) => !reachable.has(f)) };
}
