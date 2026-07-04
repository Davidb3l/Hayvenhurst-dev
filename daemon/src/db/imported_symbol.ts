/**
 * PACKER reachability helper — cross-file IMPORTED-SYMBOL inclusion (NEW module).
 *
 * The packer's referenced-entity pass (`context_pack.ts` §4) only inlines
 * indexed NODES that are type-like (`kind:"class"`). But a target function
 * routinely NAMES a cross-file identifier that is NOT a node at all — a
 * module-level `export const HANDLERS = {…}` dispatch table, a `CONFIG` object,
 * a bare `export type` alias — defined in ANOTHER file and imported. The
 * extractor doesn't emit graph nodes for those, so they're invisible to every
 * rung: not a callee (no call edge), not a ref (no node), and the header only
 * carries the target file's own module scope, not the imported file's body.
 * This module recovers them.
 *
 * APPROACH (robust, bounded — reuse the graph, don't re-implement a parser):
 *   1. FILE→FILE imports from the GRAPH, not regex. The target's file imports
 *      other files via `import`-kind edges. In this schema an import edge's
 *      `dst` is a MODULE node (the imported file's `kind:"module"` entity,
 *      resolved by the SpecifierResolver — see graph/ingest.ts), so the set of
 *      "files imported by target.file" is exactly {module.file : for each
 *      import edge out of the target file's module node}. This gives candidate
 *      source files WITHOUT us parsing import statements ourselves.
 *   2. CANDIDATE IDENTIFIERS: tokenize `targetText` for identifiers, keep those
 *      that are NOT already an indexed node (the ref/callee passes own those)
 *      and NOT already in `alreadyAddedIds`.
 *   3. LOCATE the declaration in one of the imported candidate files by matching
 *      a MODULE-LEVEL declaration of that exact name and extracting it,
 *      brace/paren-balanced, bounded to `maxLines`.
 *
 * IMPORTANT — what the import-edge data CAN and CANNOT do (honesty):
 *   - It CANNOT map a specific imported NAME → its source file. Import edges are
 *     FILE/MODULE-level (`dst` is a module node), and there is no symbol-level
 *     export record in the index for non-node consts/objects/type-aliases. So we
 *     cannot say "HANDLERS came from b.ts" purely from edges.
 *   - It CAN give the SET of files this file imports. We then search that set for
 *     a module-level declaration of the name. This is the robust, bounded
 *     compromise: scope the text scan to the actually-imported files (not the
 *     whole repo), match a module-level `export`ed declaration of the exact name.
 *
 * Pure + read-only. Never throws (an unreadable file → skip that file).
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { IMPORT_KIND } from "./graph_walk.ts";
import type { Db, NodeRow } from "./queries.ts";
import type { ContextSlice } from "./context_pack.ts";

export interface ImportedSymbolOptions {
  /** Cap how many imported-symbol slices to add (default 5). */
  maxSymbols?: number;
  /** Cap each extracted declaration's line span (default 20). */
  maxLines?: number;
}

const DEFAULT_MAX_SYMBOLS = 5;
const DEFAULT_MAX_LINES = 20;

/** Identifiers shorter than this are too noisy to be worth a cross-file scan
 *  (single-letter locals, `i`, `x`). Real dispatch tables / configs / type
 *  aliases are longer. */
const MIN_IDENT_LEN = 2;

/** JS/TS keywords + a few ultra-common globals we never treat as a candidate
 *  cross-file imported symbol. Keeps the per-identifier file scan from chasing
 *  language noise. Not exhaustive by design — a non-match just costs one regex
 *  test against the imported files and is dropped. */
const STOP_IDENTS = new Set<string>([
  "const", "let", "var", "function", "return", "if", "else", "for", "while",
  "switch", "case", "break", "continue", "new", "this", "super", "class",
  "extends", "implements", "interface", "type", "enum", "import", "export",
  "from", "as", "default", "async", "await", "yield", "typeof", "instanceof",
  "in", "of", "void", "delete", "throw", "try", "catch", "finally", "do",
  "true", "false", "null", "undefined", "string", "number", "boolean", "object",
  "any", "unknown", "never", "Promise", "Array", "Map", "Set", "Record",
  "console", "Math", "JSON", "Object", "Date", "Error", "RegExp", "Symbol",
  "require", "module", "exports", "globalThis", "window", "document",
]);

/** A tiny per-call file cache mirroring context_pack's reader: imported files
 *  may be scanned for several candidate names, so read each at most once.
 *  Returns the file's lines, or `null` if it can't be read. */
