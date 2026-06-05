// Pan, zoom, and node-selection helpers for the graph view.
//
// Pan/zoom is implemented by writing the `transform` attribute on a single
// <g> wrapper so we avoid recomputing every node position. A simple
// matrix is enough: translate(tx, ty) scale(s).

export interface Viewport {
  tx: number;
  ty: number;
  s: number;
}

export function defaultViewport(): Viewport {
  return { tx: 0, ty: 0, s: 1 };
}

export function applyViewport(g: SVGGElement, v: Viewport): void {
  g.setAttribute("transform", `translate(${v.tx.toFixed(2)} ${v.ty.toFixed(2)}) scale(${v.s.toFixed(3)})`);
}

/** Convert a screen coordinate to graph (untransformed) space. */
export function screenToGraph(v: Viewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - v.tx) / v.s, y: (y - v.ty) / v.s };
}

export interface InteractionHandlers {
  /** Called on wheel events. Receives the new viewport. */
  onZoom?: (v: Viewport) => void;
  /** Called on drag with the new viewport. */
  onPan?: (v: Viewport) => void;
}

/** Zoom clamp shared by wheel, pinch, and any future zoom path. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;

export function clampZoom(s: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s));
}

/**
 * Compute a new viewport for a zoom toward a focal screen point. Pure — shared
 * by wheel zoom and two-finger pinch so both honor the same clamp and the same
 * "keep the focal point stationary" math. `factor` is the multiplicative zoom
 * change requested (clamped after applying).
 */
export function zoomToward(v: Viewport, factor: number, x: number, y: number): Viewport {
  const newS = clampZoom(v.s * factor);
  // If the clamp pinned us, `newS / v.s` is the *effective* factor.
  const tx = x - (x - v.tx) * (newS / v.s);
  const ty = y - (y - v.ty) * (newS / v.s);
  return { tx, ty, s: newS };
}

/** Euclidean distance between two touch points. */
export function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

/** Midpoint of two touch points (used as the pinch focal point). */
export function touchMidpoint(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): { x: number; y: number } {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Attach pan/zoom handlers to an SVG container. Returns a cleanup function.
 */
export function attachPanZoom(
  svg: SVGSVGElement,
  getViewport: () => Viewport,
  setViewport: (v: Viewport) => void,
  handlers: InteractionHandlers = {},
): () => void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const v = getViewport();
    const rect = svg.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nv = zoomToward(v, factor, x, y);
    setViewport(nv);
    handlers.onZoom?.(nv);
  };

  const onMouseDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    dragging = true;
    lastX = ev.clientX;
    lastY = ev.clientY;
  };

  const onMouseMove = (ev: MouseEvent) => {
    if (!dragging) return;
    const v = getViewport();
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    const nv: Viewport = { tx: v.tx + dx, ty: v.ty + dy, s: v.s };
    setViewport(nv);
    handlers.onPan?.(nv);
  };

  const onMouseUp = () => {
    dragging = false;
  };

  // Touch: single-finger pan, two-finger pinch-zoom. Mirrors the mouse path
  // and reuses `zoomToward` so the zoom clamp [0.1, 8] is identical.
  let touchPanLast: { x: number; y: number } | null = null;
  let pinchPrevDist = 0;

  const onTouchStart = (ev: TouchEvent) => {
    if (ev.touches.length === 1) {
      ev.preventDefault();
      touchPanLast = { x: ev.touches[0]!.clientX, y: ev.touches[0]!.clientY };
      pinchPrevDist = 0;
    } else if (ev.touches.length === 2) {
      ev.preventDefault();
      touchPanLast = null;
      pinchPrevDist = touchDistance(ev.touches[0]!, ev.touches[1]!);
    }
  };

  const onTouchMove = (ev: TouchEvent) => {
    if (ev.touches.length === 1 && touchPanLast) {
      ev.preventDefault();
      const t = ev.touches[0]!;
      const v = getViewport();
      const dx = t.clientX - touchPanLast.x;
      const dy = t.clientY - touchPanLast.y;
      touchPanLast = { x: t.clientX, y: t.clientY };
      const nv: Viewport = { tx: v.tx + dx, ty: v.ty + dy, s: v.s };
      setViewport(nv);
      handlers.onPan?.(nv);
    } else if (ev.touches.length === 2) {
      ev.preventDefault();
      const a = ev.touches[0]!;
      const b = ev.touches[1]!;
      const dist = touchDistance(a, b);
      if (pinchPrevDist > 0 && dist > 0) {
        const v = getViewport();
        const rect = svg.getBoundingClientRect();
        const mid = touchMidpoint(a, b);
        const x = mid.x - rect.left;
        const y = mid.y - rect.top;
        const factor = dist / pinchPrevDist;
        const nv = zoomToward(v, factor, x, y);
        setViewport(nv);
        handlers.onZoom?.(nv);
      }
      pinchPrevDist = dist;
    }
  };

  const onTouchEnd = (ev: TouchEvent) => {
    if (ev.touches.length === 0) {
      touchPanLast = null;
      pinchPrevDist = 0;
    } else if (ev.touches.length === 1) {
      // Dropped from pinch to one finger — resume panning from the survivor.
      touchPanLast = { x: ev.touches[0]!.clientX, y: ev.touches[0]!.clientY };
      pinchPrevDist = 0;
    }
  };

  svg.addEventListener("wheel", onWheel, { passive: false });
  svg.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
  svg.addEventListener("touchstart", onTouchStart, { passive: false });
  svg.addEventListener("touchmove", onTouchMove, { passive: false });
  svg.addEventListener("touchend", onTouchEnd);
  svg.addEventListener("touchcancel", onTouchEnd);

  return () => {
    svg.removeEventListener("wheel", onWheel);
    svg.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    svg.removeEventListener("touchstart", onTouchStart);
    svg.removeEventListener("touchmove", onTouchMove);
    svg.removeEventListener("touchend", onTouchEnd);
    svg.removeEventListener("touchcancel", onTouchEnd);
  };
}
