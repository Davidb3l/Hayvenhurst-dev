// Guards the two new pure pieces of the "agent reflex" on-ramp:
//   - resolveSkillSource(): where `hayven init` finds the skill SOURCE to copy.
//   - ensureReflexBlock(): the idempotent CLAUDE.md/AGENTS.md ambient reflex.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, sep } from "node:path";

import { resolveSkillSource } from "../src/util/paths.ts";
import { ensureReflexBlock } from "../src/cli/init.ts";

const SENTINEL = "<!-- hayvenhurst:reflex -->";

describe("resolveSkillSource", () => {
  const prev = process.env["HAYVEN_SKILL_SRC"];
  afterEach(() => {
    if (prev === undefined) delete process.env["HAYVEN_SKILL_SRC"];
    else process.env["HAYVEN_SKILL_SRC"] = prev;
  });

  test("returns the $HAYVEN_SKILL_SRC override (resolved absolute)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "hayven-skillsrc-"));
    const custom = join(tmp, "my-skill.md");
    writeFileSync(custom, "# custom");
    process.env["HAYVEN_SKILL_SRC"] = custom;
    expect(resolveSkillSource()).toBe(custom);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("resolves the real <checkout>/skill/hayvenhurst.md in source mode", () => {
    delete process.env["HAYVEN_SKILL_SRC"];
    const got = resolveSkillSource();
    expect(isAbsolute(got)).toBe(true);
    // In dev (bun src), process.execPath is `bun` so step 2 is skipped and the
    // import.meta.dir walk finds the real checkout skill — which exists.
    expect(got.endsWith(`${sep}skill${sep}hayvenhurst.md`)).toBe(true);
    expect(existsSync(got)).toBe(true);
  });
});

describe("ensureReflexBlock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hayven-reflex-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates the file with the reflex block when it does not exist", () => {
    const f = join(dir, "AGENTS.md");
    expect(existsSync(f)).toBe(false);
    expect(ensureReflexBlock(f)).toBe(true);
    const body = readFileSync(f, "utf8");
    expect(body).toContain(SENTINEL);
    expect(body).toContain("prefer `hayven` over grep");
    expect(body).toContain("<!-- /hayvenhurst:reflex -->");
  });

  test("appends to an existing file, preserving prior content", () => {
    const f = join(dir, "CLAUDE.md");
    writeFileSync(f, "# My project\n\nSome existing notes.\n");
    expect(ensureReflexBlock(f)).toBe(true);
    const body = readFileSync(f, "utf8");
    expect(body).toContain("Some existing notes.");
    expect(body).toContain(SENTINEL);
  });

  test("is idempotent — a second call adds nothing (single block)", () => {
    const f = join(dir, "AGENTS.md");
    expect(ensureReflexBlock(f)).toBe(true);
    const after1 = readFileSync(f, "utf8");
    expect(ensureReflexBlock(f)).toBe(false);
    const after2 = readFileSync(f, "utf8");
    expect(after2).toBe(after1); // byte-identical, no re-append
    // exactly one sentinel occurrence
    expect(after2.split(SENTINEL).length - 1).toBe(1);
  });

  test("never throws on an unwritable path (returns false)", () => {
    // A path whose parent is a regular file cannot be written/created.
    const blocker = join(dir, "afile");
    writeFileSync(blocker, "x");
    const bad = join(blocker, "AGENTS.md"); // parent is a file, not a dir
    expect(() => ensureReflexBlock(bad)).not.toThrow();
    expect(ensureReflexBlock(bad)).toBe(false);
  });
});
