/**
 * `hayven reindex` — drop the DERIVED graph tables and rebuild them by
 * re-parsing the working tree.
 *
 * What is destroyed: `nodes`, `edges`, `call_sites`, the `nodes_fts` shadow,
 * `merge_rejections`, and the `stats` keys that assert a successful ingest.
 * All of it is reproduced by the `--full` ingest that runs immediately after.
 *
 * What SURVIVES (see `REINDEX_PRESERVED_TABLES`): fleet memory, observations,
 * test coverage, and claims. None of those can be re-derived from a re-parse —
 * fleet memory in particular is agent/user-authored knowledge whose only copy is
 * this SQLite file. `reindex` used to delete all of it with no prompt, no
 * warning, and no export, while advertising that it only rebuilt derived data.
 *
 * CRASH SAFETY — the invariant this command relies on:
 *
 *   From the moment the graph is cleared until the follow-on `--full` ingest
 *   returns 0, THIS handle holds an in-flight ingest token, and the two
 *   detectors behind `Db.checkIndexIntegrity` (`ingest_in_progress`,
 *   `last_ingest_nodes`) are preserved through the drop.
 *
 * So an interrupted reindex — Ctrl-C, OOM, a failing native binary — leaves the
 * index marked BROKEN rather than reporting itself fresh at zero nodes. We
 * cannot lean on `runIngest`'s own token: `endIngest()` retracts only the token
 * minted by ITS handle, so ours has to be retracted here, after we know the
 * rebuild committed. That is why the handle stays open across `runIngest` (it
 * holds no transaction while doing so, so it does not block the writer).
 */
import { existsSync } from "node:fs";

import type { ParsedArgs } from "../cli.ts";
import { requireProject } from "./_shared.ts";
import { runIngest } from "./ingest.ts";
import { resolveWriteIndex } from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import { REINDEX_PRESERVED_TABLES, dropDerived } from "../db/migrations.ts";

/**
 * Injection seam for the tests. The destructive half of this command is the
 * half worth covering, and driving it end to end otherwise means running the
 * real native parser. Same dependency-injection idiom as `daemon/detach.ts`.
 * Production callers pass nothing.
 */
export interface ReindexDeps {
  /** Stand in for the follow-on full ingest. Return code, 0 = success. */
  ingest?: (args: ParsedArgs) => Promise<number>;
  /** Project root to resolve from, instead of `process.cwd()`. */
  cwd?: string;
}

export async function runReindex(args: ParsedArgs, deps: ReindexDeps = {}): Promise<number> {
  const ingest = deps.ingest ?? runIngest;
  let ctx;
  try {
    ctx = requireProject(deps.cwd);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Target the CURRENT branch's index (or the legacy index outside a git repo) —
  // the same index the subsequent `--full` ingest will rebuild. seed:false: we
  // are about to clear it anyway, so seeding from a sibling would be wasted work.
  const sqlitePath = resolveWriteIndex(ctx.paths, ctx.config, { seed: false }).path;

  // No index yet: nothing to clear, and `runIngest` marks/clears its own graph.
  if (!existsSync(sqlitePath)) {
    process.stdout.write("No existing index. Running full ingest...\n");
    return ingest({ positionals: [], flags: { ...args.flags, full: true } });
  }

  const db = new Db(sqlitePath);
  try {
    try {
      // `migrate()` runs `assertSchemaCompatible` (so we never drop tables out of
      // an index a NEWER hayven wrote) and guarantees `stats` exists, which
      // `beginIngest` needs in order to stamp anything at all.
      db.migrate();
      // MARK BEFORE DESTROY. Ordering is the whole fix: `dropDerived` refuses to
      // run without this, and preserves the marker row through the drop.
      db.beginIngest();
      dropDerived(db.handle);
      // Immediately re-create the dropped tables, EMPTY. Without this the index
      // sits with no `nodes` table at all until the ingest recreates it, and a
      // reader in that window gets `SQLiteError: no such table: nodes` —
      // `checkIndexIntegrity` degrades to `unreadable`, which discards the
      // `claimedNodes` watermark and reports a worse diagnosis than the truth.
      // With the tables present and empty, an interrupted rebuild reads exactly
      // as what it is: `ingest-interrupted`, or `empty-but-claims-content`.
      db.migrate();
      const kept = summarizePreserved(db);
      // Fold the WAL back into the main file. The old code deleted the
      // `-wal`/`-shm` sidecars outright, which was harmless only because it had
      // just emptied every table; now that fleet memory and the in-progress
      // marker survive in this file, unlinking a WAL that still holds committed
      // pages is itself the data-loss bug we are fixing.
      try {
        db.handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // Best-effort: a busy checkpoint is not a reason to fail the reindex.
        // The WAL stays, and the next open replays it correctly.
      }
      process.stdout.write(`Dropped the derived graph tables. Preserved ${kept}.\n`);
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 1;
    }

    process.stdout.write("Re-running full ingest...\n");
    const code = await ingest({ positionals: [], flags: { ...args.flags, full: true } });
    if (code === 0) {
      // Only now is the index whole again. Retracts OUR token only; a concurrent
      // ingest's token is left standing.
      db.endIngest();
    } else {
      // Leave the marker set ON PURPOSE — the graph is cleared and the rebuild
      // did not finish, which is exactly the state the marker exists to
      // advertise. Say so, or the user is left with a silently unusable index.
      process.stderr.write(
        "error: the rebuild did not complete, so this index is marked unusable " +
          "(it holds a cleared graph). Re-run `hayven reindex` once the cause is fixed.\n",
      );
    }
    return code;
  } finally {
    db.close();
  }
}

/**
 * Human-readable roll-up of what the drop left alone, e.g.
 * `2 fleet_memory, 41 observations`. Reporting it is the user-visible signal the
 * old destructive path never had: silence read as "only derived data was lost",
 * which was false. Tables absent from this index are omitted; when nothing at
 * all was stored we say so explicitly rather than printing an empty list.
 */
function summarizePreserved(db: Db): string {
  const parts: string[] = [];
  for (const table of REINDEX_PRESERVED_TABLES) {
    if (table === "fleet_memory_fts") continue; // shadow of fleet_memory — not a separate fact
    try {
      const row = db.handle.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${table}"`).get();
      if ((row?.n ?? 0) > 0) parts.push(`${row?.n} ${table}`);
    } catch {
      // Table absent on an older index — nothing to report for it.
    }
  }
  return parts.length > 0 ? `${parts.join(", ")} row(s)` : "fleet memory, observations and claims";
}
