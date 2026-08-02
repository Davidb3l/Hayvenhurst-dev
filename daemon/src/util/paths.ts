/**
 * Filesystem path helpers for the Hayvenhurst daemon.
 *
 * Centralizes repo-root detection (walk up looking for `.git/` then `.hayven/`)
 * and the canonical sub-paths inside `.hayven/`.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Canonical, symlink-resolved absolute path — the identity key for a served
 * project. `resolve` alone normalizes `.`/`..`/trailing slashes but NOT symlinks,
 * so two symlink-equivalent roots would otherwise dedupe as distinct and open a
 * SECOND Db on the SAME `.hayven/index.sqlite` (two writers on one WAL = corruption).
 * Falls back to `resolve` when the path doesn't exist yet (realpath throws on ENOENT).
 */
export function canonicalRoot(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

export interface HayvenPaths {
  /** Absolute path of the user's project root. */
  readonly repoRoot: string;
  /** `<repoRoot>/.hayven` */
  readonly hayvenDir: string;
  readonly nodesDir: string;
  readonly tracesDir: string;
  readonly claimsDir: string;
  readonly crdtDir: string;
  readonly peersDir: string;
  readonly crashesDir: string;
  readonly logsDir: string;
  readonly configFile: string;
  /**
   * The LEGACY single index at `<hayvenDir>/index.sqlite`. Still the index the
   * daemon serves, what `init` creates, and the read FALLBACK for a branch that
   * has no per-branch index yet. Branch-aware resolution (`db/branch_index.ts`)
   * returns this verbatim when per-branch caching is off or the project is not
   * a git repo.
   */
  readonly sqliteFile: string;
  /** `<hayvenDir>/branches` — parent of the per-branch `<key>/index.sqlite`s. */
  readonly branchesDir: string;
  readonly pidFile: string;
  /** `<repoRoot>/.claude/skills` for skill install. */
  readonly skillDir: string;
  /**
   * Where the built Astro viewer lives. Resolved at startup via (in order):
   *   1. `$HAYVEN_VIEWER_DIST` env var (production binary will set this),
   *   2. `<hayvenhurstRepoRoot>/viewer/dist` when running from source.
   * Always absolute; may not exist if the viewer hasn't been built yet —
   * the daemon's viewer route handles that case gracefully.
   */
  readonly viewerDist: string;
  /**
   * Where the first-party Hayvenhurst skill markdown SOURCE lives. Resolved at
   * startup (in order) via (1) `$HAYVEN_SKILL_SRC`, (2) `<exeDir>/skill/hayvenhurst.md`
   * (packaged tarball), (3) `<hayvenhurstCheckout>/skill/hayvenhurst.md` (source),
   * (4) `<cwd>/skill/hayvenhurst.md`. Always absolute; may not exist — `init`
   * guards with existsSync exactly like `viewerDist`. This is the SOURCE that
   * `init` copies into a user project's `.claude/skills/hayvenhurst/SKILL.md`.
   */
  readonly skillSrc: string;
}

export const HAYVEN_DIR_NAME = ".hayven";

/**
 * Walk up from `start` looking for a directory marker.
 * Returns the directory containing the marker, or `null` if not found.
 *
 * `opts.stopAt` (inclusive) bounds the walk: once `dir` reaches that directory
 * it is the LAST one checked, and the walk does not ascend past it. This is the
 * BL-15 home boundary — an in-home cwd must not resolve a marker that lives
 * ABOVE `$HOME` (a `.git` outside the user's tree). The boundary dir itself is
 * checked; only its ancestors are excluded.
 */
export function findUp(
  start: string,
  marker: string,
  opts: { stopAt?: string } = {},
): string | null {
  let dir = resolve(start);
  const stopAt = opts.stopAt !== undefined ? resolve(opts.stopAt) : null;
  // The boundary may be spelled differently from the path we are walking:
  // `homedir()` returns the passwd string with symlinks INTACT, while a walk
  // that started at `process.cwd()` is already physical. On a host where `$HOME`
  // has a symlinked component (`/home/x` → `/mnt/…`, an autofs/NFS home, a
  // relocated macOS home) a raw `dir === stopAt` never fires, the walk sails
  // straight past home, and BL-15's "never pick a marker above the user's tree"
  // guarantee is silently off. Resolved ONCE, and only kept when it actually
  // differs, so the overwhelmingly common unsymlinked case costs nothing.
  const stopAtCanon = stopAt !== null ? canonicalRoot(stopAt) : null;
  const needCanonCheck = stopAtCanon !== null && stopAtCanon !== stopAt;
  // Loop terminates at filesystem root (parent === dir) or the stop boundary.
  while (true) {
    const candidate = join(dir, marker);
    if (existsSync(candidate)) {
      return dir;
    }
    // BL-15: do not ascend above the boundary (but DO check the boundary
    // itself, above, before bailing out here).
    if (stopAt !== null && (dir === stopAt || (needCanonCheck && canonicalRoot(dir) === stopAtCanon))) {
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Detect the project root.
 *
 * Priority:
 *   1. An existing `.hayven/` directory (initialized project).
 *   2. A `.git/` directory (uninitialized but inside a repo).
 *   3. The starting directory itself (fallback — callers can warn).
 *
 * The home directory's `.hayven` is the GLOBAL config dir (see
 * `config/load.ts` layer 2), NOT a project marker. If the `.hayven` walk-up
 * resolves to the home dir, it is skipped so an uninitialized project under
 * `$HOME` falls through to `.git` / cwd instead of latching onto `~/.hayven`.
 * A project with its OWN `.hayven` lower in the tree is found first and is
 * unaffected. `opts.homeDir` is injectable purely so this is unit-testable
 * without depending on the real `os.homedir()`.
 *
 * BL-15 — home-boundary policy for the `.git` fallback. Two guards:
 *   (a) the upward walk for BOTH markers STOPS AT `$HOME` and never ascends
 *       above it, so a `.git`/`.hayven` outside the user's tree can never be
 *       picked as a project root for an in-home cwd; and
 *   (b) `$HOME` itself is never a project root — a stray `~/.git` (home under
 *       version control) is skipped just like the global `~/.hayven`, so every
 *       uninitialized project under `$HOME` falls through to the cwd fallback
 *       rather than latching onto home.
 * A `.git` strictly BELOW `$HOME` (e.g. a real monorepo umbrella at `~/work`)
 * is still a valid root and is resolved to — that matches plain `git` behavior;
 * the umbrella is a deliberate version-control boundary, and the NEAREST such
 * marker wins. When the starting dir is itself ABOVE `$HOME` the boundary does
 * not apply (the walk never reaches home), so out-of-home repos resolve
 * normally via an unbounded `.git` walk.
 */
export function detectRepoRoot(
  start: string = process.cwd(),
  opts: { homeDir?: string } = {},
): {
  root: string;
  reason: "hayven" | "git" | "cwd-fallback";
} {
  // BOTH notions of "home" are off-limits, and they are NOT the same thing:
  // `homedir()` is the user's actual home, `hayvenHomeDir()` is where global
  // state lives. They coincide in production (nobody sets `$HAYVEN_HOME`).
  // Checking only the latter would mean a user who legitimately relocates state
  // (`HAYVEN_HOME=/opt/hayven`) loses this boundary on their REAL home and
  // re-arms the whole-home-tree indexing bug; checking only the former makes a
  // sandbox's global `.hayven` look like a project root. So: check both.
  const homes = (opts.homeDir !== undefined ? [opts.homeDir] : [homedir(), hayvenHomeDir()]).map((h) =>
    resolve(h),
  );
  // Compare home in BOTH spellings, exactly as `assertRegistrableRoot` does and
  // for exactly the same reason: `homedir()` keeps symlinks, every path derived
  // from `process.cwd()` is physical, and a raw `===` between the two lets the
  // ORIGINAL whole-home-tree bug through on any host with a symlinked home. The
  // canonical arm is only computed where it differs, so the normal case is free.
  const homesCanon = homes.map((h) => canonicalRoot(h));
  const isHome = (p: string): boolean => {
    const abs = resolve(p);
    if (homes.includes(abs)) return true;
    return homesCanon.some((h, i) => h !== homes[i]) && homesCanon.includes(canonicalRoot(abs));
  };
  // BL-15: bound BOTH marker walks at `$HOME`, but only when the start dir is
  // at/below home. A start ABOVE home (e.g. a system path outside the user's
  // tree) keeps an unbounded walk so out-of-home repos resolve normally. With
  // two candidate homes, bound at the DEEPEST one that contains the start, so
  // the tighter boundary wins.
  const startResolved = resolve(start);
  const startCanon = canonicalRoot(startResolved);
  const under = (dir: string, base: string): boolean => dir === base || dir.startsWith(base + sep);
  const containing = homes
    // The containment test needs the same two-spelling treatment: a physical
    // cwd under a symlink-spelled home is NOT a string prefix of it, so without
    // this the boundary is simply never installed on those hosts.
    .filter((h, i) => under(startResolved, h) || under(startCanon, homesCanon[i] as string))
    .sort((a, b) => b.length - a.length);
  const stopAt = containing.length > 0 ? { stopAt: containing[0] as string } : {};

  const hayven = findUp(startResolved, HAYVEN_DIR_NAME, stopAt);
  // Treat the home dir's `.hayven` as the global config dir, not a project
  // root: skip it and fall through to `.git` / cwd.
  if (hayven && !isHome(hayven)) return { root: hayven, reason: "hayven" };
  const git = findUp(startResolved, ".git", stopAt);
  // BL-15: `$HOME` itself is never a project root. A stray `~/.git` (or a home
  // dir under version control) must not make every uninitialized project under
  // `$HOME` resolve its root to home; skip it like the `~/.hayven` case and
  // fall through to the cwd fallback.
  if (git && !isHome(git)) return { root: git, reason: "git" };
  return { root: startResolved, reason: "cwd-fallback" };
}

/**
 * BL-15 — init root-confirmation policy for the `.git` fallback.
 *
 * The `$HOME` boundary in `detectRepoRoot` stops a marker ABOVE the user's
 * tree from being picked, and a stray `~/.git`/`~/.hayven` from latching the
 * root to home. What it deliberately does NOT do is reject a `.git` that lives
 * strictly BELOW `$HOME` (a real monorepo umbrella at `~/work`): resolving to
 * it matches plain `git` behavior and the NEAREST such marker wins. But that
 * leaves one foot-gun: an uninitialized project at `~/work/foo` whose only
 * marker is the umbrella `~/work/.git` would create `.hayven` at `~/work`, not
 * `foo` — silently the wrong root.
 *
 * Policy (decided for BL-15): do NOT change where `detectRepoRoot` resolves —
 * the nearest `.git` is still correct for `git`-aware tooling — but have `init`
 * CONFIRM the target when it was matched via `.git` (`reason === "git"`) AND
 * the cwd is a STRICT subdirectory of that root. In that case the user almost
 * certainly meant the subdir; an explicit confirm catches the umbrella mistake
 * without ever blocking the common "init at the repo root" path.
 *
 * This helper is pure (no I/O, no prompting) so it is unit-testable; the CLI
 * layer decides how to surface the prompt and how `--yes`/non-interactive skips
 * it. Returns `needsConfirm: false` for every other case (an existing
 * `.hayven`, a `.git` AT the cwd, or the cwd fallback), so the prompt is shown
 * only for the genuinely ambiguous nested-`.git` layout.
 */
export interface RootConfirmDecision {
  /** True only for a `.git`-matched root strictly above the cwd. */
  readonly needsConfirm: boolean;
  /** A ready-to-print confirmation line (empty when `needsConfirm` is false). */
  readonly message: string;
}

export function rootConfirmDecision(
  detected: { root: string; reason: "hayven" | "git" | "cwd-fallback" },
  cwd: string,
): RootConfirmDecision {
  const root = resolve(detected.root);
  const here = resolve(cwd);
  const cwdIsStrictSubdir = here !== root && here.startsWith(root + sep);
  if (detected.reason === "git" && cwdIsStrictSubdir) {
    return {
      needsConfirm: true,
      message: `Initializing at ${root} (matched .git), not the current directory ${here} — correct? [y/N] `,
    };
  }
  return { needsConfirm: false, message: "" };
}

export function hayvenPathsFor(repoRoot: string): HayvenPaths {
  const hayvenDir = join(repoRoot, HAYVEN_DIR_NAME);
  return {
    repoRoot,
    hayvenDir,
    nodesDir: join(hayvenDir, "nodes"),
    tracesDir: join(hayvenDir, "traces"),
    claimsDir: join(hayvenDir, "claims"),
    crdtDir: join(hayvenDir, "crdt"),
    peersDir: join(hayvenDir, "peers"),
    crashesDir: join(hayvenDir, "crashes"),
    logsDir: join(hayvenDir, "logs"),
    configFile: join(hayvenDir, "config.json"),
    sqliteFile: join(hayvenDir, "index.sqlite"),
    branchesDir: join(hayvenDir, "branches"),
    pidFile: join(hayvenDir, "daemon.pid"),
    skillDir: join(repoRoot, ".claude", "skills"),
    viewerDist: resolveViewerDist(),
    skillSrc: resolveSkillSource(),
  };
}

/**
 * Resolve where the built Astro viewer lives.
 *
 * Order:
 *   1. `$HAYVEN_VIEWER_DIST` — set by the production install script or
 *      packaged binary so the viewer can ship alongside `hayven`.
 *   2. `<hayvenhurst-checkout>/viewer/dist` — the development case. We walk
 *      up from this file (`paths.ts`) looking for a sibling `viewer/dist`,
 *      which works whether the daemon is invoked from any project directory.
 *   3. A best-effort `<cwd>/viewer/dist` fallback for completeness.
 */
function resolveViewerDist(): string {
  const fromEnv = process.env["HAYVEN_VIEWER_DIST"];
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);

  // Production tarball: the compiled `hayven` binary ships with a sibling
  // `viewer/dist/` (release.yml bundles it there). Resolve it relative to the
  // executable so it works from any cwd. In dev, `process.execPath` is the `bun`
  // binary — its dir has no viewer/dist, so the existsSync guard skips this and
  // we fall through to the source-checkout walk below.
  try {
    const beside = join(dirname(process.execPath), "viewer", "dist");
    if (existsSync(beside)) return beside;
  } catch {
    /* process.execPath unavailable — fall through */
  }

  // Walk up from this source file looking for a checkout root with viewer/.
  // `import.meta.dir` is the dir of this `.ts` file; this works in source
  // mode and is harmless (returns null fallback) once we ship a single bundle.
  const here = typeof import.meta.dir === "string" ? import.meta.dir : "";
  if (here.length > 0) {
    const checkoutRoot = findUp(here, "viewer");
    if (checkoutRoot) {
      const candidate = join(checkoutRoot, "viewer", "dist");
      return candidate;
    }
  }

  return resolve(process.cwd(), "viewer", "dist");
}

/**
 * Resolve the first-party Hayvenhurst skill markdown SOURCE file.
 *
 * Mirrors `resolveViewerDist`: the skill ships beside the binary in the release
 * tarball (release.yml bundles `skill/hayvenhurst.md` into `<exeDir>/skill/`),
 * so `hayven init` can install it into ANY user project — not just this repo.
 *
 * Order:
 *   1. `$HAYVEN_SKILL_SRC` — explicit override (tests / packaging).
 *   2. `<exeDir>/skill/hayvenhurst.md` — production tarball: the compiled
 *      `hayven` binary ships with a sibling `skill/` (release.yml). Resolved
 *      relative to the executable so it works from any cwd. In dev,
 *      `process.execPath` is the `bun` binary whose dir has no `skill/`, so the
 *      existsSync guard skips this and we fall through to the source walk.
 *   3. `<hayvenhurst-checkout>/skill/hayvenhurst.md` — development case. Walk
 *      up from this file (`paths.ts`) looking for a checkout root containing a
 *      `skill/` directory.
 *   4. A best-effort `<cwd>/skill/hayvenhurst.md` fallback for completeness.
 *
 * Returns an absolute path that MAY NOT EXIST; callers guard with existsSync
 * exactly like `viewerDist`.
 */
export function resolveSkillSource(): string {
  const fromEnv = process.env["HAYVEN_SKILL_SRC"];
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);

  // Production tarball: skill ships beside the binary at <exeDir>/skill/.
  try {
    const beside = join(dirname(process.execPath), "skill", "hayvenhurst.md");
    if (existsSync(beside)) return beside;
  } catch {
    /* process.execPath unavailable — fall through */
  }

  // Walk up from this source file looking for a checkout root with skill/.
  const here = typeof import.meta.dir === "string" ? import.meta.dir : "";
  if (here.length > 0) {
    const checkoutRoot = findUp(here, "skill");
    if (checkoutRoot) {
      return join(checkoutRoot, "skill", "hayvenhurst.md");
    }
  }

  return resolve(process.cwd(), "skill", "hayvenhurst.md");
}

/**
 * The home directory Hayvenhurst anchors its global state to.
 *
 * `$HAYVEN_HOME` overrides it. Two reasons: it lets a user relocate global
 * state, and it is the ONLY way to sandbox this in a test — Bun resolves
 * `os.homedir()` once per process, so mutating `process.env.HOME` at runtime
 * does nothing and a test that tried would silently read and rewrite the
 * developer's real `~/.hayven/projects.json`.
 */
export function hayvenHomeDir(): string {
  const override = process.env["HAYVEN_HOME"];
  if (!override || override.trim().length === 0) return homedir();
  // Must be ABSOLUTE. `resolve()` on a relative value is cwd-relative, so a
  // daemon started in repo A and a CLI run in repo B would silently use
  // different registries, writer ids, and logs — global state that moves with
  // the working directory is worse than no override at all.
  if (!isAbsolute(override)) {
    throw new Error(`HAYVEN_HOME must be an absolute path (got ${JSON.stringify(override)}).`);
  }
  return resolve(override);
}

/** Global Hayvenhurst directory under the user's home. */
export function globalHayvenDir(): string {
  return join(hayvenHomeDir(), HAYVEN_DIR_NAME);
}

export function globalConfigFile(): string {
  return join(globalHayvenDir(), "config.json");
}

export function globalLogsDir(): string {
  return join(globalHayvenDir(), "logs");
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directory names the pre-flight count skips, mirroring `ALWAYS_SKIP_DIRS` +
 * `VENDORED_DIRS` in `native/src/parse/walker.rs`.
 */
const PREFLIGHT_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".hayven",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
  "Godeps",
  "third_party",
]);

