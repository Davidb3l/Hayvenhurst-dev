/**
 * `hayven summarize [<id>] [--all] [--json]`
 *
 * Replaces the `SUMMARY_PLACEHOLDER` in a node's markdown body with a concise
 * one-line summary, written CONSISTENTLY into both the markdown
 * source-of-truth under `.hayven/nodes/` AND the SQL `summary` read cache.
 *
 * SUMMARIZER (see `graph/summarize.ts`): a heuristic default + an LLM upgrade,
 * selected exactly like the conflict oracle (`selectOracle`). With no tier-3
 * model present the deterministic {@link HeuristicSummarizer} runs (zero-config
 * default). When a model is present AND a native binary is locatable, the
 * {@link LlmSummarizer} runs `hayven-native infer`; any timeout / infer error /
 * unusable output silently falls back to the heuristic. Summarization NEVER
 * blocks or fails on the model.
 *
 * WRITE PATH (BL-12 LWW): summaries are body edits, so they route through the
 * same LWW-Register path as `hayven node body`:
 *   - When the daemon is UP and serves THIS project, we PUT each summary to
 *     `/api/nodes/:id/body`. The daemon owns the op log (§14.3 "one writer per
 *     segment per daemon"), mints the LwwOp, persists it (Merkle sync), writes
 *     the markdown, and refreshes the SQL cache. This is the preferred path.
 *   - When the daemon is DOWN, we write directly through a local {@link
 *     CrdtState} (recordLww → markdown → SQL upsert), replicating the route's
 *     three steps. Safe because no daemon owns the segment; the op still lands
 *     in the op log and participates in sync on the daemon's next start.
 * Either way the summary mints an LWW op and lands in both stores.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ParsedArgs } from "../cli.ts";
import { CrdtState } from "../crdt/state.ts";
import {
  edgeRowToGraphEdge,
  nodeRowToGraphNode,
  type NodeRow,
} from "../db/queries.ts";
import { writeNodeMarkdown, type NodeNeighbors } from "../graph/nodeWriter.ts";
import {
  selectSummarizer,
  type NodeSummarizer,
  type SummaryInput,
} from "../graph/summarize.ts";
import { countUnsummarized, selectUnsummarizedIds } from "../graph/summarize_scan.ts";
import type { GraphNode } from "../graph/types.ts";
import { tryLocateNativeBinary } from "../native/locate.ts";
import { rootLogger } from "../util/log.ts";
import {
  assertDaemonServesProject,
  isJson,
  openProjectDb,
  projectHeader,
  requireProject,
  type ProjectContext,
} from "./_shared.ts";

interface SummarizedNode {
  id: string;
  summary: string;
  summarizer: string;
}

/**
 * How often (in nodes) the long `--all` run emits a progress line to stderr so an
 * operator/agent can see it's alive and bounded, not hung.
 */
const PROGRESS_EVERY = 50;

/**
 * A bounded run budget threaded into the per-node loop. `limit` caps how many
 * nodes this run will pick (it bounds the candidate SELECT, step 1). The
 * wall-clock budget is a `--max-seconds` cap on the SUMMARIZATION WORK: when the
 * deadline passes, the loop finishes the node it's on and stops cleanly.
 * `remainingAtStart` is the FULL count of still-unsummarized nodes when the run
 * began, so the final report can say how many are left for a re-run.
 *
 * IMPORTANT (the deadline is ARMED at loop entry, not at parse time): the
 * `--max-seconds` budget intentionally EXCLUDES the fixed per-run setup cost —
 * the daemon-health probe and, on the offline path, CRDT op-log HYDRATION, which
 * on a large repo with a big op log can itself take tens of seconds (measured
 * ~41s to hydrate a ~9k-op log). If the deadline were anchored at flag-parse
 * time, that setup would silently eat the entire budget and the run would
 * summarize ZERO nodes (a bound that does no work is useless). So each transport
 * calls {@link armDeadline} immediately before its first node — the budget then
 * measures the time spent actually summarizing, which is what an operator means
 * by `--max-seconds`. `budgetMs` is the relative cap; `deadlineMs` starts at
 * `Infinity` ("not yet armed") and is set once the loop begins.
 */
interface RunBudget {
  /** Relative wall-clock cap in ms for the summarization loop; `Infinity` = none. */
  budgetMs: number;
  /**
   * Absolute epoch-ms deadline, ARMED at loop entry by {@link armDeadline}.
   * `Infinity` until armed (and forever, when there is no `--max-seconds` budget).
   */
  deadlineMs: number;
  /** Total nodes still needing a summary when this run started (for `remaining`). */
  remainingAtStart: number;
  /** Number of node ids this run will attempt (after applying `--limit`). */
  selected: number;
}

