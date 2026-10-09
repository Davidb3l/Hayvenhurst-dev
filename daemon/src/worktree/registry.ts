/**
 * The per-project WORKTREE REGISTRY (HAYV-13): which linked git worktrees of
 * this repo have their own overlay index, and where those overlays live.
 *
 * Layout (all under the MAIN checkout's `.hayven/`):
 *
 *   worktrees.json                 { version, worktrees: [{path, id, created_at, seed_head}] }
 *   worktrees.json.lock            advisory lock for read → modify → write
 *   worktrees/<id>/index.sqlite    the overlay: a FULL COPY of a graph, not a delta
 *   worktrees/<id>/nodes/          the overlay's own node markdown
 *   worktrees/<id>/refresh.lock    held while that overlay re-ingests
 *
 * Deliberately NOT under `branches/`: the per-branch LRU (`db/branch_index.ts`)
 * enumerates that directory to pick seeds and victims, so an overlay living
 * there would consume one of the 8 branch slots, could be chosen as a seed for
 * a real branch, and could be evicted out from under a worktree mid-read.
 *
 * Registration is EXPLICIT (`hayven worktree add`). An unregistered worktree
 * resolves exactly as it always has, so nothing changes for anyone who does not
 * opt in, and a stray `git worktree add` never silently grows `.hayven/`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withFileLockSync } from "../util/file_lock.ts";
import { canonicalRoot, type HayvenPaths } from "../util/paths.ts";
import { detectLinkedWorktree, revParsePathProbe } from "./git.ts";

/** Hard cap on registered overlays per project. Each one is a full index copy. */
export const MAX_WORKTREE_OVERLAYS = 16;

const REGISTRY_VERSION = 1;
const OVERLAY_INDEX_FILE = "index.sqlite";

/** Registry critical sections are a small JSON read + rename: seconds of headroom. */
const REGISTRY_LOCK = { budgetMs: 6_000, staleMs: 5_000 } as const;

export interface WorktreeEntry {
  /** Canonical absolute path of the worktree's top-level directory. */
  readonly path: string;
  /** Short stable hash of {@link path}; names the overlay directory. */
  readonly id: string;
  /** ISO-8601 registration time. */
  readonly created_at: string;
  /** The main-index HEAD the overlay was first seeded from, when known. */
  readonly seed_head: string | null;
}

/** The registry's file name inside `.hayven/`. */
export const WORKTREE_REGISTRY_FILE = "worktrees.json";

/** `<main>/.hayven/worktrees.json`. */
export function worktreeRegistryFile(paths: HayvenPaths): string {
  return join(paths.hayvenDir, WORKTREE_REGISTRY_FILE);
}

/** `<main>/.hayven/worktrees` — parent of every overlay directory. */
export function worktreesDir(paths: HayvenPaths): string {
  return join(paths.hayvenDir, "worktrees");
}

export function overlayDir(paths: HayvenPaths, id: string): string {
  return join(worktreesDir(paths), id);
}

export function overlaySqlitePath(paths: HayvenPaths, id: string): string {
  return join(overlayDir(paths, id), OVERLAY_INDEX_FILE);
}

export function overlayNodesDir(paths: HayvenPaths, id: string): string {
  return join(overlayDir(paths, id), "nodes");
}

/**
 * The overlay id for a worktree path: the first 12 hex chars of the sha256 of
 * its CANONICAL path. Stable across runs and symlink spellings (`/tmp` vs
 * `/private/tmp` on macOS hash the same), and filesystem-safe by construction.
 */
export function overlayId(worktreePath: string): string {
  return createHash("sha256").update(canonicalRoot(worktreePath)).digest("hex").slice(0, 12);
}

/** Thrown for a registry file we cannot parse; mutations refuse to clobber it. */
export class WorktreeRegistryCorrupt extends Error {
  constructor(file: string, detail: string) {
    super(`worktree registry ${file} is unreadable (${detail}); fix or delete it.`);
    this.name = "WorktreeRegistryCorrupt";
  }
}

function parseEntries(file: string, raw: string): WorktreeEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new WorktreeRegistryCorrupt(file, (err as Error).message);
  }
  const list = (parsed as { worktrees?: unknown } | null)?.worktrees;
  if (!Array.isArray(list)) throw new WorktreeRegistryCorrupt(file, "no `worktrees` array");
  const out: WorktreeEntry[] = [];
  for (const e of list as Array<Record<string, unknown>>) {
    if (typeof e?.["path"] !== "string" || typeof e["id"] !== "string") continue;
    out.push({
      path: e["path"],
      id: e["id"],
      created_at: typeof e["created_at"] === "string" ? e["created_at"] : "",
      seed_head: typeof e["seed_head"] === "string" ? e["seed_head"] : null,
    });
  }
  return out;
}