/**
 * `FIXTURE_LIKE_DIRS` from `native/src/parse/walker.rs` — pruned by default
 * (`include_fixtures: false`), so the pre-flight count must prune them too or
 * it counts files the ingest would never parse.
 */
const PREFLIGHT_FIXTURE_DIRS: ReadonlySet<string> = new Set(["examples", "benchmark", "benchmarks"]);

/** `FIXTURE_ANCESTOR_DIRS` from the walker: under one of these, `fixtures/` is pruned. */
const PREFLIGHT_FIXTURE_ANCESTORS: ReadonlySet<string> = new Set(["test", "tests", "e2e", "__tests__"]);

/**
 * Extensions the native parser can actually turn into graph nodes — the exact
 * arm list of `Language::from_extension` in `native/src/parse/language.rs`.
 *
 * WHY THIS EXISTS AS A FILTER, not a comment: the pre-flight count used to
 * count EVERY non-hidden file of ANY extension, while the ingest cap
 * (`DEFAULT_MAX_INGEST_FILES` in `graph/ingest.ts`) counts the native walker's
 * `files_total` — language-mapped AND post-`.gitignore`. Measured on one tree,
 * the two numbers were 401 and 1. Two ceilings expressed in units that differ
 * by two orders of magnitude are not two ceilings; the init one just refuses
 * repos with a large ignored `coverage/`, `out/`, `.output/` or `data/` dir
 * that the ingest would never have looked at.
 *
 * Keep in step with `language.rs`. A NEW language added there and missed here
 * makes this UNDER-count, which is the direction that lets a huge tree through.
 */
