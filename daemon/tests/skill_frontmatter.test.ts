// SOT-17: SKILL.md frontmatter must be VALID YAML. `when_to_use` was a plain
// scalar containing bare ": " sequences ("...per-agent context: partition...",
// "Also: claim a scope..."), which YAML reads as a nested mapping. Claude Code
// then dropped ALL frontmatter ("loads with empty metadata") and
// `claude plugin validate plugin/` failed. Parse both shipped copies with a real
// YAML parser so that can never regress unnoticed (CI also runs the CLI).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const FILES = {
  "skill/hayvenhurst.md": join(repoRoot, "skill", "hayvenhurst.md"),
  "plugin/skills/hayvenhurst/SKILL.md": join(repoRoot, "plugin", "skills", "hayvenhurst", "SKILL.md"),
};

function frontmatter(path: string): Record<string, unknown> {
  const src = readFileSync(path, "utf8");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (m === null) throw new Error(`${path}: no frontmatter block`);
  return Bun.YAML.parse(m[1]!) as Record<string, unknown>;
}

describe("SKILL frontmatter parses as YAML (SOT-17)", () => {
  for (const [label, path] of Object.entries(FILES)) {
    test(`${label}: name/description/when_to_use are strings and nothing else leaks in`, () => {
      const fm = frontmatter(path);
      expect(Object.keys(fm).sort()).toEqual(["description", "name", "when_to_use"]);
      expect(fm["name"]).toBe("hayvenhurst");
      expect(typeof fm["description"]).toBe("string");
      expect((fm["description"] as string).length).toBeGreaterThan(40);
      const when = fm["when_to_use"];
      expect(typeof when).toBe("string");
      // The bare-colon phrases that broke the old plain scalar survive intact.
      expect(when as string).toContain("per-agent context: partition with `plan-lanes`");
      expect(when as string).toContain("Also: claim a scope before editing");
      // Folded to a single line (no stray newlines inside a value).
      expect(when as string).not.toContain("\n");
    });
  }

  test("the marketplace manifest carries a description", () => {
    const mp = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8")) as {
      description?: unknown;
    };
    expect(typeof mp.description).toBe("string");
    expect((mp.description as string).length).toBeGreaterThan(20);
  });
});
