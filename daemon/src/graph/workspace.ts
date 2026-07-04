/**
 * Workspace (monorepo) package discovery + bare-specifier mapping.
 *
 * Measured motivation (bench/monorepo-astro-RESULTS.md §2b): on withastro/astro
 * ALL 1,348 workspace-package import edges dangled (`?:astro/config`,
 * `?:@astrojs/mdx`, …) because the specifier resolver treated every bare
 * specifier as external — pnpm-workspace's `packages/*` → `astro`/`@astrojs/*`
 * mappings were never consulted. This module reads the repo's workspace
 * manifests and maps a bare specifier to candidate IN-REPO source paths, so
 * `importers`/`refs`/`impact` can cross package boundaries by EDGE instead of
 * name-match luck.
 *
 * Sources consulted (simple cases only, by design):
 *   - `pnpm-workspace.yaml` → `packages:` list (a tiny hand-rolled YAML-subset
 *     reader: top-level key + `- item` block list; negation patterns are
 *     ignored — a dir only counts if it holds a named `package.json` anyway).
 *   - root `package.json` → `workspaces` (array, or `{ packages: [...] }`).
 *   - each matched package dir's `package.json` → `name`, `exports`, `main`,
 *     `module`.
 *
 * Glob support is deliberately minimal: literal segments plus single-`*`
 * segments (`packages/*`, `packages/integrations/*`). `**` patterns are
 * skipped (best-effort — none of the surveyed workspaces need them for the
 * package list itself).
 *
 * Specifier → candidate paths: `exports` subpath targets (string leaves of
 * conditional objects, single-`*` wildcards), then `main`/`module`, then the
 * conventional `src/<subpath>` / `<subpath>` / `src/index` probes. Because
 * published `exports` targets usually point at BUILT files (`./dist/x.js`)
 * that aren't in the index, every `dist/`-rooted target also yields a
 * `src/`-swapped candidate (the actual source the graph indexed); the caller's
 * extension probing handles the `.js` → `.ts` mismatch. All of this is
 * candidate GENERATION only — the caller accepts a candidate solely when it
 * probes to a real indexed module, so a miss degrades to unresolved (honest),
 * never to an invented edge.
 *
 * Everything degrades to an EMPTY map on any read/parse failure: a repo with
 * no workspace manifests behaves exactly as before this module existed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** One workspace package, as discovered from its `package.json`. */
export interface WorkspacePackage {
  /** The published name (`astro`, `@astrojs/mdx`) — the bare-specifier key. */
  name: string;
  /** Repo-relative posix dir of the package (no trailing slash). */
  dir: string;
  /** Raw `exports` field, if any (string or conditional/subpath object). */
  exports: unknown;
  /** `main` entry, if any. */
  main: string | null;
  /** `module` entry, if any. */
  module: string | null;
}

/** Posix-normalize helper (local copy — keeps this module dependency-free). */
function posixNorm(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
}

/**
 * Parse the `packages:` block list out of a pnpm-workspace.yaml. Hand-rolled
 * YAML SUBSET on purpose (repo style: no dependency for a 20-line need): a
 * top-level `packages:` key followed by `- item` lines, quotes stripped,
 * `#` comments and blank lines tolerated, negations (`!…`) skipped.
 */