function makeFileReader(repoRoot: string) {
  const cache = new Map<string, string[] | null>();
  return (file: string): string[] | null => {
    if (cache.has(file)) return cache.get(file) ?? null;
    let lines: string[] | null = null;
    try {
      const abs = isAbsolute(file) ? file : join(repoRoot, file);
      lines = readFileSync(abs, "utf8").split("\n");
    } catch {
      lines = null;
    }
    cache.set(file, lines);
    return lines;
  };
}

/** Whether a file is a test/spec file — mirrors context_pack.isTestFile. Source
 *  never legitimately imports a symbol FROM a test, so a candidate file that is
 *  a test is noise; skip it. */
function isTestFile(file: string | null): boolean {
  return (
    !!file && (/\.(test|spec)\.[cm]?[tj]sx?$/.test(file) || /(^|\/)__tests__\//.test(file))
  );
}

/**
 * The SET of source files imported BY `target.file`, derived from the graph
 * (import-kind edges out of the file's module node), NOT from regex.
 *
 * In this schema an import edge's `dst` is the imported file's MODULE node, so
 * `module.file` is the imported source file. We resolve the target file's own
 * module node, walk its outgoing `import` edges, and collect each resolved
 * module's `.file`. Test files and the target file itself are excluded.
 */
function importedFilesOf(db: Db, target: NodeRow): string[] {
  if (!target.file) return [];
  const moduleNode = db.handle
    .query<{ id: string }, [string]>(
      "SELECT id FROM nodes WHERE file = ? AND kind = 'module' LIMIT 1",
    )
    .get(target.file);
  if (!moduleNode) return [];

  const files = new Set<string>();
  for (const e of db.outgoing(moduleNode.id)) {
    if (e.kind !== IMPORT_KIND) continue;
    const imp = db.getNode(e.dst);
    if (!imp?.file) continue;
    if (imp.file === target.file) continue;
    if (isTestFile(imp.file)) continue;
    files.add(imp.file);
  }
  return [...files].sort();
}

/**
 * Distinct candidate identifiers NAMED in `targetText`, in first-appearance
 * order. Plain identifier-regex tokenization, then drop language keywords,
 * ultra-short names, and obvious noise. Whether each is actually an indexed
 * node / already-added / locatable is decided by the caller.
 */
function candidateIdentifiers(targetText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(targetText)) !== null) {
    const name = m[0];
    if (name.length < MIN_IDENT_LEN) continue;
    if (STOP_IDENTS.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** True when ANY indexed node resolves to `name` — by bare `name` OR by the
 *  `::name` qualified-id suffix. If so, the ref/callee passes own it and this
 *  helper must NOT add it (we only recover NON-node imported symbols). */
function isIndexedNode(db: Db, name: string): boolean {
  const byName = db.handle
    .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM nodes WHERE name = ?")
    .get(name);
  if ((byName?.c ?? 0) > 0) return true;
  // Some nodes carry the name only in the qualified id suffix (`file.ts::NAME`).
  const byId = db.handle
    .query<{ c: number }, [string]>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE ? ESCAPE '\\'",
    )
    .get(`%::${name.replace(/[\\%_]/g, "\\$&")}`);
  return (byId?.c ?? 0) > 0;
}

const ESC_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Find the 1-based line of a MODULE-LEVEL declaration of `name` in `lines`, plus
 * whether it opens a brace/paren block we should balance. Module-level = the
 * declaration starts at column 0 (no leading whitespace) so we don't match a
 * `const NAME =` nested inside a function body. Recognizes:
 *   export const|let|var NAME …
 *   export type NAME …            export interface NAME …
 *   export enum NAME …            export function NAME …   (defensive)
 *   const|let|var NAME …          (a local later re-exported via `export {…}`)
 * Returns null when no module-level declaration of the exact name is found.
 */
function findDeclLine(lines: string[], name: string): number | null {
  const esc = name.replace(ESC_RE, "\\$&");
  // No leading whitespace → module-level (top of file / not indented in a body).
  // Optional `export `, optional `declare `, then a binding/type keyword, then
  // the exact name on an identifier boundary.
  const decl = new RegExp(
    `^(?:export\\s+)?(?:declare\\s+)?` +
      `(?:const|let|var|type|interface|enum|function|class)\\s+${esc}(?![\\w$])`,
  );
  for (let i = 0; i < lines.length; i++) {
    if (decl.test(lines[i] ?? "")) return i + 1; // 1-based
  }
  return null;
}

/**
 * Extract the declaration starting at `startLine` (1-based), balancing the
 * FIRST opened bracket group (`{`, `(`, or `[`) if the declaration opens one;
 * otherwise extend to the end of the statement (first line ending in `;` or a
 * blank line / next top-level decl), bounded to `maxLines`. String/char/`//`
 * content is NOT parsed out — this is a best-effort bracket counter, so a brace
 * inside a string can over- or under-count; the `maxLines` cap is the safety net
 * and `truncatedFromEndLine`-style truncation is implicit (we stop at the cap).
 * Returns { endLine (1-based, inclusive), text }.
 */
function extractDecl(
  lines: string[],
  startLine: number,
  maxLines: number,
): { endLine: number; text: string } {
  const maxEndIdx = Math.min(lines.length - 1, startLine - 1 + maxLines - 1);
  const startIdx = startLine - 1;

  // Balance the first opened bracket group ({, (, [); a no-bracket statement
  // ends at the first `;` (or a non-continuation line). Bounded to `maxLines`.
  let depth = 0;
  let opened = false;
  let endIdx = startIdx;

  for (let i = startIdx; i <= maxEndIdx; i++) {
    const line = lines[i] ?? "";
    for (const ch of line) {
      if (ch === "{" || ch === "(" || ch === "[") {
        depth++;
        opened = true;
      } else if (ch === "}" || ch === ")" || ch === "]") {
        if (depth > 0) depth--;
      }
    }
    endIdx = i;
    if (opened) {
      // Once a bracket group is open, the declaration ends when it re-balances.
      if (depth === 0) break;
    } else {
      // No bracket opened yet — a simple statement (`export type X = Y;`,
      // `export const X = 1;`). It ends at the first line terminating in `;`,
      // or — for declarations with no `;` — at the first line that doesn't look
      // like a continuation (no trailing `=`, `,`, or open bracket).
      const trimmed = line.trimEnd();
      if (trimmed.endsWith(";")) break;
      if (i > startIdx && !/[=,]$/.test(trimmed)) break;
      if (i === startIdx && !/[=,]$/.test(trimmed)) break;
    }
  }

  const text = lines.slice(startIdx, endIdx + 1).join("\n");
  return { endLine: endIdx + 1, text };
}

/**
 * Find cross-file identifiers NAMED in `targetText` that are imported from a
 * local file and are NOT indexed nodes (consts/objects/type-aliases the ref pass
 * misses), and return their source-extracted declarations as `via:"ref"` slices.
 *
 * Pure + read-only; never throws. Caps at `maxSymbols`; each slice's body is
 * bounded to `maxLines`. Dedups by (file,startLine). Skips test files, names
 * that ARE indexed nodes, names already in `alreadyAddedIds`, and names not
 * found at module scope in any imported file.
 */
export function collectImportedSymbols(
  db: Db,
  repoRoot: string,
  target: NodeRow,
  targetText: string,
  alreadyAddedIds: Set<string>,
  opts: ImportedSymbolOptions = {},
): ContextSlice[] {
  const maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  if (maxSymbols <= 0 || maxLines <= 0) return [];
  if (!target.file || !targetText) return [];

  const candidateFiles = importedFilesOf(db, target);
  if (candidateFiles.length === 0) return [];

  const read = makeFileReader(repoRoot);
  const out: ContextSlice[] = [];
  const seenLoc = new Set<string>(); // (file,startLine) dedupe key

  for (const name of candidateIdentifiers(targetText)) {
    if (out.length >= maxSymbols) break;
    // The ref/callee passes own anything that's an indexed node.
    if (isIndexedNode(db, name)) continue;

    for (const file of candidateFiles) {
      if (out.length >= maxSymbols) break;
      const lines = read(file);
      if (!lines) continue; // unreadable → skip this file (never throw)
      const declLine = findDeclLine(lines, name);
      if (declLine == null) continue;

      // Build a stable id so caller dedupe / alreadyAddedIds can apply, and so
      // we don't add the same imported symbol twice. The id is synthetic
      // (these aren't indexed nodes) but deterministic: `<file>::<name>`.
      const synthId = `${file}::${name}`;
      if (alreadyAddedIds.has(synthId)) continue;
      const locKey = `${file}:${declLine}`;
      if (seenLoc.has(locKey)) continue;

      const { endLine, text } = extractDecl(lines, declLine, maxLines);
      out.push({
        role: "neighbor",
        id: null,
        kind: "other",
        file,
        startLine: declLine,
        endLine,
        text,
        via: "ref",
      });
      seenLoc.add(locKey);
      alreadyAddedIds.add(synthId);
      break; // found this name; move to the next candidate identifier
    }
  }

  return out;
}
