/**
 * ci/release-notes.sh builds the GitHub Release body from CHANGELOG.md. The
 * release workflow used to hard-code a stale notes file, so v0.0.8 and v0.0.9
 * both published "# Hayvenhurst v0.0.6". The script must (a) pick exactly the
 * tagged version's section, (b) tolerate CRLF checkouts, and (c) FAIL, not
 * publish empty notes, when the section is missing or empty.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "ci", "release-notes.sh");
const REAL_CHANGELOG = resolve(import.meta.dir, "..", "..", "CHANGELOG.md");
const hasBash = Bun.which("bash") !== null;

function run(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function withChangelog(text: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hayven-relnotes-"));
  try {
    const path = join(dir, "CHANGELOG.md");
    writeFileSync(path, text);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- pending change",
  "",
  "## [0.0.10] - 2026-10-20",
  "",
  "- ten A",
  "",
  "### Detail",
  "- ten B",
  "",
  "## [0.0.1]",
  "",
  "- one",
  "",
  "## [0.0.2]",
  "",
  "",
].join("\n");

describe.skipIf(!hasBash)("ci/release-notes.sh", () => {
  test("selects only the tagged version's section, with or without the v prefix", () => {
    withChangelog(SAMPLE, (path) => {
      for (const arg of ["v0.0.10", "0.0.10"]) {
        const r = run([arg, path]);
        expect(r.code).toBe(0);
        expect(r.out).toBe("- ten A\n\n### Detail\n- ten B\n");
      }
    });
  });

  test("0.0.1 does not match the 0.0.10 heading (literal, not prefix/regex)", () => {
    withChangelog(SAMPLE, (path) => {
      const r = run(["v0.0.1", path]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("- one\n");
    });
  });

  test("a CRLF changelog yields clean LF output", () => {
    withChangelog(SAMPLE.replace(/\n/g, "\r\n"), (path) => {
      const r = run(["v0.0.10", path]);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("\r");
      expect(r.out.startsWith("- ten A\n")).toBe(true);
    });
  });

  test("fails when the heading is missing", () => {
    withChangelog(SAMPLE, (path) => {
      const r = run(["v9.9.9", path]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("::error::");
    });
  });

  test("fails when the section is empty", () => {
    withChangelog(SAMPLE, (path) => {
      const r = run(["v0.0.2", path]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("no non-empty");
    });
  });

  test("[Unreleased] is not a releasable section", () => {
    withChangelog(SAMPLE, (path) => {
      expect(run(["Unreleased", path]).code).toBe(1);
      expect(run(["v0.0.10-rc", path]).code).toBe(1);
    });
  });

  test("the repo's own changelog resolves 0.0.9 to 0.0.9's notes", () => {
    const r = run(["v0.0.9", REAL_CHANGELOG]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("installers' \"file in use\"");
    expect(r.out).not.toContain("hayven doctor --json");
  });
});