export const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
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

/** Lowercase extension without the dot, or "" when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/* ------------------------------------------------------------------ *
 * .gitignore matching for the pre-flight count
 * ------------------------------------------------------------------ */

/**
 * One compiled ignore pattern. `re` is tested against the candidate's path
 * RELATIVE to the directory whose ignore file declared it (POSIX separators).
 */
export interface IgnoreRule {
  readonly re: RegExp;
  /** `!pattern` — re-includes something an earlier rule excluded. */
  readonly negated: boolean;
  /** `pattern/` — matches directories only. */
  readonly dirOnly: boolean;
}

/** The rules declared by one directory's ignore file(s), plus that directory. */
interface IgnoreScope {
  readonly base: string;
  readonly rules: readonly IgnoreRule[];
}

/**
 * Hard bounds on ignore parsing. The counter exists to BOUND work, so its own
 * ignore handling must not become the unbounded thing: a hostile or generated
 * `.gitignore` (a megabyte of patterns, one per built artifact) would otherwise
 * cost a regex compile per pattern per directory.
 */
const MAX_IGNORE_BYTES = 256 * 1024;
const MAX_IGNORE_RULES_PER_FILE = 2_000;

/** Escape a literal character for inclusion in a RegExp source. */
function escapeRe(c: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
}

