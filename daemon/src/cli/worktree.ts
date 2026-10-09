/**
 * `hayven worktree <add|remove|list|prune>` — register git worktrees for their
 * own overlay index (HAYV-13).
 *
 * A Sirius worker edits inside a detached `git worktree`. Without registration,
 * a graph read from there walks up to the MAIN checkout's `.hayven` (or, for a
 * worktree outside the repo, finds no project at all) and answers about the
 * main branch: the worker's brand-new files map to nothing. Registering the
 * worktree gives it an overlay index that every read from inside it uses, kept
 * fresh lazily on each read. See `worktree/overlay.ts` for the mechanics.
 */
import { resolve } from "node:path";

import type { ParsedArgs } from "../cli.ts";
import { canonicalRoot } from "../util/paths.ts";
import { detectLinkedWorktree } from "../worktree/git.ts";
import { overlayStatus, refreshOverlay } from "../worktree/overlay.ts";
import {
  MAX_WORKTREE_OVERLAYS,
  mutateWorktreeRegistry,
  overlayId,
  pruneWorktreeOverlays,
  readWorktreeRegistryStrict,
  removeOverlayFiles,
  validateWorktree,
  type WorktreeEntry,
} from "../worktree/registry.ts";
import { isJson, openProjectDb, projectCwd, requireProject, type ProjectContext } from "./_shared.ts";

const HELP = `hayven worktree: per-worktree overlay indexes

Usage:
  hayven worktree add <path> [--json]   Register a git worktree of this repo and build its overlay
  hayven worktree remove <path>         Unregister it and delete its overlay
  hayven worktree list [--json]         Registered worktrees and overlay freshness
  hayven worktree prune [--json]        Drop overlays whose worktree is gone or no longer of this repo

Graph reads (query, refs, importers, impact, neighbors, context, affected-tests,
plan-lanes, fleet-context, mcp, proxy) run from inside a REGISTERED worktree, or
with \`--root <worktree>\`, answer from that worktree's overlay: its own code,
including brand-new files. The overlay re-ingests only what changed, lazily,
before each read. Claims, fleet memory and the daemon stay with the main project.

At most ${MAX_WORKTREE_OVERLAYS} overlays per project. Unregistered worktrees resolve exactly as before.
`;

/**
 * Resolve the MAIN project for a worktree command. Usually `requireProject`
 * already gets there (cwd in the main checkout, or in any worktree nested under
 * it). From an UNREGISTERED worktree outside the repo there is no `.hayven` to
 * walk up to, so fall back to the main checkout git itself names.
 */
function resolveMainProject(): ProjectContext {
  try {
    return requireProject();
  } catch (err) {
    const linked = detectLinkedWorktree(projectCwd());
    if (linked?.mainRoot) {
      try {
        return requireProject(linked.mainRoot);
      } catch {
        // fall through to the original, more relevant error
      }
    }
    throw err;
  }
}

