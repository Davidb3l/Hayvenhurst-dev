/**
 * Filesystem path helpers for the Hayvenhurst daemon.
 *
 * Centralizes repo-root detection (walk up looking for `.git/` then `.hayven/`)
 * and the canonical sub-paths inside `.hayven/`.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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
  // Loop terminates at filesystem root (parent === dir) or the stop boundary.
  while (true) {
    const candidate = join(dir, marker);
    if (existsSync(candidate)) {
      return dir;
    }
    // BL-15: do not ascend above the boundary (but DO check the boundary
    // itself, above, before bailing out here).
    if (stopAt !== null && dir === stopAt) {
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
  const home = resolve(opts.homeDir ?? homedir());
  // BL-15: bound BOTH marker walks at `$HOME`, but only when the start dir is
  // at/below home. A start ABOVE home (e.g. a system path outside the user's
  // tree) keeps an unbounded walk so out-of-home repos resolve normally.
  const startResolved = resolve(start);
  const withinHome = startResolved === home || startResolved.startsWith(home + sep);
  const stopAt = withinHome ? { stopAt: home } : {};

  const hayven = findUp(startResolved, HAYVEN_DIR_NAME, stopAt);
  // Treat the home dir's `.hayven` as the global config dir, not a project
  // root: skip it and fall through to `.git` / cwd.
  if (hayven && resolve(hayven) !== home) return { root: hayven, reason: "hayven" };
  const git = findUp(startResolved, ".git", stopAt);
  // BL-15: `$HOME` itself is never a project root. A stray `~/.git` (or a home
  // dir under version control) must not make every uninitialized project under
  // `$HOME` resolve its root to home; skip it like the `~/.hayven` case and
  // fall through to the cwd fallback.
  if (git && resolve(git) !== home) return { root: git, reason: "git" };
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

/** Global Hayvenhurst directory under the user's home. */
export function globalHayvenDir(): string {
  return join(homedir(), HAYVEN_DIR_NAME);
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