/**
 * Strip trailing whitespace that git would ignore. A backslash-escaped trailing
 * space is significant, so stop at one.
 */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) {
    // An odd number of preceding backslashes escapes this space — keep it.
    let backslashes = 0;
    while (end - 2 - backslashes >= 0 && line[end - 2 - backslashes] === "\\") backslashes++;
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

/**
 * Compile one `.gitignore` line to a rule, or null for a blank/comment line.
 *
 * Implements the subset of gitignore syntax that appears in real repos:
 * comments, negation, directory-only (`build/`), anchoring (a `/` anywhere but
 * the end anchors to the declaring dir), `*`, `?`, `**`, character classes and
 * backslash escapes. Anything it cannot express compiles to a rule that simply
 * does not match, which OVER-counts — the direction that refuses too loudly
 * rather than the one that lets a home dir through.
 */
export function compileIgnorePattern(raw: string): IgnoreRule | null {
  let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (line.length === 0 || line.startsWith("#")) return null;
  line = stripTrailingSpaces(line);
  if (line.length === 0) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
    line = line.slice(1);
  }
  let dirOnly = false;
  while (line.endsWith("/")) {
    dirOnly = true;
    line = line.slice(0, -1);
  }
  if (line.length === 0) return null;

  // A `/` anywhere except the (already removed) trailing position anchors the
  // pattern to the declaring directory; otherwise it matches by basename at any
  // depth. This is the rule that makes `build/` prune every `build` dir but
  // `src/build` prune only the one.
  const anchored = line.includes("/");
  if (line.startsWith("/")) line = line.slice(1);

  let body = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === "\\") {
      body += escapeRe(line[++i] ?? "\\");
      continue;
    }
    if (c === "*") {
      const doubled = line[i + 1] === "*";
      if (doubled) {
        const atStart = i === 0 || line[i - 1] === "/";
        if (atStart && line[i + 2] === "/") {
          body += "(?:[^/]+/)*"; // `**/` — zero or more directory levels
          i += 2;
          continue;
        }
        if (atStart && i + 2 === line.length) {
          body += ".*"; // trailing `/**` — everything below
          i += 1;
          continue;
        }
        // `**` not used as a path component is just `*` to git.
        body += "[^/]*";
        i += 1;
        continue;
      }
      body += "[^/]*";
      continue;
    }
    if (c === "?") {
      body += "[^/]";
      continue;
    }
    if (c === "[") {
      const close = findClassEnd(line, i);
      if (close === -1) {
        body += "\\[";
        continue;
      }
      let cls = line.slice(i + 1, close);
      if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
      body += `[${cls}]`;
      i = close;
      continue;
    }
    body += escapeRe(c);
  }

  // The `(?:/.*)?` tail is how a matched DIRECTORY also covers its contents —
  // git never re-includes a file whose parent dir is excluded, and the walk
  // prunes such a dir on sight, so this only matters when a rule names a dir
  // the walk reached by another route.
  const prefix = anchored ? "^" : "^(?:.*/)?";
  let re: RegExp;
  try {
    re = new RegExp(`${prefix}${body}(?:/.*)?$`);
  } catch {
    return null; // an unrepresentable class — over-count rather than throw
  }
  return { re, negated, dirOnly };
}

