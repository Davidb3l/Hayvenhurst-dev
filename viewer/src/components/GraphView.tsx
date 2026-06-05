// The interactive graph view.
//
// Wires together the four moving pieces of PRD §12.3:
//   1. Semantic clustering — `cluster=auto|off|module` toolbar; cluster-level
//      nodes show "(N fns)" and double-click expands their module.
//   2. Viewport culling — every pan/zoom recomputes the visible rect and only
//      nodes inside it (plus a 200px screen-margin buffer) are mounted.
//   3. Progressive rendering — three tiers driven by zoom + interaction; tier
//      transitions are CSS-class swaps on existing groups, not re-mounts.
//   4. Graceful degradation — `total_raw_nodes > 2000 && cluster_level ==
//      "function"` shows GraphDegradation instead of the renderer.
//
// SVG is the only rendering path. There is no <canvas>, no Canvas fallback,
// no Canvas hit-testing. Per PRD §16 bullet 8.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, qk } from "~/api/client";
import type { ClusterMode } from "~/api/types";
import { useQuery } from "./useQuery";
import GraphDegradation from "./GraphDegradation";
import {
  buildSim,
  defaultOptions,
  energy,
  step,
} from "~/graph/layout";
import { applyViewport, attachPanZoom, defaultViewport, type Viewport } from "~/graph/interact";
import { ZOOM_TIER1_THRESHOLD, type InteractionState } from "~/graph/lod";
import {
  initScene,
  reconcileEdges,
  reconcileNodes,
  type NodeMeta,
  type SceneHandles,
} from "~/graph/render";
import { cullIndices, visibleRect } from "~/graph/viewport";
import { shouldDegrade } from "~/graph/degradation";

