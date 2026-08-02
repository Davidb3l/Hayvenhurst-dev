/**
 * EXTRA (the "re-check for raw-string root comparisons" sweep) — `detectRepoRoot`
 * compared `$HOME` against the walk by RAW STRING.
 *
 * `assertRegistrableRoot` has a long comment explaining why it must compare
 * canonical forms: `homedir()` returns the passwd spelling with symlinks
 * INTACT, while anything derived from `process.cwd()` is already physical, so
 * on a host with a symlinked home (`/home/x` → `/mnt/…`, an autofs/NFS home, a
 * relocated macOS home) a raw `===` compares unequal and lets the original
 * whole-home-tree bug straight through. `detectRepoRoot` did NOT do that, in
 * two places:
 *
 *   1. `isHome(p)` — so home's global `.hayven`/stray `.git` could be picked as
 *      a PROJECT ROOT, the exact "daemon indexed the whole home dir" shape; and
 *   2. the containment test that installs the BL-15 `stopAt` boundary — a
 *      physical cwd is not a string prefix of a symlink-spelled home, so the
 *      boundary was simply never installed and the walk ascended ABOVE the
 *      user's tree to find a `.git` outside it.
 *
 * The fixture builds a symlinked home on purpose: `<sb>/link-home` → `<sb>/real-home`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectRepoRoot } from "../src/util/paths.ts";

let sb: string;

beforeEach(() => {
  sb = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapp-symhome-")));
});

afterEach(() => {
  rmSync(sb, { recursive: true, force: true });
});

/**
 * `{ physicalHome, linkedHome }` where `linkedHome` is a symlink to
 * `physicalHome` — the two spellings of one home directory. The global
 * `.hayven` config dir lives inside it, exactly as in production.
 */
function symlinkedHome(): { physical: string; linked: string } {
  const physical = join(sb, "real-home");
  const linked = join(sb, "link-home");
  mkdirSync(join(physical, ".hayven"), { recursive: true });
  symlinkSync(physical, linked);
  return { physical, linked };
}

describe("the home guard survives a symlinked $HOME", () => {
  it("does NOT treat home as a project root when the two spellings differ", () => {
    // `homeDir` is the SYMLINK spelling (what `homedir()` returns from passwd);
    // the start dir is the PHYSICAL spelling (what `process.cwd()` gives). The
    // only marker anywhere is home's own global `.hayven`.
    const { physical, linked } = symlinkedHome();

    const got = detectRepoRoot(physical, { homeDir: linked });

    // Before the fix this returned `reason: "hayven"` with `root` = home, i.e.
    // the daemon would index the user's entire tree.
    expect(got.reason).toBe("cwd-fallback");
  });

  it("positive control: the same call with matching spellings already worked", () => {
    // Differs ONLY in which spelling of home is injected. Proves the failure
    // above came from the spelling mismatch, not from the fixture.
    const { physical } = symlinkedHome();
    expect(detectRepoRoot(physical, { homeDir: physical }).reason).toBe("cwd-fallback");
  });

  it("BL-15: the walk still stops at home when the spellings differ", () => {
    // `<sb>/.git` is ABOVE home. An in-home cwd must never resolve to it.
    const { physical, linked } = symlinkedHome();
    mkdirSync(join(sb, ".git"), { recursive: true });
    const sub = join(physical, "notes", "deep");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: linked });

    // Before the fix the containment test failed (a physical path is not a
    // prefix of the symlink spelling), no `stopAt` was installed, and the walk
    // ascended out of the user's tree and returned `<sb>` as the project root.
    expect(got.reason).toBe("cwd-fallback");
    expect(got.root).toBe(sub);
  });

  it("positive control: a real project BELOW home still resolves normally", () => {
    // The guard must not have become a blanket refusal — a repo inside home is
    // the normal case and has to keep working through the symlinked spelling.
    const { physical, linked } = symlinkedHome();
    const repo = join(physical, "work", "myrepo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "src");
    mkdirSync(sub, { recursive: true });

    const got = detectRepoRoot(sub, { homeDir: linked });
    expect(got.reason).toBe("git");
    expect(got.root).toBe(repo);
  });
});
