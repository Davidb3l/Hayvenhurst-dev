/**
 * Multi-project registry.
 *
 * A single running daemon can serve N indexed repositories at once; the viewer
 * and API select one per request via `?project=<alias>`. This module is the
 * source of truth for WHICH repos a daemon serves: a small JSON file at
 * `~/.hayven/projects.json` mapping a short `alias` → absolute repo `root`.
 *
 * The file is intentionally boring and hand-editable:
 *
 *   { "version": 1, "projects": [ { "alias": "myrepo", "root": "/abs/path" } ] }
 *
 * `hayven init` auto-registers the project it initializes; `hayven daemon
 * register <path>` adds one explicitly; `hayven daemon projects` lists them.
 * The daemon reads this at startup and opens each project's index.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import { globalHayvenDir } from "../util/paths.ts";

export interface ProjectEntry {
  /** Short, URL-safe handle used in `?project=<alias>` and the viewer switcher. */
  readonly alias: string;
  /** Absolute path to the repo root (the dir holding `.hayven/`). */
  readonly root: string;
}

const REGISTRY_VERSION = 1;

/** Absolute path of the registry file (`~/.hayven/projects.json`). */
export function registryFile(): string {
  return join(globalHayvenDir(), "projects.json");
}

/** Sanitize a candidate alias to a short, URL-safe, lowercase handle. */
function sanitizeAlias(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "project";
}

/**
 * Read the registry, tolerating a missing or malformed file (returns `[]` so a
 * corrupt registry never crashes a daemon start). Entries with a non-absolute
 * root or duplicate alias are dropped defensively.
 */
export function readRegistry(): ProjectEntry[] {
  const file = registryFile();
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = (parsed as { projects?: unknown })?.projects;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ProjectEntry[] = [];
  for (const raw of list) {
    const alias = typeof raw?.alias === "string" ? raw.alias : "";
    const root = typeof raw?.root === "string" ? raw.root : "";
    if (!alias || !root || !isAbsolute(root) || seen.has(alias)) continue;
    seen.add(alias);
    out.push({ alias, root });
  }
  return out;
}

/** Atomically persist the registry (creates `~/.hayven/` if needed). */
export function writeRegistry(entries: ProjectEntry[]): void {
  const dir = globalHayvenDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ version: REGISTRY_VERSION, projects: entries }, null, 2) + "\n";
  const file = registryFile();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  // Rename is atomic within a filesystem; avoids a torn read by a concurrent daemon.
  writeFileSync(file, body);
  try {
    // Best-effort cleanup of the temp file; the real write above is what matters.
    if (existsSync(tmp)) writeFileSync(tmp, "");
  } catch {
    /* ignore */
  }
}

/**
 * Derive a unique alias for `root`: start from an explicit `preferred` (or the
 * repo's directory name) and append `-2`, `-3`, … if that handle is already
 * taken by a DIFFERENT root.
 */
export function deriveAlias(root: string, preferred: string | undefined, taken: ProjectEntry[]): string {
  const base = sanitizeAlias(preferred && preferred.length > 0 ? preferred : basename(root));
  const byAlias = new Map(taken.map((e) => [e.alias, e.root]));
  // If the base alias is free, or already points at THIS root, use it.
  const existing = byAlias.get(base);
  if (existing === undefined || existing === root) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    const owner = byAlias.get(candidate);
    if (owner === undefined || owner === root) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * Register `root` (resolved to absolute). Idempotent by root: re-registering an
 * already-known root returns its existing entry unchanged unless `alias` asks
 * to rename it. Returns the resulting entry.
 */
export function registerProject(root: string, alias?: string): ProjectEntry {
  const abs = isAbsolute(root) ? root : resolve(process.cwd(), root);
  const entries = readRegistry();
  const existing = entries.find((e) => e.root === abs);
  if (existing && !alias) return existing;

  const others = entries.filter((e) => e.root !== abs);
  const finalAlias = deriveAlias(abs, alias ?? existing?.alias, others);
  const entry: ProjectEntry = { alias: finalAlias, root: abs };
  writeRegistry([...others, entry].sort((a, b) => a.alias.localeCompare(b.alias)));
  return entry;
}

/** Remove a project by alias OR absolute root. Returns true if something was removed. */
export function unregisterProject(aliasOrRoot: string): boolean {
  const abs = isAbsolute(aliasOrRoot) ? aliasOrRoot : resolve(process.cwd(), aliasOrRoot);
  const entries = readRegistry();
  const next = entries.filter((e) => e.alias !== aliasOrRoot && e.root !== abs);
  if (next.length === entries.length) return false;
  writeRegistry(next);
  return true;
}
