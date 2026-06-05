# Hayvenhurst Viewer

Astro 5 + Preact viewer served by the Hayvenhurst daemon at `localhost:7777`.

## Build

```sh
cd viewer
bun install
bun run build      # → viewer/dist/
bun run dev        # → http://localhost:4321 (uses mocks if no daemon)
bun test           # → 50 tests across layout, mocks, markdown, viewport, LOD, degradation
```

The daemon mounts `dist/` as static assets. For node-detail URLs, the daemon
serves a single SPA-style fallback: **`GET /node/* → dist/node/index.html`**.
There is no per-id rewrite and no viewer-supplied seed list; the shell HTML
parses the id from `window.location.pathname` on hydration and fetches the
detail from the daemon API.

## What's where

```
src/
├── layouts/Base.astro          shared HTML shell, theme bootstrap, nav
├── pages/
│   ├── index.astro             overview (Stats island)
│   ├── graph.astro             interactive SVG graph (GraphView island)
│   ├── node/[...id].astro      single shell page served for every /node/*
│   ├── search.astro            search results
│   ├── claims.astro            claim board (placeholder, Week 7)
│   └── peers.astro             peer sync (placeholder, Week 6)
├── components/
│   ├── GraphView.tsx           SVG renderer + clustering/culling/LOD wiring
│   ├── GraphDegradation.tsx    "this is too many nodes" action panel
│   ├── NodeShell.tsx           detail view (URL-derived id, daemon fetch)
│   ├── Stats.tsx               live counts on the overview
│   ├── SearchBox.tsx, SearchResults.tsx
│   └── useQuery.ts             hand-rolled query cache (no TanStack)
├── graph/                      SVG-only renderer, split out for testability
│   ├── layout.ts               Barnes-Hut force-directed sim (deterministic)
│   ├── render.ts               SVG draw + reconcile (mount/unmount + tiers)
│   ├── interact.ts             pan/zoom + screen-to-graph mapping
│   ├── viewport.ts             culling: visible-rect math, point-in-rect
│   ├── lod.ts                  progressive-rendering tier rules
│   └── degradation.ts          >2k-node trigger rule (pure, unit-tested)
├── api/
│   ├── client.ts               daemon HTTP client; falls back to mocks
│   ├── types.ts                wire contracts (NeighborsResponse, ClusterMode…)
│   └── mocks.ts                seed dataset for SSG + offline dev
├── util/md.ts                  tiny markdown → HTML (escapes, wiki links)
└── styles/global.css           hand-rolled CSS, dark/light variables
```

## Bundle budgets (measured on this build)

| Page                  | HTML  | JS raw | JS gz  | Budget         |
|-----------------------|------:|-------:|-------:|---------------|
| `/`                   |  11K  |  33K   |  14K   | <20K / <50K   |
| `/graph`              |  10K  |  48K   |  20K   | <20K / <100K  |
| `/node`               |  10K  |  34K   |  15K   | <20K / <50K   |
| `/search`             |  10K  |  24K   |  11K   | <20K / <50K   |
| `/claims`, `/peers`   |  7K   |  0     |  0     | <20K / <50K   |

**Renderer-only chunk** (`dist/_a/graph-renderer.js`, all of `src/graph/`): **7K
raw / 3K gz** — well under the §12.3 budget of ~25K minified. The `/graph`
total includes the GraphView island, GraphDegradation panel, Preact hooks,
API client, mock dataset, and Astro client runtime.

Run `bun tests/_measure.ts` after a build to verify.

## Renderer (PRD §12.3)

SVG is the only rendering path. No `<canvas>`, no WebGPU, no Canvas hit
testing, no parallel a11y layer. Three LOD techniques keep the visible-DOM
node count under ~1k regardless of underlying graph size:

1. **Semantic clustering.** `GET /api/neighbors/:id?cluster=auto|off|module`
   — viewer ships an auto/off/module toggle. Cluster nodes render with their
   member count ("auth (5 fns)"); double-click to expand to a scoped
   function-level view of just that module.
2. **Viewport culling.** Only nodes whose layout positions fall inside the
   visible graph-space rect (plus a 200px screen-margin buffer) are mounted.
   Pan/zoom triggers re-cull → mount/unmount, not `display:none`.
3. **Progressive rendering.** Three tiers; transitions are CSS-class swaps
   on existing node groups, not re-mounts.
   - Tier 0: 2px dot, no label, no hover, no ARIA, no tab stop.
   - Tier 1: zoom ≥ 1.5 — labeled node with ARIA + tabindex.
   - Tier 2: hovered/focused/selected — full styling + edge highlighting.

If a query would render >2k visible nodes with clustering off, the
`GraphDegradation` panel replaces the renderer with four action buttons:
re-enable clustering, filter by module, reduce depth, or jump to search.

## Deliberate non-choices

- **No CSS framework.** No Tailwind, no styled-components.
- **No icon library.** Inline SVG.
- **No charting/graph library.** Custom Barnes-Hut force layout.
- **No `@tanstack/query-core`.** 80-line hand-rolled hook (`useQuery.ts`).
- **No markdown library.** `util/md.ts` is 60 lines.
- **No Canvas renderer.** SVG end-to-end; LOD covers every real-world load.

## Theme

Dark by default. Toggle in nav writes to `localStorage["hv-theme"]`. The
bootstrap script in `Base.astro` reads it pre-paint to avoid flash.
