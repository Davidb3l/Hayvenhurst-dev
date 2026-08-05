/**
 * `hayven context <symbol>` — the context-COST PACKER (Phase 0.0.4.5 pivot).
 *
 * The pivot doc (`docs/PHASE_0.0.4.5_PIVOT.md`) measured the one thing hayven
 * actually wins at: feeding an agent a graph-precise SLICE instead of whole
 * files cut re-sent context tokens 78–86%, and a model fixed a real bug from a
 * 311-token slice with all tests passing. This module assembles that slice.
 *
 * It is a LIBRARY first (the CLI in `cli/context.ts` is a thin wrapper) because
 * the integration that dodged every prior failure is: the BUILDER calls this to
 * assemble a prompt — an Agent-SDK app or a multi-agent harness that controls
 * context programmatically — NOT a tool the free-roaming agent must choose to
 * use (every measurement showed it greps instead).
 *
 * The pack, line-exact, is:
 *   1. HEADER  — the target file's leading import/comment block (so referenced
 *                symbols resolve in the slice).
 *   2. TARGET  — the target entity's body (file lines `range_start..range_end`).
 *   3. NEIGHBORS — the target's 1-hop DEPENDENCIES: the bodies of the symbols it
 *                CALLS (outgoing call edges), deduped, module nodes excluded
 *                (their "body" is the whole file). This is the cross-file slice
 *                — a callee in another file comes in as its own line-exact body.
 *
 * Everything is reused from the assets the pivot identified: node ranges
 * (`NodeRow.range_start/end`), the call/import edge graph (`db.outgoing`), and
 * `resolveNodeId` (the same fuzzy locator `refs`/`impact` use). No embeddings,
 * no model — exact-identifier, never-stale, line-exact.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { isPathExcludedByWalker } from "../native/ignore.ts";
// The test-file predicate is SHARED with the fts scaffold-ranking penalty (both
// are generated from one pattern list) so the packer's neighbor filter and
// search ranking can no longer disagree about what a test file is. It covers
// all six indexed languages; the JS/TS-only regex that used to live here let
// Python/Go/Rust tests through as if they were real source.
import { isTestFile } from "../util/test_files.ts";
import { IMPORT_KIND, isCallKind, resolveNodeId } from "./graph_walk.ts";
import { collectImportedSymbols } from "./imported_symbol.ts";
import type { Db, NodeRow } from "./queries.ts";

/** One contiguous, line-exact slice of source in the pack. */
export interface ContextSlice {
  /** Why this slice is here. `"module-frame"` is a header run produced by
   *  {@link buildModuleFrame} (a whole-file module frame with no single target),
   *  distinguished from a single-symbol `"header"` run only by provenance. */
  role: "header" | "target" | "neighbor" | "module-frame";
  /** The node id this slice came from (`null` for a synthetic header slice). */
  id: string | null;
  /** The node kind (`"header"` for the synthetic header slice). */
  kind: string;
  /** Repo-relative source file. */
  file: string;
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based inclusive last line. */
  endLine: number;
  /** The sliced source text (no trailing newline). */
  text: string;
  /** For a neighbor: how it was reached from the target — `"call"` (an outgoing
   *  call edge), `"ref"` (a same-file entity named in the target body, e.g. a
   *  type used in the signature, which is not a call edge), or `"caller"` (an
   *  INCOMING call edge — a symbol that CALLS the target, opt-in via
   *  {@link ContextPackOptions.maxCallers}; surfaces load-bearing code supplied
   *  by the caller, e.g. a lambda passed to a higher-order target). */
  via?: "call" | "ref" | "caller";
  /** For a `"call"` neighbor: total call occurrences from the target into this
   *  symbol. For a `"caller"` neighbor: the incoming call edge weight. Absent for
   *  `"ref"` neighbors. */
  weight?: number;
  /** For a `"ref"` neighbor that was capped to the first N lines of its entity:
   *  the entity's TRUE last line (so callers can tell the slice is a head-of-body
   *  excerpt). Absent when the ref was included whole (or for non-ref slices). */
  truncatedFromEndLine?: number;
}

/** The assembled context pack for a symbol. */
export interface ContextPack {
  /** The resolved target node id. */
  symbol: string;
  /** The chosen id when `rawId` was fuzzy-resolved via the top FTS hit;
   *  `null` when it matched exactly (mirrors the `refs`/`impact` shape). */
  resolved: string | null;
  /** The slices, in pack order: header, target, then neighbors. */
  slices: ContextSlice[];
  /** Total source lines across all slices. */
  lineCount: number;
  /** Approximate token count (≈ chars/4 — a tokenizer-robust proxy, NOT exact;
   *  the cl100k ratios in the pivot measurement were within a few % of this). */
  estTokens: number;
  /** Non-fatal notes (e.g. a neighbor whose file couldn't be read). */
  notes: string[];
  /** Approximate token count of the target's WHOLE file (same `estimateTokens`
   *  chars/4 proxy as {@link estTokens}). `0` when the target has no readable
   *  file. The honest yardstick for {@link worthwhile}. */
  targetFileEstTokens: number;
  /** `true` when the pack is strictly smaller than just opening the target's
   *  whole file (`estTokens < targetFileEstTokens`); `false` when the pack is
   *  no smaller — i.e. shipping it buys nothing over the file. `true` when the
   *  target has no readable file (nothing better to fall back to). */
  worthwhile: boolean;
  /** LANE 3 (only set by {@link buildContextPackForChange}): `true` when the
   *  assembled pack was NOT smaller than the whole file, so the packer fell
   *  through and returned the whole file as a single slice instead — the
   *  never-worse-than-reading-the-file guarantee. Absent/false otherwise. */
  fellBackToWholeFile?: boolean;
}

/** Options for {@link buildContextPack}. */
export interface ContextPackOptions {
  /** Include 1-hop callee neighbors (default true). */
  neighbors?: boolean;
  /** Max neighbor slices, highest call-weight first (default 10). */
  maxNeighbors?: number;
  /** Max lines pulled into the module-scope header (default 120). */
  maxHeaderLines?: number;
  /** For `via:"ref"` neighbors that ARE included: cap the slice to the first N
   *  lines of the entity (default {@link DEFAULT_MAX_REF_SLICE_LINES}). Shows the
   *  declaration + opening shape (interface fields / member signatures) without
   *  deep method bodies. Does NOT affect callee (`via:"call"`) or target slices,
   *  and does NOT change the {@link MAX_REF_LINES} skip-entirely gate. */
  maxRefSliceLines?: number;
  /** OPT-IN 1-hop CALLER hop: max INCOMING-caller neighbors to inline (default
   *  `0` = no caller hop, so the pack is byte-identical to the pre-caller-hop
   *  behavior). When `> 0`, AFTER the callee + referenced-entity passes, up to
   *  this many symbols that CALL the target (incoming `isCallKind` edges) are
   *  added as `via:"caller"` slices, ranked by edge weight desc then id asc, with
   *  the SAME dangler/module/test/overlap/dedupe guards as the callee pass. This
   *  recovers cases where the target's real behavior is supplied by its caller (a
   *  higher-order function given a lambda, a callback wired at the call site) —
   *  for the escalation/sufficiency path, not the lean default pack. */
  maxCallers?: number;
  /** OPT-IN cross-file imported-symbol inclusion (default `false`). When `true`,
   *  identifiers NAMED in the target body that are imported from a local file but
   *  are NOT indexed nodes (a `const HANDLERS = {…}` dispatch table, a `CONFIG`
   *  object, a `type` alias) are extracted from their source file and added as
   *  `via:"ref"` slices — the cross-file non-node definitions the §4 ref pass
   *  (nodes only) structurally misses. Heuristic + bounded (see
   *  `imported_symbol.ts`); off by default so the lean pack stays byte-identical —
   *  for the escalation/sufficiency path. */
  importedSymbols?: boolean;
}

const DEFAULT_MAX_NEIGHBORS = 10;
/** Default for {@link ContextPackOptions.maxCallers}: `0` = NO caller hop. This
 *  is what keeps the default pack byte-identical to the pre-caller-hop behavior —
 *  the caller pass is skipped entirely unless the caller explicitly opts in. */
const DEFAULT_MAX_CALLERS = 0;
const DEFAULT_MAX_HEADER_LINES = 120;
/** A referenced entity (a type/class named in the target) is only inlined when
 *  its body is at most this many lines. A small interface/type alias is useful
 *  context; a 500-line class used merely as a parameter type would dominate the
 *  pack and defeat the slicing — the import line in the header already names it. */
const MAX_REF_LINES = 40;
/** A `via:"ref"` neighbor that IS included (body ≤ {@link MAX_REF_LINES}) is
 *  capped to this many LEADING lines — the declaration + opening shape (interface
 *  fields / class member signatures) — so a referenced type contributes its
 *  signature surface, not its deep method bodies. Line-exact: the slice is the
 *  real file lines `[start .. start+N-1]`; truncation is recorded in `notes`
 *  (and on the slice's `truncatedFromEndLine`), never injected into `text`.
 *  Overridable per call via `opts.maxRefSliceLines`. */
const DEFAULT_MAX_REF_SLICE_LINES = 12;

