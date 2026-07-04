/**
 * `hayven branches [--json] [--prune] [--keep N]` — per-branch index cache
 * observability + cleanup (daemonless).
 *
 * Hayvenhurst caches a per-branch index at `.hayven/branches/<key>/index.sqlite`
 * (see `db/branch_index.ts`): a switch back to an already-indexed branch is
 * INSTANT (no re-ingest, never any re-embed). Those caches accumulate one
 * directory per visited branch, so this command makes them VISIBLE (default
 * list) and PRUNABLE (`--prune`) without a daemon.
 *
 * House style, mirrored from `cli/refs.ts` / `cli/affected_tests.ts`:
 * `requireProject()` → `isJson(args.flags)` split → markdown vs `--json` → a
 * clean, pipeable stdout. The per-branch index files are opened READ-ONLY only
 * to read their `nodes`/`test_coverage` counts, and each is closed immediately.
 *
 * SAFETY (prune): only ever removes directories strictly under
 * `paths.branchesDir`; NEVER the active branch and NEVER the legacy
 * `.hayven/index.sqlite` (which lives outside `branchesDir`). The most-recently-
 * used `--keep N` branches (default `DEFAULT_MAX_BRANCHES`) are also retained.
 */
import { existsSync, statSync } from "node:fs";

import type { ParsedArgs } from "../cli.ts";
import {
  activeBranchKey,
  DEFAULT_MAX_BRANCHES,
  listBranchIndexes,
  pruneBranches,
  type BranchPruneResult,
} from "../db/branch_index.ts";
import { Db } from "../db/queries.ts";
import { isJson, requireProject } from "./_shared.ts";

/** One per-branch (or legacy) index cache, enriched for display / `--json`. */
interface BranchCacheEntry {
  /** The branch key, or `"(legacy)"` for the fallback `.hayven/index.sqlite`. */
  key: string;
  /** Absolute path of the index file. */
  path: string;
  /** True when this is the active branch's cache. */
  active: boolean;
  /** True for the legacy `.hayven/index.sqlite` entry. */
  legacy: boolean;
  /** On-disk size = index.sqlite + any `-wal`/`-shm` sidecar. */
  sizeBytes: number;
  /** Last-modified epoch ms (of the main index file). */
  mtimeMs: number;
  /** `nodes` row count, or `null` if the index is missing/corrupt. */
  nodes: number | null;
  /** `test_coverage` row count, or `null` if missing/corrupt. */
  coverageRows: number | null;
}

const SQLITE_SIDECARS = ["-wal", "-shm"] as const;

/** Sum the on-disk bytes of an index file plus any `-wal`/`-shm` sidecars. */
function indexSizeBytes(path: string): number {
  let total = 0;
  for (const suffix of ["", ...SQLITE_SIDECARS]) {
    try {
      total += statSync(path + suffix).size;
    } catch {
      // Missing main file or absent sidecar — counts as 0.
    }
  }
  return total;
}

/**
 * Open `path` read-only and read its `nodes` + `test_coverage` row counts.
 * Returns `{ nodes: null, coverageRows: null }` for a missing/corrupt index so
 * a bad branch dir is listed gracefully rather than crashing the command.
 */
function readCounts(path: string): { nodes: number | null; coverageRows: number | null } {
  if (!existsSync(path)) return { nodes: null, coverageRows: null };
  let db: Db | null = null;
  try {
    db = new Db(path, { readonly: true });
    const count = (table: string): number | null => {
      try {
        const row = db!.handle
          .query(`SELECT count(*) AS n FROM ${table}`)
          .get() as { n: number } | undefined;
        return row?.n ?? 0;
      } catch {
        return null; // table absent (older schema) or unreadable
      }
    };
    return { nodes: count("nodes"), coverageRows: count("test_coverage") };
  } catch {
    return { nodes: null, coverageRows: null };
  } finally {
    db?.close();
  }
}