/** Index of the `]` closing a character class opened at `start`, or -1. */
function findClassEnd(line: string, start: number): number {
  let i = start + 1;
  if (line[i] === "!") i++;
  if (line[i] === "]") i++; // a leading `]` is literal
  for (; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "]") return i;
  }
  return -1;
}

/** Parse one ignore FILE into rules. Returns [] for a missing/huge/unreadable file. */
function readIgnoreFile(file: string): IgnoreRule[] {
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_IGNORE_BYTES) return [];
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of text.split("\n")) {
    const rule = compileIgnorePattern(line);
    if (rule !== null) rules.push(rule);
    if (rules.length >= MAX_IGNORE_RULES_PER_FILE) break;
  }
  return rules;
}

/**
 * The ignore scope contributed by `dir`, or null when it declares nothing.
 *
 * Reads `.gitignore` and `.ignore` (both honoured by the `ignore` crate the
 * native walker wraps: `git_ignore(true)` + `ignore(true)`). NOT honoured, and
 * deliberately so: the user's global core.excludesFile (`git_global(true)`)
 * and ignore files in directories ABOVE the walk root (`parents(true)`).
 * Reading either means shelling out to `git config` or walking out of the tree
 * we were asked to size; both omissions only make this OVER-count, which
 * refuses too loudly instead of waving a home directory through.
 */