/**
 * Read a "how many" pack knob, falling back to `dflt` for anything that is not
 * an integer >= `min`.
 *
 * These knobs arrive from surfaces that own no validated numeric type — the MCP
 * tool arguments, and the daemon route's query string — and a negative one was
 * not merely ignored, it corrupted the OUTPUT: `maxRefSliceLines: -1000000`
 * produced slices with `endLine < startLine` (`[3, -999998]`), which then flowed
 * into the `order` continuation token a builder threads back, and made
 * `lineCount` hugely negative. `0` is meaningful for the caps (`maxNeighbors: 0`
 * = no neighbors, `maxCallers: 0` = no caller hop), so `min` defaults to 0 and
 * only the slice LENGTH knob raises it to 1.
 */
function countOpt(v: number | undefined, dflt: number, min = 0): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min ? v : dflt;
}

/** ≈4 chars/token — the cheap, tokenizer-robust proxy the pivot used to report
 *  ratios. Exact counts need a tokenizer; ratios hold either way. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** One contiguous run of module-scope lines (the "header"). */
interface Segment {
  start: number;
  end: number;
  text: string;
}

/**
 * Whether `line` is a "leading-decoration" line — a comment, attribute, or
 * decorator that, when it sits immediately above an entity, BELONGS to that
 * entity (Go/Rust/Python doc comments, Rust `#[...]` attributes, Python `@deco`
 * decorators) even though tree-sitter's node range starts at the `func`/`def`/
 * `fn` keyword and excludes it. The module-skeleton pass subtracts entity
 * BODIES; without absorbing these, every excluded entity's doc-comment block
 * leaks into the header as a junk fragment (measured: httprouter's `ServeHTTP`
 * pack carried 19 header slices that were almost entirely OTHER methods' doc
 * comments). Language-agnostic by line shape — no parser dependency.
 */
function isLeadingDecoration(line: string): boolean {
  const t = line.trim();
  if (t === "") return true; // blank line between a comment block and its entity
  return (
    t.startsWith("//") || // Go / Rust line comment
    t.startsWith("#[") || // Rust attribute
    t.startsWith("#!") || // Rust inner attribute / shebang
    t.startsWith("#") || // Python comment / Python decorator is `@` (below)
    t.startsWith("@") || // Python / TS decorator
    t.startsWith("/*") || // C-style block comment open
    t.startsWith("*/") || // block comment close
    t.startsWith("*") || // block-comment continuation / Rust `///`-adjacent
    t.startsWith("///") || // Rust doc comment
    t.startsWith("//!") // Rust inner doc comment
  );
}

/**
 * The file's MODULE SKELETON / FRAME: every top-level line that is NOT inside
 * any entity's body — imports, module-level `const`/`type`/`enum` declarations,
 * re-exports, the module docstring, the shell around functions. Returned as the
 * contiguous, non-blank runs left after subtracting EVERY entity body in the
 * file (including any in `subtractIds`, which the single-symbol header path also
 * passes the target through — it then re-adds the target separately as the
 * target slice).
 *
 * Why this and not just the leading import block: a target function routinely
 * references **module-level constants/types that are neither call edges nor
 * imports** (e.g. `const ENCODINGS = {…}` used inside the function). The old
 * import-only header omitted them, and an answerer given the slice would
 * hallucinate definitions for symbols that already existed (measured — see
 * `bench/context-pack-measure.ts` and `docs/PHASE_0.0.4.5_PIVOT.md` §5). The
 * skeleton captures them while STILL excluding every function body, so it stays
 * far smaller than the whole file. With no anchor (`anchorRanges` empty), the
 * whole frame is returned: every module-scope line, no entity bodies — exactly
 * the surface a module-level change (imports, `__all__`, module constants)
 * lands in.
 *
 * When the skeleton exceeds `maxLines`, the runs FARTHEST from the nearest
 * anchor (a target/root body) are dropped first (nearer module-scope context is
 * likelier relevant). With no anchors, the LAST runs are dropped first.
 *
 * @param subtractIds entity ids whose bodies to subtract — for the header path,
 *   the SET of "frame complement" entities (everything not re-added as a target).
 *   Every non-module node in the file is subtracted regardless; this set is the
 *   same node id(s) the caller will re-add as target slices, and is used only to
 *   anchor the distance-based trimming (their ranges are the anchors).
 */
function computeModuleScope(
  db: Db,
  file: string,
  lines: string[],
  opts: { anchorRanges?: Array<[number, number]>; maxLines: number },
): Segment[] {
  const { maxLines } = opts;
  const anchorRanges = opts.anchorRanges ?? [];
  const n = lines.length;
  const covered = new Uint8Array(n + 2);
  const mark = (s: number, e: number): void => {
    for (let l = Math.max(1, s); l <= Math.min(n, e); l++) covered[l] = 1;
  };
  /** Extend `start` upward over the contiguous block of comment/attribute/
   *  decorator/blank lines immediately above an entity — those decorations
   *  belong to it, not to module scope, so they must be subtracted from the
   *  header too (else every excluded entity's doc-comment leaks in). Stops at
   *  the first non-decoration line or another entity's body. Returns the
   *  absorbed start line. */
  const withLeadingDecoration = (start: number): number => {
    let s = start;
    while (s - 1 >= 1 && !covered[s - 1] && isLeadingDecoration(lines[s - 2] ?? "")) {
      s--;
    }
    return s;
  };

  // Subtract EVERY non-module entity body in the file (frame = everything left).
  // The single-symbol header path subtracts its target here too and re-adds it
  // separately as the target slice — byte-identical to the prior behavior.
  const rows = db.handle
    .query<
      { id: string; kind: string; range_start: number; range_end: number },
      [string]
    >("SELECT id, kind, range_start, range_end FROM nodes WHERE file = ?")
    .all(file);
  for (const r of rows) {
    if (r.kind === "module") continue;
    mark(withLeadingDecoration(r.range_start), r.range_end);
  }

  const segs: Segment[] = [];
  let l = 1;
  while (l <= n) {
    if (covered[l]) {
      l++;
      continue;
    }
    const start = l;
    while (l <= n && !covered[l]) l++;
    const end = l - 1;
    const text = lines.slice(start - 1, end).join("\n");
    if (text.trim() !== "") segs.push({ start, end, text });
  }

  let total = segs.reduce((a, s) => a + (s.end - s.start + 1), 0);
  if (total > maxLines) {
    // Distance to the NEAREST anchor range (a target/root body). With no
    // anchors, sort by position so the trailing runs drop first.
    const dist = (s: Segment): number => {
      if (anchorRanges.length === 0) return s.start;
      let best = Infinity;
      for (const [as, ae] of anchorRanges) {
        const d = s.end < as ? as - s.end : s.start > ae ? s.start - ae : 0;
        if (d < best) best = d;
      }
      return best;
    };
    const drop = new Set<Segment>();
    for (const s of [...segs].sort((a, b) => dist(b) - dist(a))) {
      if (total <= maxLines) break;
      drop.add(s);
      total -= s.end - s.start + 1;
    }
    return segs.filter((s) => !drop.has(s));
  }
  return segs;
}

/**
 * The target file's MODULE SKELETON anchored to a single target — every
 * top-level line outside an entity body, with the distance-based trimming
 * anchored to the target's range. Thin wrapper over {@link computeModuleScope};
 * preserves the exact single-symbol header behavior byte-for-byte.
 */
function moduleScopeSegments(
  db: Db,
  target: NodeRow,
  lines: string[],
  maxLines: number,
): Segment[] {
  return computeModuleScope(db, target.file ?? "", lines, {
    anchorRanges: [[target.range_start, target.range_end]],
    maxLines,
  });
}

/** `realpathSync` that yields `null` instead of throwing on a missing path. */
function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Largest file the packer will read, mirroring the Rust walker's
 * `max_file_size` (`native/src/parse/walker.rs`) EXACTLY — a file the indexer
 * refuses to walk is not one the packer should slurp either.
 *
 * Without this, one `context_for_change` call naming a large in-repo file was an
 * amplifier: a 200 MiB file cost +835 MB RSS, a 32 MiB file turned a 156-BYTE
 * request into a 67.1 MB response (430,000x), and 100 MiB reached
 * `RangeError: Out of memory` on the real stdio path. Every knob a client could
 * send was bounded except the one that actually determines the work.
 */
export const MAX_PACK_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Path segments and basenames that are NEVER packed, even though they sit
 * inside the repo.
 *
 * WHY THIS EXISTS SEPARATELY FROM CONTAINMENT — containment says nothing about
 * `.env`, because `.env` IS in the repo root. The packer reads the raw file
 * whether or not it is INDEXED, so `.gitignore` (which the Rust walker honours,
 * keeping these out of the graph entirely) gives no protection on this path.
 * `tools/call {file:".env"}` was as easy to name as `/etc/passwd`, and leaked;
 * so did `.git/config` (which carries an embedded token whenever a remote URL
 * has credentials in it) and `id_rsa`.
 *
 * This is a DENYLIST of well-known credential SHAPES. It is deliberately kept
 * as belt-and-braces UNDERNEATH the class rule in {@link isIndexerAdmissible},
 * which is what actually bounds this surface: a denylist can only ever name the
 * secrets someone thought of.
 */
const DENIED_DIR_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".docker",
  ".hayven",
]);

