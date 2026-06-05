// Drift guard: the Claude Code PLUGIN ships its OWN copy of the skill at
// plugin/skills/hayvenhurst/SKILL.md because a marketplace/git install cannot
// reliably follow a symlink. The CANONICAL source is skill/hayvenhurst.md (what
// `hayven init` copies and what release.yml bundles). These two MUST stay
// byte-identical, or an agent installing via the plugin gets a stale reflex.
//
// Mirrors the viewer/tests/contract.test.ts drift-guard discipline: encode the
// invariant as a test so the two copies never diverge unnoticed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// daemon/tests/ → repo root is two levels up.
const repoRoot = join(import.meta.dir, "..", "..");
const CANONICAL = join(repoRoot, "skill", "hayvenhurst.md");
const PLUGIN_COPY = join(repoRoot, "plugin", "skills", "hayvenhurst", "SKILL.md");

describe("plugin skill drift guard", () => {
  test("plugin SKILL.md is byte-identical to skill/hayvenhurst.md", () => {
    const canonical = readFileSync(CANONICAL);
    const pluginCopy = readFileSync(PLUGIN_COPY);

    const identical = canonical.equals(pluginCopy);
    expect(
      identical,
      identical
        ? "ok"
        : "plugin/skills/hayvenhurst/SKILL.md has DRIFTED from the canonical " +
          "skill/hayvenhurst.md. Re-copy it verbatim:\n\n" +
          "    cp skill/hayvenhurst.md plugin/skills/hayvenhurst/SKILL.md\n\n" +
          "skill/hayvenhurst.md is the single source of truth (it is what " +
          "`hayven init` installs and what release.yml bundles); the plugin copy " +
          "exists only because a marketplace/git install cannot follow a symlink.",
    ).toBe(true);
  });
});