function ignoreScopeFor(dir: string, isRoot: boolean): IgnoreScope | null {
  const rules = [
    ...readIgnoreFile(join(dir, ".gitignore")),
    ...readIgnoreFile(join(dir, ".ignore")),
    // `git_exclude(true)`: the repo-local, uncommitted exclude list.
    ...(isRoot ? readIgnoreFile(join(dir, ".git", "info", "exclude")) : []),
  ];
  return rules.length > 0 ? { base: dir, rules } : null;
}

/**
 * True when `abs` is ignored by `scopes` (outermost first).
 *
 * Last match wins, and a deeper ignore file overrides a shallower one — the
 * scopes are already ordered outermost → innermost, so a single left-to-right
 * pass with "last match wins" gives exactly git's precedence.
 */
function isIgnored(abs: string, isDir: boolean, scopes: readonly IgnoreScope[]): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const rel = relative(scope.base, abs).split(sep).join("/");
    if (rel.length === 0 || rel.startsWith("../")) continue;
    for (const rule of scope.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rel)) ignored = !rule.negated;
    }
  }
  return ignored;
}

export interface BoundedFileCount {
  /** Files seen. A LOWER BOUND when `exact` is false. */
  readonly count: number;
  /** True when the tree holds more than `ceiling` countable files. */
  readonly exceeded: boolean;
  /** False when the scan stopped at its own hard cap or time budget. */
  readonly exact: boolean;
}

