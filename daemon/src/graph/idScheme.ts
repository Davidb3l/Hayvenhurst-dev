/**
 * Entity ID derivation.
 *
 * Format for the module node itself:
 *   `<scope>/<module_name>`
 *
 * Format for entities defined inside a module (functions, classes, methods):
 *   `<scope>/<module_name>/<qualified_name>`
 *
 * `<scope>` is the directory under the project's first `src/` segment. If
 * the file is not under `src/`, the scope is the file's directory path
 * relative to the repo root (or the empty string for top-level files).
 *
 * The module-name segment is required to disambiguate same-named entities
 * in sibling files (`src/parse/hash.rs` and `src/parse/extract.rs` can both
 * define `do_something` without colliding on a primary key).
 *
 * Examples:
 *   src/auth/login.ts  module    qn="login"            -> auth/login
 *   src/auth/login.ts  function  qn="loginHandler"     -> auth/login/loginHandler   (moduleName="login")
 *   src/auth/login.ts  method    qn="Session.refresh"  -> auth/login/Session.refresh
 *   lib/util/x.py      module    qn="x"                -> lib/util/x
 *   lib/util/x.py      function  qn="helper"           -> lib/util/x/helper
 *   index.ts           module    qn="index"            -> index
 *
 * BL-16 — module-dot vs `Class.method` dot. A dot in the qualified name is
 * ambiguous: it can be a class/method separator (`Session.refresh`) OR a module
 * qualifier some parsers prepend (a top-level Rust `struct MyStruct` in
 * `hash.rs` emitted as `hash.MyStruct`). The old code skipped the module prefix
 * whenever `qn` started with `<module>.`, which broke the second case: it
 * produced `parse/hash.MyStruct` (reads as a method on class `hash`) instead of
 * disambiguating the struct under its module. We now resolve the ambiguity by
 * the node KIND, not a string-prefix match:
 *   - a `method` keeps its dotted `Class.method` qn and is module-prefixed
 *     (`auth/login/Session.refresh`); the dot is a real class separator.
 *   - a top-level entity (function/struct/class/…) whose qn starts with
 *     `<module>.` has a redundant module qualifier — strip the leading
 *     `<module>.` and then module-prefix (`parse/hash/MyStruct`).
 * This is an id-scheme CONTRACT change: top-level entities whose parser-emitted
 * qn was module-qualified now get a stable `<scope>/<module>/<name>` id instead
 * of the old flattened `<scope>/<module>.<name>`. Existing methods are
 * unaffected.
 */
import { dirname, sep } from "node:path";

import type { NodeKind } from "./types.ts";

const POSIX_SEP = "/";

function toPosix(path: string): string {
  return sep === POSIX_SEP ? path : path.split(sep).join(POSIX_SEP);
}

/** Returns the scope path (no trailing slash) for a repo-relative file. */
export function scopeForFile(repoRelFile: string): string {
  const posix = toPosix(repoRelFile).replace(/^\.\/+/, "").replace(/^\/+/, "");
  const parts = posix.split(POSIX_SEP).filter((p) => p.length > 0);

  // Drop the filename — we only want the directory part for the scope.
  if (parts.length === 0) return "";
  const dirParts = parts.slice(0, -1);

  // If the path includes a `src/` segment, use everything after the FIRST one.
  const srcIdx = dirParts.indexOf("src");
  if (srcIdx >= 0) {
    return dirParts.slice(srcIdx + 1).join(POSIX_SEP);
  }
  return dirParts.join(POSIX_SEP);
}

/** Strip a trailing file extension (last `.foo`) from a single path segment. */
function stripExt(segment: string): string {
  const dot = segment.lastIndexOf(".");
  if (dot <= 0) return segment;
  return segment.slice(0, dot);
}

/**
 * Compute the canonical entity ID for a parsed node.
 *
 * @param repoRelFile    Path of the file *relative to the repo root* (POSIX or native sep).
 * @param qualifiedName  Parser-provided qualified name (e.g. `Session.refresh`).
 * @param options.moduleName  The file's module name (file stem, with `mod.rs`/
 *                            `__init__.py`/etc. resolved). Required to
 *                            disambiguate non-module entities across sibling
 *                            files. Omit (or pass `qualifiedName`) when
 *                            deriving the module node's own ID.
 * @param options.kind        The node's kind. Used to resolve the BL-16 dot
 *                            ambiguity: a `method`'s dot is a class separator;
 *                            any other kind's leading `<module>.` is a redundant
 *                            module qualifier. Optional and backward-compatible:
 *                            when omitted, a leading `<module>.` is treated as a
 *                            module qualifier (the common, top-level case).
 */
