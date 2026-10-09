/**
 * `hayven projects` — look after the project registry (`~/.hayven/projects.json`)
 * without hand-editing it.
 *
 * WHY THIS EXISTS: the registry only ever grew. Moving a checkout left a
 * missing ghost row plus a new `<alias>-2`, and the only repair was opening the
 * JSON in an editor while a daemon might be writing it. Every subcommand here
 * goes through the locked, atomic, backed-up mutations in `daemon/registry.ts`
 * and, when a daemon is running, keeps it consistent with no restart (see
 * `projects_live.ts`).
 *
 * `hayven daemon projects` / `hayven daemon unregister` still work unchanged;
 * this is the fuller surface, not a replacement for scripts that use them.
 */
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  classifyUnregisterArg,
  isRegistrableRoot,
  pruneMissingProjects,
  readRegistryRaw,
  relocateProject,
  renameProject,
  sameProjectRoot,
  unregisterProjectDetailed,
  type ProjectEntry,
} from "../daemon/registry.ts";
import { isDirectory } from "../util/paths.ts";
import type { ParsedArgs } from "../cli.ts";
import { isJson } from "./_shared.ts";
import {
  connectLiveDaemon,
  daemonBaseUrl,
  describeServe,
  serveLive,
  servedFor,
  stopServingLive,
  type LiveDaemon,
  type ServedProject,
} from "./projects_live.ts";

export const PROJECTS_USAGE = `hayven projects <subcommand>

  list [--json]                 (default) Every registered project: alias, status,
                                index size, whether the running daemon serves it,
                                and root.
  remove <alias|path>           Forget a project. A BARE NAME is an alias, never a
                                path; pass ./name or an absolute path to remove by
                                location.
  rename <old> <new>            Change a project's alias. Refuses a name that is
                                already taken or would need sanitizing.
  relocate <alias> <new-root> [--force]
                                Point an alias at the repo's new location (after
                                moving it). If <new-root> is already registered
                                under another alias (e.g. lydgr-2), that row is
                                folded in and removed. Refuses when <new-root> is
                                a different project (its .hayven/config.json
                                writer_id differs) unless --force.
  prune [--missing-for <dur>] [--dry-run]
                                Remove every project whose root is missing right
                                now. <dur> (0, 30m, 24h, 7d; default 0) keeps the
                                ones that have not been missing that long.

Every change backs up projects.json first (projects.json.hayven-backup-
YYYYMMDD-HHMMSS, newest 10 kept; hand-made projects.json.bak-* files are
never touched). With a daemon running, it is updated live, with no restart,
except for its PRIMARY project, which changes on \`hayven daemon restart\`.

list --json prints an array of objects with these fields:
  alias           string          the project's handle (?project=<alias>)
  root            string          the registered repo root
  id              string | null   the repo's identity (.hayven/config.json
                                  writer_id), null until a daemon has seen it
  status          "ok" | "missing" | "invalid"
                                  invalid = a root that can never be served (not
                                  absolute, or the home directory)
  missing_since   string | null   ISO time the daemon first found it missing
  index_bytes     number | null   size of .hayven/index.sqlite + -wal; null when
                                  there is no index
  index_modified  string | null   newest mtime of those files. The last-ingest
                                  time itself is NOT reported: it lives inside
                                  the SQLite index, and listing never opens one.
  served          boolean | null  whether the running daemon serves it; null when
                                  no daemon could be asked
  served_alias    string | null   the alias the daemon serves it under, when served
`;

