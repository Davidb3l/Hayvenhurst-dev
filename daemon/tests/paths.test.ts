import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectRepoRoot, findUp, hayvenPathsFor, rootConfirmDecision } from "../src/util/paths.ts";

describe("findUp / detectRepoRoot", () => {
  it("returns null when marker is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    expect(findUp(tmp, ".nope")).toBeNull();
  });

  it("locates a project via .hayven/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    mkdirSync(join(tmp, ".hayven"));
    const sub = join(tmp, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(detectRepoRoot(sub).reason).toBe("hayven");
    expect(detectRepoRoot(sub).root).toBe(tmp);
  });

  it("falls back to git", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    mkdirSync(join(tmp, ".git"));
    expect(detectRepoRoot(tmp).reason).toBe("git");
  });

  it("does NOT latch onto the home dir's global .hayven (falls through to git)", () => {
    // <tmp>/home/.hayven      (global config dir)
    // <tmp>/home/proj/.git    (uninitialized project)
    // <tmp>/home/proj/sub     (nested cwd)
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    const home = join(tmp, "home");
    mkdirSync(join(home, ".hayven"), { recursive: true });
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    const sub = join(proj, "sub");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: home });
    expect(got.reason).toBe("git");
    expect(got.root).toBe(proj);
  });

  it("a project with its OWN .hayven still resolves to itself", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    const home = join(tmp, "home");
    mkdirSync(join(home, ".hayven"), { recursive: true });
    const proj = join(home, "proj");
    mkdirSync(join(proj, ".hayven"), { recursive: true });
    mkdirSync(join(proj, ".git"), { recursive: true });
    const sub = join(proj, "sub");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: home });
    expect(got.reason).toBe("hayven");
    expect(got.root).toBe(proj);
  });

  it("running directly in home with only the global .hayven does not report home as a project root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    const home = join(tmp, "home");
    mkdirSync(join(home, ".hayven"), { recursive: true });

    const got = detectRepoRoot(home, { homeDir: home });
    expect(got.reason).not.toBe("hayven");
    expect(got.root).not.toBe(undefined);
  });

  /* ─── BL-15: the .git fallback walk must respect the $HOME boundary ──── */

  it("BL-15: a .git two levels up (below home) still resolves to that .git root", () => {
    // home/work/.git           (a real monorepo umbrella, BELOW home)
    // home/work/foo/sub        (uninitialized nested project + cwd)
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });
    const work = join(home, "work");
    mkdirSync(join(work, ".git"), { recursive: true });
    const sub = join(work, "foo", "sub");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: home });
    // Policy: the walk is bounded at $HOME, and a .git below home is a valid
    // root. The nearest-marker is the umbrella at `work` — resolve to it.
    expect(got.reason).toBe("git");
    expect(got.root).toBe(work);
  });

  it("BL-15: a stray ~/.git does NOT make an uninitialized project resolve its root to $HOME", () => {
    // home/.git                (stray — home itself under version control)
    // home/work/foo/sub        (uninitialized project + cwd)
    // Expectation: the walk does not escape above home AND home itself is never
    // a project root, so this falls through to the cwd fallback.
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    const home = join(tmp, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    const sub = join(home, "work", "foo", "sub");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: home });
    expect(got.reason).toBe("cwd-fallback");
    expect(got.root).toBe(sub);
  });

  it("BL-15: the upward walk does not escape ABOVE $HOME for the .git fallback", () => {
    // tmp/.git                 (ABOVE home — must be invisible to the walk)
    // tmp/home                 ($HOME)
    // tmp/home/proj/sub        (uninitialized project + cwd)
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    mkdirSync(join(tmp, ".git"), { recursive: true });
    const home = join(tmp, "home");
    const sub = join(home, "proj", "sub");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: home });
    // The `.git` above home must not be found; nothing below home matches.
    expect(got.reason).toBe("cwd-fallback");
    expect(got.root).toBe(sub);
  });

  it("BL-15: a start dir ABOVE home keeps an unbounded .git walk (out-of-home repos still resolve)", () => {
    // tmp/repo/.git            (a repo entirely outside the user's home tree)
    // tmp/repo/sub             (cwd)
    // tmp/home                 ($HOME, unrelated)
    const tmp = mkdtempSync(join(tmpdir(), "hayven-paths-"));
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: home });
    expect(got.reason).toBe("git");
    expect(got.root).toBe(repo);
  });
});

describe("findUp stopAt boundary (BL-15)", () => {
  it("checks the boundary dir itself but not its ancestors", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-findup-"));
    // marker lives AT the boundary → found.
    mkdirSync(join(tmp, "boundary", "child"), { recursive: true });
    mkdirSync(join(tmp, "boundary", ".marker"));
    const boundary = join(tmp, "boundary");
    expect(findUp(join(boundary, "child"), ".marker", { stopAt: boundary })).toBe(boundary);
  });

  it("does not find a marker ABOVE the boundary", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-findup-"));
    mkdirSync(join(tmp, ".marker")); // above the boundary
    const boundary = join(tmp, "boundary", "child");
    mkdirSync(boundary, { recursive: true });
    expect(findUp(boundary, ".marker", { stopAt: join(tmp, "boundary") })).toBeNull();
  });
});

describe("rootConfirmDecision (BL-15 init confirm policy)", () => {
  it("asks for confirmation when a .git root is matched strictly ABOVE the cwd", () => {
    const d = rootConfirmDecision(
      { root: "/home/work", reason: "git" },
      "/home/work/foo/sub",
    );
    expect(d.needsConfirm).toBe(true);
    expect(d.message).toContain("/home/work");
    expect(d.message).toContain("/home/work/foo/sub");
    expect(d.message).toContain("matched .git");
  });

  it("does NOT confirm when the .git root IS the cwd", () => {
    const d = rootConfirmDecision({ root: "/home/work", reason: "git" }, "/home/work");
    expect(d.needsConfirm).toBe(false);
    expect(d.message).toBe("");
  });

  it("does NOT confirm for a .hayven-matched root (initialized project)", () => {
    const d = rootConfirmDecision(
      { root: "/home/work", reason: "hayven" },
      "/home/work/foo/sub",
    );
    expect(d.needsConfirm).toBe(false);
  });

  it("does NOT confirm for the cwd fallback", () => {
    const d = rootConfirmDecision(
      { root: "/home/work/foo", reason: "cwd-fallback" },
      "/home/work/foo",
    );
    expect(d.needsConfirm).toBe(false);
  });

  it("does not treat a sibling sharing a path prefix as a subdir", () => {
    // `/home/workshop` must not count as being under `/home/work`.
    const d = rootConfirmDecision({ root: "/home/work", reason: "git" }, "/home/workshop");
    expect(d.needsConfirm).toBe(false);
  });
});

describe("hayvenPathsFor", () => {
  it("produces the canonical sub-paths", () => {
    const p = hayvenPathsFor("/repo");
    expect(p.hayvenDir).toBe("/repo/.hayven");
    expect(p.nodesDir).toBe("/repo/.hayven/nodes");
    expect(p.configFile).toBe("/repo/.hayven/config.json");
    expect(p.sqliteFile).toBe("/repo/.hayven/index.sqlite");
    expect(p.skillDir).toBe("/repo/.claude/skills");
  });
});
