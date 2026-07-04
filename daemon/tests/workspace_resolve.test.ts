/**
 * Workspace (monorepo) resolution tests — the two measured astro P0/P1s:
 *
 *   1. bare workspace specifiers (`astro/config`, `@astrojs/mdx`) must resolve
 *      to IN-REPO package sources (was 0/1,348 on withastro/astro);
 *   2. name-match must be scoped WITHIN a package, with cross-package hits
 *      requiring an import-edge witness (kills the measured `defineConfig`
 *      false positive: `playwright.config.js` importing from
 *      `@playwright/test` was attributed to astro's `defineConfig`).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEdges } from "../src/graph/ingest.ts";
import { SpecifierResolver } from "../src/graph/specifierResolve.ts";
import type { GraphNode, RawEdge } from "../src/graph/types.ts";
import { parsePnpmWorkspacePackages, WorkspaceMap } from "../src/graph/workspace.ts";

/** Build a `kind:"module"` node with a given repo-rel file and entity id. */
function mod(file: string, id: string): GraphNode {
  return {
    id,
    name: id.split("/").pop()!,
    qualified_name: id.split("/").pop()!,
    kind: "module",
    language: "typescript",
    file,
    range: [1, 1],
    ast_hash: `mod-${file}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

/** Build a non-module entity node. */
function entity(file: string, id: string, name: string): GraphNode {
  return {
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    file,
    range: [1, 5],
    ast_hash: `e-${id}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

/**
 * Lay out a miniature pnpm workspace on disk:
 *   packages/astro     (name `astro`,        exports "." → ./dist/index.js,
 *                       "./config" → ./dist/config.js — dist-built, source in src/)
 *   packages/mdx       (name `@astrojs/mdx`, main ./dist/index.js)
 *   packages/helpers   (name `@astrojs/internal-helpers`, exports "./path" → ./dist/path.js)
 */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-ws-"));
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n  - '!**/test/**' # negations ignored\n",
  );
  const pkg = (dir: string, json: Record<string, unknown>): void => {
    mkdirSync(join(root, dir, "src"), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(json));
  };
  pkg("packages/astro", {
    name: "astro",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./config": "./dist/config.js",
      "./runtime/*": "./dist/runtime/*",
    },
  });
  pkg("packages/mdx", { name: "@astrojs/mdx", main: "./dist/index.js" });
  pkg("packages/helpers", {
    name: "@astrojs/internal-helpers",
    exports: { "./path": "./dist/path.js" },
  });
  return root;
}

describe("parsePnpmWorkspacePackages", () => {
  it("reads the packages block list, stripping quotes and negations", () => {
    const yaml = [
      "# comment",
      "packages:",
      "  - 'packages/*'",
      '  - "packages/integrations/*"',
      "  - packages/markdown/*   # trailing comment",
      "  - '!**/fixtures/**'",
      "",
      "onlyBuiltDependencies:",
      "  - esbuild",
    ].join("\n");
    expect(parsePnpmWorkspacePackages(yaml)).toEqual([
      "packages/*",
      "packages/integrations/*",
      "packages/markdown/*",
    ]);
  });

  it("returns [] when there is no packages key", () => {
    expect(parsePnpmWorkspacePackages("foo:\n  - bar\n")).toEqual([]);
  });
});

describe("WorkspaceMap", () => {
  const root = makeWorkspace();
  const ws = WorkspaceMap.load(root);

  it("discovers every named package under the glob", () => {
    expect(ws.size).toBe(3);
    expect([...ws.packages.keys()].sort()).toEqual([
      "@astrojs/internal-helpers",
      "@astrojs/mdx",
      "astro",
    ]);
  });

  it("degrades to an empty map for a non-workspace repo / unset root", () => {
    expect(WorkspaceMap.load("").size).toBe(0);
    expect(WorkspaceMap.load(mkdtempSync(join(tmpdir(), "hayven-nows-"))).size).toBe(0);
  });

  it("packageForFile: longest-prefix match, '' outside every package", () => {
    expect(ws.packageForFile("packages/astro/src/core/index.ts")).toBe("packages/astro");
    expect(ws.packageForFile("packages/mdx/src/index.ts")).toBe("packages/mdx");
    expect(ws.packageForFile("benchmark/bench.js")).toBe("");
  });

  it("candidatePaths: root entry — exports + dist→src swap + conventional probes", () => {
    const c = ws.candidatePaths("astro");
    expect(c).toContain("packages/astro/dist/index.js"); // literal exports target
    expect(c).toContain("packages/astro/src/index.js"); // dist→src swap (built → source)
    expect(c).toContain("packages/astro/src/index"); // conventional fallback
  });

  it("candidatePaths: subpath via exact exports key", () => {
    const c = ws.candidatePaths("astro/config");
    expect(c).toContain("packages/astro/src/config.js");
    expect(c).toContain("packages/astro/src/config"); // conventional fallback
  });

  it("candidatePaths: subpath via wildcard exports key", () => {
    const c = ws.candidatePaths("astro/runtime/server");
    expect(c).toContain("packages/astro/src/runtime/server");
  });

  it("candidatePaths: scoped package name + main field", () => {
    const c = ws.candidatePaths("@astrojs/mdx");
    expect(c).toContain("packages/mdx/src/index.js");
    expect(c).toContain("packages/mdx/src/index");
  });

  it("candidatePaths: [] for an unknown/external bare specifier", () => {
    expect(ws.candidatePaths("preact")).toEqual([]);
    expect(ws.candidatePaths("@playwright/test")).toEqual([]);
  });
});

