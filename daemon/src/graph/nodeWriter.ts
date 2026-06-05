/**
 * Writes code-entity nodes as markdown files under `.hayven/nodes/`.
 *
 * Format matches PRD section 5.2:
 *
 *   ---
 *   id: auth/loginHandler
 *   kind: function
 *   ...
 *   ---
 *
 *   # `loginHandler`
 *
 *   _Summary pending — run `hayven summarize` (not yet implemented)._
 *
 *   ## Observed callers (from traces)
 *   - [[some_caller]] (N invocations)
 *
 *   ## Observed callees (from traces)
 *   - [[some_callee]] (N invocations)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { GraphEdge, GraphNode } from "./types.ts";
import { nodeMarkdownPath } from "./idScheme.ts";

const SUMMARY_PLACEHOLDER = "_Summary pending — run `hayven summarize` (not yet implemented)._";

export interface NodeNeighbors {
  /** Edges where this node is the destination (i.e. it is being called). */
  callers: GraphEdge[];
  /** Edges where this node is the source. */
  callees: GraphEdge[];
}

const EMPTY_NEIGHBORS: NodeNeighbors = { callers: [], callees: [] };

function escapeYaml(value: string): string {
  // Quote strings that contain YAML-significant characters.
  if (/^[A-Za-z0-9_./\-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function renderFrontmatter(node: GraphNode): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${escapeYaml(node.id)}`);
  lines.push(`name: ${escapeYaml(node.name)}`);
  lines.push(`qualified_name: ${escapeYaml(node.qualified_name)}`);
  lines.push(`kind: ${node.kind}`);
  lines.push(`language: ${node.language}`);
  lines.push(`file: ${escapeYaml(node.file)}`);
  lines.push(`range: [${node.range[0]}, ${node.range[1]}]`);
  lines.push(`ast_hash: blake3:${node.ast_hash}`);
  lines.push(`last_seen: ${new Date(node.last_seen).toISOString()}`);
  lines.push(`logical_clock: ${node.logical_clock}`);
  if (node.last_modified_by) {
    lines.push(`last_modified_by: ${escapeYaml(node.last_modified_by)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function renderEdgeList(edges: GraphEdge[], directionField: "src" | "dst"): string {
  if (edges.length === 0) return "_None observed yet._";
  const sorted = [...edges].sort((a, b) => b.weight - a.weight);
  return sorted
    .map((e) => {
      const other = directionField === "src" ? e.src : e.dst;
      return `- [[${other}]] (${e.weight} invocation${e.weight === 1 ? "" : "s"})`;
    })
    .join("\n");
}

export function renderNodeMarkdown(node: GraphNode, neighbors: NodeNeighbors = EMPTY_NEIGHBORS): string {
  const body = node.summary && node.summary.trim().length > 0 ? node.summary.trim() : SUMMARY_PLACEHOLDER;
  const heading = `# \`${node.name}\``;
  return [
    renderFrontmatter(node),
    "",
    heading,
    "",
    body,
    "",
    "## Observed callers (from traces)",
    renderEdgeList(neighbors.callers, "src"),
    "",
    "## Observed callees (from traces)",
    renderEdgeList(neighbors.callees, "dst"),
    "",
  ].join("\n");
}

/** Absolute file path for a node id under the given nodes directory. */
export function nodeFilePath(nodesDir: string, id: string): string {
  return join(nodesDir, nodeMarkdownPath(id));
}

/** Write a single node to disk, creating parent directories as needed. */
export function writeNodeMarkdown(
  nodesDir: string,
  node: GraphNode,
  neighbors: NodeNeighbors = EMPTY_NEIGHBORS,
): string {
  const path = nodeFilePath(nodesDir, node.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderNodeMarkdown(node, neighbors), "utf8");
  return path;
}

/**
 * Write many nodes concurrently, capped at the given concurrency. Default 16 —
 * matches the PRD's guidance and is a reasonable balance between OS file
 * descriptor pressure and throughput.
 */
export async function writeNodeMarkdowns(
  nodesDir: string,
  nodes: GraphNode[],
  neighborsByNode: Map<string, NodeNeighbors> = new Map(),
  concurrency = 16,
): Promise<number> {
  let written = 0;
  let i = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = i++;
      if (idx >= nodes.length) return;
      const node = nodes[idx];
      if (!node) return;
      writeNodeMarkdown(nodesDir, node, neighborsByNode.get(node.id) ?? EMPTY_NEIGHBORS);
      written++;
    }
  };
  for (let w = 0; w < Math.max(1, concurrency); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return written;
}
