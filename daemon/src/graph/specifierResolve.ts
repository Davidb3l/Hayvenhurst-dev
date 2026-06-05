/**
 * Module-specifier resolution for import (and member-call) edges.
 *
 * The native parser emits `import` edges whose `dst_name` is the RAW module
 * specifier as written in source — `"./useQuery"`, `"~/api/client"`,
 * `"../models/registry.ts"`, `"preact"`, `"node:fs"`. A specifier is never an
 * entity *name*, so the name/qualified-name indexes in `resolveEdges` can't
 * match it and every relative/alias import lands on `?:<specifier>`. That's the
 * dominant source of unresolved edges (a dogfood put it at ~72% of all edges).
 *
 * This module resolves a specifier to the id of the MODULE entity for the file
 * it points at, by:
 *   1. `byFile`: a `repoRelPath → moduleNodeId` index built from the
 *      `kind:"module"` nodes (each module node's `.file` → `.id`).
 *   2. classifying the specifier:
 *      - RELATIVE (`./x`, `../x`): join against `dirname(src_file)`, normalize
 *        `.`/`..`, then probe with extensions and `/index.*`.
 *      - ALIAS (`~/x`, or any non-relative non-bare prefix matched by a nearest
 *        `tsconfig.json` `compilerOptions.paths`): expand via the nearest
 *        tsconfig's `paths` + `baseUrl`, then probe like a relative path.
 *      - BARE (`preact`, `node:fs`, `@scope/pkg`): external — left UNRESOLVED.
 *
 * Everything here is pure given the (nodes, repoRoot) inputs except the tsconfig
 * read, which hits the real filesystem and is cached. Alias resolution degrades
 * to "unresolved" (never throws) when no tsconfig / baseUrl is found, so the
 * relative + extensionless path stays fully unit-testable with synthetic nodes
 * and no filesystem at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { scopeForFile } from "./idScheme.ts";
import type { GraphNode } from "./types.ts";

/** Extensions probed (in order) when a specifier omits one. */
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".astro", ".py", ".rs", ".go"] as const;

