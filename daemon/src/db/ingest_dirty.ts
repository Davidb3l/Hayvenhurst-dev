/**
 * `last_ingest_dirty`: which files an index may hold in a state that differs
 * from its `last_ingest_git_head` commit (HAYV-13).
 *
 * An index built from a working tree with uncommitted edits holds those edits.
 * `last_ingest_git_head` alone cannot say so, and the worktree overlays seed
 * from the main index on exactly that assumption: they diff the worktree
 * against the seed's HEAD and re-parse what git reports. Main's CURRENT dirty
 * set is not a substitute either: edit `a.ts`, `hayven ingest`, then `git
 * stash`, and main is clean while its index still carries the stashed symbol,
 * which a seeded overlay would then serve as fresh. So every ingest records
 * the dirty set it was built from, and the seed re-parses the union of that
 * record and main's current dirty set.
 *
 * The record is CUMULATIVE across non-authoritative (incremental/scoped) runs:
 * an incremental run re-parses only part of the tree, so files left dirty by an
 * earlier run may still be in the index in their dirty form even after they
 * were reverted. Only a full rebuild resets it. A superset only ever costs the
 * seed a few extra re-parses; a subset serves wrong code.
 */
import { gitStatus } from "../worktree/git.ts";
import type { Db } from "./queries.ts";

export const LAST_INGEST_DIRTY_KEY = "last_ingest_dirty";

/** The recorded dirty set, or `null` when the index predates the record (or git failed). */
export function readIngestDirty(db: Db): string[] | null {
  const raw = db.getStat(LAST_INGEST_DIRTY_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Compute the value to record for an ingest of `repoRoot` that is finishing
 * now, or `null` when git cannot say (the record must then be REMOVED, never
 * left describing an older run). Runs git, so call it OUTSIDE any write
 * transaction, exactly like `readGitHead`.
 */
export function nextIngestDirty(db: Db, repoRoot: string, authoritative: boolean): string[] | null {
  const status = gitStatus(repoRoot);
  if (status === null) return null;
  if (authoritative) return status.paths;
  const prior = readIngestDirty(db);
  if (prior === null) return status.paths;
  return [...new Set([...prior, ...status.paths])].sort();
}

/** Write (or, for `null`, delete) the record. Call inside the success transaction. */
export function writeIngestDirty(db: Db, dirty: string[] | null): void {
  if (dirty === null) {
    db.handle.query("DELETE FROM stats WHERE key = ?").run(LAST_INGEST_DIRTY_KEY);
    return;
  }
  db.setStat(LAST_INGEST_DIRTY_KEY, JSON.stringify(dirty));
}
