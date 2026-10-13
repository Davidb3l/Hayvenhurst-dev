/**
 * Windows path-case identity (audit finding 4.1).
 *
 * `canonicalRoot` used `realpathSync(resolve(p))`, which on Windows echoes the
 * caller's spelling, so `c:/users/me/repo` and `C:\Users\Me\Repo` registered as
 * TWO projects and were both served: two writers on one `.hayven/index.sqlite`
 * WAL. The fix is `realpathSync.native` (on-disk casing) plus a case-folding
 * comparison key (`rootKey`/`sameRoot`) for roots that do not exist yet.
 *
 * The win32-only blocks run only on Windows; the platform-parameterised cases
 * run everywhere so Linux CI still pins the case-SENSITIVE POSIX behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readRegistryRaw, registerProject, sameProjectRoot } from "../src/daemon/registry.ts";
import { canonicalRoot, rootKey, sameRoot } from "../src/util/paths.ts";
import { overlayId } from "../src/worktree/registry.ts";

const isWin = process.platform === "win32";
const winIt = isWin ? it : it.skip;

describe("rootKey / sameRoot (platform-parameterised)", () => {
  it("folds case on win32 and not on POSIX, for paths that do not exist", () => {
    const a = isWin ? "C:\\Nope\\Repo" : "/nope/Repo";
    const b = isWin ? "c:\\nope\\repo" : "/nope/repo";
    expect(sameRoot(a, b, "win32")).toBe(true);
    expect(rootKey(a, "win32")).toBe(rootKey(b, "win32"));
    expect(sameRoot(a, b, "linux")).toBe(false);
    expect(sameRoot(a, b, "darwin")).toBe(false);
  });

  it("is reflexive and trailing-slash insensitive", () => {
    const p = join(tmpdir(), "hayven-case-nonexistent");
    expect(sameRoot(p, p)).toBe(true);
    expect(sameRoot(p, p + (isWin ? "\\" : "/"))).toBe(true);
  });
});

describe("Windows path-case duplicate registration", () => {
  let home: string;
  let proj: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env["HAYVEN_HOME"];
    home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-case-home-")));
    process.env["HAYVEN_HOME"] = home;
    mkdirSync(join(home, ".hayven"), { recursive: true });
    proj = realpathSync(mkdtempSync(join(tmpdir(), "hayven-case-Proj-")));
    mkdirSync(join(proj, ".hayven"), { recursive: true });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env["HAYVEN_HOME"];
    else process.env["HAYVEN_HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  winIt("canonicalRoot returns the on-disk casing for any spelling of an existing root", () => {
    const lower = proj.toLowerCase().replace(/\\/g, "/");
    const upper = proj.toUpperCase();
    expect(canonicalRoot(lower)).toBe(proj);
    expect(canonicalRoot(upper)).toBe(proj);
    expect(canonicalRoot(proj)).toBe(proj);
  });

  winIt("sameProjectRoot treats c:/users/... and C:\\Users\\... as one project", () => {
    expect(sameProjectRoot(proj.toLowerCase().replace(/\\/g, "/"), proj)).toBe(true);
    expect(sameProjectRoot(proj.toUpperCase(), proj)).toBe(true);
  });

  winIt("registerProject dedupes differently-cased spellings into ONE entry", () => {
    const first = registerProject(proj);
    const second = registerProject(proj.toLowerCase().replace(/\\/g, "/"));
    const third = registerProject(proj.toUpperCase());
    expect(second.alias).toBe(first.alias);
    expect(third.alias).toBe(first.alias);
    expect(readRegistryRaw().length).toBe(1);
  });

  winIt("overlayId is stable across spellings (hashed on the case-folded canonical root)", () => {
    expect(overlayId(proj.toUpperCase())).toBe(overlayId(proj));
    expect(overlayId(proj.toLowerCase().replace(/\\/g, "/"))).toBe(overlayId(proj));
  });

  it("registerProject still dedupes trailing-slash spellings on every platform", () => {
    const first = registerProject(proj);
    const second = registerProject(proj + (isWin ? "\\" : "/"));
    expect(second.alias).toBe(first.alias);
    expect(readRegistryRaw().length).toBe(1);
  });
});