/**
 * Count the files a first ingest would PARSE under `root`, with hard bounds.
 *
 * WHY THIS EXISTS: the home-directory incident (98% CPU for 6h, 195 GB read, a
 * 593 MB index) was NOT caused by home being special. It was caused by an
 * UNBOUNDED walk with no ceiling — home merely happened to be the one root that
 * had a guard. `~/Library`, `~/Documents`, `/Users` and `/Volumes` all still
 * pass `isRegistrableRoot`, and `~/Library/Python/site-packages` is the tree
 * that produced most of that 195 GB. So callers get a cheap number they can
 * refuse on BEFORE any of the expensive work starts.
 *
 * COMPARABLE UNITS. This counts the same population the native walker feeds the
 * parser, which is also the population `DEFAULT_MAX_INGEST_FILES` in
 * `graph/ingest.ts` caps (`files_total` off the `start` record): the skip-list
 * and fixture/vendored prunes, `.gitignore`/`.ignore`/`.git/info/exclude`, and
 * only extensions `Language::from_extension` maps. It used to count EVERY
 * non-hidden file of any extension and ignore `.gitignore` entirely — measured
 * on one tree that was 401 against the ingest's 1, so the init ceiling could
 * refuse a perfectly normal repo purely for having a large ignored `coverage/`
 * or `out/` dir. See {@link INDEXABLE_EXTENSIONS}.
 *
 * The counter is itself bounded, or it would just be the same unbounded walk
 * one step earlier: it stops at `scanCap` files or `budgetMs` of wall clock and
 * reports `exact: false`, so the caller can still say "more than N". It reads
 * directory entries and ignore files only — never source contents — and never
 * follows symlinks (matching the native walker, and closing the
 * directory-cycle hazard).
 */