/**
 * Directory names the Rust walker ALWAYS prunes
 * (`native/src/parse/walker.rs::ALWAYS_SKIP_DIRS`), mirrored here name-for-name.
 *
 * These are where gitignored content actually lives, and the prune is
 * UNCONDITIONAL on the Rust side — no walk option turns it back on — so nothing
 * under them can ever be an indexed node, and mirroring it costs no legitimate
 * read. The walker's CONDITIONAL prunes (`VENDORED_DIRS`, `FIXTURE_LIKE_DIRS`,
 * fixture ancestors) are deliberately NOT mirrored: `--include-vendored` /
 * `--include-fixtures` make those files real indexed nodes, and refusing to pack
 * a node the index contains would break the packer for no security gain.
 */
const ALWAYS_SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
]);

/**
 * File extensions the indexer can actually PARSE, mirroring
 * `native/src/parse/language.rs::Language::from_extension` EXACTLY — the same
 * kind of mirror as {@link MAX_PACK_FILE_BYTES} against the walker's
 * `max_file_size`.
 *
 * THIS IS THE CLASS FIX. The denylist above enumerates credential SHAPES, so a
 * gitignored file with a name nobody enumerated — a stray `dump.sql`, a
 * `backup.json`, a `secrets.yaml.bak`, a `db.sqlite` — was still readable if the
 * caller named it exactly, which made the packer strictly MORE permissive than
 * the indexer on the one path that feeds a model prompt. The indexer would never
 * open any of those files, because it only opens files of a language it parses.
 * Requiring the same here closes the whole "data file named anything" class in
 * one predicate instead of chasing names, AND keeps the legitimate case the
 * denylist was shaped around: a brand-new, not-yet-indexed `src/foo.ts` still
 * packs, because the gate is about what the indexer WOULD admit, not about what
 * it has already seen.
 *
 * Kept lowercase; the caller lowercases the basename before testing.
 */
const SOURCE_EXTENSIONS = new Set([
  "py",
  "ts",
  "cts",
  "mts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "rs",
  "go",
  "astro",
]);

/** Exact basenames that are credential files by convention. */
const DENIED_BASENAMES = new Set([
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".htpasswd",
  ".git-credentials",
  ".dockercfg",
  ".envrc",
  "credentials",
  "master.key",
  "terraform.tfstate",
]);

/** Basename PREFIXES that are private-key material by convention. */
const DENIED_BASENAME_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".env"];

/** Extensions that are key/certificate material, never source. */
const DENIED_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".asc",
  ".gpg",
  ".ppk",
];

/**
 * Would the INDEXER have opened this repo-relative path? The class rule that
 * replaces "hope the denylist named it".
 *
 * The Rust walker admits a file only when ALL of these hold, and this mirrors
 * the three that are purely path-shaped (size and file-type are enforced
 * separately by {@link isPackableFile}):
 *
 *   1. NOT HIDDEN — `WalkBuilder::hidden(true)` prunes every dot-prefixed
 *      component. This alone is the reason `.env`, `.envrc`, `.npmrc`,
 *      `.netrc`, `.git/`, `.ssh/`, `.aws/` are not in the graph, and it covers
 *      the dotfiles nobody has enumerated yet.
 *   2. NOT under an ALWAYS-pruned build/VCS/cache directory
 *      ({@link ALWAYS_SKIP_DIR_SEGMENTS}) — where gitignored output lives.
 *   3. A PARSEABLE LANGUAGE ({@link SOURCE_EXTENSIONS}) — the indexer opens no
 *      other file, so neither will we.
 *
 * WHAT THIS PREDICATE DELIBERATELY DOES NOT DO: evaluate `.gitignore`. Its
 * residual — a gitignored file that is non-hidden, outside every always-pruned
 * directory, AND carries a source extension (a generated `src/gen/keys.ts`, a
 * committed-then-ignored `src/config.local.ts`) — is closed SEPARATELY, by
 * {@link isPathExcludedByWalker}, which asks the Rust `ignore` crate over the
 * `hayven-native check-ignored` op. Gitignore is a spec, not a regex
 * (negations, `**`, directory-only rules, nested ignore files,
 * `.git/info/exclude`, `core.excludesFile`, `require_git`), and hand-rolling it
 * half-right buys false confidence. The two stay separate on purpose: this one
 * is pure and free and removes the whole class of NON-source files by shape,
 * which keeps the paid, subprocess-backed check off all but the paths that
 * would otherwise have been allowed.
 */
function isIndexerAdmissible(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  for (const part of parts) {
    // (1) hidden — the walker's `hidden(true)`. `.` / `..` cannot appear here
    //     (the path is already resolved), so a leading dot means dotfile.
    if (part.startsWith(".")) return false;
    // (2) always-pruned build/cache/VCS directory, at any depth. CASE-SENSITIVE
    //     on purpose: `walker.rs::is_skipped_dir` is `ALWAYS_SKIP_DIRS
    //     .contains(&name)` with no case folding, so a repo with a real `Build/`
    //     or `Dist/` source tree IS indexed — and lowercasing here would refuse
    //     to pack nodes the index actually contains, which is the one thing this
    //     mirror must never do. (The credential DENYLIST below stays
    //     case-insensitive: over-refusing is the safe direction there, and it is
    //     not mirroring anything.)
    if (ALWAYS_SKIP_DIR_SEGMENTS.has(part)) return false;
  }
  // (3) parseable language. A basename with no dot has no extension and is
  //     refused, exactly as `Language::from_extension` refuses it.
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // no extension, or a leading dot (already refused)
  return SOURCE_EXTENSIONS.has(base.slice(dot + 1));
}

/** Is this repo-relative path one we refuse to read regardless of containment? */
function isDeniedRepoPath(rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  // Any DIRECTORY component in the denied set poisons the whole path, so
  // `.git/config` and `.ssh/known_hosts` lose no matter how deep.
  for (const part of parts.slice(0, -1)) {
    if (DENIED_DIR_SEGMENTS.has(part.toLowerCase())) return true;
  }
  const base = (parts[parts.length - 1] ?? "").toLowerCase();
  // A denied name used AS a directory (`.git/…` was covered above, but
  // `.ssh` alone as the final component) is refused too.
  if (DENIED_DIR_SEGMENTS.has(base)) return true;
  if (DENIED_BASENAMES.has(base)) return true;
  // `.env`, `.env.local`, `.env.production`; `id_rsa`, `id_rsa.pub`.
  if (DENIED_BASENAME_PREFIXES.some((p) => base === p || base.startsWith(`${p}.`))) {
    return true;
  }
  if (DENIED_EXTENSIONS.some((e) => base.endsWith(e))) return true;
  return false;
}

/**
 * Resolve `file` (repo-relative, or absolute) to an absolute path the packer is
 * allowed to read, or `null`.
 *
 * SECURITY — this is the gate for every file the packer reads. The packer's
 * `file` argument is CLIENT-SUPPLIED on the `hayven mcp` surface
 * (`context_for_change`'s `file` tool arg goes straight through
 * `contextForChange` → {@link buildContextPackForChange} → the file reader), so
 * an MCP host — or a prompt injection sitting inside an indexed source file —
 * gets to name the path. Three independent checks:
 *
 *   1. CONTAINMENT. Lexically, so `../../secret` and an out-of-tree absolute
 *      path lose; and after `realpathSync`, so a SYMLINK inside the repo
 *      pointing out loses. For a path that EXISTS the realpath is authoritative
 *      and is what we return, which also closes the check-then-read window a
 *      swapped symlink would otherwise open. A path that does not exist yet
 *      cannot be a symlink escape, so it falls back to the lexical answer and
 *      the read fails on its own.
 *   2. DENYLIST. Containment alone permits `.env`, `.git/config` and `id_rsa`,
 *      all of which are INSIDE the repo — see {@link isDeniedRepoPath}.
 *   3. FILE TYPE + SIZE. See {@link isPackableFile}: a FIFO inside the repo made
 *      `readFileSync` block forever, synchronously and uninterruptibly, wedging
 *      the single-process stdio MCP server exactly as an unbounded region loop
 *      did. Directories, sockets and device nodes are refused for the same
 *      reason; oversized files for {@link MAX_PACK_FILE_BYTES}.
 *
 *   4. INDEXER PARITY. See {@link isIndexerAdmissible}: hidden paths, always-
 *      pruned build/cache directories, and any extension the indexer cannot
 *      parse are refused, so this gate is never MORE permissive than the walker
 *      that builds the graph. That is what retires the stray-`dump.sql` class
 *      the denylist alone could not reach.
 *
 *   5. GITIGNORE PARITY. See {@link isPathExcludedByWalker}: the Rust `ignore`
 *      crate — the same configuration `walker::discover` walks with — is asked
 *      whether the indexer would have yielded this path (by path, the way
 *      `git check-ignore` answers, so a not-yet-created file is still
 *      resolvable). This closes the last residual of (4): a gitignored file that
 *      is non-hidden, outside every pruned directory, and carries a source
 *      extension. It is the only check here that costs a subprocess, so it runs
 *      LAST and only for paths every cheap rule already allowed, and it fails
 *      CLOSED — an unavailable or broken native binary refuses the read.
 *
 * WHAT THIS DOES NOT GUARANTEE. The guarantee is: nothing outside the repo,
 * nothing the indexer itself would not open, nothing of a well-known credential
 * shape, nothing that can block, nothing unbounded. It is NOT an access-control
 * boundary for a repo whose own tracked source contains secrets — a checked-in
 * `src/config.ts` full of API keys is, to every rule here, ordinary source.
 */
