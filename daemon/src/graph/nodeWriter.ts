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
 *   _Summary pending — run `hayven summarize` to generate one._
 *
 *   ## Observed callers (from traces)
 *   - [[some_caller]] (N invocations)
 *
 *   ## Observed callees (from traces)
 *   - [[some_callee]] (N invocations)
 */
import { mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import type { GraphEdge, GraphNode } from "./types.ts";
import { nodeMarkdownPath } from "./idScheme.ts";

const SUMMARY_PLACEHOLDER = "_Summary pending — run `hayven summarize` to generate one._";

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

/**
 * Write a single node to disk, creating parent directories as needed.
 *
 * SKIPS the write when the file already holds byte-identical content (see
 * {@link writeNodeMarkdowns} for why that matters). Returns the path either way.
 */
export function writeNodeMarkdown(
  nodesDir: string,
  node: GraphNode,
  neighbors: NodeNeighbors = EMPTY_NEIGHBORS,
): string {
  const path = nodeFilePath(nodesDir, node.id);
  const content = renderNodeMarkdown(node, neighbors);
  if (unchangedSync(path, content)) return path;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

/** True iff `path` already holds `content` up to the volatile `last_seen` line.
 *  A missing/unreadable file reads as "changed" so we fall through to a write. */
function unchangedSync(path: string, content: string): boolean {
  try {
    return sansVolatile(readFileSync(path, "utf8")) === sansVolatile(content);
  } catch {
    return false;
  }
}

/**
 * Strip the frontmatter `last_seen:` line, which is the ONLY field that changes
 * on a node whose code did not.
 *
 * THIS IS WHAT MAKES THE WRITE-SKIP REAL. `graph/ingest.ts` stamps
 * `last_seen: Date.now()` on every node on every run, and `renderFrontmatter`
 * renders it — so a plain byte comparison could NEVER be true on the production
 * path, and the skip was inert: every ingest still rewrote every file, and now
 * also read each one first, NET-ADDING I/O. (The unit tests missed it because
 * their fixture pins `last_seen: 0` and never routes through `runIngest`.)
 *
 * Excluding it means an untouched node keeps a slightly stale `last_seen` on
 * disk until something else about it changes. That is the deliberate trade:
 * `last_seen` is an ingest timestamp, the SQLite row carries the authoritative
 * value, and the alternative is rewriting ~300k files every watcher cycle — the
 * behaviour that wrote 12.6 GB during the incident.
 */
function sansVolatile(md: string): string {
  return md.replace(/^last_seen: .*$/m, "last_seen: <ignored>");
}

/**
 * Write many nodes, capped at `concurrency` in-flight writes, SKIPPING any node
 * whose file is already byte-identical. Returns the number of files ACTUALLY
 * written (not the number of nodes considered).
 *
 * CHANGE DETECTION is the load-bearing part. This used to `mkdirSync` +
 * `writeFileSync` for EVERY node on EVERY ingest unconditionally. A node's
 * markdown only changes when its name/kind/range/ast_hash/summary changes, so on
 * a watcher-driven repo the overwhelming majority of those writes rewrote
 * identical bytes. That was a direct contributor to the runaway-daemon incident's
 * 12.6 GB written (~300k files rewritten per cycle × ~11,600 cycles). A read that
 * matches costs a page-cache hit and dirties nothing; only genuine changes reach
 * the disk.
 *
 * The comparison EXCLUDES the frontmatter `last_seen:` line (see
 * {@link sansVolatile}). It has to: the ingest stamps `last_seen: Date.now()` on
 * every node every run, so a whole-content comparison is never true on the
 * production path and the skip would be inert — worse than inert, since it adds
 * a read before each unavoidable rewrite. A node whose other fields changed
 * still gets rewritten, `last_seen` and all.
 *
 * CONCURRENCY is now real. The previous implementation took a `concurrency`
 * parameter and then called the SYNCHRONOUS `writeFileSync`, so the first worker
 * drained the entire array before any other worker's first tick — the knob was
 * inert. These workers await genuinely-async fs calls, so `concurrency` actually
 * bounds in-flight I/O.
 */
export async function writeNodeMarkdowns(
  nodesDir: string,
  nodes: GraphNode[],
  neighborsByNode: Map<string, NodeNeighbors> = new Map(),
  concurrency = 16,
): Promise<number> {
  let written = 0;
  let i = 0;
  /** Dirs we've already ensured this run, so we mkdir once per dir, not per node. */
  const ensuredDirs = new Set<string>();
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = i++;
      if (idx >= nodes.length) return;
      const node = nodes[idx];
      if (!node) return;
      const path = nodeFilePath(nodesDir, node.id);
      const content = renderNodeMarkdown(node, neighborsByNode.get(node.id) ?? EMPTY_NEIGHBORS);
      let current: string | null = null;
      try {
        current = await readFile(path, "utf8");
      } catch {
        current = null; // absent/unreadable → write it
      }
      // Compare modulo the volatile `last_seen` stamp — see `sansVolatile`.
      // A raw byte compare here is ALWAYS false on the production path, which
      // made this skip inert and added a read per node on top of the rewrite.
      if (current !== null && sansVolatile(current) === sansVolatile(content)) continue;
      const dir = dirname(path);
      if (!ensuredDirs.has(dir)) {
        await mkdir(dir, { recursive: true });
        ensuredDirs.add(dir);
      }
      await writeFile(path, content, "utf8");
      written++;
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.max(1, concurrency); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return written;
}

/**
 * Unlink the markdown files for `ids`, pruning any directories left empty.
 * Returns the number of files removed. Best-effort — a file that is already
 * gone (or unlinkable) is skipped, never thrown.
 *
 * WHY: nothing anywhere used to unlink from `nodesDir`. `Db.deleteNodesByFile`
 * touches SQLite only, so every renamed, moved or deleted symbol left a
 * permanent orphan `.md` on disk and `.hayven/nodes/` grew monotonically
 * forever. Pair this with `Db.nodeIdsForFile(file)` captured BEFORE the delete.
 *
 * CONTAINMENT: an id whose derived path lands OUTSIDE `nodesDir` is skipped, not
 * unlinked. Ids are path-derived and `nodeMarkdownPath`'s sanitizer preserves
 * `.`, so `..` survives as a path segment and `join` resolves it outward — this
 * function would otherwise delete a `.md` file (and then, via
 * {@link pruneEmptyDirs}, its directory) belonging to something else entirely.
 * We only ever reclaim inside the directory we own.
 */
export function removeNodeMarkdowns(nodesDir: string, ids: Iterable<string>): number {
  let removed = 0;
  const dirs = new Set<string>();
  const boundary = nodesDir.endsWith(sep) ? nodesDir : nodesDir + sep;
  for (const id of ids) {
    const path = nodeFilePath(nodesDir, id);
    if (!path.startsWith(boundary)) continue; // escapes nodesDir — never ours to delete
    try {
      unlinkSync(path);
      removed++;
      dirs.add(dirname(path));
    } catch {
      // already gone / unreadable — nothing to reclaim
    }
  }
  pruneEmptyDirs(dirs, nodesDir);
  return removed;
}

/**
 * Delete `.md` files under `nodesDir` that hayven PROVABLY wrote and whose node
 * no longer exists — the full-rebuild sweep reclaiming symbols renamed or
 * removed since the last ingest. Returns files removed.
 *
 * TWO SAFETY RULES, both learned the hard way:
 *
 * 1. NEVER DELETE WHAT WE CANNOT PROVE WE WROTE. The sweep used to unlink every
 *    `.md` whose path was not in the keep set, which happily destroyed a
 *    hand-written `MY_NOTES.md` a user had left in the directory. A file
 *    qualifies only if it carries our generated frontmatter AND its declared
 *    `id:` is exactly the id its own path encodes — i.e. it is a file this
 *    writer produced, at the path this writer would have produced it at.
 *    Anything else (foreign markdown, an edited file, a path/id mismatch) is
 *    left alone.
 *
 * 2. THE CALLER MUST OWN `nodesDir`. It is one directory per PROJECT, shared by
 *    every per-branch index, so "not in THIS branch's node set" is not the same
 *    as "orphaned" — sweeping under per-branch caching deleted other branches'
 *    markdown. `runIngest` only calls this behind an explicit
 *    `sweepOrphanMarkdown` opt-in that the CLI sets only for a single-index
 *    project. Rule 1 is the backstop for when that judgement is wrong.
 *
 * Only meaningful on a FULL ingest, where `keepIds` is the complete node set. An
 * incremental run knows only the changed files' nodes and must use
 * {@link removeNodeMarkdowns} with explicitly-captured ids instead.
 *
 * Best-effort and bounded by what is on disk; never throws.
 */
export function pruneOrphanNodeMarkdowns(nodesDir: string, keepIds: Iterable<string>): number {
  const keepPaths = new Set<string>();
  for (const id of keepIds) keepPaths.add(nodeFilePath(nodesDir, id));

  let removed = 0;
  const touchedDirs = new Set<string>();
  const stack: string[] = [nodesDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, never abort the sweep
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      if (keepPaths.has(p)) continue; // still a live node
      if (!isOwnNodeMarkdown(nodesDir, p)) continue; // not ours — hands off
      try {
        unlinkSync(p);
        removed++;
        touchedDirs.add(dir);
      } catch {
        // best-effort
      }
    }
  }
  pruneEmptyDirs(touchedDirs, nodesDir);
  return removed;
}

/**
 * True iff `path` is a file THIS writer generated: it opens with our
 * `---`/`id:` frontmatter, and the declared id maps back to exactly `path`
 * under `nodesDir`. The round-trip through {@link nodeFilePath} is what makes
 * this a proof rather than a guess — a foreign file that merely happens to
 * start with `id:` will not land on its own path.
 */
function isOwnNodeMarkdown(nodesDir: string, path: string): boolean {
  let head: string;
  try {
    head = readFileSync(path, "utf8").slice(0, 512);
  } catch {
    return false;
  }
  if (!head.startsWith("---\n")) return false;
  const m = /^---\nid: (.+)$/m.exec(head);
  const raw = m?.[1]?.trim();
  if (raw === undefined || raw.length === 0) return false;
  // `renderFrontmatter` JSON-quotes ids that need escaping; undo that so the
  // round-trip compares the same id it wrote.
  let id = raw;
  if (id.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(id);
      if (typeof parsed !== "string") return false;
      id = parsed;
    } catch {
      return false;
    }
  }
  return nodeFilePath(nodesDir, id) === path;
}