export default function GraphView({ initialId = "*" }: { initialId?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);

  const [centerId, setCenterId] = useState(initialId);
  const [cluster, setCluster] = useState<ClusterMode>("auto");
  const [depth, setDepth] = useState(2);
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 520 });

  const q = useQuery({
    queryKey: qk.neighbors(centerId, { cluster, depth, ...(scope ? { scope } : {}) }),
    queryFn: () => api.neighbors(centerId, { cluster, depth, ...(scope ? { scope } : {}) }),
  });

  // Resize observer — keeps `size` in sync with the container's box.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(320, r.width), h: Math.max(360, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Should we render the graceful-degradation panel instead?
  const tooMany = shouldDegrade(q.data);

  return (
    <div class="hv-graph">
      <Toolbar
        centerId={centerId}
        onCenter={setCenterId}
        cluster={cluster}
        onCluster={setCluster}
        depth={depth}
        onDepth={setDepth}
        scope={scope}
        onScope={setScope}
        clusterLevel={q.data?.cluster_level}
        totalRaw={q.data?.total_raw_nodes}
      />
      <div ref={containerRef} class="hv-graph-stage">
        {tooMany ? (
          <GraphDegradation
            totalNodes={q.data!.total_raw_nodes}
            onReenableCluster={() => setCluster("auto")}
            onApplyScope={(s) => setScope(s)}
            canReduceDepth={depth > 1}
            onReduceDepth={() => setDepth((d) => Math.max(1, d - 1))}
          />
        ) : (
          <Scene
            svgRef={svgRef}
            gRef={gRef}
            size={size}
            data={q.data}
            isLoading={q.isLoading}
            error={q.error}
            onCenter={(id) => {
              // Expanding a module: drop into cluster=off scoped to that module.
              if (q.data?.cluster_level === "module") {
                setScope(id);
                setCluster("off");
              } else {
                setCenterId(id);
              }
            }}
          />
        )}
        {!tooMany && <GraphLegend />}
      </div>
      <style>{`
        .hv-graph { display: flex; flex-direction: column; gap: 10px; }
        .hv-graph-stage {
          position: relative;
          height: 70vh; min-height: 420px;
          background: var(--bg-elev);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .hv-graph-stage svg { display: block; }
        .hv-overlay {
          position: absolute; left: 50%; top: 50%;
          transform: translate(-50%, -50%);
          padding: 8px 12px;
          background: var(--bg-elev-2);
          border-radius: var(--radius);
        }
        .hv-side {
          position: absolute; right: 12px; top: 12px;
          min-width: 220px; max-width: 320px;
          background: var(--bg-elev-2);
        }
        /* Persistent interaction legend — subtle, blends with the terminal
           aesthetic, sits bottom-left of the canvas so it never overlaps the
           selection card (top-right). ~0.6 opacity, lifts on hover/focus. */
        .hv-legend {
          position: absolute; left: 12px; bottom: 12px;
          z-index: 2;
          padding: var(--space-2) var(--space-3);
          font-family: var(--font-mono); font-size: 0.7rem;
          color: var(--fg-faint);
          background: color-mix(in srgb, var(--bg-elev-2) 80%, transparent);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          backdrop-filter: blur(6px);
          opacity: 0.6;
          transition: opacity 0.18s ease;
          pointer-events: none;
          max-width: 220px;
        }
        .hv-graph-stage:hover .hv-legend,
        .hv-graph-stage:focus-within .hv-legend { opacity: 0.95; }
        .hv-legend ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
        .hv-legend li { display: flex; align-items: center; gap: var(--space-2); white-space: nowrap; }
        .hv-legend .hv-legend-title {
          font-size: 0.62rem; letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--fg-faint); margin: 0 0 var(--space-1);
        }
        .hv-legend .hv-legend-title::before { content: "[ "; }
        .hv-legend .hv-legend-title::after { content: " ]"; }
        .hv-legend svg { flex: 0 0 auto; color: var(--accent); }
        .hv-legend .k {
          font-size: 0.62rem; padding: 0 4px; border-radius: 4px;
          border: 1px solid var(--border-2); color: var(--fg-dim);
          line-height: 1.5;
        }
        /* LOD tier styling. Tier 0 nodes get no hover affordance — they are
           informational dots. Tier 1+ get the focus ring + cursor. */
        .hv-n0 { pointer-events: none; }
        .hv-n1, .hv-n2 { cursor: pointer; }
        .hv-n1 circle { stroke: var(--bg-elev-2); stroke-width: 1; transition: stroke-width 0.1s; }
        .hv-n2 circle { stroke: var(--accent); stroke-width: 2; transition: stroke-width 0.1s; }
        .hv-n1:focus, .hv-n2:focus { outline: none; }
        /* Hover / focus: thicker accent stroke + a phosphor drop-shadow glow so
           the active node is unmistakable at mid-zoom, in both themes. The glow
           rides the CSS filter on the <g> (circle + label move together). */
        .hv-n1:hover, .hv-n2:hover,
        .hv-n1:focus-visible, .hv-n2:focus-visible,
        .hv-n1:focus, .hv-n2:focus {
          filter: drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 2px var(--accent));
        }
        .hv-n1:hover circle, .hv-n2:hover circle,
        .hv-n1:focus circle, .hv-n2:focus circle {
          stroke: var(--accent); stroke-width: 3;
        }
      `}</style>
    </div>
  );
}

/**
 * Persistent, subtle interaction legend overlaid inside the graph container.
 * Surfaces pan / zoom / click / double-click / keyboard affordances that were
 * previously only in a muted paragraph above the canvas. Inline SVG glyphs only
 * (PRD §2.4 — no icon libs). Decorative; the SVG already carries the full
 * aria-label, so this is aria-hidden to avoid double-announcing to AT.
 */