/** Posix-normalize a path: forward slashes, collapse `.`/`..`, strip leading `./`. */
export function normalizePosix(p: string): string {
  const segs = p.split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Pop a real segment if there is one; otherwise keep the `..` (the path
      // escapes the start dir — it won't match `byFile` and stays unresolved).
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/**
 * Derive the module entity id for a repo-relative file the way a `module` node
 * would: `<scope>/<stem>` (stem = filename without its extension). Used only as
 * a fallback for files that have no synthetic `module` node, and only accepted
 * when a node with the derived id actually exists.
 */
function moduleIdForFile(file: string): string | null {
  const norm = normalizePosix(file);
  const last = norm.split("/").pop();
  if (!last) return null;
  const dot = last.lastIndexOf(".");
  const stem = dot > 0 ? last.slice(0, dot) : last;
  if (!stem) return null;
  const scope = scopeForFile(norm);
  return scope ? `${scope}/${stem}` : stem;
}

/** Posix dirname of a repo-relative file. */
function posixDir(file: string): string {
  const norm = file.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx < 0 ? "" : norm.slice(0, idx);
}

/**
 * Given a candidate repo-relative path that points at a module file (with or
 * without an extension, possibly a directory needing `/index.*`), return the
 * matching module id from `byFile`, or null.
 */
function probeModule(byFile: Map<string, string>, candidate: string): string | null {
  const base = normalizePosix(candidate);
  // 1. Exact (the specifier already carried an extension: `../models/registry.ts`).
  const exact = byFile.get(base);
  if (exact !== undefined) return exact;
  // 2. Append each known extension (`./useQuery` → `…/useQuery.tsx`).
  for (const ext of EXTENSIONS) {
    const hit = byFile.get(base + ext);
    if (hit !== undefined) return hit;
  }
  // 3. Directory import → `<dir>/index.<ext>`.
  for (const ext of EXTENSIONS) {
    const hit = byFile.get(`${base}/index${ext}`);
    if (hit !== undefined) return hit;
  }
  // 4. A specifier WITH an extension that wasn't in `byFile` directly — strip a
  //    trailing source extension and retry the extension probes. Handles a
  //    `.js` specifier resolving to a `.ts` source (TS `allowImportingTsExtensions`
  //    style / NodeNext rewrite), e.g. `./x.js` → `./x.ts`.
  const dot = base.lastIndexOf(".");
  if (dot > base.lastIndexOf("/")) {
    const stem = base.slice(0, dot);
    for (const ext of EXTENSIONS) {
      const hit = byFile.get(stem + ext);
      if (hit !== undefined) return hit;
    }
  }
  return null;
}

interface TsPaths {
  /** Repo-relative directory the `paths` entries resolve against (baseUrl). */
  baseDir: string;
  /** Ordered alias patterns from `compilerOptions.paths`. */
  entries: Array<{ pattern: string; targets: string[] }>;
}

/**
 * Caches parsed tsconfig `paths`/`baseUrl` keyed by the tsconfig path. A `null`
 * means "no usable paths config here". Created per-resolver so a long-lived
 * process picks up edits on the next ingest (a fresh resolver is built each run).
 */
export class TsconfigCache {
  private cache = new Map<string, TsPaths | null>();

  /**
   * Find the nearest `tsconfig.json` at or above `repoRelDir` (a directory,
   * repo-relative), parse its `compilerOptions.paths`/`baseUrl`, and return the
   * alias config — or null if none is found up to the repo root.
   *
   * @param repoRoot Absolute path of the repo root. Filesystem reads are scoped
   *                 to it; if unset/empty, alias resolution is skipped entirely.
   */
  nearest(repoRoot: string, repoRelDir: string): TsPaths | null {
    if (!repoRoot) return null;
    let dir = normalizePosix(repoRelDir);
    // Walk up: <dir>/tsconfig.json, then parent, … to repo root.
    for (;;) {
      const tsconfigRel = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
      const abs = join(repoRoot, tsconfigRel);
      const cached = this.cache.get(abs);
      const parsed = cached !== undefined ? cached : this.load(repoRoot, dir, abs);
      if (cached === undefined) this.cache.set(abs, parsed);
      if (parsed) return parsed;
      if (!dir) return null; // reached repo root, nothing found
      const parent = posixDir(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  private load(repoRoot: string, tsconfigDirRel: string, abs: string): TsPaths | null {
    if (!existsSync(abs)) return null;
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      return null;
    }
    let json: unknown;
    try {
      json = parseJsonc(raw);
    } catch {
      return null;
    }
    const co = (json as { compilerOptions?: unknown })?.compilerOptions;
    if (!co || typeof co !== "object") return null;
    const opts = co as { paths?: unknown; baseUrl?: unknown };
    const paths = opts.paths;
    if (!paths || typeof paths !== "object") return null;

    // baseUrl is relative to the tsconfig's own directory. Default to the
    // tsconfig dir when baseUrl is omitted (paths still resolve against it).
    const baseUrl = typeof opts.baseUrl === "string" ? opts.baseUrl : ".";
    const baseDir = normalizePosix(
      tsconfigDirRel ? `${tsconfigDirRel}/${baseUrl}` : baseUrl,
    );

    const entries: TsPaths["entries"] = [];
    for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const strTargets = targets.filter((t): t is string => typeof t === "string");
      if (strTargets.length > 0) entries.push({ pattern, targets: strTargets });
    }
    if (entries.length === 0) return null;
    return { baseDir, entries };
  }
}

/**
 * Expand a specifier against a tsconfig `paths` table. Returns the candidate
 * repo-relative paths to probe (in target order), or [] if no pattern matches.
 *
 * Supports the single-`*`-wildcard form TS uses: `"~/*": ["src/*"]` expands
 * `~/api/client` → `<baseDir>/src/api/client`. Also supports exact (no-`*`)
 * mappings.
 */
function expandAlias(spec: string, ts: TsPaths): string[] {
  const candidates: string[] = [];
  for (const { pattern, targets } of ts.entries) {
    const star = pattern.indexOf("*");
    if (star >= 0) {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (spec.startsWith(prefix) && spec.endsWith(suffix) &&
          spec.length >= prefix.length + suffix.length) {
        const matched = spec.slice(prefix.length, spec.length - suffix.length);
        for (const t of targets) {
          const expanded = t.includes("*") ? t.replace("*", matched) : t;
          candidates.push(normalizePosix(`${ts.baseDir}/${expanded}`));
        }
      }
    } else if (spec === pattern) {
      for (const t of targets) candidates.push(normalizePosix(`${ts.baseDir}/${t}`));
    }
  }
  return candidates;
}

/** True for a bare/external specifier (npm pkg, `node:` builtin, absolute). */
function isBare(spec: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return false; // relative
  }
  // Absolute or protocol-prefixed (`node:fs`, `/abs`) → external/non-entity.
  if (spec.startsWith("/") || isAbsolute(spec)) return true;
  // Everything else (`preact`, `@scope/pkg`, `~/x`) is "non-relative"; whether
  // it's an alias is decided by the tsconfig paths table at resolution time.
  return false;
}

/**
 * A reusable module-specifier resolver. Build once per ingest from the node set
 * + repo root; call {@link resolve} per import edge.
 */
export class SpecifierResolver {
  private byFile = new Map<string, string>();
  private tsconfigs = new TsconfigCache();

  constructor(
    nodes: GraphNode[],
    private repoRoot: string,
  ) {
    // Pass 1: the authoritative `file → moduleId` mapping from `module` nodes.
    for (const n of nodes) {
      if (n.kind === "module") {
        // A file should have exactly one module node; last write wins if not.
        this.byFile.set(normalizePosix(n.file), n.id);
      }
    }
    // Pass 2: some files have NO synthetic `module` node — e.g. a viewer
    // component whose default export is an arrow-const (`useQuery.ts` is parsed
    // as a top-level `function`, not a `module`). An import like `./useQuery`
    // legitimately targets such a file, but there's no module node to map to.
    // For any file we haven't already mapped, fall back to the module id derived
    // from the file path via the SAME scheme module nodes use
    // (`<scope>/<stem>`), so the specifier still resolves to a real entity id
    // that exists in the graph. We only register a derived id when a node with
    // exactly that id is present (so we never invent a dangling target).
    const idSet = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      const file = normalizePosix(n.file);
      if (this.byFile.has(file)) continue;
      const derived = moduleIdForFile(file);
      if (derived && idSet.has(derived)) this.byFile.set(file, derived);
    }
  }

  /** Expose the file→moduleId index (read-only use by callers/tests). */
  get fileIndex(): ReadonlyMap<string, string> {
    return this.byFile;
  }

  /**
   * Resolve a module specifier as written in `src_file` to a module entity id,
   * or null when it doesn't point at a known repo module (bare/external, or an
   * unmatched relative/alias path — both correctly left UNRESOLVED upstream).
   */
  resolve(srcFile: string, spec: string): string | null {
    if (!spec) return null;
    const srcDir = posixDir(srcFile.replace(/\\/g, "/"));

    // RELATIVE — resolve against the importing file's directory.
    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      const joined = srcDir ? `${srcDir}/${spec}` : spec;
      return probeModule(this.byFile, joined);
    }

    // BARE/absolute/protocol — external, never a repo entity.
    if (isBare(spec)) return null;

    // ALIAS — try the nearest tsconfig's paths table. If none matches, it's a
    // bare npm import after all → unresolved.
    const ts = this.tsconfigs.nearest(this.repoRoot, srcDir);
    if (ts) {
      for (const candidate of expandAlias(spec, ts)) {
        const hit = probeModule(this.byFile, candidate);
        if (hit !== null) return hit;
      }
    }
    return null;
  }
}

/**
 * Minimal JSONC parser: strips `//` line comments, `/* *​/` block comments, and
 * trailing commas, then `JSON.parse`s. tsconfig.json is JSONC and astro's
 * extends-based config commonly uses comments. Best-effort: throws (caught by
 * the caller) on genuinely malformed JSON.
 */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  let inString = false;
  let quote = "";
  while (i < n) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Strip trailing commas before } or ].
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}
