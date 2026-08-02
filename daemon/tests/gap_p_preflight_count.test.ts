/**
 * P2 — the init ceiling and the ingest cap must be expressed in the SAME units.
 *
 * `DEFAULT_MAX_INIT_FILES` (cli/init.ts) counted every non-hidden file of ANY
 * extension and ignored `.gitignore`. `DEFAULT_MAX_INGEST_FILES` (graph/ingest.ts)
 * caps the native walker's `files_total`, which is language-mapped and
 * post-gitignore. Measured on one tree the two numbers were 401 and 1, so
 * "50,000 vs 200,000" was not a 4x margin, it was an unrelated number — and the
 * init ceiling could refuse a normal repo purely for a large ignored
 * `coverage/`, `out/`, `.output/` or `data/` dir outside the hard skip list.
 *
 * These tests pin the POPULATION being counted, which is the thing that was
 * wrong. They are deliberately fixture-driven rather than asserting a constant.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileIgnorePattern, countIndexableFiles, INDEXABLE_EXTENSIONS } from "../src/util/paths.ts";

let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapp-count-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

/** Write `file` (creating parents) with trivial contents. */
function put(root: string, rel: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "x\n");
}

describe("countIndexableFiles counts what the INGEST counts", () => {
  it("ignores files the parser has no language for", () => {
    const root = join(home, "langs");
    mkdirSync(root, { recursive: true });
    // Parsed.
    put(root, "src/a.ts");
    put(root, "src/b.py");
    put(root, "src/c.rs");
    put(root, "src/d.go");
    put(root, "src/e.tsx");
    put(root, "src/f.astro");
    // NOT parsed — `Language::from_extension` returns None for every one.
    for (const noise of [
      "README.md",
      "package.json",
      "bun.lock",
      "Cargo.toml",
      "logo.png",
      "notes.txt",
      "data.csv",
      "Makefile", // no extension at all
      "archive.tar.gz",
    ]) {
      put(root, noise);
    }

    expect(countIndexableFiles(root, 1000)).toEqual({ count: 6, exceeded: false, exact: true });
  });

  it("matches the extension list the native parser actually maps", () => {
    // A drift tripwire. If `language.rs` gains a language and this set does
    // not, the counter UNDER-counts — the direction that lets a huge tree
    // through the ceiling.
    expect([...INDEXABLE_EXTENSIONS].sort()).toEqual(
      ["astro", "cjs", "cts", "go", "js", "jsx", "mjs", "mts", "py", "rs", "ts", "tsx"].sort(),
    );
  });

  it("THE FALSE REFUSAL: a large .gitignore'd dir outside the skip list is not counted", () => {
    // `coverage/` is the named example: it is not in ALWAYS_SKIP_DIRS, it is
    // gitignored in essentially every JS repo, and it is full of `.js`. Before
    // the fix this repo counted 121 against an ingest that would see 1.
    const root = join(home, "falserefusal");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "coverage/\nout/\n.output/\ndata/\n");
    put(root, "src/only-real-file.ts");
    for (let i = 0; i < 30; i++) put(root, `coverage/lcov-report/f${i}.js`);
    for (let i = 0; i < 30; i++) put(root, `out/chunk${i}.js`);
    for (let i = 0; i < 30; i++) put(root, `.output/server/n${i}.mjs`);
    for (let i = 0; i < 30; i++) put(root, `data/gen${i}.py`);

    expect(countIndexableFiles(root, 1000)).toEqual({ count: 1, exceeded: false, exact: true });
  });

  it("positive control: the SAME 121 files are counted when nothing ignores them", () => {
    // Identical fixture minus the `.gitignore`. Proves the drop above came from
    // the ignore rules and not from the skip list, the extension filter, or a
    // fixture that never got written.
    const root = join(home, "noignore");
    mkdirSync(root, { recursive: true });
    put(root, "src/only-real-file.ts");
    for (let i = 0; i < 30; i++) put(root, `coverage/lcov-report/f${i}.js`);
    for (let i = 0; i < 30; i++) put(root, `out/chunk${i}.js`);
    for (let i = 0; i < 30; i++) put(root, `.output/server/n${i}.mjs`);
    for (let i = 0; i < 30; i++) put(root, `data/gen${i}.py`);

    // `.output/` is a HIDDEN dir, skipped by the walker's `hidden(true)` in
    // both cases — so the control is 91, not 121.
    expect(countIndexableFiles(root, 1000)).toEqual({ count: 91, exceeded: false, exact: true });
  });

  it("honours .ignore and .git/info/exclude, not just .gitignore", () => {
    const root = join(home, "otherignores");
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".ignore"), "generated/\n");
    writeFileSync(join(root, ".git", "info", "exclude"), "scratch/\n");
    put(root, "src/a.ts");
    put(root, "generated/g.ts");
    put(root, "scratch/s.ts");

    expect(countIndexableFiles(root, 1000).count).toBe(1);
  });

  it("a nested .gitignore overrides its parent, including re-inclusion", () => {
    const root = join(home, "nested");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "*.gen.ts\n");
    put(root, "src/a.gen.ts"); // ignored by the root rule
    put(root, "src/b.ts");
    mkdirSync(join(root, "keep"), { recursive: true });
    writeFileSync(join(root, "keep", ".gitignore"), "!*.gen.ts\n");
    put(root, "keep/c.gen.ts"); // re-included by the deeper rule

    expect(countIndexableFiles(root, 1000).count).toBe(2);
  });

  it("prunes the fixture/example/benchmark dirs the walker prunes by default", () => {
    const root = join(home, "fixtures");
    mkdirSync(root, { recursive: true });
    put(root, "src/a.ts");
    put(root, "examples/demo/app.ts");
    put(root, "benchmark/bench.ts");
    put(root, "benchmarks/other.ts");
    put(root, "pkg/test/fixtures/app/index.ts");
    put(root, "pkg/test/functions/fixtures/nested/index.ts"); // the netlify shape
    // A first-party `src/fixtures/` has NO test-dir ancestor and stays counted.
    put(root, "src/fixtures/data.ts");

    expect(countIndexableFiles(root, 1000).count).toBe(2);
  });
});