/**
 * Remove now-empty directories, walking upward from each of `dirs` but NEVER
 * past (or including) `root`. `rmdirSync` fails on a non-empty dir, which is
 * exactly the stop condition we want, so a failure just ends that branch.
 *
 * CONTAINMENT: the guard is `root + sep`, not a bare `startsWith(root)`. A bare
 * prefix match treats `/…/nodesX` as being "inside" `/…/nodes`, so a directory
 * that merely SHARES A NAME PREFIX with the root would be rmdir'd — the same
 * unguarded-prefix shape that let `/foo` match `/foobar` in a separate bug this
 * round. It is reachable here: node ids are path-derived and `nodeMarkdownPath`
 * preserves `.`, so an id like `../nodesX/thing` resolves to a SIBLING of
 * `nodesDir` whose path passes a bare prefix test. Deleting a directory outside
 * the directory we own is never acceptable, whatever produced the id.
 */
function pruneEmptyDirs(dirs: Set<string>, root: string): void {
  const boundary = root.endsWith(sep) ? root : root + sep;
  for (const start of dirs) {
    let dir = start;
    while (dir.length > root.length && dir.startsWith(boundary)) {
      try {
        rmdirSync(dir); // throws ENOTEMPTY when it still holds entries
      } catch {
        break;
      }
      dir = dirname(dir);
    }
  }
}
