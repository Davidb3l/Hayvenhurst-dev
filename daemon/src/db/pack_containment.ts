/**
 * The packer's CONTAINMENT AND ADMISSIBILITY GATE: the security boundary that
 * decides which paths the packer is ever allowed to resolve, stat and read.
 *
 * It is carved out of `context_pack.ts` into its own module because it is the
 * one part of the packer that is security-critical rather than merely
 * behavioral: path traversal, symlink escape, secret-file denylists, and
 * indexer parity all land here, several other modules already import it, and it
 * deserves to be reviewable on its own. The code below is moved verbatim; every
 * narrative comment travels with the block it documents because those comments
 * record the incidents each guard exists to prevent.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

import { isPathExcludedByWalker } from "../native/ignore.ts";

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
