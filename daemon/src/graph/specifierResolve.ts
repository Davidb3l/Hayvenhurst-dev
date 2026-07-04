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
 *      - BARE (`preact`, `node:fs`, `@scope/pkg`): external — left UNRESOLVED,
 *        EXCEPT a DOTTED Python-style specifier (`werkzeug.exceptions`,
 *        `werkzeug.exceptions.HTTPException`) which is additively probed against
 *        an internal module index (see below) and resolved only when it matches a
 *        real internal node — otherwise still UNRESOLVED (external, correct).
 *
 * DOTTED-PYTHON internal resolution (additive): Python imports arrive as dotted
 * specifiers (`from werkzeug.exceptions import HTTPException` → the parser emits a
 * `?:werkzeug.exceptions.HTTPException` placeholder). Node ids use `/`, not `.`,
 * so the dotted form never matched the relative/alias classifiers and every
 * Python import stayed unresolved. We build a `byImportPath` index mapping each
 * module node's DOTTED-EQUIVALENT import path (derived from its file: strip a
 * leading `src/` the same way {@link scopeForFile} does, drop the extension, and
 * fold `__init__.py`/`__init__.pyi` to the package dir) → its module id. A dotted
 * specifier is split on `.`, and we probe the LONGEST module prefix that matches
 * `byImportPath`; any trailing segments are then tried as a symbol under that
 * module id (`<moduleId>/<rest>`, else `<moduleId>/<lastSegment>`), preferring a
 * real symbol node, else resolving to the module. A dotted specifier whose
 * leading segment is not an internal package (`os.path`, `IPython.*`) matches
 * nothing and stays unresolved (external, correct). This is strictly ADDITIVE:
 * it only fires on the BARE/external fall-through and only returns an id that
 * exists in the graph, so TS/JS/Rust/Go and genuinely-external specifiers are
 * unchanged.
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
import { WorkspaceMap } from "./workspace.ts";

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

/**
 * Derive the DOTTED-EQUIVALENT import path for a module file, as a `/`-joined
 * key (dots→slashes already applied). Mirrors {@link scopeForFile}'s "everything
 * after the first `src/` segment" convention so the key lines up with the
 * dotted import specifier a Python `import`/`from` writes:
 *   `src/werkzeug/exceptions.py`  → `werkzeug/exceptions`
 *   `src/werkzeug/__init__.py`    → `werkzeug`               (package)
 *   `pkg/sub/mod.py`              → `pkg/sub/mod`            (no `src/`)
 * `__init__.py`/`__init__.pyi` fold to the package directory (the name a bare
 * `import pkg.sub` targets). Returns "" for a path with no usable segments.
 */
function importPathForFile(file: string): string {
  let parts = normalizePosix(file).split("/").filter(Boolean);
  const srcIdx = parts.indexOf("src");
  if (srcIdx >= 0) parts = parts.slice(srcIdx + 1);
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1]!;
  if (last === "__init__.py" || last === "__init__.pyi") {
    parts = parts.slice(0, -1);
  } else {
    const dot = last.lastIndexOf(".");
    if (dot > 0) parts[parts.length - 1] = last.slice(0, dot);
  }
  return parts.join("/");
}

/**
 * True if `spec` looks like a plain (dotted or dotless) Python-style import path
 * we can additively probe against the internal module index. Rejects anything
 * with a scheme (`node:fs`), scope (`@x/y`), slash, whitespace, or leading dot
 * (relative Python imports arrive with leading dots and are handled elsewhere;
 * the parser does not currently emit them in a resolvable form).
 *
 * NB: a dotless bare name (`werkzeug`, but also `preact`) is allowed here — the
 * probe stays additive because {@link SpecifierResolver.resolveDotted} only
 * returns an id when the leading segment matches a real internal package node,
 * so genuinely-external bare imports (`preact`) still return null.
 */
