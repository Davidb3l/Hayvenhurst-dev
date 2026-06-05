// `hayven init` keeps its generated artifacts (.hayven/ index + .claude/skills/
// installed skill) out of the user's commits by managing the project .gitignore.
// Guards the idempotent ensure-entries helper.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGitignoreEntries } from "../src/cli/init.ts";

const ENTRIES = [".hayven/", ".claude/skills/"];

describe("ensureGitignoreEntries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hayven-gitignore-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates .gitignore with the entries in a git repo that has none", () => {
    mkdirSync(join(dir, ".git"));
    const added = ensureGitignoreEntries(dir, ENTRIES);
    expect(added).toEqual(ENTRIES);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(".hayven/");
    expect(gi).toContain(".claude/skills/");
    expect(gi.startsWith("\n")).toBe(false); // no leading blank line when creating
  });

  test("appends only the missing entries to an existing .gitignore", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.hayven/\n");
    const added = ensureGitignoreEntries(dir, ENTRIES);
    expect(added).toEqual([".claude/skills/"]); // .hayven/ already present
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    // exactly one .hayven/ line (no duplicate)
    expect(gi.split(/\r?\n/).filter((l) => l.trim() === ".hayven/")).toHaveLength(1);
    expect(gi).toContain(".claude/skills/");
    expect(gi).toContain("node_modules/");
  });

  test("is idempotent — a second call adds nothing", () => {
    writeFileSync(join(dir, ".gitignore"), "");
    ensureGitignoreEntries(dir, ENTRIES);
    const added2 = ensureGitignoreEntries(dir, ENTRIES);
    expect(added2).toEqual([]);
  });

  test("does not create a spurious .gitignore in a non-git tree", () => {
    // no .git and no existing .gitignore
    const added = ensureGitignoreEntries(dir, ENTRIES);
    expect(added).toEqual([]);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});
