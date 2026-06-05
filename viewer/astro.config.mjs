// @ts-check
import { defineConfig, passthroughImageService } from "astro/config";
import preact from "@astrojs/preact";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Prune orphan JS chunks from the static client build. (BL-17 #2.)
//
// Astro's static render pass compiles `.astro` pages + their server runtime
// into JS chunks; a handful of those (the SSR runtime bundled with Astro's
// `code-frame` error formatter — ~183 KB — plus a couple of duplicate
// island/mock chunks) get emitted into the client assets dir (`_a/`) even
// though no page HTML references them. They are dead weight in the shipped
// tree. This integration walks the import graph from the emitted HTML and
// deletes any `_a/*.js` that is unreachable, so `dist/` contains only chunks a
// browser can actually load. Config-only — no new dependency (uses node:fs).
function pruneOrphanChunks() {
  /** @type {import("astro").AstroIntegration} */
  return {
    name: "hayven:prune-orphan-chunks",
    hooks: {
      /** @param {{ dir: URL, logger: { info: (msg: string) => void } }} ctx */
      "astro:build:done": ({ dir, logger }) => {
        const distDir = fileURLToPath(dir);
        const assetsDir = join(distDir, "_a");
        let assetFiles;
        try {
          assetFiles = readdirSync(assetsDir).filter((f) => f.endsWith(".js"));
        } catch {
          return; // no _a dir → nothing to prune
        }

        // Collect every HTML page as a reachability root.
        /** @type {string[]} */
        const htmlFiles = [];
        /** @param {string} d */
        const walk = (d) => {
          for (const name of readdirSync(d)) {
            const p = join(d, name);
            if (statSync(p).isDirectory()) walk(p);
            else if (name.endsWith(".html")) htmlFiles.push(p);
          }
        };
        walk(distDir);

        const chunkRe = /_a\/([A-Za-z0-9_-]+\.js)/g;
        const localRe = /["'](?:\.\/|_a\/)([A-Za-z0-9_-]+\.js)["']/g;
        /**
         * @param {string} src
         * @param {RegExp} re
         * @returns {Set<string>}
         */
        const matchAll = (src, re) => {
          /** @type {Set<string>} */
          const out = new Set();
          for (const m of src.matchAll(re)) if (m[1]) out.add(m[1]);
          return out;
        };

        // BFS from HTML roots through each chunk's imports.
        const roots = new Set();
        for (const h of htmlFiles) {
          for (const c of matchAll(readFileSync(h, "utf8"), chunkRe)) roots.add(c);
        }
        const reachable = new Set();
        const stack = [...roots];
        while (stack.length) {
          const c = stack.pop();
          if (reachable.has(c) || !assetFiles.includes(c)) continue;
          reachable.add(c);
          const src = readFileSync(join(assetsDir, c), "utf8");
          for (const dep of matchAll(src, localRe)) stack.push(dep);
        }

        let freed = 0;
        for (const f of assetFiles) {
          if (reachable.has(f)) continue;
          freed += statSync(join(assetsDir, f)).size;
          rmSync(join(assetsDir, f));
          logger.info(`pruned orphan chunk _a/${f}`);
        }
        if (freed > 0) {
          logger.info(`pruned ${(freed / 1024).toFixed(1)} KB of orphan JS from dist/`);
        }
      },
    },
  };
}

// Hayvenhurst viewer Astro config.
//
// Discipline: every byte costs. We ship static HTML with surgical Preact
// islands. No Tailwind, no icon library, no CSS framework. All styles are
// hand-rolled and scoped via Astro <style> blocks.
//
// The daemon serves `dist/` directly as static assets at localhost:7777.
// We use `output: "static"` so the build is a tree of plain files.
export default defineConfig({
  output: "static",
  // The viewer is SVG-only and never processes raster images, so Astro's
  // default `sharp` image service is pure dead weight. Worse, `sharp` pulls in
  // `@img/sharp-libvips-*` (LGPL-3.0-or-later) — the *only* copyleft dependency
  // in the whole tree (everything else is permissive; see §16(10)). The
  // no-op passthrough service drops sharp entirely, keeping the dependency tree
  // 100% permissive. (BL-17 #1.)
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    preact({
      compat: false,
    }),
    pruneOrphanChunks(),
  ],
  compressHTML: true,
  build: {
    inlineStylesheets: "always",
    assets: "_a",
  },
  vite: {
    build: {
      target: "es2022",
      cssMinify: "esbuild",
      modulePreload: { polyfill: false },
      rollupOptions: {
        output: {
          // Keep filename hashes short to save a few bytes per HTML reference.
          entryFileNames: "_a/[hash:8].js",
          chunkFileNames: (info) => {
            // Pin the renderer to a stable filename so build measurements can
            // verify the PRD §12.3 "renderer stays under ~25KB" budget without
            // grepping hashed chunks. Everything under src/graph/ ends up here.
            if (info.name === "graph-renderer") return "_a/graph-renderer.js";
            return "_a/[hash:8].js";
          },
          assetFileNames: "_a/[hash:8][extname]",
          manualChunks(id) {
            // Bundle the renderer modules (layout, render, interact, viewport,
            // lod) into a single chunk so the PRD §12.3 bundle budget for the
            // *renderer alone* is measurable independent of the rest of the
            // GraphView island (toolbar, degradation panel, etc).
            if (/\/src\/graph\//.test(id)) return "graph-renderer";
            return undefined;
          },
        },
      },
    },
  },
});