export function parsePnpmWorkspacePackages(yaml: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (!inBlock) {
      if (/^packages\s*:\s*(#.*)?$/.test(line)) inBlock = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = /^-\s*(.+?)\s*$/.exec(trimmed);
    if (!m) {
      // Not a list item — the block ended (next top-level key).
      inBlock = false;
      continue;
    }
    let item = m[1]!.replace(/\s+#.*$/, "").trim();
    if (
      (item.startsWith('"') && item.endsWith('"')) ||
      (item.startsWith("'") && item.endsWith("'"))
    ) {
      item = item.slice(1, -1);
    }
    if (item && !item.startsWith("!")) out.push(item);
  }
  return out;
}

/**
 * Expand a workspace glob pattern against the real filesystem. Supports
 * literal segments and single-`*` (prefix*suffix) segments; `**` is skipped.
 * Returns repo-relative posix dirs that exist and are directories.
 */
function expandPattern(repoRoot: string, pattern: string): string[] {
  const segs = posixNorm(pattern).split("/").filter(Boolean);
  if (segs.some((s) => s === "**")) return [];
  let dirs: string[] = [""];
  for (const seg of segs) {
    const next: string[] = [];
    for (const d of dirs) {
      if (seg.includes("*")) {
        const star = seg.indexOf("*");
        const prefix = seg.slice(0, star);
        const suffix = seg.slice(star + 1);
        let entries;
        try {
          entries = readdirSync(join(repoRoot, d), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const name = e.name;
          if (name === "node_modules" || name.startsWith(".")) continue;
          if (
            name.startsWith(prefix) &&
            name.endsWith(suffix) &&
            name.length >= prefix.length + suffix.length
          ) {
            next.push(d ? `${d}/${name}` : name);
          }
        }
      } else {
        next.push(d ? `${d}/${seg}` : seg);
      }
    }
    dirs = next;
  }
  return dirs.filter((d) => {
    if (!d) return false;
    try {
      return statSync(join(repoRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Collect every string leaf of an `exports` target value, insertion order. */
function collectTargetStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 4) return; // defensive: conditions don't nest deeper in practice
  if (typeof v === "string") {
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectTargetStrings(x, out, depth + 1);
    return;
  }
  if (v && typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) {
      collectTargetStrings(x, out, depth + 1);
    }
  }
}

/**
 * A map of the repo's workspace packages, queryable by bare specifier and by
 * file path. Build once per ingest via {@link WorkspaceMap.load}; a repo with
 * no workspace manifests yields an EMPTY map (single-package behavior).
 */
export class WorkspaceMap {
  private byName = new Map<string, WorkspacePackage>();
  /** Package dirs, longest-first, for the longest-prefix file→package match. */
  private dirsLongestFirst: string[] = [];

  constructor(packages: WorkspacePackage[]) {
    for (const p of packages) {
      if (!this.byName.has(p.name)) this.byName.set(p.name, p);
    }
    this.dirsLongestFirst = [...new Set(packages.map((p) => p.dir))].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** Number of discovered workspace packages (0 == not a workspace repo). */
  get size(): number {
    return this.byName.size;
  }

  /** The discovered packages (read-only use by callers/tests). */
  get packages(): ReadonlyMap<string, WorkspacePackage> {
    return this.byName;
  }

  /**
   * Read the workspace manifests under `repoRoot` and build the map. Never
   * throws — any failure yields an empty map (graceful single-package
   * degradation).
   */
  static load(repoRoot: string): WorkspaceMap {
    if (!repoRoot) return new WorkspaceMap([]);
    const patterns: string[] = [];
    try {
      const pnpmPath = join(repoRoot, "pnpm-workspace.yaml");
      if (existsSync(pnpmPath)) {
        patterns.push(...parsePnpmWorkspacePackages(readFileSync(pnpmPath, "utf8")));
      }
      const rootPkgPath = join(repoRoot, "package.json");
      if (existsSync(rootPkgPath)) {
        const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as {
          workspaces?: unknown;
        };
        const ws = rootPkg.workspaces;
        if (Array.isArray(ws)) {
          patterns.push(...ws.filter((x): x is string => typeof x === "string"));
        } else if (ws && typeof ws === "object") {
          const pk = (ws as { packages?: unknown }).packages;
          if (Array.isArray(pk)) {
            patterns.push(...pk.filter((x): x is string => typeof x === "string"));
          }
        }
      }
    } catch {
      return new WorkspaceMap([]);
    }
    if (patterns.length === 0) return new WorkspaceMap([]);

    const packages: WorkspacePackage[] = [];
    const seenDirs = new Set<string>();
    for (const pattern of patterns) {
      for (const dir of expandPattern(repoRoot, pattern)) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        try {
          const raw = readFileSync(join(repoRoot, dir, "package.json"), "utf8");
          const pkg = JSON.parse(raw) as {
            name?: unknown;
            exports?: unknown;
            main?: unknown;
            module?: unknown;
          };
          if (typeof pkg.name !== "string" || pkg.name.length === 0) continue;
          packages.push({
            name: pkg.name,
            dir,
            exports: pkg.exports,
            main: typeof pkg.main === "string" ? pkg.main : null,
            module: typeof pkg.module === "string" ? pkg.module : null,
          });
        } catch {
          // No/broken package.json → not a package dir; skip.
        }
      }
    }
    return new WorkspaceMap(packages);
  }

  /**
   * The workspace-package DIR containing `repoRelFile` (longest prefix match),
   * or `""` for a file outside every package (the implicit root package).
   * Package-identity for the ingest resolver's within-package name scoping.
   */
  packageForFile(repoRelFile: string): string {
    if (this.dirsLongestFirst.length === 0) return "";
    const file = posixNorm(repoRelFile);
    for (const dir of this.dirsLongestFirst) {
      if (file.startsWith(`${dir}/`)) return dir;
    }
    return "";
  }

  /**
   * Candidate repo-relative SOURCE paths a bare specifier may resolve to, most
   * specific first. Empty when the specifier names no workspace package. The
   * caller must probe each candidate against the real module index — nothing
   * here asserts existence.
   */
  candidatePaths(spec: string): string[] {
    const match = this.matchSpecifier(spec);
    if (!match) return [];
    const { pkg, subpath } = match;
    const targets: string[] = [];

    // 1. `exports` map. For the package root the key is "."; a subpath import
    //    uses "./<subpath>" (exact first, then single-`*` wildcard patterns).
    const exp = pkg.exports;
    if (typeof exp === "string") {
      if (subpath === "") collectTargetStrings(exp, targets);
    } else if (exp && typeof exp === "object" && !Array.isArray(exp)) {
      const entries = Object.entries(exp as Record<string, unknown>);
      const wantKey = subpath === "" ? "." : `./${subpath}`;
      // Bare-object exports without "./" keys ({ import: "...", default: "..." })
      // describe the ROOT entry only.
      const hasSubpathKeys = entries.some(([k]) => k === "." || k.startsWith("./"));
      if (!hasSubpathKeys) {
        if (subpath === "") collectTargetStrings(exp, targets);
      } else {
        for (const [key, value] of entries) {
          if (key === wantKey) collectTargetStrings(value, targets);
        }
        if (subpath !== "") {
          for (const [key, value] of entries) {
            const star = key.indexOf("*");
            if (star < 0) continue;
            const prefix = key.slice(2, star); // strip leading "./"
            const suffix = key.slice(star + 1);
            if (
              key.startsWith("./") &&
              subpath.startsWith(prefix) &&
              subpath.endsWith(suffix) &&
              subpath.length >= prefix.length + suffix.length
            ) {
              const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
              const raw: string[] = [];
              collectTargetStrings(value, raw);
              for (const t of raw) targets.push(t.replace("*", matched));
            }
          }
        }
      }
    }

    // 2. Root-entry manifest fields.
    if (subpath === "") {
      if (pkg.module) targets.push(pkg.module);
      if (pkg.main) targets.push(pkg.main);
    }

    // 3. Conventional source-layout fallbacks. `exports` targets usually name
    //    BUILT artifacts (`./dist/x.js`) the index never saw; the graph indexed
    //    the SOURCE, so probe the conventional source locations too.
    if (subpath === "") {
      targets.push("src/index", "index");
    } else {
      targets.push(`src/${subpath}`, subpath);
    }

    // Expand to repo-relative candidates; a `dist/`-rooted target also yields
    // its `src/`-swapped twin (built artifact → the source that produced it).
    const out: string[] = [];
    const push = (p: string): void => {
      const norm = posixNorm(p);
      if (norm && !out.includes(norm)) out.push(norm);
    };
    for (const t of targets) {
      const rel = posixNorm(t);
      if (!rel || rel.startsWith("..")) continue;
      push(`${pkg.dir}/${rel}`);
      if (rel.startsWith("dist/")) {
        push(`${pkg.dir}/src/${rel.slice("dist/".length)}`);
      }
    }
    return out;
  }

  /** Match `spec` to a package by name (`astro`, `@astrojs/mdx/utils` → mdx). */
  private matchSpecifier(spec: string): { pkg: WorkspacePackage; subpath: string } | null {
    if (this.byName.size === 0 || !spec || spec.startsWith(".")) return null;
    // Exact name first, then the longest name that prefixes `spec` at a `/`
    // boundary (scoped names contain one `/` themselves, so a simple split
    // can't distinguish `@astrojs/mdx` from a subpath).
    const exact = this.byName.get(spec);
    if (exact) return { pkg: exact, subpath: "" };
    let best: WorkspacePackage | null = null;
    for (const [name, pkg] of this.byName) {
      if (spec.startsWith(`${name}/`) && (best === null || name.length > best.name.length)) {
        best = pkg;
      }
    }
    if (!best) return null;
    return { pkg: best, subpath: spec.slice(best.name.length + 1) };
  }
}
