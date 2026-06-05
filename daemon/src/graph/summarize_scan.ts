/**
 * Incremental candidate-selection for `hayven summarize --all` (scale-safe).
 *
 * `summarize --all` previously loaded `db.allNodeIds()` and re-summarized EVERY
 * node on every run. On a ~40k-node repo that never finishes: the LLM path
 * spawns `hayven-native infer` per node, and even the heuristic path writes
 * markdown + an LWW op per node. A mid-run interruption (or the ~240s cap that
 * was hitting in the thesis-validation protocol) meant ALL the work was redone
 * on the next attempt — there was no notion of "already done".
 *
 * This module makes the selection INCREMENTAL and RESUMABLE: it returns ONLY the
 * node ids that still NEED a summary, via a RAW read on the public `db.handle`.
 * Because the predicate skips nodes that already carry a real summary, re-running
 * `summarize --all` continues exactly where a previous (interrupted) run left
 * off — the engine of resumability is selection, not bookkeeping.
 *
 * WHAT COUNTS AS "ALREADY SUMMARIZED" (the predicate): a node's `summary` column
 * is a NON-EMPTY string that is NOT the markdown placeholder sentinel. So a node
 * NEEDS summarizing iff:
 *   `summary IS NULL OR summary = '' OR summary = <PLACEHOLDER>`
 * The placeholder can legitimately land in the SQL `summary` column: the markdown
 * is the source of truth, and `graph/nodeReader.ts` reads the rendered body
 * (which is `SUMMARY_PLACEHOLDER` for an un-summarized node) straight back into
 * `node.summary` on a markdown→DB round-trip. Treating it as "needs work" keeps
 * the placeholder from masquerading as a real summary.
 *
 * NB on the sentinel: `SUMMARY_PLACEHOLDER` lives in `graph/nodeWriter.ts` and is
 * NOT exported (and that file is owned by another lane), so we mirror the literal
 * here. It MUST stay byte-for-byte in lockstep with the writer's constant; the
 * `summarize.test.ts` suite pins this with a cross-check against the rendered
 * markdown so drift is caught.
 */
import type { Db } from "../db/queries.ts";

/**
 * The markdown body shown for a node with no real summary yet. MUST stay
 * byte-identical to `SUMMARY_PLACEHOLDER` in `graph/nodeWriter.ts` (that file is
 * owned by another lane and does not export it). Drift is guarded by a test that
 * renders a placeholder node and compares.
 */
export const SUMMARY_PLACEHOLDER_SENTINEL =
  "_Summary pending — run `hayven summarize` (not yet implemented)._";

/**
 * The SQL predicate (sans `SELECT … FROM nodes WHERE`) that matches a node which
 * still NEEDS a summary. Bound parameter `?1` is the placeholder sentinel. Kept
 * as a constant so the count + the id-fetch use the exact same predicate.
 */
const NEEDS_SUMMARY_PREDICATE = "summary IS NULL OR summary = '' OR summary = ?1";

/** Count how many nodes still need a summary (the full remaining set size). */
export function countUnsummarized(db: Db): number {
  const row = db.handle
    .query<{ c: number }, [string]>(
      `SELECT COUNT(*) AS c FROM nodes WHERE ${NEEDS_SUMMARY_PREDICATE}`,
    )
    .get(SUMMARY_PLACEHOLDER_SENTINEL);
  return row?.c ?? 0;
}

/**
 * Fetch up to `limit` ids of nodes that still need a summary (oldest-id-first via
 * a stable `ORDER BY id` so successive bounded runs cover disjoint prefixes and
 * the whole set is eventually drained). `limit <= 0` means "no cap" — fetch the
 * entire remaining set. The order is stable so a `--limit` run is deterministic.
 *
 * RAW read on the public `db.handle` by design: the incremental predicate lives
 * in THIS lane and must not add a method to `db/queries.ts` (another lane owns
 * the schema/query surface).
 */
export function selectUnsummarizedIds(db: Db, limit: number): string[] {
  if (limit > 0) {
    const rows = db.handle
      .query<{ id: string }, [string, number]>(
        `SELECT id FROM nodes WHERE ${NEEDS_SUMMARY_PREDICATE} ORDER BY id LIMIT ?2`,
      )
      .all(SUMMARY_PLACEHOLDER_SENTINEL, limit);
    return rows.map((r) => r.id);
  }
  const rows = db.handle
    .query<{ id: string }, [string]>(
      `SELECT id FROM nodes WHERE ${NEEDS_SUMMARY_PREDICATE} ORDER BY id`,
    )
    .all(SUMMARY_PLACEHOLDER_SENTINEL);
  return rows.map((r) => r.id);
}