function isDottedInternalCandidate(spec: string): boolean {
  if (spec.startsWith(".") || spec.includes("/") || spec.includes(":")) return false;
  if (spec.startsWith("@") || /\s/.test(spec)) return false;
  return spec.length > 0;
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
  // 3. Directory import → `<dir>/index.<ext>`. When the normalized base is ""
  //    (a package-ROOT import: `require('..')` from a top-level test dir — the
  //    single most common specifier in a CJS test suite), the join must not
  //    produce a leading slash: byFile keys are repo-relative WITHOUT one, so
  //    `/index.js` could never hit (measured: 68 `?:..`/`?:../` edges on
  //    express all targeting the indexed root `index.js`).
  const dirPrefix = base === "" ? "" : `${base}/`;
  for (const ext of EXTENSIONS) {
    const hit = byFile.get(`${dirPrefix}index${ext}`);
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
  /** Dotted-equivalent import path (`werkzeug/exceptions`) → module node id. */
  private byImportPath = new Map<string, string>();
  /** Every node id in the graph — used to probe dotted symbol targets. */
  private idSet = new Set<string>();
  private tsconfigs = new TsconfigCache();
  /** Lazily-loaded workspace package map (empty for non-workspace repos). */
  private ws: WorkspaceMap | null;

  constructor(
    nodes: GraphNode[],
    private repoRoot: string,
    workspace?: WorkspaceMap,
  ) {
    this.ws = workspace ?? null;
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
    this.idSet = idSet;
    for (const n of nodes) {
      const file = normalizePosix(n.file);
      if (this.byFile.has(file)) continue;
      const derived = moduleIdForFile(file);
      if (derived && idSet.has(derived)) this.byFile.set(file, derived);
    }
    // Pass 3: dotted-import-path → module id, for internal Python dotted imports.
    // Built only from `module` nodes (the only kind whose id is the module
    // target). First writer wins so a real `module` node beats a derived one.
    for (const n of nodes) {
      if (n.kind !== "module") continue;
      const key = importPathForFile(n.file);
      if (key && !this.byImportPath.has(key)) this.byImportPath.set(key, n.id);
    }
  }

  /** Expose the file→moduleId index (read-only use by callers/tests). */
  get fileIndex(): ReadonlyMap<string, string> {
    return this.byFile;
  }

  /**
   * The repo's workspace package map (loaded lazily from `repoRoot`; empty for
   * a non-workspace repo or an unset root). Shared with the ingest resolver so
   * name-match scoping and bare-specifier mapping agree on package identity.
   */
  get workspace(): WorkspaceMap {
    if (this.ws === null) this.ws = WorkspaceMap.load(this.repoRoot);
    return this.ws;
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
      const direct = probeModule(this.byFile, joined);
      if (direct !== null) return direct;
      // BUILT-ARTIFACT swap: monorepo tests routinely import the package's
      // build output relatively (`../dist/index.js`). `dist/` is always
      // walker-skipped, so such a specifier can never probe directly — but the
      // SOURCE that produced it is indexed. Swap the first `dist` segment for
      // `src` (extension mismatch `.js`→`.ts` is handled by probeModule's stem
      // retry). Safe: dist is never indexed, so the swap cannot shadow a real
      // module, and a miss still returns null (unresolved, honest).
      const norm = normalizePosix(joined);
      const swapped = norm.replace(/(^|\/)dist\//, "$1src/");
      if (swapped !== norm) return probeModule(this.byFile, swapped);
      return null;
    }

    // BARE/absolute/protocol — external, never a repo entity.
    if (isBare(spec)) return null;

    // DOTTED PYTHON-STYLE — additively probe the internal module index. Only
    // fires when the specifier's leading segment is an internal package AND the
    // match is a real node id; otherwise falls through to unresolved (external).
    if (isDottedInternalCandidate(spec)) {
      const hit = this.resolveDotted(spec);
      if (hit !== null) return hit;
    }

    // ALIAS — try the nearest tsconfig's paths table.
    const ts = this.tsconfigs.nearest(this.repoRoot, srcDir);
    if (ts) {
      for (const candidate of expandAlias(spec, ts)) {
        const hit = probeModule(this.byFile, candidate);
        if (hit !== null) return hit;
      }
    }

    // WORKSPACE — a bare specifier naming an IN-REPO workspace package
    // (`astro/config`, `@astrojs/mdx`). Candidate paths come from the package's
    // manifest (`exports`/`main`, with `dist/`→`src/` swaps) plus conventional
    // source-layout probes; a candidate only wins when it maps to a REAL
    // indexed module, so a genuinely-external bare import still falls through
    // to unresolved (correct). Tried after tsconfig aliases so pre-existing
    // alias behavior is byte-identical.
    for (const candidate of this.workspace.candidatePaths(spec)) {
      const hit = probeModule(this.byFile, candidate);
      if (hit !== null) return hit;
    }
    return null;
  }

  /**
   * Resolve a dotted Python-style specifier (`werkzeug.exceptions.HTTPException`)
   * to an internal node id, or null when no internal package matches (external).
   *
   * Splits on `.` and probes the LONGEST module prefix present in
   * `byImportPath`. Trailing segments (the imported symbol path) are tried under
   * the matched module id, preferring a real symbol node id
   * (`<moduleId>/<rest…>`, then `<moduleId>/<lastSegment>`); with no symbol match
   * we resolve to the module itself. A specifier whose leading segment is not an
   * internal package matches no prefix and returns null.
   */
  resolveDotted(spec: string): string | null {
    const segs = spec.split(".").filter(Boolean);
    if (segs.length === 0) return null;
    for (let k = segs.length; k >= 1; k--) {
      const moduleId = this.byImportPath.get(segs.slice(0, k).join("/"));
      if (moduleId === undefined) continue;
      const rest = segs.slice(k);
      if (rest.length > 0) {
        // Prefer the fully-qualified symbol path, then the bare last segment
        // (e.g. `from pkg.mod import Cls` → `pkg/mod/Cls`), else the module.
        const full = `${moduleId}/${rest.join("/")}`;
        if (this.idSet.has(full)) return full;
        const last = `${moduleId}/${rest[rest.length - 1]}`;
        if (this.idSet.has(last)) return last;
      }
      return moduleId;
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