/** The main read index's HEAD, recorded as the overlay's `seed_head`. */
function mainIndexHead(ctx: ProjectContext): string | null {
  try {
    const db = openProjectDb(ctx, { readonly: true, mainIndex: true });
    try {
      return db.getStat("last_ingest_git_head");
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Thrown inside the registry lock to refuse the over-cap registration. */
class OverlayCapError extends Error {}

async function add(args: ParsedArgs, ctx: ProjectContext): Promise<number> {
  const raw = args.positionals[1];
  if (raw === undefined) {
    process.stderr.write("usage: hayven worktree add <path> [--json]\n");
    return 2;
  }
  const v = validateWorktree(resolve(projectCwd(), raw), ctx.paths.repoRoot);
  if (!v.ok) {
    process.stderr.write(`error: cannot register ${raw}: ${v.reason}\n`);
    return 1;
  }
  const seedHead = mainIndexHead(ctx);
  let outcome: { entry: WorktreeEntry; added: boolean };
  try {
    outcome = mutateWorktreeRegistry<{ entry: WorktreeEntry; added: boolean }>(ctx.paths, (entries) => {
      const existing = entries.find((e) => e.path === v.path);
      if (existing !== undefined) return { entries, result: { entry: existing, added: false } };
      if (entries.length >= MAX_WORKTREE_OVERLAYS) {
        throw new OverlayCapError(
          `refusing to register ${v.path}: this project already has ${entries.length} worktree overlays ` +
            `(the cap is ${MAX_WORKTREE_OVERLAYS}; each one is a full index copy). Run \`hayven worktree prune\` ` +
            "to drop overlays whose worktree is gone, or `hayven worktree remove <path>`.",
        );
      }
      const entry: WorktreeEntry = {
        path: v.path,
        id: overlayId(v.path),
        created_at: new Date().toISOString(),
        seed_head: seedHead,
      };
      return { entries: [...entries, entry], result: { entry, added: true } };
    });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  // Build NOW rather than on the first read, so a broken worktree or a missing
  // native binary fails here, where the caller is looking, and the first query
  // from the worker is not the one that pays for the seed.
  let result;
  try {
    result = await refreshOverlay({ paths: ctx.paths, config: ctx.config, entry: outcome.entry });
  } catch (err) {
    if (outcome.added) {
      // Do not leave a registration whose overlay never existed: every read
      // from that worktree would retry (and re-fail) the build.
      mutateWorktreeRegistry(ctx.paths, (entries) => ({
        entries: entries.filter((e) => e.id !== outcome.entry.id),
        result: undefined,
      }));
      removeOverlayFiles(ctx.paths, outcome.entry.id);
    }
    process.stderr.write(`error: could not build the overlay for ${v.path}: ${(err as Error).message}\n`);
    return 1;
  }

  if (isJson(args.flags)) {
    process.stdout.write(
      JSON.stringify(
        { ...outcome.entry, added: outcome.added, action: result.action, seeded: result.seeded, nodes: result.nodes },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(
      `${outcome.added ? "Registered" : "Already registered"} worktree ${v.path} (overlay ${outcome.entry.id})\n` +
        `  overlay: ${result.action}${result.seeded ? " (seeded from the main index)" : ""}, ${result.nodes} nodes\n`,
    );
  }
  return 0;
}

async function remove(args: ParsedArgs, ctx: ProjectContext): Promise<number> {
  const raw = args.positionals[1];
  if (raw === undefined) {
    process.stderr.write("usage: hayven worktree remove <path>\n");
    return 2;
  }
  // Canonicalize without requiring the path to exist: removing the
  // registration of a worktree that was already deleted must still work.
  const target = canonicalRoot(resolve(projectCwd(), raw));
  let removed: WorktreeEntry | undefined;
  try {
    removed = mutateWorktreeRegistry(ctx.paths, (entries) => {
      const hit = entries.find((e) => e.path === target || e.id === raw);
      return { entries: entries.filter((e) => e !== hit), result: hit };
    });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  if (removed === undefined) {
    process.stderr.write(`error: ${target} is not a registered worktree (see \`hayven worktree list\`)\n`);
    return 1;
  }
  removeOverlayFiles(ctx.paths, removed.id);
  process.stdout.write(`Removed worktree ${removed.path} (overlay ${removed.id} deleted)\n`);
  return 0;
}

function list(args: ParsedArgs, ctx: ProjectContext): number {
  let entries: WorktreeEntry[];
  try {
    entries = readWorktreeRegistryStrict(ctx.paths);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const rows = entries.map((entry) => ({
    ...entry,
    ...overlayStatus({ paths: ctx.paths, config: ctx.config, entry }),
  }));
  if (isJson(args.flags)) {
    process.stdout.write(JSON.stringify({ worktrees: rows, cap: MAX_WORKTREE_OVERLAYS }, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("No registered worktrees. Register one with `hayven worktree add <path>`.\n");
    return 0;
  }
  const lines = [`${rows.length}/${MAX_WORKTREE_OVERLAYS} worktree overlays:`];
  for (const r of rows) {
    lines.push(`  ${r.id}  ${r.freshness.padEnd(13)} ${String(r.nodes).padStart(6)} nodes  ${r.path}`);
  }
  if (rows.some((r) => r.freshness === "worktree-gone")) {
    lines.push("Run `hayven worktree prune` to drop the overlays whose worktree is gone.");
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function prune(args: ParsedArgs, ctx: ProjectContext): number {
  let res;
  try {
    res = pruneWorktreeOverlays(ctx.paths);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  if (isJson(args.flags)) {
    process.stdout.write(
      JSON.stringify(
        { removed: res.removed.map((r) => ({ ...r.entry, reason: r.reason })), orphanDirs: res.orphanDirs },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  if (res.removed.length === 0 && res.orphanDirs.length === 0) {
    process.stdout.write("Nothing to prune.\n");
    return 0;
  }
  for (const r of res.removed) process.stdout.write(`Pruned ${r.entry.path} (${r.reason})\n`);
  if (res.orphanDirs.length > 0) {
    process.stdout.write(`Deleted ${res.orphanDirs.length} unregistered overlay dir(s)\n`);
  }
  return 0;
}

export async function runWorktree(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "help" || args.flags["help"] === true) {
    process.stdout.write(HELP);
    return 0;
  }
  if (sub === undefined) {
    process.stderr.write(HELP);
    return 2;
  }
  if (!["add", "remove", "list", "prune"].includes(sub)) {
    process.stderr.write(`Unknown worktree subcommand: ${sub}\n\n${HELP}`);
    return 2;
  }
  let ctx: ProjectContext;
  try {
    ctx = resolveMainProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  switch (sub) {
    case "add":
      return add(args, ctx);
    case "remove":
      return remove(args, ctx);
    case "list":
      return list(args, ctx);
    default:
      return prune(args, ctx);
  }
}