export function countIndexableFiles(
  root: string,
  ceiling: number,
  opts: { scanCap?: number; budgetMs?: number } = {},
): BoundedFileCount {
  // Keep counting past the ceiling so the error message can name a real number
  // instead of "more than N" — but only to a hard multiple of it, so a truly
  // enormous tree still terminates quickly.
  const scanCap = opts.scanCap ?? Math.max(ceiling * 10, ceiling + 1);
  const budgetMs = opts.budgetMs ?? 10_000;
  const deadline = Date.now() + budgetMs;
  const start = resolve(root);
  /**
   * A pending directory plus the ignore scopes in force there. Scopes are
   * ordered outermost → innermost and shared by reference between siblings, so
   * a deep tree costs one array per directory, not one per file.
   */
  const stack: Array<{ dir: string; scopes: readonly IgnoreScope[] }> = [];
  const rootScope = ignoreScopeFor(start, true);
  stack.push({ dir: start, scopes: rootScope !== null ? [rootScope] : [] });
  let count = 0;
  let checked = 0;

  while (stack.length > 0) {
    const { dir, scopes } = stack.pop() as { dir: string; scopes: readonly IgnoreScope[] };
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (perms, a vanished path) — not a reason to fail
    }
    for (const e of entries) {
      // Symlinks are neither counted nor descended into: the native walker does
      // not follow them either, and descending would let a single `~/x -> ~`
      // link make this scan non-terminating. Belt-and-braces — `readdirSync`
      // dirents already carry lstat semantics, so `isDirectory()` is false for
      // a link — but stated explicitly so a later switch to `stat` cannot
      // quietly reintroduce the cycle.
      if (e.isSymbolicLink()) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || PREFLIGHT_SKIP_DIRS.has(e.name)) continue;
        if (isPrunedFixtureDir(start, abs, e.name)) continue;
        if (isIgnored(abs, true, scopes)) continue;
        // A child's own ignore file is appended so it OVERRIDES its ancestors'
        // (git: the deepest matching rule wins).
        const own = ignoreScopeFor(abs, false);
        stack.push({ dir: abs, scopes: own !== null ? [...scopes, own] : scopes });
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name.startsWith(".")) continue; // the walker runs with hidden(true)
      // Extension filter FIRST: it is a set lookup, while `isIgnored` runs a
      // regex per rule per scope. On a repo with a large ignored build dir the
      // order is worth several seconds of the scan budget.
      if (!INDEXABLE_EXTENSIONS.has(extensionOf(e.name))) continue;
      if (isIgnored(abs, false, scopes)) continue;
      count++;
      if (count >= scanCap) return { count, exceeded: count > ceiling, exact: false };
    }
    // Check the clock per directory, not per file — `Date.now()` in the inner
    // loop would dominate the cost of the scan it is supposed to bound.
    if (++checked % 64 === 0 && Date.now() > deadline) {
      return { count, exceeded: count > ceiling, exact: false };
    }
  }
  return { count, exceeded: count > ceiling, exact: true };
}

/**
 * `is_fixture_dir` from `native/src/parse/walker.rs`: an `examples`/
 * `benchmark(s)` dir at any depth, or a `fixtures` dir with a test-dir ancestor
 * INSIDE the walk root. The ancestor check is deliberately repo-relative — a
 * checkout that happens to live under a directory named `test` on the user's
 * disk must keep its own `fixtures/` counted.
 */
function isPrunedFixtureDir(root: string, abs: string, name: string): boolean {
  if (PREFLIGHT_FIXTURE_DIRS.has(name)) return true;
  if (name !== "fixtures") return false;
  const rel = relative(root, abs);
  if (rel.length === 0 || rel.startsWith("..")) return false;
  const parts = rel.split(sep);
  // Exclude the dir's own name (the last part) from the ancestor scan.
  return parts.slice(0, -1).some((p) => PREFLIGHT_FIXTURE_ANCESTORS.has(p));
}