export function deriveEntityId(
  repoRelFile: string,
  qualifiedName: string,
  options?: { moduleName?: string; kind?: NodeKind },
): string {
  const scope = scopeForFile(repoRelFile);
  let qn = qualifiedName.trim();

  if (qn.length === 0) {
    // Fallback: use the filename (without extension) as the entity name.
    const posix = toPosix(repoRelFile);
    const last = posix.split(POSIX_SEP).pop() ?? posix;
    return scope.length > 0 ? `${scope}/${stripExt(last)}` : stripExt(last);
  }

  const moduleSegment = options?.moduleName?.trim() ?? "";

  // BL-16: when the qn starts with `<module>.` and this is NOT a method, the
  // leading `<module>.` is a redundant module qualifier the parser prepended
  // (e.g. a top-level `struct MyStruct` in `hash.rs` emitted as
  // `hash.MyStruct`). Strip it so the module segment is added exactly once
  // below, yielding `…/hash/MyStruct` rather than the old, misleading
  // `…/hash.MyStruct`. A `method` keeps its dotted `Class.method` qn intact —
  // the dot there is a real class separator, not a module qualifier.
  if (
    moduleSegment.length > 0 &&
    options?.kind !== "method" &&
    qn.startsWith(`${moduleSegment}.`)
  ) {
    qn = qn.slice(moduleSegment.length + 1);
  }

  // Prepend the module segment only when:
  //   - it was supplied,
  //   - the qualified name doesn't already start with `<module>/` (defensive —
  //     parsers may emit a `module/`-prefixed qn; that separator is
  //     unambiguous, unlike the dot handled above).
  //
  // The `moduleSegment === qn` case is KIND-AWARE (idScheme collision fix):
  //   - For the MODULE node itself, callers pass NO `moduleName` (moduleSegment
  //     is "" — see graph/ingest.ts: the module record calls
  //     `deriveEntityId(file, qn, {kind:"module"})`), so this branch is never
  //     reached for it and its id stays `<scope>/<module>` (e.g. `parse/hash`,
  //     never `parse/hash/hash`).
  //   - For a NON-module entity whose qn equals the module name (a function
  //     `sympify` defined in `sympify.py`), we MUST still prepend, or the
  //     function's id would collide with the module node's id and the SQLite
  //     UPSERT would clobber one with the other. So when a `moduleName` is
  //     supplied AND the kind is not `"module"`, always prepend — yielding
  //     `<scope>/sympify/sympify` for the function, distinct from `<scope>/sympify`
  //     for the module. The historical `moduleSegment !== qn` guard (meant to
  //     avoid `parse/hash/hash` for the module node) over-suppressed this case;
  //     because the module node never supplies `moduleName`, dropping the guard
  //     for non-module kinds is the precise fix and the module node is unaffected.
  const sameAsModule = moduleSegment === qn;
  const isModuleKind = options?.kind === "module";
  const needsPrefix =
    moduleSegment.length > 0 &&
    !qn.startsWith(`${moduleSegment}/`) &&
    // Suppress the prefix only when the qn equals the module name AND this is a
    // module-kind node (or kind is unknown) — i.e. preserve the original
    // `parse/hash` shape for the module node. A non-module entity with a
    // matching qn always gets the prefix (the collision fix).
    (!sameAsModule || (!isModuleKind && options?.kind !== undefined));

  const localPath = needsPrefix ? `${moduleSegment}/${qn}` : qn;
  return scope.length > 0 ? `${scope}/${localPath}` : localPath;
}

/**
 * Build the unresolved-edge id used when a `dst_name` cannot be matched to a
 * known entity. Prefix `?:` makes these easy to filter and re-resolve later.
 */
export function unresolvedEdgeId(dstName: string): string {
  return `?:${dstName}`;
}

/** Compute the on-disk node markdown path (relative to `nodesDir`). */
export function nodeMarkdownPath(id: string): string {
  // IDs may contain `/`; that's fine — it maps to nested directories.
  // Sanitize each segment: replace anything unfriendly to filesystems.
  const parts = id.split("/").map(sanitizeSegment);
  const last = parts.pop() ?? "node";
  return [...parts, `${last}.md`].join("/");
}

function sanitizeSegment(s: string): string {
  // Replace path-unsafe characters; preserve common identifier chars and `.`.
  return s.replace(/[^A-Za-z0-9_.\-]/g, "_");
}

/** Derive the directory portion of a repo-relative file path. */
export function fileDir(repoRelFile: string): string {
  return toPosix(dirname(repoRelFile));
}
