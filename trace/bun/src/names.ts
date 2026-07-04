/**
 * Frame -> graph node-id derivation and scoping for the Bun/Node collector.
 *
 * ## Entity-id convention
 *
 * Each kept call frame becomes `"<module>:<functionName>"` where:
 *
 *   - `<module>` is the source file's basename without extension
 *     (`auth.ts` -> `auth`), derived from the frame's `url`.
 *   - `<functionName>` is V8's `callFrame.functionName`. V8 already qualifies
 *     methods as `Class.method` / `obj.method`, so a class method shows up as
 *     e.g. `auth:Session.login` and a bare function as `auth:login`.
 *
 * This mirrors the Python collector's `"<module>:<qualname>"` shape. The
 * daemon's resolver normalizes separators and matches the **trailing**
 * segment(s) of the runtime name against its node index — the 2-segment
 * `Type.method` qualified name first, then the bare final `name` — accepting
 * only UNAMBIGUOUS matches. By putting the function's qualified name in the
 * trailing position (after the `:` module hint), names like `auth:Session.login`
 * resolve on the trailing `Session.login` / `login` the index carries, and
 * `db:getUser` on `getUser`. Unresolvable names are kept by the daemon as
 * orphan observations (no data loss; just not joined to a node).
 *
 * Anonymous frames (`functionName === ""`) are dropped: V8 reports them for
 * arrow callbacks/IIFEs with no stable name, and an unnamed edge can never
 * resolve to a graph entity anyway.
 *
 * ## Scoping
 *
 * Pseudo-frames (`(root)`, `(program)`, `(idle)`, `(garbage collector)`),
 * the collector's own frames, Node/Bun internals (`node:` / `bun:` URLs),
 * `node_modules`, and `eval`/`<anonymous>` sources are dropped by default so
 * the trace reflects the user's own call graph (mirrors the Python collector's
 * stdlib filter and trace/go's runtime-frame drop). When `projectPaths` /
 * module prefixes are supplied, ONLY frames whose file path OR derived module
 * id starts with one of them are kept.
 */

import type { CallFrame, NameResolver } from "./profile.ts";

export interface ScopeOptions {
  /**
   * Path or module-prefix scope. A frame is kept only if its source file path
   * (decoded from the `file://` url) OR its derived `<module>:<fn>` id starts
   * with one of these prefixes. Empty array = keep everything that survives
   * the default internal/node_modules filtering.
   */
  projectPaths?: string[];
  /**
   * Keep `node_modules` / `node:` / `bun:` internal frames. Default false.
   */
  includeInternal?: boolean;
  /**
   * Repo root for PATH-QUALIFIED module hints. When set and a frame's source
   * file lives under this directory, the module hint becomes the repo-relative
   * path without extension (`src/utils/body`) instead of the bare basename
   * (`body`), so the emitted id is `src/utils/body:parseBody`.
   *
   * WHY (measured, bench/affected-tests-typescript-RESULTS.md §"Resolution
   * quality"): basename-only hints are near-useless in idiomatic TS — hono has
   * 5 `router.ts` and dozens of `index.ts`, so 69 of 102 unresolved runtime
   * names were ambiguous purely because the hint couldn't disambiguate. The
   * daemon's resolver already scores module-hint segments against entity-id
   * path segments; repo-relative hints let that scoring actually bite. Frames
   * OUTSIDE the root (or when unset) keep the basename hint, so synthetic /
   * out-of-repo frames are unchanged.
   */
  moduleRoot?: string;
}

/** Strip a `file://` URL (or plain path) down to an absolute filesystem path. */
export function urlToPath(url: string | undefined): string {
  if (!url) return "";
  if (url.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      return url.slice("file://".length);
    }
  }
  return url;
}