/**
 * Arm the wall-clock deadline at the moment the per-node loop actually starts,
 * so the `--max-seconds` budget covers SUMMARIZATION WORK and not the fixed setup
 * (health probe + CRDT op-log hydration). Idempotent-ish: a transport calls this
 * once before its loop. No-op when there is no budget (`budgetMs === Infinity`).
 */
function armDeadline(budget: RunBudget): void {
  if (budget.budgetMs !== Number.POSITIVE_INFINITY) {
    budget.deadlineMs = Date.now() + budget.budgetMs;
  }
}

/** Parse a positive-integer flag (`--limit`), or `0`/undefined → "no limit". */
function parsePositiveInt(value: string | boolean | undefined): number {
  if (typeof value !== "string") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Parse a positive-number seconds flag (`--max-seconds`), or 0 → "no budget". */
function parsePositiveSeconds(value: string | boolean | undefined): number {
  if (typeof value !== "string") return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function runSummarize(args: ParsedArgs): Promise<number> {
  const all = args.flags["all"] === true || args.flags["all"] === "true";
  const id = args.positionals[0];
  const json = isJson(args.flags);

  if (!all && !id) {
    process.stderr.write(
      "usage: hayven summarize [<id>] [--all] [--limit <N>] [--max-seconds <S>] [--json]\n",
    );
    return 2;
  }

  // Budget flags (only meaningful with --all; harmless for a single id).
  const limit = parsePositiveInt(args.flags["limit"]);
  const maxSeconds = parsePositiveSeconds(args.flags["max-seconds"]);

  let ctx: ProjectContext;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write((err as Error).message + "\n");
    return 1;
  }

  // Read-only DB handle: we read node rows + neighbors here, and either PUT
  // through the daemon (which owns its own DB) or upsert through a short-lived
  // writable handle on the offline path.
  const db = openProjectDb(ctx, { readonly: true });
  let ids: string[];
  let remainingAtStart = 0;
  try {
    if (all) {
      // INCREMENTAL + RESUMABLE: pick ONLY nodes that still need a summary
      // (summary IS NULL / '' / the placeholder sentinel), bounded by --limit.
      // Re-running continues where a prior (interrupted) run left off because the
      // already-summarized nodes are skipped by the predicate. See summarize_scan.
      remainingAtStart = countUnsummarized(db);
      ids = selectUnsummarizedIds(db, limit);
      if (ids.length === 0) {
        // Either there are no nodes at all, or every node is already summarized.
        // Both are "nothing to do" — and crucially, the second case is what makes
        // a completed/resumed `--all` a fast no-op rather than a 40k-node redo.
        if (json) {
          process.stdout.write(
            JSON.stringify(
              {
                count: 0,
                remaining: 0,
                limit: limit > 0 ? limit : null,
                budgetSeconds: maxSeconds > 0 ? maxSeconds : null,
                nodes: [],
              },
              null,
              2,
            ) + "\n",
          );
        } else {
          process.stdout.write("No nodes need summarizing (all up to date).\n");
        }
        return 0;
      }
    } else {
      // Single id: friendly unknown-id handling (exit 1).
      if (db.getNode(id!) === null) {
        process.stderr.write(
          `error: no node with id \`${id}\` — try \`hayven query ${id}\` to fuzzy-find it.\n`,
        );
        return 1;
      }
      ids = [id!];
    }
  } finally {
    db.close();
  }

  const budget: RunBudget = {
    // Relative cap; the absolute deadline is ARMED at loop entry (armDeadline) so
    // CRDT hydration / the health probe don't eat the budget. deadlineMs starts
    // unset (Infinity) and is set once summarization actually begins.
    budgetMs: maxSeconds > 0 ? maxSeconds * 1000 : Number.POSITIVE_INFINITY,
    deadlineMs: Number.POSITIVE_INFINITY,
    remainingAtStart: all ? remainingAtStart : ids.length,
    selected: ids.length,
  };

  // Pick the summarizer ONCE (selection spawns nothing). The model id comes from
  // the configured tier-3 model; absent/missing → the heuristic default.
  const logger = rootLogger();
  const summarizer = selectSummarizer(
    { models: ctx.config.models },
    {
      hayvenDir: ctx.paths.hayvenDir,
      locateBinary: () => tryLocateNativeBinary({ repoRoot: ctx.paths.repoRoot }),
      logger,
    },
  );
  const usedModel = summarizer.id !== "heuristic-v1";

  // Decide the write transport: prefer the daemon when it's up and serves THIS
  // project (it owns the op log). Otherwise write directly via a local CrdtState.
  // `daemonHeaders` carries the project selector so a SHARED multi-project
  // daemon routes our reads/writes to THIS project, not its primary.
  const base = `http://${ctx.config.daemon_host}:${ctx.config.daemon_port}`;
  const daemonHeaders = await daemonServesProject(base, ctx);
  const daemonUp = daemonHeaders !== null;

  // Report progress for the long `--all` run only (a single id is instant).
  const onProgress = all
    ? (done: number) => {
        if (done % PROGRESS_EVERY === 0) {
          process.stderr.write(
            `summarize: ${done}/${budget.selected} this run` +
              (budget.budgetMs !== Number.POSITIVE_INFINITY
                ? ` (budget ${Math.max(0, Math.round((budget.deadlineMs - Date.now()) / 1000))}s left)`
                : "") +
              "\n",
          );
        }
      }
    : undefined;

  let results: SummarizedNode[];
  if (daemonUp) {
    results = await summarizeViaDaemon(base, ctx, ids, summarizer, budget, onProgress, daemonHeaders);
  } else {
    results = await summarizeOfflineAsync(ctx, ids, summarizer, budget, onProgress);
  }

  // Resumability accounting: `remaining` is how many nodes still need a summary
  // AFTER this run, so an operator/agent knows whether to re-run. It is the full
  // set size at start minus what THIS run actually completed (results.length).
  // A wall-clock or --limit stop leaves `remaining > 0`; a full drain leaves 0.
  const remaining = all ? Math.max(0, budget.remainingAtStart - results.length) : 0;
  const budgetStopped = all && results.length < budget.selected;

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          count: results.length,
          model: usedModel ? summarizer.id : null,
          summarizer: usedModel ? summarizer.id : "heuristic-v1",
          via: daemonUp ? "daemon" : "offline",
          // Additive fields (DELIVERABLE 1.4): existing shape unchanged.
          remaining,
          limit: limit > 0 ? limit : null,
          budgetSeconds: maxSeconds > 0 ? maxSeconds : null,
          nodes: results,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  const lines: string[] = [];
  lines.push(`# Summarized ${results.length} node${results.length === 1 ? "" : "s"}`);
  lines.push("");
  lines.push(
    usedModel
      ? `Using model \`${summarizer.id}\` (LLM upgrade; falls back to the heuristic on any error).`
      : "Using the heuristic summarizer (no tier-3 model present — this is the zero-config default).",
  );
  lines.push("");
  for (const r of results) {
    lines.push(`- \`${r.id}\` — ${r.summary}`);
  }
  lines.push("");
  if (all) {
    // The resumability summary an operator/agent reads to decide whether to
    // re-run. `done X, remaining Y`: re-run `hayven summarize --all` to continue.
    lines.push(`done ${results.length}, remaining ${remaining}`);
    if (remaining > 0) {
      lines.push(
        budgetStopped
          ? "(budget reached — re-run `hayven summarize --all` to continue; it resumes from where it stopped)"
          : "(re-run `hayven summarize --all` to continue)",
      );
    }
    lines.push("");
  }
  process.stdout.write(lines.join("\n"));
  return 0;
}

/**
 * When a daemon is reachable at `base` AND serves this exact project (register-
 * on-the-fly included), returns the request headers to address it (the project
 * selector for a shared daemon — possibly empty when we're the primary).
 * Returns `null` when the daemon is down or cannot serve this project.
 */
async function daemonServesProject(
  base: string,
  ctx: ProjectContext,
): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${base}/api/health`);
    if (!res.ok) return null;
    // Reuse the project-identity guard's logic: a foreign-serving daemon must
    // not receive our writes. assertDaemonServesProject returns ok:false only
    // when this project can't be served/registered; it also resolves the alias
    // we must address requests with on a shared multi-project daemon.
    const identity = await assertDaemonServesProject(base, ctx);
    return identity.ok ? projectHeader(identity) : null;
  } catch {
    return null;
  }
}

/** Online path: PUT each summary through the daemon's BL-12 LWW body route. */
async function summarizeViaDaemon(
  base: string,
  ctx: ProjectContext,
  ids: string[],
  summarizer: NodeSummarizer,
  budget?: RunBudget,
  onProgress?: (done: number) => void,
  /** Project-selector headers for a shared multi-project daemon. */
  daemonHeaders: Record<string, string> = {},
): Promise<SummarizedNode[]> {
  const out: SummarizedNode[] = [];
  // Arm the wall-clock deadline HERE so the budget covers summarization work, not
  // the daemon-health probe that preceded this call.
  if (budget) armDeadline(budget);
  for (const nodeId of ids) {
    // Wall-clock budget: stop CLEANLY before starting another node once the
    // deadline passes. Work already written stays written (resumable next run).
    if (budget && Date.now() >= budget.deadlineMs) break;
    // Re-fetch the node from the daemon so we summarize the daemon's current
    // view (it owns the authoritative DB while it's running).
    let node: GraphNode | null = null;
    try {
      const res = await fetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}`, {
        headers: daemonHeaders,
      });
      if (res.ok) {
        const payload = (await res.json()) as { node?: GraphNode };
        node = payload.node ?? null;
      }
    } catch {
      node = null;
    }
    if (node === null) continue;

    const result = await summarizer.summarize(buildInput(ctx, node));
    try {
      await fetch(`${base}/api/nodes/${encodeURIComponent(nodeId)}/body`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...daemonHeaders },
        body: JSON.stringify({ body: result.summary }),
      });
    } catch {
      // The daemon went away mid-run; skip this node rather than fail the batch.
      continue;
    }
    out.push({ id: nodeId, summary: result.summary, summarizer: result.summarizer });
    onProgress?.(out.length);
  }
  return out;
}

