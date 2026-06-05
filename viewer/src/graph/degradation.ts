// The graceful-degradation trigger rule (PRD §12.3).
//
// Extracted so it's pure & unit-testable. GraphView calls `shouldDegrade(q.data)`
// and renders <GraphDegradation> instead of the scene when it returns true.
//
// Rule (verbatim from the PRD): if a query would render >2k visible nodes AND
// clustering was explicitly disabled (cluster_level == "function"), the user
// gets the action prompt instead of a partial render.

import type { NeighborsResponse } from "~/api/types";

export const DEGRADATION_THRESHOLD = 2000;

export function shouldDegrade(data: NeighborsResponse | undefined | null): boolean {
  if (!data) return false;
  return data.cluster_level === "function" && data.total_raw_nodes > DEGRADATION_THRESHOLD;
}