export function resolveWithinRepo(repoRoot: string, file: string): string | null {
  return resolveRepoPath(repoRoot, file)?.abs ?? null;
}

/** A client-named path that passed every gate: its CANONICAL absolute location
 *  and the repo-relative spelling the index stores. */
export interface ResolvedRepoPath {
  /** Canonical (realpath'd where it exists) absolute path — safe to read. */
  abs: string;
  /** Canonical repo-relative path — the form `nodes.file` holds. */
  rel: string;
}

/**
 * The full result of {@link resolveWithinRepo}: both the canonical absolute path
 * to read AND the canonical repo-relative path to look up in the graph.
 *
 * The proxy needs BOTH, and it used to compute them with its own private,
 * lexical-only copy of this logic — which blessed an in-repo symlink pointing at
 * an out-of-tree secret (that file was then `readFileSync`'d straight into a
 * prompt bound for a third-party LLM API) and, in the mirror case, refused every
 * rewrite when the repo root was spelled via a symlink. Exporting the pair is
 * what removes the reason to keep a second implementation.
 */
export function resolveRepoPath(repoRoot: string, file: string): ResolvedRepoPath | null {
  const contained = containWithinRoot(repoRoot, file);
  if (contained === null) return null;
  const { abs, rel, root } = contained;

  // Denylist and the indexer mirrors run on the path RELATIVE to whichever root
  // form matched, so `.env` named as `./.env`, `a/../.env` or an absolute path
  // all normalize the same.
  if (isDeniedRepoPath(rel)) return null;
  if (!isIndexerAdmissible(rel)) return null;
  const relPosix = rel.split(sep).join("/");
  // GITIGNORE PARITY, and deliberately LAST — it is the only check that costs a
  // subprocess, so every cheap refusal above keeps it from running at all.
  //
  // The hole it closes: a gitignored file that is non-hidden, outside every
  // pruned directory, and carries a source extension. The Rust walker keeps it
  // out of the graph entirely, so packing it made this gate strictly MORE
  // permissive than the indexer on the one path that feeds a model prompt.
  //
  // NOT gated on the file existing. The oracle answers by PATH, the way
  // `git check-ignore` does, so the brand-new-file case `context_for_change`
  // exists to serve (a file the client is about to create) still resolves — it
  // is absent, not ignored. An existence gate looked like the safe framing but
  // was strictly weaker: `src/gen/not-written-yet.ts` under a gitignored
  // `src/gen/` would have passed, and no test could distinguish the gate from
  // its own absence.
  if (isPathExcludedByWalker(root, relPosix)) return null;
  return { abs, rel: relPosix };
}

/** A path proven to live inside a root, with the spellings both callers need. */
interface ContainedPath {
  /** Canonical (realpath'd where it exists) absolute path. */
  abs: string;
  /** Path relative to {@link root}, in the platform's separator. */
  rel: string;
  /** The root form `rel` is relative to — the lexical root or its realpath,
   *  whichever the target actually matched. */
  root: string;
  /** Whether the path existed at check time (i.e. `realpath` succeeded). */
  exists: boolean;
}

/**
 * THE containment check. Resolve `candidate` (relative to `root`, or absolute)
 * and prove it lives inside `root`, both LEXICALLY and after a realpath hop.
 *
 * WHY IT IS SHARED. This logic has been written three times in this codebase and
 * the copies diverged every time: the proxy kept a lexical-only version that
 * blessed an in-repo symlink pointing at an out-of-tree secret (read straight
 * into a prompt bound for a third-party API), and the viewer's static route kept
 * a `relative()`-with-`..`-prefix version with no realpath hop at all, which
 * would serve a symlink planted in the build output. Duplicated containment
 * logic is how they drifted, so there is one implementation and callers layer
 * their own POLICY (credential denylist, indexer parity, MIME) on top of it.
 *
 * The realpath hop is what makes it a containment check rather than a string
 * comparison: for a path that EXISTS the real location decides, both ways — it
 * is the only test that catches a symlink escape, and it is what rescues the
 * mirror-image case (a `root` given as the realpath with `candidate` given via
 * the symlinked spelling, which a purely lexical test refuses for no reason).
 * Returning the realpath is also what closes the check-then-read window a
 * swapped symlink would otherwise open. A path that does not exist yet cannot
 * be a symlink escape, so it falls back to the lexical answer.
 */
export function containWithinRoot(root: string, candidate: string): ContainedPath | null {
  // A NUL survives `resolve()` but makes every syscall throw. Refuse it here so
  // the gate never green-lights a path that cannot be read.
  if (candidate.length === 0 || candidate.includes("\0")) return null;
  const rootAbs = resolve(root);
  const rootReal = tryRealpath(rootAbs) ?? rootAbs;
  const inside = (p: string): boolean =>
    p === rootAbs ||
    p.startsWith(rootAbs + sep) ||
    p === rootReal ||
    p.startsWith(rootReal + sep);

  const abs = isAbsolute(candidate) ? resolve(candidate) : resolve(rootAbs, candidate);
  const real = tryRealpath(abs);
  const target = real ?? abs;
  if (!inside(target)) return null;

  const matched = target.startsWith(rootReal) ? rootReal : rootAbs;
  return {
    abs: target,
    rel: target.slice(matched.length).replace(/^[\\/]+/, ""),
    root: matched,
    exists: real !== null,
  };
}

/**
 * `statSync` the path and say whether it is a REGULAR file within
 * {@link MAX_PACK_FILE_BYTES}. `statSync` follows symlinks (so a symlink to a
 * FIFO is caught) and — unlike `open`/`read` — never blocks on one.
 *
 * Exported so the guard can be pinned DIRECTLY. Driven only through the packer,
 * the `isFile()` half is untestable: `readFileSync` on a directory throws
 * `EISDIR` on its own, so deleting the check changed nothing observable and the
 * test that "covered" it passed with the guard removed.
 */
export function isPackableFile(abs: string): boolean {
  try {
    const st = statSync(abs);
    return st.isFile() && st.size <= MAX_PACK_FILE_BYTES;
  } catch {
    return false;
  }
}

/** A tiny per-call file cache: neighbors frequently share the target's file, so
 *  read each file at most once. Returns the file's lines, or `null` if it can't
 *  be read (deleted, binary, too large, not a regular file, or — see
 *  {@link resolveWithinRepo} — outside the repo or denied). */
function makeFileReader(repoRoot: string) {
  const cache = new Map<string, string[] | null>();
  return (file: string): string[] | null => {
    if (cache.has(file)) return cache.get(file) ?? null;
    let lines: string[] | null = null;
    const abs = resolveWithinRepo(repoRoot, file);
    if (abs !== null && isPackableFile(abs)) {
      try {
        lines = readFileSync(abs, "utf8").split("\n");
      } catch {
        lines = null;
      }
    }
    cache.set(file, lines);
    return lines;
  };
}

/** Slice a node's body out of its file using its 1-based inclusive line range.
 *  Returns `null` when the node has no file, the file can't be read, or the
 *  range is degenerate. */
function sliceNode(
  node: NodeRow,
  role: ContextSlice["role"],
  read: (file: string) => string[] | null,
): ContextSlice | null {
  if (!node.file) return null;
  const lines = read(node.file);
  if (!lines) return null;
  const start = Math.max(1, node.range_start);
  const end = Math.min(lines.length, node.range_end);
  if (end < start) return null;
  const text = lines.slice(start - 1, end).join("\n");
  return {
    role,
    id: node.id,
    kind: node.kind,
    file: node.file,
    startLine: start,
    endLine: end,
    text,
  };
}

/** Whether a node is a whole-file "module" entity whose body is the entire file
 *  — we never inline these as neighbors (that defeats the slicing). */
function isModuleNode(node: NodeRow): boolean {
  return node.kind === "module";
}

/** Whether a node KIND is a "type-like" declaration — a class/interface/struct/
 *  enum/type-alias, all of which the parser emits as `kind:"class"` across the
 *  supported languages. These are the only entities the REFERENCED-entity pass
 *  (§4) should inline: the pass exists to surface a TYPE named in the target's
 *  signature whose body is neither a callee nor an import line. Methods and
 *  free functions are excluded — admitting them matched any same-file symbol
 *  that merely shared a common name with the target (sibling `convert`/`from`/
 *  `is` methods), which is noise, not a referenced type. */
function isTypeLikeKind(kind: string): boolean {
  return kind === "class";
}

/** Whether `n`'s line range overlaps `target`'s in the SAME file — i.e. `n` is
 *  nested inside (or straddles) the target body, so its text is already in the
 *  target slice and must not be added again as a neighbor. */
function overlapsTarget(n: NodeRow, target: NodeRow): boolean {
  return (
    n.file === target.file &&
    n.range_start <= target.range_end &&
    n.range_end >= target.range_start
  );
}

/** True when `name` appears as a whole identifier in `text` (so `Foo` does not
 *  match `Foobar`/`barFoo`). Identifier-boundary lookaround rather than `\b` so
 *  `$`-containing identifiers behave; `name` is regex-escaped defensively. */
function referencesName(text: string, name: string): boolean {
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(text);
}

