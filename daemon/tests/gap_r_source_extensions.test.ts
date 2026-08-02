/**
 * LANE R / R3 + R4 — the TypeScript side's idea of "a source file" must match
 * the parser's, and this lane's sources must stay greppable.
 *
 * R3. `native/src/parse/language.rs::from_extension` accepts `.mts`/`.cts`;
 * `db/freshness.ts::isSourcePath` did not. A changed `.mts` therefore read as a
 * NON-source edit: the incremental path neither purged nor re-parsed it, so its
 * symbols went silently stale with no error anywhere. Rather than assert the two
 * lists by hand (which is how they drifted apart in the first place), this test
 * READS the Rust match arms and requires every extension the parser accepts to
 * be recognised on the TypeScript side.
 *
 * R4. `graph/ingest.ts` held literal NUL bytes, so `file(1)` reported it as
 * `data` and GNU grep/ripgrep classified it as BINARY and skipped it SILENTLY —
 * two audits of that 1,000-line file (the ingest caps, the edge writes, the
 * orphan sweep) came back empty for that reason alone. The bytes are now the
 * escape `\x00`; this test keeps them that way.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deriveFenceLang } from "../src/db/context_cache.ts";
import { isSourcePath } from "../src/db/freshness.ts";
import { SpecifierResolver } from "../src/graph/specifierResolve.ts";
import type { GraphNode } from "../src/graph/types.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LANGUAGE_RS = join(REPO_ROOT, "native", "src", "parse", "language.rs");

/**
 * Every extension `Language::from_extension` accepts, read out of the Rust
 * source. Parses the match arms between `pub fn from_extension` and its closing
 * `_ => None`, collecting every quoted token on an arm that maps to `Some(...)`.
 */
function parserExtensions(): string[] {
  const src = readFileSync(LANGUAGE_RS, "utf8");
  const start = src.indexOf("pub fn from_extension");
  expect(start).toBeGreaterThan(-1); // the function was renamed — fix this test
  const end = src.indexOf("_ => None", start);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  const out = new Set<string>();
  for (const line of body.split("\n")) {
    if (!line.includes("=> Some(")) continue;
    for (const m of line.matchAll(/"([a-z0-9]+)"/g)) out.add(m[1]!);
  }
  return [...out].sort();
}

function gNode(file: string, id: string): GraphNode {
  return {
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id.split("/").pop() ?? id,
    kind: "module",
    language: "typescript",
    file,
    range: [0, 0],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  };
}

describe("R3: the source-extension list matches the parser's", () => {
  it("finds the extensions the Rust parser accepts (self-check on the fixture)", () => {
    const exts = parserExtensions();
    // If this drops below the languages we ship, the parse above broke and the
    // real assertion below would pass vacuously.
    expect(exts.length).toBeGreaterThanOrEqual(10);
    expect(exts).toContain("mts");
    expect(exts).toContain("cts");
  });

  it("isSourcePath accepts EVERY extension the parser parses", () => {
    const missing = parserExtensions().filter((ext) => !isSourcePath(`pkg/src/file.${ext}`));
    // A parser-accepted extension missing here is not a cosmetic gap: a change
    // to such a file is neither purged nor re-parsed on the incremental path.
    expect(missing).toEqual([]);
  });

  it("still rejects non-source paths (the suppression rule stays narrow)", () => {
    for (const p of ["README.md", ".gitignore", "docs/notes.txt", ".hayven/index.sqlite"]) {
      expect(isSourcePath(p)).toBe(false);
    }
  });

  it("resolves an extensionless import to an `.mts` module", () => {
    // Same drift, different consumer: the specifier prober only tried
    // `.ts/.tsx/.js/.jsx/.astro/.py/.rs/.go`, so `import "./util"` could not
    // reach a `util.mts` that IS in the graph — the edge stayed `?:util`.
    const nodes = [gNode("src/util.mts", "util"), gNode("src/app.ts", "app")];
    const resolver = new SpecifierResolver(nodes, REPO_ROOT);
    expect(resolver.resolve("src/app.ts", "./util")).toBe("util");
  });

  it("labels `.mts`/`.cts` fenced code as typescript", () => {
    expect(deriveFenceLang("src/a.mts")).toBe("typescript");
    expect(deriveFenceLang("src/a.cts")).toBe("typescript");
    expect(deriveFenceLang("src/a.ts")).toBe("typescript"); // unchanged
    expect(deriveFenceLang("src/a.tsx")).toBe("tsx"); // unchanged
  });
});

describe("R4: this lane's sources contain no literal NUL bytes", () => {
  it("keeps db/** and graph/** readable by file(1), grep and rg", () => {
    const offenders: string[] = [];
    for (const dir of [join(import.meta.dir, "..", "src", "db"), join(import.meta.dir, "..", "src", "graph")]) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".ts")) continue;
        const path = join(dir, name);
        // A raw NUL anywhere makes grep/rg treat the WHOLE file as binary and
        // skip it without a warning, which is how a 1,000-line file became
        // invisible to two separate audits. `\x00` in a string literal has the
        // identical runtime value and costs nothing.
        if (readFileSync(path).includes(0)) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