/** Assemble the summarizer input: node metadata + best-effort first source line. */
function buildInput(ctx: ProjectContext, node: GraphNode): SummaryInput {
  const firstSourceLine = readFirstSourceLine(ctx, node);
  return firstSourceLine !== undefined ? { node, firstSourceLine } : { node };
}

/**
 * Best-effort read of the first meaningful source line of a node's span. Pure
 * filesystem read; any failure (file gone, range stale) yields `undefined` and
 * the heuristic falls back to metadata only.
 */
function readFirstSourceLine(ctx: ProjectContext, node: GraphNode): string | undefined {
  if (!node.file) return undefined;
  const abs = join(ctx.paths.repoRoot, node.file);
  if (!existsSync(abs)) return undefined;
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, node.range?.[0] ?? 1);
  const end = Math.min(lines.length, node.range?.[1] ?? lines.length);
  for (let i = start - 1; i < end; i++) {
    const line = lines[i]?.trim() ?? "";
    if (line.length > 0) return line;
  }
  return undefined;
}

function rowToNeighbors(
  db: ReturnType<typeof openProjectDb>,
  id: string,
): NodeNeighbors {
  return {
    callers: db.incoming(id).map(edgeRowToGraphEdge),
    callees: db.outgoing(id).map(edgeRowToGraphEdge),
  };
}