describe("the ignore matcher", () => {
  const matches = (pattern: string, rel: string, isDir = false): boolean => {
    const rule = compileIgnorePattern(pattern);
    if (rule === null) return false;
    if (rule.dirOnly && !isDir) return false;
    return rule.re.test(rel);
  };

  it("handles the forms real .gitignore files use", () => {
    expect(matches("build/", "build", true)).toBe(true);
    expect(matches("build/", "build")).toBe(false); // dir-only
    expect(matches("build/", "src/build", true)).toBe(true); // unanchored
    expect(matches("/build", "build", true)).toBe(true);
    expect(matches("/build", "src/build", true)).toBe(false); // anchored
    expect(matches("*.log", "a/b/c.log")).toBe(true);
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false); // `*` stops at `/`
    expect(matches("src/**/a.ts", "src/deep/deeper/a.ts")).toBe(true);
    expect(matches("src/**/a.ts", "src/a.ts")).toBe(true); // `**/` is zero-or-more
    expect(matches("dist/**", "dist/x/y.js")).toBe(true);
    expect(matches("f?.ts", "f1.ts")).toBe(true);
    expect(matches("f[0-9].ts", "f7.ts")).toBe(true);
    expect(matches("f[!0-9].ts", "f7.ts")).toBe(false);
  });

  it("skips comments and blanks, and reads `!` as negation", () => {
    expect(compileIgnorePattern("")).toBeNull();
    expect(compileIgnorePattern("# a comment")).toBeNull();
    expect(compileIgnorePattern("   ")).toBeNull();
    expect(compileIgnorePattern("!keep.ts")?.negated).toBe(true);
    expect(compileIgnorePattern("keep.ts")?.negated).toBe(false);
    // `\#` is a literal `#`, not a comment.
    expect(compileIgnorePattern("\\#literal")?.re.test("#literal")).toBe(true);
  });
});