/**
 * The state the two NEIGHBOR passes (§3 callees, §4 referenced entities) share.
 *
 * Both {@link buildContextPack} (one target) and {@link buildContextPackForSymbols}
 * (N roots) run the identical passes; they used to be two near-verbatim copies,
 * so a fix to one had to be mirrored by hand into the other. Every guard is
 * written against the ROOT SET, which degenerates exactly to the single-target
 * behavior at length 1 — that is what makes one implementation serve both.
 *
 * `slices`, `notes` and `addedIds` are MUTATED by the passes; the caller owns
 * them and reads them back after.
 */
interface NeighborPassState {
  db: Db;
  read: (file: string) => string[] | null;
  slices: ContextSlice[];
  notes: string[];
  /** The pack's target(s), in emission order. */
  roots: NodeRow[];
  /** Ids of `roots`, for the "an edge pointing back at a root is not a
   *  neighbor" guard. */
  rootIds: ReadonlySet<string>;
  /** Every id already emitted as a slice (roots + whatever the passes add).
   *  Header slices have `id:null` and never appear here. */
  addedIds: Set<string>;
  maxNeighbors: number;
}

/** Whether ANY root is itself a test file. When one is, test neighbors are
 *  legitimate (a test really does depend on other test helpers) and the
 *  mis-resolution filter must not fire. */
function anyRootIsTest(st: NeighborPassState): boolean {
  return st.roots.some((r) => isTestFile(r.file));
}

/** Whether `n` overlaps ANY root's line range in that root's file — i.e. its
 *  text is already inside a target slice. */
function overlapsAnyRoot(st: NeighborPassState, n: NodeRow): boolean {
  return st.roots.some((r) => overlapsTarget(n, r));
}

/**
 * §3 NEIGHBORS — 1-hop callee dependencies (outgoing call edges) across ALL
 * roots, weight-summed, ranked weight-desc then id-asc, deduped, sharing ONE
 * `maxNeighbors` cap. A callee in another file arrives as its own line-exact
 * body — the cross-file slice.
 *
 * `omitReasonSuffix` is the only genuine difference between the two entry
 * points: the single-target pack's omission note reads "unresolved/module" and
 * the multi-root one reads "unresolved/module/dup". Passing it keeps both packs
 * byte-identical to their pre-extraction output rather than flattening one note
 * into the other.
 *
 * Import edges are deliberately NOT inlined here: the header already carries the
 * import statements textually, so inlining the imported module's body would
 * defeat the slicing.
 */