/**
 * The registered worktrees, STRICT: a corrupt file throws. Used by the
 * mutating commands, which must never overwrite a registry they could not read.
 */
export function readWorktreeRegistryStrict(paths: HayvenPaths): WorktreeEntry[] {
  const file = worktreeRegistryFile(paths);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return []; // absent: nothing registered
  }
  return parseEntries(file, raw);
}

/**
 * The registered worktrees, LENIENT: any failure reads as "none registered".
 * This is the read path's view — a damaged registry must degrade to today's
 * behavior (read the main index), never fail a query.
 */
export function readWorktreeRegistry(paths: HayvenPaths): WorktreeEntry[] {
  try {
    return readWorktreeRegistryStrict(paths);
  } catch {
    return [];
  }
}

/**
 * Read → modify → write the registry under its lock, publishing atomically
 * (unique tmp + rename in the same directory). `fn` returns the new list.
 */
export function mutateWorktreeRegistry<T>(
  paths: HayvenPaths,
  fn: (entries: WorktreeEntry[]) => { entries: WorktreeEntry[]; result: T },
): T {
  const file = worktreeRegistryFile(paths);
  return withFileLockSync(
    `${file}.lock`,
    () => {
      const { entries, result } = fn(readWorktreeRegistryStrict(paths));
      const body = JSON.stringify({ version: REGISTRY_VERSION, worktrees: entries }, null, 2) + "\n";
      // UNIQUE tmp name: a fixed `.tmp` shared by two writers can interleave
      // bytes before the (perfectly atomic) rename publishes the mix.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
      try {
        writeFileSync(tmp, body);
        renameSync(tmp, file);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      return result;
    },
    REGISTRY_LOCK,
  );
}

export type WorktreeValidation =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Three-way verdict on a candidate worktree. `invalid` is POSITIVE evidence
 * (the path is gone, or git ran and said it is not a worktree of this repo);
 * `unknown` means git could not answer at all (missing, timed out, killed).
 * `add` refuses both; `prune` deletes only on `invalid`.
 */
export type WorktreeVerdict =
  | { kind: "ok"; path: string }
  | { kind: "invalid"; reason: string }
  | { kind: "unknown"; reason: string };

/**
 * Is `candidate` a linked worktree of the repo whose MAIN checkout is
 * `mainRoot`? The returned `path` is the worktree's canonical TOP-LEVEL, so
 * registering a subdirectory registers the worktree that contains it.
 *
 * Three tests, each closing a way to register something the read path can
 * never resolve:
 *   1. same shared git dir (`git rev-parse --git-common-dir`): a worktree OF
 *      THIS REPO, wherever it lives on disk;
 *   2. not the main checkout itself (its private git dir IS the common dir);
 *   3. the main checkout that `detectLinkedWorktree` derives for it is
 *      EXACTLY this project's root. Reads resolve a worktree to its project
 *      through that derivation, so a project that is itself a linked worktree,
 *      or a repo whose main is bare / uses `--separate-git-dir`, would accept a
 *      registration that no read ever finds.
 */
export function classifyWorktree(candidate: string, mainRoot: string): WorktreeVerdict {
  if (!existsSync(candidate)) return { kind: "invalid", reason: `${candidate} does not exist` };
  const top = revParsePathProbe(candidate, "--show-toplevel");
  if (top.kind === "error") return { kind: "unknown", reason: `git could not run in ${candidate}: ${top.message}` };
  if (top.kind === "exit") {
    return /not a git repository/i.test(top.stderr)
      ? { kind: "invalid", reason: `${candidate} is not inside a git working tree` }
      : { kind: "unknown", reason: `git rev-parse failed in ${candidate}: ${top.stderr.trim()}` };
  }
  const theirs = revParsePathProbe(top.path, "--git-common-dir");
  const ours = revParsePathProbe(mainRoot, "--git-common-dir");
  if (theirs.kind !== "ok" || ours.kind !== "ok") {
    return { kind: "unknown", reason: `could not read the git common dir of ${top.path} or ${mainRoot}` };
  }
  if (theirs.path !== ours.path) {
    return {
      kind: "invalid",
      reason: `${top.path} is a worktree of a different repository (${theirs.path}, not ${ours.path})`,
    };
  }
  const own = revParsePathProbe(top.path, "--git-dir");
  if (own.kind !== "ok") return { kind: "unknown", reason: `could not read the git dir of ${top.path}` };
  const project = canonicalRoot(mainRoot);
  if (top.path === project || own.path === ours.path) {
    return { kind: "invalid", reason: `${top.path} is the main checkout itself, not a linked worktree` };
  }
  const linked = detectLinkedWorktree(top.path);
  if (linked === null || linked.mainRoot !== project) {
    return {
      kind: "invalid",
      reason:
        `${top.path} belongs to the main checkout ${linked?.mainRoot ?? "(none: a bare or separate-git-dir repository)"}, ` +
        `not to this project (${project}). Overlays can only be registered from the repository's main checkout.`,
    };
  }
  return { kind: "ok", path: top.path };
}

/** {@link classifyWorktree} for `add`: anything but `ok` is a refusal. */
export function validateWorktree(candidate: string, mainRoot: string): WorktreeValidation {
  const v = classifyWorktree(candidate, mainRoot);
  return v.kind === "ok" ? { ok: true, path: v.path } : { ok: false, reason: v.reason };
}

/** A read-path resolution: this cwd is inside a REGISTERED worktree. */
export interface RegisteredOverlay {
  /** The main checkout (owns `.hayven/`, the daemon, claims, config). */
  readonly mainRoot: string;
  /** The worktree's canonical top-level — where source files are read from. */
  readonly worktreeRoot: string;
  readonly entry: WorktreeEntry;
}

/**
 * Resolve `cwd` to a registered overlay, or `null` (→ resolve the project
 * exactly as before). Filesystem-only and never throws: an ordinary checkout
 * costs one upward stat walk, and an unregistered or unreadable registration
 * is indistinguishable from "no overlay".
 */
export function findRegisteredOverlay(cwd: string, mainPathsFor: (root: string) => HayvenPaths): RegisteredOverlay | null {
  const linked = detectLinkedWorktree(cwd);
  if (linked === null || linked.mainRoot === null) return null;
  const mainPaths = mainPathsFor(linked.mainRoot);
  if (!existsSync(worktreeRegistryFile(mainPaths))) return null;
  const entry = readWorktreeRegistry(mainPaths).find((e) => e.path === linked.worktreeRoot);
  if (entry === undefined) return null;
  return { mainRoot: linked.mainRoot, worktreeRoot: linked.worktreeRoot, entry };
}

export interface PruneResult {
  /** Registry entries dropped, with why. */
  readonly removed: Array<{ entry: WorktreeEntry; reason: string }>;
  /** Overlay directories on disk with no registry entry, deleted. */
  readonly orphanDirs: string[];
}

/** Delete one overlay's directory. Only ever a direct child of `worktreesDir`. */
export function removeOverlayFiles(paths: HayvenPaths, id: string): void {
  if (!/^[0-9a-f]{12}$/.test(id)) return; // never let a bad id path-escape
  rmSync(overlayDir(paths, id), { recursive: true, force: true });
}

/**
 * Drop overlays whose worktree is gone or is no longer a worktree of this repo,
 * and delete overlay directories no registry entry points at.
 *
 * The git validation runs OUTSIDE the registry lock (it spawns git per entry),
 * then the removal re-reads under the lock and drops only those ids, so a
 * concurrent `add` is never lost.
 */
export function pruneWorktreeOverlays(paths: HayvenPaths): PruneResult {
  const before = readWorktreeRegistryStrict(paths);
  const verdicts = new Map<string, string>();
  for (const e of before) {
    // POSITIVE EVIDENCE ONLY. This runs on every daemon start; a git that is
    // missing, slow or killed must leave registrations alone, not delete a
    // live worker's overlay. `unknown` keeps the entry.
    const v = classifyWorktree(e.path, paths.repoRoot);
    if (v.kind === "invalid") verdicts.set(e.id, v.reason);
    else if (v.kind === "ok" && v.path !== e.path) verdicts.set(e.id, `${e.path} now resolves to ${v.path}`);
  }
  const removed =
    verdicts.size === 0
      ? []
      : mutateWorktreeRegistry(paths, (entries) => {
          const gone = entries.filter((e) => verdicts.has(e.id));
          return {
            entries: entries.filter((e) => !verdicts.has(e.id)),
            result: gone.map((entry) => ({ entry, reason: verdicts.get(entry.id) ?? "" })),
          };
        });
  for (const r of removed) removeOverlayFiles(paths, r.entry.id);

  const live = new Set(readWorktreeRegistry(paths).map((e) => e.id));
  const orphanDirs: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(worktreesDir(paths));
  } catch {
    // no overlays dir yet
  }
  for (const d of dirs) {
    if (live.has(d) || !/^[0-9a-f]{12}$/.test(d)) continue;
    removeOverlayFiles(paths, d);
    orphanDirs.push(d);
  }
  return { removed, orphanDirs };
}

/** Ensure the overlays parent exists (callers then create `<id>/`). */
export function ensureWorktreesDir(paths: HayvenPaths): void {
  mkdirSync(worktreesDir(paths), { recursive: true });
}