/** `/a/b/auth.ts` -> `auth`; `/a/b/index.js` -> `index`; `node:fs` -> `fs`; falls back to "". */
export function moduleOf(path: string): string {
  if (!path) return "";
  // Strip a `node:` / `bun:` scheme so internal frames get a clean module hint.
  const scheme = path.match(/^[a-z]+:/);
  const cleaned = scheme && (scheme[0] === "node:" || scheme[0] === "bun:") ? path.slice(scheme[0].length) : path;
  const base = cleaned.split("/").pop() ?? cleaned;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem;
}

/**
 * Path-qualified module id: the path RELATIVE to `root`, extension stripped,
 * `/`-joined (`src/utils/body.test.ts` under the repo root -> `src/utils/body.test`).
 * Falls back to {@link moduleOf}'s basename when the path is not under `root`
 * (or `root` is empty). The daemon's trace resolver treats every segment before
 * the function name as a module HINT, so the extra path segments strictly ADD
 * disambiguation signal — the trailing-name matching is unchanged.
 */
export function moduleIdOf(path: string, root: string | undefined): string {
  if (!path) return "";
  if (root) {
    const prefix = root.endsWith("/") ? root : root + "/";
    if (path.startsWith(prefix)) {
      const rel = path.slice(prefix.length);
      const dot = rel.lastIndexOf(".");
      const slash = rel.lastIndexOf("/");
      // Strip only a FILENAME extension (a dot after the last slash, not at
      // position 0 of the basename), mirroring moduleOf's stem rule.
      const stem = dot > slash + 1 ? rel.slice(0, dot) : rel;
      if (stem) return stem;
    }
  }
  return moduleOf(path);
}

function isInternalPath(path: string, url: string): boolean {
  if (!path && !url) return true;
  if (url.startsWith("node:") || url.startsWith("bun:")) return true;
  if (path.includes("/node_modules/")) return true;
  // eval / synthetic sources surface as empty url or "<...>".
  if (url.startsWith("<")) return true;
  return false;
}

/** A pseudo-frame V8 inserts that is not real user code. */
function isPseudoFrame(name: string): boolean {
  // V8 pseudo nodes: "(root)", "(program)", "(idle)",
  // "(garbage collector)", "(native ...)". All start with "(".
  return name.startsWith("(");
}

/**
 * Build a {@link NameResolver} that maps frames to `"<module>:<fn>"` ids and
 * applies the configured scoping. The `selfMarker` (default the collector's own
 * `src/` directory segment) is used to drop the collector's own frames so it
 * never traces itself. It is intentionally the `src/` subtree, not all of
 * `trace/bun/`, so a project that happens to live under `trace/bun/` (e.g. this
 * package's own tests) is still traceable.
 */
export function makeResolver(opts: ScopeOptions = {}, selfMarker = "/trace/bun/src/"): NameResolver {
  const projectPaths = (opts.projectPaths ?? []).filter((p) => p.length > 0);
  const includeInternal = opts.includeInternal ?? false;
  const moduleRoot = opts.moduleRoot;
  // The collector's own on-disk location, so self-frames are still dropped when
  // the package is vendored/copied somewhere that doesn't match the static
  // `/trace/bun/src/` marker (e.g. installed into a consumer repo).
  const selfDir = new URL(".", import.meta.url).pathname;

  return {
    nameOf(frame: CallFrame): string | null {
      const fn = (frame.functionName ?? "").trim();
      if (!fn || isPseudoFrame(fn)) return null;

      const path = urlToPath(frame.url);
      // Drop the collector's own frames so it never traces itself.
      if (path.includes(selfMarker) || (selfDir.length > 1 && path.startsWith(selfDir))) return null;

      if (!includeInternal && isInternalPath(path, frame.url ?? "")) return null;

      const mod = moduleIdOf(path, moduleRoot) || "<anonymous>";
      const id = `${mod}:${fn}`;

      if (projectPaths.length > 0) {
        const inScope = projectPaths.some((p) => path.startsWith(p) || id.startsWith(p));
        if (!inScope) return null;
      }
      return id;
    },
  };
}