function addCalleeNeighbors(st: NeighborPassState, omitReasonSuffix: string): void {
  const rootIsTest = anyRootIsTest(st);
  const byCallee = new Map<string, number>();
  for (const root of st.roots) {
    for (const e of st.db.outgoing(root.id)) {
      if (!isCallKind(e.kind) || st.rootIds.has(e.dst)) continue;
      byCallee.set(e.dst, (byCallee.get(e.dst) ?? 0) + e.weight);
    }
  }
  const ranked = [...byCallee.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  let added = 0;
  for (const [calleeId, weight] of ranked) {
    if (added >= st.maxNeighbors) break;
    if (st.addedIds.has(calleeId)) continue;
    const callee = st.db.getNode(calleeId);
    // Skip danglers (edge to an unresolved id), whole-file modules, and call
    // edges that mis-resolved into a test file (not a real dependency).
    if (!callee || isModuleNode(callee)) continue;
    if (isTestFile(callee.file) && !rootIsTest) continue;
    if (overlapsAnyRoot(st, callee)) continue; // nested in a root → already shown
    const slice = sliceNode(callee, "neighbor", st.read);
    if (!slice) continue;
    slice.via = "call";
    slice.weight = weight;
    st.slices.push(slice);
    st.addedIds.add(calleeId);
    added++;
  }
  if (ranked.length > added) {
    st.notes.push(
      `${ranked.length - added} more callee(s) omitted (cap ${st.maxNeighbors}, or ${omitReasonSuffix})`,
    );
  }
}

/**
 * §4 REFERENCED ENTITIES — indexed type-like entities NAMED in a root body but
 * not already included as callees.
 *
 * Types aren't call edges and the header skeleton subtracts entity bodies, so a
 * target whose signature uses a type (a same-file `ServeStaticOptions` OR an
 * imported `MiddlewareHandler`) would otherwise lack its definition. Same-file
 * refs run first (over `rootFiles`, in the caller's order), then cross-file refs
 * resolved via each root file's module-import edges. Refs get their OWN
 * `maxNeighbors` budget, separate from the callee pass's.
 */
function addRefNeighbors(
  st: NeighborPassState,
  opts: {
    /** The text searched for referenced names: the target body, or the
     *  concatenation of all root bodies in the multi-root case. */
    rootText: string;
    /** Root files in same-file-scan order. Also the exclusion set for the
     *  cross-file scan (a "cross-file" ref must not be in a root file). */
    rootFiles: string[];
    maxRefSliceLines: number;
  },
): void {
  const { rootText, rootFiles, maxRefSliceLines } = opts;
  const rootIsTest = anyRootIsTest(st);
  const rootFileSet = new Set(rootFiles);
  let refAdded = 0;

  /** Try to add one entity row as a `via:"ref"` neighbor; returns true if added. */
  const tryAddRef = (r: { id: string; name: string; kind: string }): boolean => {
    if (st.rootIds.has(r.id) || r.kind === "module") return false;
    // ONLY type-like entities (classes/interfaces/structs/enums/type-aliases —
    // all `kind:"class"` in this schema) are valid refs. The ref pass exists to
    // surface a TYPE named in a root's signature/body whose definition is
    // neither a callee nor an import-statement line. Admitting `method`/
    // `function` entities here matched any same-file symbol that merely SHARES
    // a common name with the target (e.g. nine sibling `convert` methods for a
    // target also named `convert`, or `from`/`is`/`drop` in Rust) — pure noise,
    // since real calls already arrive via the callee pass. (Measured: this
    // dropped 8–10 junk ref slices per pack on click/anyhow.)
    if (!isTypeLikeKind(r.kind)) return false;
    if (st.addedIds.has(r.id)) return false;
    if (!referencesName(rootText, r.name)) return false;
    const node = st.db.getNode(r.id);
    if (!node) return false;
    if (overlapsAnyRoot(st, node)) return false; // nested in a root → already shown
    if (isTestFile(node.file) && !rootIsTest) return false;
    // Skip huge entities (a big class used only as a type) — they'd dominate
    // the pack; the header's import line already names them.
    if (node.range_end - node.range_start + 1 > MAX_REF_LINES) return false;
    const slice = sliceNode(node, "neighbor", st.read);
    if (!slice) return false;
    slice.via = "ref";
    // Leaner ref slices: a referenced type contributes its declaration +
    // opening shape (interface fields / member signatures), not deep method
    // bodies. Cap to the FIRST N lines of the entity, LINE-EXACT — the slice
    // text stays the real file lines [startLine .. startLine+N-1]; the
    // truncation is recorded in notes + on the slice, never inside text.
    // (Never applies to callee/target slices; composes with the MAX_REF_LINES
    // skip-entirely gate above — only refs that ARE included are capped.)
    const fullEnd = slice.endLine;
    const sliceLen = slice.endLine - slice.startLine + 1;
    if (sliceLen > maxRefSliceLines) {
      const newEnd = slice.startLine + maxRefSliceLines - 1;
      const lines = st.read(node.file ?? "");
      if (lines) {
        slice.endLine = newEnd;
        slice.text = lines.slice(slice.startLine - 1, newEnd).join("\n");
        slice.truncatedFromEndLine = fullEnd;
        st.notes.push(
          `ref \`${r.id}\` truncated to first ${maxRefSliceLines} of ${sliceLen} lines`,
        );
      }
    }
    st.slices.push(slice);
    st.addedIds.add(r.id);
    refAdded++;
    return true;
  };

  const entitiesIn = (file: string) =>
    st.db.handle
      .query<{ id: string; name: string; kind: string }, [string]>(
        "SELECT id, name, kind FROM nodes WHERE file = ?",
      )
      .all(file)
      .sort((a, b) => a.id.localeCompare(b.id));

  // 4a. Same-file referenced entities.
  for (const file of rootFiles) {
    if (refAdded >= st.maxNeighbors) break;
    for (const r of entitiesIn(file)) {
      if (refAdded >= st.maxNeighbors) break;
      tryAddRef(r);
    }
  }

  // 4b. Cross-file referenced entities: resolve each root file's module node,
  //     follow its import edges to imported module files, and inline any entity
  //     therein named in a root body (e.g. an imported type used in the
  //     signature). Each imported entity comes in as its own line-exact body.
  if (refAdded >= st.maxNeighbors) return;
  const importedFiles = new Set<string>();
  for (const file of rootFiles) {
    const moduleNode = st.db.handle
      .query<{ id: string }, [string]>(
        "SELECT id FROM nodes WHERE file = ? AND kind = 'module' LIMIT 1",
      )
      .get(file);
    if (!moduleNode) continue;
    for (const e of st.db.outgoing(moduleNode.id)) {
      if (e.kind !== IMPORT_KIND) continue;
      const imp = st.db.getNode(e.dst);
      if (imp?.file && !rootFileSet.has(imp.file)) importedFiles.add(imp.file);
    }
  }
  for (const f of [...importedFiles].sort()) {
    if (refAdded >= st.maxNeighbors) break;
    for (const r of entitiesIn(f)) {
      if (refAdded >= st.maxNeighbors) break;
      tryAddRef(r);
    }
  }
}

/**
 * Assemble the minimal precise context pack for a symbol.
 *
 * Returns `null` only when the symbol can't be resolved to any node at all.
 * Individual slices that can't be produced (unreadable file, module neighbor)
 * are skipped with a note rather than failing the whole pack.
 */
export function buildContextPack(
  db: Db,
  repoRoot: string,
  rawId: string,
  opts: ContextPackOptions = {},
): ContextPack | null {
  const includeNeighbors = opts.neighbors !== false;
  const maxNeighbors = countOpt(opts.maxNeighbors, DEFAULT_MAX_NEIGHBORS);
  const maxHeaderLines = countOpt(opts.maxHeaderLines, DEFAULT_MAX_HEADER_LINES);
  const maxRefSliceLines = countOpt(
    opts.maxRefSliceLines,
    DEFAULT_MAX_REF_SLICE_LINES,
    1,
  );
  const maxCallers = countOpt(opts.maxCallers, DEFAULT_MAX_CALLERS);
  const importedSymbols = opts.importedSymbols === true;

  const resolved = resolveNodeId(db, rawId);
  if (!resolved) return null;
  const target = db.getNode(resolved.id);
  if (!target) return null;

  const read = makeFileReader(repoRoot);
  const slices: ContextSlice[] = [];
  const notes: string[] = [];

  // 1. HEADER — the target file's MODULE SKELETON (imports + module-level
  //    const/type declarations + the shell around entities), i.e. every
  //    top-level line outside another entity's body. Emitted as one header
  //    slice per contiguous run so line numbers stay exact. Captures the
  //    module-scope symbols the target references that are neither callees nor
  //    imports (the boundary the §5 measurement found).
  if (target.file) {
    const lines = read(target.file);
    if (lines) {
      for (const seg of moduleScopeSegments(db, target, lines, maxHeaderLines)) {
        slices.push({
          role: "header",
          id: null,
          kind: "header",
          file: target.file,
          startLine: seg.start,
          endLine: seg.end,
          text: seg.text,
        });
      }
    } else {
      notes.push(`could not read target file \`${target.file}\``);
    }
  }

  // 2. TARGET — the entity body.
  const targetSlice = sliceNode(target, "target", read);
  if (targetSlice) slices.push(targetSlice);
  else notes.push(`could not slice target body for \`${target.id}\``);

  // 3 + 4. NEIGHBOR PASSES — callee dependencies then referenced type-like
  //    entities. Both are the SHARED implementation (see {@link NeighborPassState}),
  //    run here over a single-element root set. The omission-note suffix is the
  //    one output difference from the multi-root entry point and is passed
  //    explicitly rather than flattened.
  const passState: NeighborPassState = {
    db,
    read,
    slices,
    notes,
    roots: [target],
    rootIds: new Set([target.id]),
    addedIds: new Set([target.id]),
    maxNeighbors,
  };
  if (includeNeighbors && maxNeighbors > 0) {
    addCalleeNeighbors(passState, "unresolved/module");
  }
  if (includeNeighbors && maxNeighbors > 0 && target.file) {
    addRefNeighbors(passState, {
      rootText: targetSlice?.text ?? "",
      rootFiles: [target.file],
      maxRefSliceLines,
    });
  }

  // 5. CALLERS — OPT-IN 1-hop INCOMING-caller neighbors (default OFF). Mirrors
  //    the §3 callee pass exactly — same dangler/module/test/overlap guards,
  //    same weight-desc-then-id-asc ranking — but over `db.incoming` (symbols
  //    that CALL the target) and tagged `via:"caller"`. This recovers the case
  //    the callee/ref passes structurally CAN'T: a target whose load-bearing
  //    behavior is supplied BY its caller (a higher-order function handed a
  //    lambda, a callback wired at the call site). Dedupes by id against every
  //    slice already added (header has id:null, so only target/callee/ref ids
  //    collide). Skipped entirely when maxCallers is 0/undefined → the default
  //    pack is byte-identical to the pre-caller-hop behavior.
  if (maxCallers > 0) {
    const addedIds = new Set(
      slices.map((s) => s.id).filter((x): x is string => x !== null),
    );
    const byCaller = new Map<string, number>();
    for (const e of db.incoming(target.id)) {
      if (!isCallKind(e.kind) || e.src === target.id) continue;
      byCaller.set(e.src, (byCaller.get(e.src) ?? 0) + e.weight);
    }
    const ranked = [...byCaller.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    let added = 0;
    for (const [callerId, weight] of ranked) {
      if (added >= maxCallers) break;
      const caller = db.getNode(callerId);
      // Same guards as the callee pass: skip danglers (edge from an unresolved
      // id), whole-file modules, call edges from a test file (not a real
      // dependency when the target is real source), and any caller already in
      // the slice set (dedupe by id against everything added so far).
      //
      // The test guard reads DIFFERENTLY on this pass and is deliberately kept:
      // real source genuinely IS called by its tests, so dropping test callers
      // can leave the opt-in caller hop empty for a well-tested symbol. It is
      // retained anyway because the pass exists to recover behavior SUPPLIED BY
      // a caller (a lambda handed to a higher-order function), and a test's
      // stub argument is exactly the wrong thing to hand the model as if it
      // were production behavior. Widening `isTestFile` to Python/Go/Rust makes
      // this filter fire in repos where it previously never did.
      if (!caller || isModuleNode(caller)) continue;
      if (isTestFile(caller.file) && !isTestFile(target.file)) continue;
      if (overlapsTarget(caller, target)) continue; // straddles target → already shown
      if (addedIds.has(callerId)) continue; // already a target/callee/ref slice
      const slice = sliceNode(caller, "neighbor", read);
      if (!slice) continue;
      slice.via = "caller";
      slice.weight = weight;
      slices.push(slice);
      addedIds.add(callerId);
      added++;
    }
    if (ranked.length > added) {
      notes.push(
        `${ranked.length - added} more caller(s) omitted (cap ${maxCallers}, or unresolved/module/dup)`,
      );
    }
  }

  // 6. IMPORTED SYMBOLS — OPT-IN cross-file non-node definitions (default OFF).
  //    The §4 ref pass only inlines indexed type-like NODES; a target that names
  //    an imported `const`/object/`type` (a dispatch table, a CONFIG) defined in
  //    another file has no node, so it's invisible to every rung. When opted in,
  //    `collectImportedSymbols` text-extracts those declarations from the target
  //    file's imported source files and returns them as `via:"ref"` slices.
  //    Skipped entirely when off → the default pack is byte-identical.
  if (importedSymbols && target.file) {
    const addedIds = new Set(
      slices.map((s) => s.id).filter((x): x is string => x !== null),
    );
    const extra = collectImportedSymbols(
      db,
      repoRoot,
      target,
      targetSlice?.text ?? "",
      addedIds,
      { maxSymbols: maxNeighbors },
    );
    for (const s of extra) slices.push(s);
    if (extra.length > 0) {
      notes.push(`+${extra.length} cross-file imported symbol(s) (opt-in)`);
    }
  }

  let lineCount = 0;
  let chars = 0;
  for (const s of slices) {
    lineCount += s.endLine - s.startLine + 1;
    chars += s.text.length;
  }
  const estTokens = estimateTokens(chars);

  // "Worthwhile" signal — an honest, additive check that the precise pack is
  // actually cheaper than just opening the target's WHOLE file. We measured
  // packs that come out >= the file (a heavily-referenced target), where
  // shipping the pack buys nothing. Same chars/4 proxy as estTokens. When the
  // target has no readable file there's nothing better to fall back to → 0/true.
  let targetFileEstTokens = 0;
  if (target.file) {
    const lines = read(target.file);
    if (lines) targetFileEstTokens = estimateTokens(lines.join("\n").length);
  }
  const worthwhile = targetFileEstTokens === 0 || estTokens < targetFileEstTokens;
  if (!worthwhile) {
    notes.push(
      `pack (~${estTokens} tok) is not smaller than the target file (~${targetFileEstTokens} tok) — consider using the whole file`,
    );
  }

  return {
    symbol: target.id,
    resolved: resolved.resolved ? target.id : null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
  };
}

/** Compute lineCount / estTokens / targetFileEstTokens / worthwhile for an
 *  assembled slice set, the SAME way {@link buildContextPack} does, and tack on
 *  the not-worthwhile note. `anchorFile` is the file whose whole-file token
 *  count is the worthwhile yardstick (the first root's file). */
function finalizePack(
  slices: ContextSlice[],
  notes: string[],
  read: (file: string) => string[] | null,
  anchorFile: string | null,
): {
  lineCount: number;
  estTokens: number;
  targetFileEstTokens: number;
  worthwhile: boolean;
} {
  let lineCount = 0;
  let chars = 0;
  for (const s of slices) {
    lineCount += s.endLine - s.startLine + 1;
    chars += s.text.length;
  }
  const estTokens = estimateTokens(chars);
  let targetFileEstTokens = 0;
  if (anchorFile) {
    const lines = read(anchorFile);
    if (lines) targetFileEstTokens = estimateTokens(lines.join("\n").length);
  }
  const worthwhile = targetFileEstTokens === 0 || estTokens < targetFileEstTokens;
  if (!worthwhile) {
    notes.push(
      `pack (~${estTokens} tok) is not smaller than the target file (~${targetFileEstTokens} tok) — consider using the whole file`,
    );
  }
  return { lineCount, estTokens, targetFileEstTokens, worthwhile };
}

/**
 * LANE 1 — the file's MODULE FRAME: the contiguous runs of top-level lines NOT
 * inside ANY entity body (functions/methods/classes) — imports, module-level
 * assignments, `__all__`, the module docstring, the shell. This is exactly
 * {@link computeModuleScope} with NO single target (every entity body is
 * subtracted; nothing is re-added as a "target").
 *
 * Closes the **MISS_MODULE_LEVEL** caveat: a change to a module-scope line
 * (an import, `MAC = sys.platform...`, `__all__`, a module constant) has no
 * enclosing entity, so {@link buildContextPack} on the "smallest enclosing
 * entity" misses it. The module frame IS that surface — the changed module-scope
 * lines fall inside the frame.
 *
 * Slices have role `"module-frame"`. estTokens/lineCount/targetFileEstTokens/
 * worthwhile are computed identically to {@link buildContextPack}. Returns null
 * only when the file can't be read (nothing to frame).
 */
export function buildModuleFrame(
  db: Db,
  repoRoot: string,
  file: string,
  opts: { maxLines?: number; anchorRanges?: Array<[number, number]> } = {},
): ContextPack | null {
  const maxLines = countOpt(opts.maxLines, DEFAULT_MAX_HEADER_LINES);
  const read = makeFileReader(repoRoot);
  const lines = read(file);
  if (!lines) return null;

  const slices: ContextSlice[] = [];
  const notes: string[] = [];
  // With no anchor → the whole module frame; trimming (if over maxLines) drops
  // trailing runs first. With anchor ranges (the changed regions), trimming
  // keeps the module-scope runs NEAREST the change — so a small inter-entity gap
  // line a straddle change touches is retained instead of trimmed away.
  for (const seg of computeModuleScope(db, file, lines, {
    maxLines,
    anchorRanges: opts.anchorRanges,
  })) {
    slices.push({
      role: "module-frame",
      id: null,
      kind: "module-frame",
      file,
      startLine: seg.start,
      endLine: seg.end,
      text: seg.text,
    });
  }
  const { lineCount, estTokens, targetFileEstTokens, worthwhile } = finalizePack(
    slices,
    notes,
    read,
    file,
  );
  return {
    symbol: file,
    resolved: null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
  };
}

/**
 * LANE 2 — a MULTI-ROOT context pack: the union of each resolved root's TARGET
 * slice + its 1-hop callee/ref dependencies, DEDUPED across roots (by node id
 * AND by overlapping (file,range) so a callee that is also a root isn't
 * double-included), with ONE shared module skeleton per file (the skeleton
 * subtracts ALL entity bodies; each root is added back as its own target slice).
 *
 * Closes the **MISS_STRADDLE** caveat: a change spanning/adding multiple
 * entities has no single enclosing entity, but IS covered when every straddled
 * entity is a root. Ranking/caps: `maxNeighbors` applies across the COMBINED dep
 * set (not per-root) so the pack stays bounded. Deterministic order: roots in
 * input order, then deps weight-desc then id-asc. The dangler/module/test/
 * overlap guards from {@link buildContextPack} are reused.
 *
 * Returns null only if NO id resolves. A single-element `rawIds` produces a pack
 * equivalent to {@link buildContextPack} for that id.
 */
export function buildContextPackForSymbols(
  db: Db,
  repoRoot: string,
  rawIds: string[],
  opts: ContextPackOptions = {},
): ContextPack | null {
  const includeNeighbors = opts.neighbors !== false;
  const maxNeighbors = countOpt(opts.maxNeighbors, DEFAULT_MAX_NEIGHBORS);
  const maxHeaderLines = countOpt(opts.maxHeaderLines, DEFAULT_MAX_HEADER_LINES);
  const maxRefSliceLines = countOpt(
    opts.maxRefSliceLines,
    DEFAULT_MAX_REF_SLICE_LINES,
    1,
  );

  const read = makeFileReader(repoRoot);
  const slices: ContextSlice[] = [];
  const notes: string[] = [];

  // Resolve roots, preserving input order, deduped by node id.
  const roots: NodeRow[] = [];
  const rootIds = new Set<string>();
  for (const raw of rawIds) {
    const resolved = resolveNodeId(db, raw);
    if (!resolved) continue;
    if (rootIds.has(resolved.id)) continue;
    const node = db.getNode(resolved.id);
    if (!node) continue;
    rootIds.add(resolved.id);
    roots.push(node);
  }
  if (roots.length === 0) return null;

  // Group roots by file so each file gets ONE shared module skeleton (subtract
  // ALL entity bodies; the roots in that file are re-added as target slices).
  const rootsByFile = new Map<string, NodeRow[]>();
  for (const r of roots) {
    if (!r.file) continue;
    if (!rootsByFile.has(r.file)) rootsByFile.set(r.file, []);
    rootsByFile.get(r.file)!.push(r);
  }

  // 1. SHARED MODULE SKELETON per file (header runs). Anchored to ALL the file's
  //    roots so trimming keeps runs near any root.
  // 2. TARGET slices — every root's body, in input order.
  // To keep header-then-target-then-neighbors order AND group per file the way
  // buildContextPack does (header[file], target, …), we emit per-file headers
  // first, then targets in input order, then the combined neighbor set.
  for (const [file, fileRoots] of rootsByFile) {
    const lines = read(file);
    if (!lines) {
      notes.push(`could not read root file \`${file}\``);
      continue;
    }
    const anchorRanges = fileRoots.map(
      (r): [number, number] => [r.range_start, r.range_end],
    );
    for (const seg of computeModuleScope(db, file, lines, {
      anchorRanges,
      maxLines: maxHeaderLines,
    })) {
      slices.push({
        role: "header",
        id: null,
        kind: "header",
        file,
        startLine: seg.start,
        endLine: seg.end,
        text: seg.text,
      });
    }
  }

  // TARGET slices in INPUT order.
  const targetSlices = new Map<string, ContextSlice>();
  for (const root of roots) {
    const slice = sliceNode(root, "target", read);
    if (slice) {
      slices.push(slice);
      targetSlices.set(root.id, slice);
    } else {
      notes.push(`could not slice target body for \`${root.id}\``);
    }
  }

  // 3 + 4. NEIGHBOR PASSES — the SAME shared implementation the single-target
  //    entry point uses, run over the full root set. Dedupe set starts at every
  //    id already a slice (the roots); the (file,range) overlap test inside the
  //    passes keeps a callee that IS a root (or nested in one) from re-entering.
  if (includeNeighbors && maxNeighbors > 0) {
    const passState: NeighborPassState = {
      db,
      read,
      slices,
      notes,
      roots,
      rootIds,
      addedIds: new Set<string>(rootIds),
      maxNeighbors,
    };
    addCalleeNeighbors(passState, "unresolved/module/dup");
    // Refs are searched against the CONCATENATION of every root body, and
    // scanned same-file over each root file (sorted) before going cross-file.
    addRefNeighbors(passState, {
      rootText: roots.map((r) => targetSlices.get(r.id)?.text ?? "").join("\n"),
      rootFiles: [...rootsByFile.keys()].sort(),
      maxRefSliceLines,
    });
  }

  const anchorFile = roots[0]?.file ?? null;
  const { lineCount, estTokens, targetFileEstTokens, worthwhile } = finalizePack(
    slices,
    notes,
    read,
    anchorFile,
  );
  return {
    symbol: roots.map((r) => r.id).join(","),
    resolved: null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
  };
}

/** A changed region in a file (1-based inclusive lines). */
export interface ChangeRegion {
  startLine: number;
  endLine: number;
}

/**
 * Convenience builder-facing "I'm changing these regions" API. Classifies each
 * region against the file's non-module entities:
 *
 *   - A region CONTAINED in a single entity → that entity (the SMALLEST
 *     enclosing node) is a root.
 *   - A region that STRADDLES (spans/adds across) >1 entity, or partly outside
 *     any entity → EVERY entity it overlaps becomes a root (the multi-root path
 *     covers each straddled body), and — if any line of the region also falls
 *     OUTSIDE every entity (true module scope) — the module frame is added too.
 *     This is what closes MISS_STRADDLE.
 *   - A region that overlaps NO entity at all (a pure module-level change:
 *     imports, `__all__`, a module constant) → "module-level", served by the
 *     module frame. This closes MISS_MODULE_LEVEL.
 *
 * The pack is {@link buildContextPackForSymbols} over the collected root entity
 * ids MERGED with {@link buildModuleFrame} IFF any region needs module scope.
 * Merged slices are deduped by (file,startLine,endLine). Returns null only when
 * nothing resolves (no entity root AND no readable module frame).
 */
export function buildContextPackForChange(
  db: Db,
  repoRoot: string,
  file: string,
  regions: ChangeRegion[],
  opts: ContextPackOptions = {},
): ContextPack | null {
  // Classify each region against the file's non-module nodes.
  const rows = db.handle
    .query<
      { id: string; kind: string; range_start: number; range_end: number },
      [string]
    >("SELECT id, kind, range_start, range_end FROM nodes WHERE file = ?")
    .all(file)
    .filter((r) => r.kind !== "module");
  const entityIds: string[] = [];
  const seen = new Set<string>();
  let anyModuleLevel = false;
  /**
   * Entity coverage for this file as a bitmap over `1..maxEntityEnd`, built ONCE
   * in O(rows + lines).
   *
   * BOUND — the scan below used to ask "is line L inside any entity?" by walking
   * `rows` for EVERY line of EVERY region, i.e. O(regions × lines × entities).
   * That survived the gap-fill clamp and was independently measured at 76
   * SECONDS for 1024 whole-file regions against a 20k-line / 5k-entity file —
   * every one of those regions schema-valid and accepted by the MCP wire. Same
   * permanent wedge of the synchronous single-process stdio server, reached
   * through the other loop. The bitmap makes the scan O(lines).
   *
   * `range_end` comes from the index, so a corrupt/stale row could claim an
   * absurd end and turn the allocation itself into the DoS; cap it. Lines past
   * the cap answer "module scope", which is the inclusive (never-lose-context)
   * direction.
   */
  const MAX_COVERAGE_LINES = 10_000_000;
  const maxEntityEnd = Math.min(
    MAX_COVERAGE_LINES,
    rows.reduce((m, r) => Math.max(m, r.range_end), 0),
  );
  const insideEntity = new Uint8Array(maxEntityEnd + 2);
  for (const r of rows) {
    const from = Math.max(1, r.range_start);
    const to = Math.min(maxEntityEnd, r.range_end);
    for (let L = from; L <= to; L++) insideEntity[L] = 1;
  }
  /** Mark every line in [lo,hi] that is NOT inside ANY entity → if any remains,
   *  the region touches true module scope and needs the frame. */
  const regionTouchesModuleScope = (lo: number, hi: number): boolean => {
    // A line below 1 or past the last entity is outside every entity, so it IS
    // the answer — return without walking the range at all. (This also keeps a
    // hugely negative `lo` from becoming its own unbounded loop.)
    if (lo < 1 || hi > maxEntityEnd) return true;
    for (let L = lo; L <= hi; L++) if (!insideEntity[L]) return true;
    return false;
  };
  for (const region of regions) {
    const lo = Math.min(region.startLine, region.endLine);
    const hi = Math.max(region.startLine, region.endLine);
    // (1) smallest entity that fully CONTAINS the region.
    let best: { id: string; span: number } | null = null;
    for (const r of rows) {
      if (r.range_start <= lo && r.range_end >= hi) {
        const span = r.range_end - r.range_start;
        if (!best || span < best.span) best = { id: r.id, span };
      }
    }
    if (best) {
      if (!seen.has(best.id)) {
        seen.add(best.id);
        entityIds.push(best.id);
      }
      continue;
    }
    // (2) STRADDLE / partial — every entity the region overlaps is a root.
    const overlapping = rows.filter(
      (r) => r.range_start <= hi && r.range_end >= lo,
    );
    for (const r of overlapping) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        entityIds.push(r.id);
      }
    }
    // (3) module scope — pure module-level (no overlap) OR a straddle whose span
    //     also covers lines outside every entity → also add the frame.
    if (overlapping.length === 0 || regionTouchesModuleScope(lo, hi)) {
      anyModuleLevel = true;
    }
  }

  const entityPack =
    entityIds.length > 0
      ? buildContextPackForSymbols(db, repoRoot, entityIds, opts)
      : null;
  const framePack = anyModuleLevel
    ? buildModuleFrame(db, repoRoot, file, {
        // Through `countOpt` like every other read of this knob — reading the
        // raw option here was a hole in the guard (a negative/fractional
        // `maxHeaderLines` reached `computeModuleScope` untouched on this path).
        maxLines: countOpt(opts.maxHeaderLines, DEFAULT_MAX_HEADER_LINES),
        // Anchor frame-trimming to the changed regions so the module-scope runs
        // a (straddle) change touches — e.g. a gap line between two entities —
        // are retained instead of trimmed away in a large file.
        anchorRanges: regions.map(
          (r): [number, number] => [
            Math.min(r.startLine, r.endLine),
            Math.max(r.startLine, r.endLine),
          ],
        ),
      })
    : null;

  if (!entityPack && !framePack) return null;

  // Merge: entity-pack slices first (header/target/neighbors), then the module
  // frame's runs that aren't already covered. Dedupe by (file,start,end).
  const read = makeFileReader(repoRoot);
  const slices: ContextSlice[] = [];
  const notes: string[] = [];
  const sliceKey = (s: ContextSlice): string => `${s.file}:${s.startLine}:${s.endLine}`;
  const seenSlices = new Set<string>();
  const pushAll = (pack: ContextPack | null): void => {
    if (!pack) return;
    for (const s of pack.slices) {
      const k = sliceKey(s);
      if (seenSlices.has(k)) continue;
      seenSlices.add(k);
      slices.push(s);
    }
    for (const n of pack.notes) if (!notes.includes(n)) notes.push(n);
  };
  pushAll(entityPack);
  pushAll(framePack);

  // GAP-FILL — a straddle region can sweep lines that live between two entities
  // and were absorbed as one entity's leading decoration (blank/comment lines
  // above a def), so they end up in neither a target slice nor the frame. Add
  // the minimal real-line runs needed to cover every changed region line, so the
  // pack is genuinely SUFFICIENT for the change. Line-exact (real file lines),
  // tagged "module-frame" (they're inter-entity module scope).
  const fileLines = read(file);
  if (fileLines) {
    const covered = (L: number): boolean =>
      slices.some((s) => s.file === file && s.startLine <= L && s.endLine >= L);
    // BOUND — clamp every region to the file's real line span, then MERGE the
    // clamped spans before walking lines. Two failure modes this closes, both
    // reachable from `hayven mcp`'s client-supplied `regions` arg:
    //   - one huge `endLine` (a client using MAX_SAFE_INTEGER as a "whole file"
    //     sentinel) walked the whole range against a 10-line file — measured at
    //     197s for 2e10, ~years for 2^53, with the synchronous stdio server
    //     pegged and unable to answer another call;
    //   - many overlapping regions multiplied the per-line `covered()` scan.
    // After clamp+merge the per-line work is bounded by the FILE's length no
    // matter what the caller sends, so a future caller cannot reintroduce this.
    const spans: Array<[number, number]> = [];
    for (const region of regions) {
      const lo = Math.max(1, Math.min(region.startLine, region.endLine));
      const hi = Math.min(fileLines.length, Math.max(region.startLine, region.endLine));
      // NaN/Infinity fall out here: every comparison against them is false.
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) spans.push([lo, hi]);
    }
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const [lo, hi] of spans) {
      const last = merged[merged.length - 1];
      if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
      else merged.push([lo, hi]);
    }
    const uncovered: number[] = [];
    for (const [lo, hi] of merged) {
      for (let L = lo; L <= hi; L++) if (!covered(L)) uncovered.push(L);
    }
    uncovered.sort((a, b) => a - b);
    let i = 0;
    while (i < uncovered.length) {
      const start = uncovered[i]!;
      let end = start;
      while (i + 1 < uncovered.length && uncovered[i + 1] === end + 1) {
        end = uncovered[++i]!;
      }
      i++;
      const text = fileLines.slice(start - 1, end).join("\n");
      const k = `${file}:${start}:${end}`;
      if (!seenSlices.has(k)) {
        seenSlices.add(k);
        slices.push({
          role: "module-frame",
          id: null,
          kind: "module-frame",
          file,
          startLine: start,
          endLine: end,
          text,
        });
      }
    }
  }

  const anchorFile = entityPack?.slices[0]?.file ?? framePack?.slices[0]?.file ?? file;
  const fin = finalizePack(slices, notes, read, anchorFile);
  let { lineCount, estTokens, worthwhile } = fin;
  const targetFileEstTokens = fin.targetFileEstTokens;

  // LANE 3 — the never-worse-than-the-file guarantee. When the assembled pack is
  // NOT smaller than just reading the whole file (a change-set that spans most of
  // a small file), fall through and return the WHOLE FILE as a single slice. The
  // whole file is the minimal context that is still lossless + sufficient, and
  // this makes the builder contract unconditional: calling the packer is NEVER
  // worse than reading the file. By construction the returned pack is always
  // `estTokens <= targetFileEstTokens`.
  let fellBackToWholeFile = false;
  if (!worthwhile) {
    const lines = read(file);
    if (lines) {
      const text = lines.join("\n");
      slices.length = 0; // replace the (too-large) assembled slices in place
      slices.push({
        role: "target",
        id: null,
        kind: "whole-file",
        file,
        startLine: 1,
        endLine: lines.length,
        text,
      });
      lineCount = lines.length;
      estTokens = estimateTokens(text.length);
      worthwhile = false; // == the file: no slicing savings, but minimal + correct
      fellBackToWholeFile = true;
      notes.push(
        `pack was not smaller than \`${file}\` — returned the whole file (lossless, never worse than reading it)`,
      );
    }
  }

  return {
    symbol: [...entityIds, ...(anyModuleLevel ? [`${file}::module-frame`] : [])].join(
      ",",
    ),
    resolved: null,
    slices,
    lineCount,
    estTokens,
    notes,
    targetFileEstTokens,
    worthwhile,
    fellBackToWholeFile,
  };
}
