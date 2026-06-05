/**
 * `hayven neighbors <id> [--depth N] [--json] [--refresh]` — graph traversal.
 */
import type { ParsedArgs } from "../cli.ts";
import { refreshIfRequested, warnIfStale } from "../db/freshness.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

interface NeighborGraph {
  root: string;
  depth: number;
  nodes: string[];
  edges: Array<{ src: string; dst: string; kind: string; weight: number }>;
}

export async function runNeighbors(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("usage: hayven neighbors <id> [--depth N] [--json] [--refresh]\n");
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Opt-in `--refresh`: run a bounded incremental ingest BEFORE the read iff the
  // index is stale AND no daemon/watcher owns the project. No-op when fresh or
  // daemon-owned; entirely skipped (read path byte-identical) without the flag.
  if (args.flags["refresh"] === true || args.flags["refresh"] === "true") {
    await refreshIfRequested(args, ctx);
  }

  const depth = Math.min(5, Math.max(1, Number(args.flags["depth"]) || 1));
  const db = openProjectDb(ctx, { readonly: true });
  try {
    // Surface (on stderr only) if the index looks stale and no watcher owns it.
    // Emitted before the node-exists check so a stale index also explains a
    // "no node" miss. Never touches stdout, so `--json` stays byte-identical.
    warnIfStale(db, ctx.paths);
    if (!db.getNode(id)) {
      process.stderr.write(`No node with id \`${id}\` — try \`hayven query ${id}\` to fuzzy-find it.\n`);
      return 1;
    }
    const graph = walk(db, id, depth);
    if (isJson(args.flags)) {
      process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
      return 0;
    }
    const lines = [`# Neighbors of \`${id}\` (depth ${depth})`, "", `${graph.nodes.length} nodes, ${graph.edges.length} edges`, ""];
    lines.push("## Edges");
    for (const e of graph.edges) {
      lines.push(`- \`${e.src}\` → \`${e.dst}\`  (${e.kind}, weight ${e.weight})`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

/** Exported for tests: BFS the graph and return DISTINCT `(src,dst,kind)` edges. */
export function walk(db: ReturnType<typeof openProjectDb>, root: string, depth: number): NeighborGraph {
  const visited = new Set<string>([root]);
  const frontier = new Set<string>([root]);
  // Dedupe edges by a distinct `(src, dst, kind)` key. An edge whose BOTH
  // endpoints land in the frontier is otherwise discovered twice (once as the
  // `outgoing` of one node, once as the `incoming` of the other), inflating the
  // "N edges" line and the `--json` `edges[]` vs the true distinct-edge count.
  // The NUL separator can't collide with any id/kind content.
  const edgeMap = new Map<string, NeighborGraph["edges"][number]>();
  for (let d = 0; d < depth; d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const e of db.outgoing(id)) {
        edgeMap.set(`${e.src}\x00${e.dst}\x00${e.kind}`, { src: e.src, dst: e.dst, kind: e.kind, weight: e.weight });
        if (!visited.has(e.dst)) {
          visited.add(e.dst);
          next.add(e.dst);
        }
      }
      for (const e of db.incoming(id)) {
        edgeMap.set(`${e.src}\x00${e.dst}\x00${e.kind}`, { src: e.src, dst: e.dst, kind: e.kind, weight: e.weight });
        if (!visited.has(e.src)) {
          visited.add(e.src);
          next.add(e.src);
        }
      }
    }
    frontier.clear();
    for (const n of next) frontier.add(n);
  }
  return { root, depth, nodes: [...visited], edges: [...edgeMap.values()] };
}
