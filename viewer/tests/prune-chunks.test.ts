// Regression coverage for the orphan-chunk pruner's matching logic
// (src/build/prune-chunks.mjs, used by hayven:prune-orphan-chunks in
// astro.config.mjs). The exact failure guarded here: a dot-less name pattern
// matched Astro 5's hash-only chunk names (`P4Fj0MHm.js`) but NOTHING in
// Astro 7's `<name>.<hash>.js` shape (`SearchBox.BC2z29UO.js`), so every HTML
// root came back empty, every chunk was classified an orphan, and the pruner
// silently deleted the entire client bundle while the build exited 0
// (commit 85d232c).

import { test, expect, describe } from "bun:test";
import { computeOrphans, htmlChunkRefs, localImportRefs } from "../src/build/prune-chunks.mjs";

// Representative names from both eras, plus the current pinned-name shape.
const ASTRO5 = ["P4Fj0MHm.js", "Cr4brfVl.js", "3nnpGM_F.js"];
const ASTRO7 = ["SearchBox.BC2z29UO.js", "hooks.module.DDVs_TlB.js", "jsxRuntime.module.DC-0aEl7.js"];
const PINNED = ["graph-renderer.js"];

describe("htmlChunkRefs", () => {
  test("matches Astro 5 hash-only chunk names in HTML", () => {
    const html = `<script type="module" src="/_a/P4Fj0MHm.js"></script>
      <astro-island component-url="/_a/Cr4brfVl.js" renderer-url="/_a/3nnpGM_F.js">`;
    expect(htmlChunkRefs(html)).toEqual(new Set(ASTRO5));
  });

  test("matches Astro 7 dotted chunk names in HTML (the 85d232c regression)", () => {
    const html = `<astro-island component-url="/_a/SearchBox.BC2z29UO.js"
      renderer-url="/_a/jsxRuntime.module.DC-0aEl7.js">
      <script type="module" src="/_a/hooks.module.DDVs_TlB.js"></script>`;
    const refs = htmlChunkRefs(html);
    expect(refs).toEqual(new Set(ASTRO7));
    // The regression's exact symptom: roots must NOT come back empty.
    expect(refs.size).toBeGreaterThan(0);
  });

  test("matches the pinned stable renderer name", () => {
    expect(htmlChunkRefs(`import("/_a/graph-renderer.js")`)).toEqual(new Set(PINNED));
  });
});

describe("localImportRefs", () => {
  test("matches relative and _a/ import specifiers in both name shapes", () => {
    const src = `import{h}from"./P4Fj0MHm.js";import"./hooks.module.DDVs_TlB.js";import("_a/graph-renderer.js")`;
    expect(localImportRefs(src)).toEqual(
      new Set(["P4Fj0MHm.js", "hooks.module.DDVs_TlB.js", "graph-renderer.js"]),
    );
  });

  test("ignores unquoted or non-js references", () => {
    expect(localImportRefs(`const s = "./styles.css"; // ./notquoted.js`)).toEqual(new Set());
  });
});

describe("computeOrphans", () => {
  const sources: Record<string, string> = {
    // Astro 7 era: island entry imports the runtime + pinned renderer chunk.
    "SearchBox.BC2z29UO.js": `import{u}from"./hooks.module.DDVs_TlB.js";import("./graph-renderer.js")`,
    "hooks.module.DDVs_TlB.js": `export const u=1;`,
    "graph-renderer.js": `export const render=()=>{};`,
    // Astro 5 era hash-only chunk, referenced directly from HTML.
    "P4Fj0MHm.js": `export default 1;`,
    // A genuinely dead chunk nothing references.
    "DeadWeight.Cabc1234.js": `export const ssr=1;`,
  };
  const assetFiles = Object.keys(sources);
  const readChunk = (name: string) => sources[name] ?? "";

  test("keeps transitively reachable chunks, prunes only true orphans", () => {
    const html = [
      `<astro-island component-url="/_a/SearchBox.BC2z29UO.js"></astro-island>`,
      `<script type="module" src="/_a/P4Fj0MHm.js"></script>`,
    ];
    const { reachable, orphans } = computeOrphans(assetFiles, html, readChunk);
    expect(reachable).toEqual(
      new Set(["SearchBox.BC2z29UO.js", "hooks.module.DDVs_TlB.js", "graph-renderer.js", "P4Fj0MHm.js"]),
    );
    expect(orphans).toEqual(["DeadWeight.Cabc1234.js"]);
  });

  test("HTML referencing only dotted names never yields an empty reachable set", () => {
    // Astro 7 shape only; under the pre-85d232c dot-less pattern this case
    // pruned the whole bundle.
    const html = [`<astro-island component-url="/_a/SearchBox.BC2z29UO.js">`];
    const { reachable, orphans } = computeOrphans(assetFiles, html, readChunk);
    expect(reachable.size).toBeGreaterThan(0);
    expect(orphans).not.toContain("SearchBox.BC2z29UO.js");
  });

  test("chunks referenced in HTML but missing on disk are ignored, not fatal", () => {
    const html = [`<script src="/_a/Gone.Missing1.js"></script>`];
    const { reachable, orphans } = computeOrphans(assetFiles, html, readChunk);
    expect(reachable.size).toBe(0);
    expect(orphans).toEqual(assetFiles);
  });
});