/** Build the enriched, display-ready list of every index cache for this project. */
function collectEntries(ctx: ReturnType<typeof requireProject>): BranchCacheEntry[] {
  const activeKey = activeBranchKey(ctx.paths, ctx.config);
  const entries: BranchCacheEntry[] = [];

  for (const b of listBranchIndexes(ctx.paths)) {
    const counts = readCounts(b.path);
    entries.push({
      key: b.key,
      path: b.path,
      active: b.key === activeKey,
      legacy: false,
      sizeBytes: indexSizeBytes(b.path),
      mtimeMs: b.mtimeMs,
      nodes: counts.nodes,
      coverageRows: counts.coverageRows,
    });
  }

  // Most-recently-used first; the active branch surfaces among them naturally.
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // The legacy index (the read fallback) — shown last, labeled, never active.
  if (existsSync(ctx.paths.sqliteFile)) {
    const counts = readCounts(ctx.paths.sqliteFile);
    entries.push({
      key: "(legacy)",
      path: ctx.paths.sqliteFile,
      active: false,
      legacy: true,
      sizeBytes: indexSizeBytes(ctx.paths.sqliteFile),
      mtimeMs: statSync(ctx.paths.sqliteFile).mtimeMs,
      nodes: counts.nodes,
      coverageRows: counts.coverageRows,
    });
  }

  return entries;
}

/** `--keep N` → a positive integer, defaulting to the config cap / `DEFAULT_MAX_BRANCHES`. */
function keepCount(args: ParsedArgs, ctx: ReturnType<typeof requireProject>): number {
  const raw = args.flags["keep"];
  if (raw !== undefined && raw !== true) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return Math.max(1, ctx.config.index?.maxBranches ?? DEFAULT_MAX_BRANCHES);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Human-relative "… ago" for an epoch-ms mtime. */
function relativeTime(mtimeMs: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - mtimeMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export async function runBranches(args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const json = isJson(args.flags);
  const prune = args.flags["prune"] === true || args.flags["prune"] === "true";

  if (prune) {
    const keep = keepCount(args, ctx);
    const result: BranchPruneResult = pruneBranches(ctx.paths, ctx.config, keep);

    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            pruned: result.removed.map((r) => ({
              key: r.key,
              path: r.path,
              sizeBytes: r.sizeBytes,
            })),
            removedCount: result.removed.length,
            bytesReclaimed: result.bytesReclaimed,
            kept: result.kept,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }

    if (result.removed.length === 0) {
      process.stdout.write(
        `# Prune\n\nNothing to remove — ${result.kept.length} branch cache(s) within keep=${keep}.\n`,
      );
      return 0;
    }
    const lines = [
      "# Prune",
      "",
      `Removed ${result.removed.length} stale branch cache(s), reclaimed ${formatBytes(result.bytesReclaimed)}.`,
      "",
    ];
    for (const r of result.removed) {
      lines.push(`- \`${r.key}\`  (${formatBytes(r.sizeBytes)})`);
    }
    lines.push("");
    lines.push(`Kept: ${result.kept.map((k) => `\`${k}\``).join(", ") || "(none)"}`);
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  }

  // DEFAULT: list.
  const entries = collectEntries(ctx);

  if (json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    return 0;
  }

  if (entries.length === 0) {
    process.stdout.write(
      "No per-branch index caches.\n" +
        "(Run `hayven ingest` on a git branch to create one, " +
        "or this project may not be a git repo.)\n",
    );
    return 0;
  }

  const lines = [`# Branch index caches (${entries.length})`, ""];
  for (const e of entries) {
    const marker = e.active ? "* " : "  ";
    const label = e.legacy ? `${e.key}` : `\`${e.key}\``;
    const nodes = e.nodes === null ? "?" : String(e.nodes);
    const cov = e.coverageRows === null ? "?" : String(e.coverageRows);
    lines.push(
      `${marker}${label}` +
        (e.active ? " (active)" : "") +
        `  ${formatBytes(e.sizeBytes)}, ${relativeTime(e.mtimeMs)}, ` +
        `${nodes} node(s), ${cov} coverage row(s)`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}
