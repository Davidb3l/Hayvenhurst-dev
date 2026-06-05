// Progressive-rendering tier rules.
//
// PRD §12.3 LOD technique #3: three visual tiers, with the tier of a node
// determined by zoom + interaction state. Transitions are implemented as a
// CSS-class swap on the node group (not a re-mount), so going from "dot" to
// "labeled node" is one attribute write per affected node.
//
//   Tier 0  — default. 2px dot. No label, no hover, no ARIA, no tabindex.
//   Tier 1  — small node with label + hover handlers + ARIA. Triggered when
//             zoom scale exceeds `ZOOM_TIER1_THRESHOLD`, applied to every
//             in-viewport node.
//   Tier 2  — full styled node + edge highlighting. Triggered on hover,
//             keyboard focus, or click — per-node, regardless of zoom.
//
// We expose pure rule functions here so the renderer just calls `tierFor`
// per node per frame and writes the result to a CSS class. The DOM element
// type itself never changes (it's always an SVG group with a circle + an
// optional text child); only attributes/classes change.

export type Tier = 0 | 1 | 2;

/**
 * Above this zoom scale, all in-viewport nodes upgrade from Tier 0 to Tier 1.
 * Picked so the default 1.0 scale is dots, a single zoom-in tick reveals
 * labels. Configurable per-call, defaulted here.
 */
export const ZOOM_TIER1_THRESHOLD = 1.5;

export interface InteractionState {
  hoveredId: string | null;
  focusedId: string | null;
  selectedId: string | null;
}

/**
 * Compute the tier for a node id given current zoom scale + interaction.
 * Pure: same inputs → same output, no DOM access. Unit-testable.
 */
export function tierFor(
  id: string,
  zoom: number,
  ix: InteractionState,
  threshold: number = ZOOM_TIER1_THRESHOLD,
): Tier {
  if (ix.hoveredId === id || ix.focusedId === id || ix.selectedId === id) return 2;
  if (zoom >= threshold) return 1;
  return 0;
}

/** CSS class for a given tier. Renderer writes this to the node group. */
export function tierClass(t: Tier): string {
  return t === 0 ? "hv-n0" : t === 1 ? "hv-n1" : "hv-n2";
}

/**
 * Whether a tier should have keyboard focus / ARIA attributes. Tier 0 nodes
 * are visually 2px dots — they would clutter screen-reader output with no
 * useful information. Tier 1+ get the full a11y treatment.
 */
export function tierIsInteractive(t: Tier): boolean {
  return t >= 1;
}