/** Hex-encode a writer id for the markdown `last_modified_by` field. */
function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] as number).toString(16).padStart(2, "0");
  return s;
}

/**
 * The real offline implementation (async). Opens a writable DB + a hydrated
 * CrdtState, summarizes each node, and writes through recordLww + markdown +
 * SQL upsert. Exported for direct testing of the offline write path.
 */
export async function summarizeOfflineAsync(
  ctx: ProjectContext,
  ids: string[],
  summarizer: NodeSummarizer,
  budget?: RunBudget,
  onProgress?: (done: number) => void,
): Promise<SummarizedNode[]> {
  const out: SummarizedNode[] = [];
  const db = openProjectDb(ctx, { readonly: false });
  const crdt = new CrdtState({
    crdtRoot: ctx.paths.crdtDir,
    configFile: ctx.paths.configFile,
  });
  // Arm the wall-clock deadline AFTER CRDT op-log hydration (the `new CrdtState`
  // above can take tens of seconds on a large op log) so the `--max-seconds`
  // budget measures the summarization loop, not the one-time hydration cost.
  if (budget) armDeadline(budget);
  try {
    for (const nodeId of ids) {
      // Wall-clock budget: stop CLEANLY before starting another node once the
      // deadline passes. Each node is fully written (CRDT op + markdown + SQL)
      // before we loop, so a budget stop never leaves a half-written node — the
      // next run resumes from the still-unsummarized remainder.
      if (budget && Date.now() >= budget.deadlineMs) break;

      const row: NodeRow | null = db.getNode(nodeId);
      if (row === null) continue;
      const node = nodeRowToGraphNode(row);

      const result = await summarizer.summarize(buildInput(ctx, node));

      // (1) CRDT write-through: mint + persist an LwwOp keyed by the entity id.
      const state = crdt.recordLww({ entityId: nodeId, value: result.summary });

      // (2) Markdown source-of-truth reflects the materialized LWW winner.
      node.summary = state.value;
      node.last_modified_by = hex(crdt.writer);
      writeNodeMarkdown(ctx.paths.nodesDir, node, rowToNeighbors(db, nodeId));

      // (3) Denormalized SQL read cache (CRDT is source of truth).
      db.upsertNode(node);

      out.push({ id: nodeId, summary: state.value, summarizer: result.summarizer });
      onProgress?.(out.length);
    }
  } finally {
    crdt.close();
    db.close();
  }
  return out;
}