describe("SpecifierResolver — workspace bare specifiers", () => {
  const root = makeWorkspace();
  const nodes: GraphNode[] = [
    mod("packages/astro/src/index.ts", "packages/astro/index"),
    mod("packages/astro/src/config.ts", "packages/astro/config"),
    mod("packages/mdx/src/index.ts", "packages/mdx/index"),
    mod("packages/helpers/src/path.ts", "packages/helpers/path"),
    mod("packages/astro/src/pages/consumer.ts", "packages/astro/pages/consumer"),
  ];
  const r = new SpecifierResolver(nodes, root);

  it("resolves a bare package name to its in-repo entry module", () => {
    expect(r.resolve("packages/mdx/src/index.ts", "astro")).toBe("packages/astro/index");
    expect(r.resolve("packages/astro/src/index.ts", "@astrojs/mdx")).toBe("packages/mdx/index");
  });

  it("resolves a package subpath (dist-built exports target → src source)", () => {
    expect(r.resolve("anything.ts", "astro/config")).toBe("packages/astro/config");
    expect(r.resolve("anything.ts", "@astrojs/internal-helpers/path")).toBe(
      "packages/helpers/path",
    );
  });

  it("leaves genuinely-external bare specifiers unresolved", () => {
    expect(r.resolve("packages/astro/src/index.ts", "preact")).toBeNull();
    expect(r.resolve("packages/astro/src/index.ts", "@playwright/test")).toBeNull();
    // Virtual modules (`astro:content`) are generated, not source — unresolved.
    expect(r.resolve("packages/astro/src/index.ts", "astro:content")).toBeNull();
  });
});