export async function runProjects(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  switch (sub) {
    case "list":
      return listProjects(args);
    case "remove":
      return removeCmd(args);
    case "rename":
      return renameCmd(args);
    case "relocate":
      return relocateCmd(args);
    case "prune":
      return pruneCmd(args);
    case "help":
      process.stdout.write(PROJECTS_USAGE);
      return 0;
    default:
      process.stderr.write(`unknown projects subcommand: ${sub}\n\n${PROJECTS_USAGE}`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

/**
 * A boolean flag, refusing a SWALLOWED value. `parseArgs` gives a flag the
 * next token as its value whenever that token does not start with `-`, so
 * `relocate --force lydgr /new` parses as `force = "lydgr"` and leaves one
 * positional. Treating that as `true` would then run with the wrong arguments.
 */
function boolFlag(args: ParsedArgs, name: string): boolean | Error {
  const v = args.flags[name];
  if (v === undefined || v === false || v === "false") return false;
  if (v === true || v === "true") return true;
  return new Error(`--${name} takes no value; put it after the other arguments (it swallowed "${v}")`);
}

const DURATION_UNITS_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parse `0`, `90s`, `30m`, `24h`, `7d` into ms. A bare number other than 0 is
 * REFUSED rather than guessed at: `--missing-for 7` meaning seven
 * milliseconds would prune everything, which is the opposite of what anyone
 * typing it meant.
 */
export function parseDuration(raw: string): number | Error {
  const s = raw.trim().toLowerCase();
  if (/^0+$/.test(s)) return 0;
  const m = /^(\d+(?:\.\d+)?)([smhd])$/.exec(s);
  if (!m) return new Error(`invalid duration "${raw}": use 0 or a number with s, m, h or d (e.g. 30m, 24h, 7d)`);
  return Math.round(Number(m[1]) * DURATION_UNITS_MS[m[2]!]!);
}

/** `1536` → `1.5 KB`. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fail(message: string, code = 1): number {
  process.stderr.write(`error: ${message}\n`);
  return code;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/** One `list --json` row. Field docs live in {@link PROJECTS_USAGE}. */
export interface ProjectRow {
  alias: string;
  root: string;
  id: string | null;
  status: "ok" | "missing" | "invalid";
  missing_since: string | null;
  index_bytes: number | null;
  index_modified: string | null;
  served: boolean | null;
  served_alias: string | null;
}

/** Size + newest mtime of the legacy index and its WAL, without opening SQLite. */
function indexStats(root: string): { bytes: number | null; modified: string | null } {
  let bytes: number | null = null;
  let newest = 0;
  for (const name of ["index.sqlite", "index.sqlite-wal"]) {
    try {
      const st = statSync(join(root, ".hayven", name));
      bytes = (bytes ?? 0) + st.size;
      newest = Math.max(newest, st.mtimeMs);
    } catch {
      /* absent: contributes nothing */
    }
  }
  return { bytes, modified: newest > 0 ? new Date(newest).toISOString() : null };
}

function rowFor(entry: ProjectEntry, live: LiveDaemon): ProjectRow {
  // RAW rows, so a hand-edited row the daemon refuses to serve is still
  // visible here, where the user can `remove` it.
  const valid = isAbsolute(entry.root) && isRegistrableRoot(entry.root);
  const status = !valid ? "invalid" : isDirectory(entry.root) ? "ok" : "missing";
  const stats = status === "ok" ? indexStats(entry.root) : { bytes: null, modified: null };
  const served = valid ? servedFor(live, entry) : undefined;
  return {
    alias: entry.alias,
    root: entry.root,
    id: entry.id ?? null,
    status,
    missing_since: entry.missing_since ?? null,
    index_bytes: stats.bytes,
    index_modified: stats.modified,
    served: live.kind === "up" ? served !== undefined : null,
    served_alias: served?.alias ?? null,
  };
}

/** Probe the daemon, or report why we could not even work out where it is. */
async function probeLive(): Promise<LiveDaemon> {
  const base = daemonBaseUrl();
  if (base instanceof Error) {
    return { kind: "unmanaged", base: "(unknown)", message: `could not read the daemon address: ${base.message}` };
  }
  return connectLiveDaemon(base);
}

async function listProjects(args: ParsedArgs): Promise<number> {
  const live = await probeLive();
  const rows = readRegistryRaw().map((e) => rowFor(e, live));
  if (isJson(args.flags)) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("no registered projects\n");
  } else {
    const statusText = (r: ProjectRow): string =>
      r.status === "missing"
        ? `missing since ${r.missing_since !== null ? r.missing_since.slice(0, 10) : "(not yet stamped)"}`
        : r.status;
    const servedText = (r: ProjectRow): string =>
      r.served === null ? "-" : r.served ? (r.served_alias === r.alias ? "yes" : `as ${r.served_alias}`) : "no";
    const table = rows.map((r) => [
      r.alias,
      statusText(r),
      r.index_bytes === null ? "-" : humanBytes(r.index_bytes),
      servedText(r),
      r.root,
    ]);
    const head = ["ALIAS", "STATUS", "INDEX", "SERVED", "ROOT"];
    const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
    const line = (cells: string[]): string =>
      cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ") + "\n";
    process.stdout.write(line(head));
    for (const row of table) process.stdout.write(line(row));
  }
  process.stdout.write(`\n${daemonSummary(live)}\n`);
  const missing = rows.filter((r) => r.status === "missing");
  if (missing.length > 0) {
    process.stdout.write(
      `${missing.length} project(s) missing. Moved? \`hayven projects relocate <alias> <new-root>\`. ` +
        "Gone? `hayven projects remove <alias>` or `hayven projects prune`.\n",
    );
  }
  return 0;
}

function daemonSummary(live: LiveDaemon): string {
  switch (live.kind) {
    case "up":
      return `daemon at ${live.base}: serving ${live.projects.length} project(s), primary "${live.primary ?? "?"}"`;
    case "none":
      return `daemon at ${live.base}: not running`;
    case "unmanaged":
      return `daemon: ${live.message}`;
  }
}

// ---------------------------------------------------------------------------
// Keeping a live daemon consistent
// ---------------------------------------------------------------------------

interface StopResult {
  /** Non-primary projects we stopped serving, in order. */
  readonly stopped: ServedProject[];
  /** Served projects we must NOT stop: the daemon's primary owns its port. */
  readonly primary: ServedProject[];
}

/**
 * Stop the live daemon serving every row in `entries` that it serves, BEFORE
 * the registry changes. All or nothing: if one DELETE fails, the ones already
 * stopped are served again and an Error comes back, so a refused command
 * leaves the daemon exactly as it found it.
 *
 * The primary is never sent a DELETE (the daemon refuses it, and the refusal
 * would abort the whole command): it is reported, and the caller says that
 * the change takes effect on restart.
 */
async function stopServed(live: LiveDaemon, entries: readonly ProjectEntry[]): Promise<StopResult | Error> {
  const stopped: ServedProject[] = [];
  const primary: ServedProject[] = [];
  if (live.kind !== "up") return { stopped, primary };
  const seen = new Set<string>();
  for (const entry of entries) {
    const served = servedFor(live, entry);
    if (served === undefined || seen.has(served.alias)) continue;
    seen.add(served.alias);
    if (served.alias === live.primary) {
      primary.push(served);
      continue;
    }
    const res = await stopServingLive(live.base, served.alias);
    if (!res.ok) {
      await restoreServed(live, stopped);
      return new Error(
        `the running daemon would not stop serving "${served.alias}": ${res.message}. Nothing was changed.`,
      );
    }
    stopped.push(served);
  }
  return { stopped, primary };
}

/** Undo {@link stopServed} after a refusal: serve each one again as it was. */
async function restoreServed(live: LiveDaemon, stopped: readonly ServedProject[]): Promise<void> {
  if (live.kind !== "up") return;
  for (const p of stopped) {
    const hot = await serveLive(live.base, p.root, p.alias);
    process.stderr.write(`${describeServe(hot, p.alias)}\n`);
  }
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Say what happened to the daemon when we did not touch it at all. */
function reportUntouched(live: LiveDaemon): void {
  if (live.kind === "none") out("daemon: not running; the change applies on the next `hayven daemon start`");
  else if (live.kind === "unmanaged") out(`daemon: ${live.message}`);
  else out(`daemon at ${live.base}: was not serving it; nothing to update live`);
}

function reportPrimary(primary: readonly ServedProject[], what: string): void {
  for (const p of primary) {
    out(
      `daemon: "${p.alias}" is the running daemon's PRIMARY project, so it was not touched live; ` +
        `${what} takes effect on \`hayven daemon restart\``,
    );
  }
}

// ---------------------------------------------------------------------------
// remove / rename / relocate / prune
// ---------------------------------------------------------------------------

async function removeCmd(args: ParsedArgs): Promise<number> {
  const arg = args.positionals[1];
  if (!arg) return fail("remove requires an alias or a path", 2);
  const target = classifyUnregisterArg(arg);
  const matched = readRegistryRaw().filter((e) =>
    target.kind === "alias" ? e.alias === target.alias : isAbsolute(e.root) && sameProjectRoot(e.root, target.root),
  );
  if (matched.length === 0) {
    // Let the registry phrase the miss: it says which reading was used.
    return fail(unregisterProjectDetailed(arg).message);
  }
  const live = await probeLive();
  const stop = await stopServed(live, matched);
  if (stop instanceof Error) return fail(stop.message);

  const outcome = unregisterProjectDetailed(arg, process.cwd(), { backup: true });
  if (!outcome.removed) {
    // Raced with another writer between our read and the locked one.
    await restoreServed(live, stop.stopped);
    return fail(outcome.message);
  }
  for (const e of outcome.removedEntries) out(`removed "${e.alias}" (${e.root})`);
  if (outcome.backup !== null) out(`backup: ${outcome.backup}`);
  for (const p of stop.stopped) out(`daemon: stopped serving "${p.alias}"`);
  reportPrimary(
    stop.primary,
    "forgetting it (a daemon started from that repo registers it again)",
  );
  if (stop.stopped.length === 0 && stop.primary.length === 0) reportUntouched(live);
  return 0;
}

async function renameCmd(args: ParsedArgs): Promise<number> {
  const [, oldAlias, newAlias] = args.positionals;
  if (!oldAlias || !newAlias) return fail("rename requires <old-alias> <new-alias>", 2);
  let plan;
  try {
    plan = renameProject(oldAlias, newAlias, { dryRun: true });
  } catch (err) {
    return fail((err as Error).message);
  }
  if (plan.entry.alias === plan.previous.alias) {
    out(`"${oldAlias}" already has that alias; nothing to do`);
    return 0;
  }
  const live = await probeLive();
  const stop = await stopServed(live, [plan.previous]);
  if (stop instanceof Error) return fail(stop.message);

  let change;
  try {
    change = renameProject(oldAlias, newAlias);
  } catch (err) {
    await restoreServed(live, stop.stopped);
    return fail((err as Error).message);
  }
  out(`renamed "${change.previous.alias}" -> "${change.entry.alias}" (${change.entry.root})`);
  if (change.backup !== null) out(`backup: ${change.backup}`);
  if (live.kind === "up") {
    for (const p of stop.stopped) {
      out(`daemon: stopped serving "${p.alias}"`);
      out(describeServe(await serveLive(live.base, change.entry.root, change.entry.alias), change.entry.alias));
    }
  }
  reportPrimary(stop.primary, `the new alias "${change.entry.alias}"`);
  if (stop.stopped.length === 0 && stop.primary.length === 0) reportUntouched(live);
  return 0;
}

async function relocateCmd(args: ParsedArgs): Promise<number> {
  const [, alias, newRoot] = args.positionals;
  if (!alias || !newRoot) return fail("relocate requires <alias> <new-root>", 2);
  const force = boolFlag(args, "force");
  if (force instanceof Error) return fail(force.message, 2);
  let plan;
  try {
    plan = relocateProject(alias, newRoot, { force, dryRun: true });
  } catch (err) {
    return fail((err as Error).message);
  }
  if (plan.replaced === undefined && JSON.stringify(plan.entry) === JSON.stringify(plan.previous)) {
    out(`"${alias}" is already registered at ${plan.entry.root}; nothing to do`);
    return 0;
  }
  const live = await probeLive();
  // Everything that might be serving either location: the row itself (at its
  // old root), the row being folded in, and the new root under any alias.
  const involved: ProjectEntry[] = [plan.previous, { alias, root: plan.entry.root }];
  if (plan.replaced !== undefined) involved.push(plan.replaced);
  const stop = await stopServed(live, involved);
  if (stop instanceof Error) return fail(stop.message);

  let change;
  try {
    change = relocateProject(alias, newRoot, { force });
  } catch (err) {
    await restoreServed(live, stop.stopped);
    return fail((err as Error).message);
  }
  out(`relocated "${alias}": ${change.previous.root} -> ${change.entry.root}`);
  if (change.replaced !== undefined) {
    out(`removed "${change.replaced.alias}": it was the same root registered under a second alias`);
  }
  if (change.backup !== null) out(`backup: ${change.backup}`);
  for (const p of stop.stopped) out(`daemon: stopped serving "${p.alias}" (${p.root})`);
  if (live.kind === "up" && stop.primary.length === 0) {
    // Served again even if it was not served before: it was most likely
    // skipped at start BECAUSE its root was missing, and now it is not.
    out(describeServe(await serveLive(live.base, change.entry.root, alias), alias));
  }
  reportPrimary(stop.primary, `serving "${alias}" from ${change.entry.root}`);
  if (live.kind !== "up") reportUntouched(live);
  return 0;
}

async function pruneCmd(args: ParsedArgs): Promise<number> {
  const rawDur = args.flags["missing-for"];
  if (rawDur === true) return fail("--missing-for requires a value, e.g. --missing-for 7d", 2);
  const minMissingMs = parseDuration(typeof rawDur === "string" ? rawDur : "0");
  if (minMissingMs instanceof Error) return fail(minMissingMs.message, 2);
  const dryRun = boolFlag(args, "dry-run");
  if (dryRun instanceof Error) return fail(dryRun.message, 2);

  const plan = pruneMissingProjects({ minMissingMs, dryRun: true });
  const criteria = minMissingMs > 0 ? `missing for at least ${String(rawDur)}` : "missing right now";
  if (plan.removed.length === 0) {
    out(`nothing to prune: no registered project is ${criteria}`);
    return 0;
  }
  if (dryRun) {
    out(`would remove ${plan.removed.length} project(s) ${criteria}:`);
    for (const e of plan.removed) out(`  ${e.alias} -> ${e.root}`);
    return 0;
  }
  const live = await probeLive();
  const stop = await stopServed(live, plan.removed);
  if (stop instanceof Error) return fail(stop.message);
  const done = pruneMissingProjects({ minMissingMs });
  out(`removed ${done.removed.length} project(s) ${criteria}:`);
  for (const e of done.removed) out(`  ${e.alias} -> ${e.root}`);
  if (done.backup !== null) out(`backup: ${done.backup}`);
  for (const p of stop.stopped) out(`daemon: stopped serving "${p.alias}"`);
  reportPrimary(stop.primary, "forgetting it");
  if (stop.stopped.length === 0 && stop.primary.length === 0) reportUntouched(live);
  return 0;
}
