// @ts-check
import { defineConfig, passthroughImageService } from "astro/config";
import preact from "@astrojs/preact";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { computeOrphans } from "./src/build/prune-chunks.mjs";

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

        // BFS from HTML roots through each chunk's imports. The matching +
        // reachability logic lives in src/build/prune-chunks.mjs so it is
        // unit-tested against both Astro 5 (`P4Fj0MHm.js`) and Astro 7
        // (`SearchBox.BC2z29UO.js`) chunk-name shapes; a dot-less pattern
        // once deleted the entire client bundle (commit 85d232c).
        const { orphans } = computeOrphans(
          assetFiles,
          htmlFiles.map((h) => readFileSync(h, "utf8")),
          (name) => readFileSync(join(assetsDir, name), "utf8"),
        );

        let freed = 0;
        for (const f of orphans) {
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
    // Astro 7 builds the client bundle in a dedicated Vite "client"
    // environment and layers its own `[name].[hash].js` naming ON TOP of any
    // top-level rollupOptions.output, so filename overrides placed there are
    // silently ignored. The environment-scoped output below is the one spread
    // LAST in Astro's build config (see astro/dist/core/build/
    // vite-build-config.js, client environment), so it is the only place these
    // naming overrides are honored.
    environments: {
      client: {
        build: {
          rolldownOptions: {
            output: {
              // Keep filename hashes short to save a few bytes per HTML
              // reference.
              entryFileNames: "_a/[hash:8].js",
              chunkFileNames: (info) => {
                // Pin the renderer to a stable filename so build measurements
                // can verify the PRD §12.3 "renderer stays under ~25KB" budget
                // without grepping hashed chunks. Everything under src/graph/
                // ends up here (see manualChunks above).
                if (info.name === "graph-renderer") return "_a/graph-renderer.js";
                return "_a/[hash:8].js";
              },
              assetFileNames: "_a/[hash:8][extname]",
            },
          },
        },
      },
    },
  },
});