describe("resolveEdges — package-scoped name-match + import witness", () => {
  const root = makeWorkspace();

  it("kills the external-import false positive (the measured defineConfig case)", () => {
    // `playwright.config.js` imports defineConfig from @playwright/test
    // (EXTERNAL) and calls it. astro defines its own defineConfig in-repo.
    // The old global name-match attributed the call to astro's defineConfig.
    const nodes: GraphNode[] = [
      mod("packages/astro/playwright.config.js", "packages/astro/playwright.config"),
      entity("packages/astro/src/config.ts", "packages/astro/config/defineConfig", "defineConfig"),
    ];
    const raw: RawEdge[] = [
      {
        src_file: "packages/astro/playwright.config.js",
        src_name: "playwright.config",
        dst_name: "@playwright/test",
        kind: "import",
        local: ["defineConfig"],
      },
      {
        src_file: "packages/astro/playwright.config.js",
        src_name: "playwright.config",
        dst_name: "defineConfig",
        kind: "static_call",
      },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw, { repoRoot: root });
    const call = resolved.find((e) => e.kind === "static_call");
    expect(call).toBeUndefined(); // NOT attributed to astro's defineConfig
    expect(unresolved.some((e) => e.dst === "?:defineConfig")).toBe(true);
  });

  it("never resolves cross-package by bare name (no import witness)", () => {
    // `transform` is defined ONLY in mdx; a helpers file calls a local
    // (unindexed) `transform` without importing it. Old behavior: global
    // unique-name match invented helpers→mdx. New behavior: unresolved.
    const nodes: GraphNode[] = [
      mod("packages/helpers/src/path.ts", "packages/helpers/path"),
      entity("packages/mdx/src/index.ts", "packages/mdx/index/transform", "transform"),
    ];
    const raw: RawEdge[] = [
      {
        src_file: "packages/helpers/src/path.ts",
        src_name: "path",
        dst_name: "transform",
        kind: "static_call",
      },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw, { repoRoot: root });
    expect(resolved.filter((e) => e.kind === "static_call")).toHaveLength(0);
    expect(unresolved.some((e) => e.dst === "?:transform")).toBe(true);
  });

  it("resolves cross-package WITH an import witness, through the workspace map", () => {
    // mdx imports appendForwardSlash from @astrojs/internal-helpers/path and
    // calls it — the measured astro false NEGATIVE (6 same-named nodes made
    // the global index bail). The import witness + workspace map pin it.
    const nodes: GraphNode[] = [
      mod("packages/mdx/src/index.ts", "packages/mdx/index"),
      mod("packages/helpers/src/path.ts", "packages/helpers/path"),
      entity(
        "packages/helpers/src/path.ts",
        "packages/helpers/path/appendForwardSlash",
        "appendForwardSlash",
      ),
      // A same-named duplicate in ANOTHER package (would poison a global index
      // into AMBIGUOUS — must not matter under package scoping).
      entity(
        "packages/astro/src/path.ts",
        "packages/astro/path/appendForwardSlash",
        "appendForwardSlash",
      ),
    ];
    const raw: RawEdge[] = [
      {
        src_file: "packages/mdx/src/index.ts",
        src_name: "index",
        dst_name: "@astrojs/internal-helpers/path",
        kind: "import",
        local: ["appendForwardSlash"],
      },
      {
        src_file: "packages/mdx/src/index.ts",
        src_name: "index",
        dst_name: "appendForwardSlash",
        kind: "static_call",
      },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: root });
    const call = resolved.find((e) => e.kind === "static_call");
    expect(call?.dst).toBe("packages/helpers/path/appendForwardSlash");
    const imp = resolved.find((e) => e.kind === "import");
    expect(imp?.dst).toBe("packages/helpers/path");
  });

  it("import-witnessed BARREL fallback: symbol deeper than <module>/<name> resolves within the target package", () => {
    // astro/config's entry module re-exports defineConfig from core — the
    // direct `<module>/<name>` id misses, but the witness licenses a
    // name-match scoped to the astro package (unique there).
    const nodes: GraphNode[] = [
      mod("packages/mdx/src/consumer.ts", "packages/mdx/consumer"),
      mod("packages/astro/src/config.ts", "packages/astro/config"),
      entity(
        "packages/astro/src/core/config/index.ts",
        "packages/astro/core/config/index/defineConfig",
        "defineConfig",
      ),
    ];
    const raw: RawEdge[] = [
      {
        src_file: "packages/mdx/src/consumer.ts",
        src_name: "consumer",
        dst_name: "astro/config",
        kind: "import",
        local: ["defineConfig"],
      },
      {
        src_file: "packages/mdx/src/consumer.ts",
        src_name: "consumer",
        dst_name: "defineConfig",
        kind: "static_call",
      },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: root });
    const call = resolved.find((e) => e.kind === "static_call");
    expect(call?.dst).toBe("packages/astro/core/config/index/defineConfig");
  });

  it("same-name-per-package: each package's callers resolve to THEIR OWN symbol", () => {
    // `nft` helper duplicated in vercel and netlify (the astro collision pair).
    // Under global indexing the name went AMBIGUOUS and neither resolved.
    const nodes: GraphNode[] = [
      mod("packages/astro/src/a.ts", "packages/astro/a"),
      mod("packages/mdx/src/b.ts", "packages/mdx/b"),
      entity("packages/astro/src/nft.ts", "packages/astro/nft/copyDeps", "copyDeps"),
      entity("packages/mdx/src/nft.ts", "packages/mdx/nft/copyDeps", "copyDeps"),
    ];
    const raw: RawEdge[] = [
      { src_file: "packages/astro/src/a.ts", src_name: "a", dst_name: "copyDeps", kind: "static_call" },
      { src_file: "packages/mdx/src/b.ts", src_name: "b", dst_name: "copyDeps", kind: "static_call" },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: root });
    const dsts = resolved.filter((e) => e.kind === "static_call").map((e) => e.dst).sort();
    expect(dsts).toEqual(["packages/astro/nft/copyDeps", "packages/mdx/nft/copyDeps"]);
  });

  it("non-workspace repos keep the old global-unique-name behavior", () => {
    // No workspace manifests → one implicit package → cross-file unique-name
    // resolution still works exactly as before (single-repo regression guard).
    const nows = mkdtempSync(join(tmpdir(), "hayven-nows2-"));
    const nodes: GraphNode[] = [
      mod("src/a.ts", "a"),
      entity("src/b.ts", "b/helper", "helper"),
    ];
    const raw: RawEdge[] = [
      { src_file: "src/a.ts", src_name: "a", dst_name: "helper", kind: "static_call" },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: nows });
    expect(resolved.find((e) => e.kind === "static_call")?.dst).toBe("b/helper");
  });
});