function GraphLegend() {
  return (
    <aside class="hv-legend" aria-hidden="true">
      <div class="hv-legend-title">controls</div>
      <ul>
        <li>
          {/* four-way move = pan */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 2v12M2 8h12M8 2 6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2" />
          </svg>
          <span>drag — pan</span>
        </li>
        <li>
          {/* magnifier = zoom */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m11 11 3.5 3.5M5.2 7h3.6M7 5.2v3.6" />
          </svg>
          <span>scroll — zoom</span>
        </li>
        <li>
          {/* pointer = click */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 2.5 12.5 7 8 8.3l-1.6 4.2z" />
          </svg>
          <span>click — inspect</span>
        </li>
        <li>
          {/* target = double-click re-center */}
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="8" r="5.5" />
            <circle cx="8" cy="8" r="1.6" />
          </svg>
          <span>dbl-click — re-center</span>
        </li>
        <li>
          <span class="k">Tab</span>
          <span class="k">↑↓←→</span>
          <span>navigate</span>
        </li>
        <li>
          <span class="k">Enter</span>
          <span class="k">Esc</span>
          <span>open / clear</span>
        </li>
      </ul>
    </aside>
  );
}

interface ToolbarProps {
  centerId: string;
  onCenter: (id: string) => void;
  cluster: ClusterMode;
  onCluster: (c: ClusterMode) => void;
  depth: number;
  onDepth: (d: number) => void;
  scope: string | undefined;
  onScope: (s: string | undefined) => void;
  clusterLevel: "function" | "module" | undefined;
  totalRaw: number | undefined;
}

function Toolbar(p: ToolbarProps) {
  return (
    <div class="hv-graph-toolbar">
      <input
        class="search-input"
        style={{ maxWidth: "240px" }}
        placeholder="Center on node id"
        value={p.centerId === "*" ? "" : p.centerId}
        onChange={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value.trim();
          p.onCenter(v === "" ? "*" : v);
        }}
      />
      <label class="muted" style={{ fontSize: "0.85em" }}>
        cluster{" "}
        <select
          value={p.cluster}
          onChange={(e) => p.onCluster((e.currentTarget as HTMLSelectElement).value as ClusterMode)}
        >
          <option value="auto">auto</option>
          <option value="off">off</option>
          <option value="module">module</option>
        </select>
      </label>
      <label class="muted" style={{ fontSize: "0.85em" }}>
        depth{" "}
        <select
          value={String(p.depth)}
          onChange={(e) => p.onDepth(Number((e.currentTarget as HTMLSelectElement).value))}
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </label>
      {p.scope && (
        <span class="tag" title="Click to clear scope" style={{ cursor: "pointer" }} onClick={() => p.onScope(undefined)}>
          scope: {p.scope} ×
        </span>
      )}
      <span class="faint" style={{ marginLeft: "auto", fontSize: "0.8em" }}>
        {p.clusterLevel === "module" ? "module-level" : p.clusterLevel === "function" ? "function-level" : ""}
        {p.totalRaw !== undefined && p.totalRaw > 0 && ` · ${p.totalRaw.toLocaleString()} raw`}
      </span>
      <style>{`
        .hv-graph-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .hv-graph-toolbar select {
          background: var(--bg-elev); color: var(--fg);
          border: 1px solid var(--border); border-radius: var(--radius);
          padding: 3px 6px; font: inherit; font-size: 0.92em;
        }
      `}</style>
    </div>
  );
}

interface SceneProps {
  svgRef: { current: SVGSVGElement | null };
  gRef: { current: SVGGElement | null };
  size: { w: number; h: number };
  data: import("~/api/types").NeighborsResponse | undefined;
  isLoading: boolean;
  error: Error | undefined;
  onCenter: (id: string) => void;
}

function Scene(props: SceneProps) {
  const { svgRef, gRef, size, data } = props;
  const [selected, setSelected] = useState<string | null>(null);

  // Build sim whenever data changes.
  const sim = useMemo(() => {
    if (!data) return null;
    return buildSim({
      nodes: data.nodes,
      edges: data.edges.map((e) => ({ src: e.src, dst: e.dst, weight: e.weight })),
      width: size.w,
      height: size.h,
    });
  }, [data, size.w, size.h]);

  const isEmpty = !!data && data.nodes.length === 0;

  const viewportRef = useRef<Viewport>(defaultViewport());
  const sceneRef = useRef<SceneHandles | null>(null);
  // Interaction state lives in a ref so render-loop reads see current values
  // without forcing an effect re-run on every hover.
  const ixRef = useRef<InteractionState>({ hoveredId: null, focusedId: null, selectedId: null });

  // When the graph data changes (re-center, cluster/depth/scope change) the sim
  // rebuilds around fresh node positions. Reset pan/zoom so the new graph is
  // framed at the origin instead of inheriting the previous view's transform —
  // otherwise the new graph renders off-screen and "click to re-center" appears
  // to do nothing. Keyed on `data` (NOT `sim`/size) so a *resize* — which also
  // rebuilds `sim` — does NOT yank the user's pan/zoom out from under them.
  useEffect(() => {
    viewportRef.current = defaultViewport();
    // Also drop any stale selection-driven interaction state from the old graph.
    ixRef.current = { hoveredId: null, focusedId: null, selectedId: null };
    setSelected(null);
    // Push the reset transform onto the live <g> immediately, in case the main
    // effect doesn't re-run this pass (e.g. only `data` changed identity).
    if (gRef.current) applyViewport(gRef.current, viewportRef.current);
  }, [data]);

  // When there's nothing to render, make sure any nodes left over from a
  // previous (non-empty) graph are torn out of the DOM. The main effect skips
  // its setup/teardown entirely for an empty sim, so do it here.
  useEffect(() => {
    if (!isEmpty) return;
    const g = gRef.current;
    if (g) while (g.firstChild) g.removeChild(g.firstChild);
    sceneRef.current = null;
  }, [isEmpty]);

  // Main effect: wire up the renderer for the current sim.
  useEffect(() => {
    const svg = svgRef.current;
    const g = gRef.current;
    if (!svg || !g || !sim || !data || isEmpty) return;

    // Build meta map + id→index for fast edge endpoint lookup.
    const meta: Map<string, NodeMeta> = new Map();
    for (const n of data.nodes) {
      meta.set(n.id, { id: n.id, name: n.name, kind: n.kind, ...(n.count !== undefined ? { count: n.count } : {}) });
    }
    const idToIndex = new Map<string, number>();
    sim.nodes.forEach((n, i) => idToIndex.set(n.id, i));

    sceneRef.current = initScene(g);

    const redraw = () => {
      const scene = sceneRef.current;
      if (!scene) return;
      const v = viewportRef.current;
      const rect = visibleRect(v, size.w, size.h);
      const visible = cullIndices(sim.nodes, rect);
      reconcileNodes(scene, visible, sim.nodes, meta, v.s, ixRef.current);
      reconcileEdges(scene, sim.nodes, sim.edges, idToIndex);
    };

    // Wire hover / focus / click on the nodes group via delegation. We attach
    // to the <g> so handlers survive node re-mounts.
    const findId = (t: EventTarget | null): string | null => {
      let el = t as Element | null;
      while (el && el !== svg) {
        const id = el.getAttribute?.("data-id");
        if (id) return id;
        el = el.parentElement;
      }
      return null;
    };
    const onPointerOver = (ev: Event) => {
      const id = findId(ev.target);
      if (id !== ixRef.current.hoveredId) {
        ixRef.current = { ...ixRef.current, hoveredId: id };
        redraw();
      }
    };
    const onPointerOut = (ev: PointerEvent) => {
      // Only clear if we left to something outside the nodes layer.
      const to = ev.relatedTarget as Element | null;
      if (to && svg.contains(to) && findId(to)) return;
      if (ixRef.current.hoveredId !== null) {
        ixRef.current = { ...ixRef.current, hoveredId: null };
        redraw();
      }
    };
    const onFocusIn = (ev: FocusEvent) => {
      const id = findId(ev.target);
      ixRef.current = { ...ixRef.current, focusedId: id };
      redraw();
    };
    const onFocusOut = () => {
      ixRef.current = { ...ixRef.current, focusedId: null };
      redraw();
    };
    const onClick = (ev: MouseEvent) => {
      const id = findId(ev.target);
      if (id) {
        ixRef.current = { ...ixRef.current, selectedId: id };
        setSelected(id);
      } else {
        ixRef.current = { ...ixRef.current, selectedId: null };
        setSelected(null);
      }
      redraw();
    };
    const onDbl = (ev: MouseEvent) => {
      const id = findId(ev.target);
      if (id) props.onCenter(id);
    };
    // Keyboard navigation of the graph. Arrow keys cycle focus through the
    // currently-focusable (tier 1+) nodes in DOM order; Enter/space opens the
    // focused node; Esc clears the selection + blurs. This rides on top of the
    // existing per-node focusin/out handlers — we only move native focus, we
    // never touch the sim, so the layout stays stable.
    const focusableNodes = (): SVGGElement[] =>
      Array.from(g.querySelectorAll<SVGGElement>('g[tabindex="0"]'));

    const cycleFocus = (dir: 1 | -1) => {
      const list = focusableNodes();
      if (list.length === 0) return;
      const active = svg.ownerDocument?.activeElement;
      const cur = list.findIndex((el) => el === active);
      const next = cur === -1
        ? (dir === 1 ? 0 : list.length - 1)
        : (cur + dir + list.length) % list.length;
      list[next]!.focus();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        const id = findId(ev.target);
        if (!id) return;
        ev.preventDefault();
        props.onCenter(id);
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        ixRef.current = { ...ixRef.current, selectedId: null };
        setSelected(null);
        const active = svg.ownerDocument?.activeElement;
        if (active && svg.contains(active)) (active as HTMLElement).blur?.();
        redraw();
        return;
      }
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") {
        ev.preventDefault();
        cycleFocus(1);
        return;
      }
      if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") {
        ev.preventDefault();
        cycleFocus(-1);
        return;
      }
    };
    svg.addEventListener("pointerover", onPointerOver);
    svg.addEventListener("pointerout", onPointerOut);
    svg.addEventListener("focusin", onFocusIn);
    svg.addEventListener("focusout", onFocusOut);
    svg.addEventListener("click", onClick);
    svg.addEventListener("dblclick", onDbl);
    svg.addEventListener("keydown", onKey);

    // Pan/zoom — viewport changes trigger redraw (re-cull + re-tier).
    const detach = attachPanZoom(
      svg,
      () => viewportRef.current,
      (v) => {
        viewportRef.current = v;
        applyViewport(g, v);
        redraw();
      },
    );
    applyViewport(g, viewportRef.current);

    // RAF loop for the layout simulation. Each step we re-position any
    // currently-mounted nodes and re-cull (positions changed → maybe a node
    // drifted into/out of view).
    let raf = 0;
    let frame = 0;
    const opts = { ...defaultOptions };
    const tick = () => {
      step(sim.nodes, sim.edges, opts, size.w, size.h);
      redraw();
      frame++;
      const e = energy(sim.nodes);
      if (e > 0.5 || frame < 60) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      detach();
      svg.removeEventListener("pointerover", onPointerOver);
      svg.removeEventListener("pointerout", onPointerOut);
      svg.removeEventListener("focusin", onFocusIn);
      svg.removeEventListener("focusout", onFocusOut);
      svg.removeEventListener("click", onClick);
      svg.removeEventListener("dblclick", onDbl);
      svg.removeEventListener("keydown", onKey);
      sceneRef.current = null;
    };
  }, [sim, data, size.w, size.h, isEmpty]);

  const selectedMeta = useMemo(() => {
    if (!selected || !data) return null;
    return data.nodes.find((n) => n.id === selected) ?? null;
  }, [selected, data]);

  return (
    <>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${size.w} ${size.h}`}
        role="application"
        tabindex={0}
        aria-roledescription="interactive code graph"
        aria-label="Interactive code graph. Drag or one-finger swipe to pan, scroll or pinch to zoom. Use arrow keys to move between nodes, Enter to open the focused node, Escape to clear the selection."
      >
        <g ref={gRef} />
      </svg>
      {props.isLoading && <div class="hv-overlay faint">Loading graph…</div>}
      {props.error && <div class="hv-overlay error">{props.error.message}</div>}
      {isEmpty && !props.isLoading && !props.error && (
        <div class="hv-overlay faint" role="status">
          No nodes to show. Try a different center node, widen the depth, or clear the scope filter.
        </div>
      )}
      {selectedMeta && (
        <div class="hv-side card">
          <div class="mono">{selectedMeta.id}</div>
          <div class="muted" style={{ fontSize: "0.85em" }}>
            {selectedMeta.kind}
            {selectedMeta.file ? ` · ${selectedMeta.file}` : ""}
            {selectedMeta.count !== undefined ? ` · ${selectedMeta.count} fns` : ""}
          </div>
          <div class="faint" style={{ fontSize: "0.78em", marginTop: "4px" }}>
            Zoom past {ZOOM_TIER1_THRESHOLD}× to see labels. Enter/space on a focused node opens it.
          </div>
          {selectedMeta.kind !== "module" && (
            <div style={{ marginTop: "8px" }}>
              <a href={`/node/${encodeURIComponent(selectedMeta.id)}`}>open detail →</a>
            </div>
          )}
        </div>
      )}
    </>
  );
}
