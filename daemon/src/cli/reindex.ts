/**
 * `hayven reindex` — drop the SQLite index and rebuild from the markdown
 * source-of-truth files.
 *
 * For week 1 the "rebuild from markdown" step is implemented by re-running
 * the native ingest. A direct markdown -> SQLite rehydrate path can be added
 * later if needed (the node reader supports it).
 */
import { existsSync, rmSync } from "node:fs";

import type { ParsedArgs } from "../cli.ts";
import { requireProject } from "./_shared.ts";
import { runIngest } from "./ingest.ts";
import { resolveWriteIndex } from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import { dropAll } from "../db/migrations.ts";

export async function runReindex(args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Drop SQLite tables (markdown files left untouched). Target the CURRENT
  // branch's index (or the legacy index outside a git repo) — the same index the
  // subsequent `--full` ingest will rebuild. seed:false: we are about to clear it
  // anyway, so seeding from a sibling would be wasted work.
  const sqlitePath = resolveWriteIndex(ctx.paths, ctx.config, { seed: false }).path;
  if (existsSync(sqlitePath)) {
    const db = new Db(sqlitePath);
    try {
      dropAll(db.handle);
    } finally {
      db.close();
    }
    // Also delete -wal / -shm sidecars so the next open starts clean.
    for (const suffix of ["-wal", "-shm"]) {
      const p = sqlitePath + suffix;
      if (existsSync(p)) {
        try {
          rmSync(p);
        } catch {
          // best-effort
        }
      }
    }
  }

  process.stdout.write("Dropped SQLite index. Re-running full ingest...\n");
  return runIngest({ positionals: [], flags: { ...args.flags, full: true } });
}
