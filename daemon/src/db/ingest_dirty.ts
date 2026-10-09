/**
 * `last_ingest_dirty`: which SOURCE files an index may hold in a state that
 * differs from its `last_ingest_git_head` commit (HAYV-13).
 *
 * An index built from a working tree with uncommitted edits holds those edits.
 * `last_ingest_git_head` alone cannot say so, and the worktree overlays seed
 * from the main index on exactly that assumption: they diff the worktree
 * against the seed's HEAD and re-parse what git reports. Main's CURRENT dirty
 * set is not a substitute either: edit `a.ts`, `hayven ingest`, then `git
 * stash`, and main is clean while its index still carries the stashed symbol,
 * which a seeded overlay would then serve as fresh. So ingests record the dirty
 * set they were built from, and the seed re-parses the union of that record and
 * main's current dirty set.
 *
 * COST, and who pays it. Recording needs a `git status`, and the daemon
 * watcher ingests on every save batch through a synchronous spawn. So:
 *   - it runs ONLY while the project has a worktree registry (`worktrees.json`
 *     exists). Everyone else pays nothing, not even the spawn. Without a
 *     registry the record is DELETED (a stat write, no git), because a record
 *     that stopped being maintained would undercount later;
 *   - the status call has a 2s budget, like `readGitHead`;
 *   - only paths the parser could have indexed are kept (source extensions;
 *     untracked included, since main may have indexed an untracked source the
 *     worktree lacks), and the list is capped at {@link DIRTY_RECORD_CAP}.
 *
 * The record is CUMULATIVE across non-authoritative (incremental/scoped) runs,
 * because an incremental run re-parses only part of the tree and a file left
 * dirty by an earlier run may still be in the index in its dirty form. A full
 * rebuild resets it. When the truth cannot be represented the record says so
 * instead of guessing: `overflow` (more than the cap) or `unknown` (git failed
 * or timed out). Both are sticky until a full rebuild, and both make the next
 * seed do a full worktree parse: slower, never wrong.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { HAYVEN_DIR_NAME } from "../util/paths.ts";
import { gitStatus } from "../worktree/git.ts";
import { WORKTREE_REGISTRY_FILE } from "../worktree/registry.ts";
import { isSourcePath } from "./freshness.ts";
import type { Db } from "./queries.ts";

export const LAST_INGEST_DIRTY_KEY = "last_ingest_dirty";

/** Above this many paths the record degrades to `overflow`. Same as the incremental cap. */
export const DIRTY_RECORD_CAP = 2000;

/** Budget for the recording `git status`; it can run on every watcher batch. */
const DIRTY_STATUS_TIMEOUT_MS = 2_000;

const OVERFLOW = "overflow";
const UNKNOWN = "unknown";

export type IngestDirty =
  | { kind: "paths"; paths: string[] }
  /** More than {@link DIRTY_RECORD_CAP} paths: too many to trust a list. */
  | { kind: "overflow" }
  /** git could not answer at some ingest since the last full rebuild. */
  | { kind: "unknown" };

/** The recorded set, or `null` when there is no record at all. */
export function readIngestDirty(db: Db): IngestDirty | null {
  const raw = db.getStat(LAST_INGEST_DIRTY_KEY);
  if (raw === null) return null;
  if (raw === OVERFLOW) return { kind: "overflow" };
  if (raw === UNKNOWN) return { kind: "unknown" };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return { kind: "paths", paths: parsed.filter((p): p is string => typeof p === "string") };
    }
  } catch {
    // fall through
  }
  return { kind: "unknown" }; // an unparseable record is not a list we may trust
}

/**
 * The record to write for an ingest of `repoRoot` that is finishing now, or
 * `null` to DELETE it (no worktree registry: nobody consumes it, and we must not
 * leave a record that later stops being maintained). Runs git only when a
 * registry exists; call it OUTSIDE any write transaction, like `readGitHead`.
 */
export function nextIngestDirty(db: Db, repoRoot: string, authoritative: boolean): IngestDirty | null {
  if (!existsSync(join(repoRoot, HAYVEN_DIR_NAME, WORKTREE_REGISTRY_FILE))) return null;
  const status = gitStatus(repoRoot, DIRTY_STATUS_TIMEOUT_MS);
  if (status === null) return { kind: "unknown" };
  const current = status.paths.filter(isSourcePath);
  const prior = authoritative ? null : readIngestDirty(db);
  if (prior !== null && prior.kind !== "paths") return prior; // sticky until a full rebuild
  const merged = [...new Set([...(prior?.paths ?? []), ...current])].sort();
  return merged.length > DIRTY_RECORD_CAP ? { kind: "overflow" } : { kind: "paths", paths: merged };
}

/** Write (or, for `null`, delete) the record. Call inside the success transaction. */
export function writeIngestDirty(db: Db, record: IngestDirty | null): void {
  if (record === null) {
    db.handle.query("DELETE FROM stats WHERE key = ?").run(LAST_INGEST_DIRTY_KEY);
    return;
  }
  db.setStat(
    LAST_INGEST_DIRTY_KEY,
    record.kind === "paths" ? JSON.stringify(record.paths) : record.kind === "overflow" ? OVERFLOW : UNKNOWN,
  );
}
