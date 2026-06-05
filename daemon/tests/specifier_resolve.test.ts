import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveEdges } from "../src/graph/ingest.ts";
import { SpecifierResolver } from "../src/graph/specifierResolve.ts";
import type { GraphNode, RawEdge } from "../src/graph/types.ts";

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
function entity(file: string, id: string, name: string, kind: GraphNode["kind"] = "function"): GraphNode {
  return {
    id,
    name,
    qualified_name: name,
    kind,
    language: "typescript",
    file,
    range: [1, 5],
    ast_hash: `e-${id}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

describe("SpecifierResolver — relative + extensionless", () => {
  // Mirror the real daemon graph module layout.
  const nodes: GraphNode[] = [
    mod("daemon/src/graph/ingest.ts", "graph/ingest"),
    mod("daemon/src/graph/idScheme.ts", "graph/idScheme"),
    mod("daemon/src/graph/types.ts", "graph/types"),
    mod("daemon/src/db/queries.ts", "db/queries"),
    mod("daemon/src/native/process.ts", "native/process"),
    mod("daemon/src/util/log.ts", "util/log"),
    mod("daemon/src/models/registry.ts", "models/registry"),
    // A directory-index module.
    mod("daemon/src/widgets/index.ts", "widgets/index"),
  ];
  const r = new SpecifierResolver(nodes, "");

  it("resolves a same-dir relative import (extensionless)", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "./idScheme")).toBe("graph/idScheme");
    expect(r.resolve("daemon/src/graph/ingest.ts", "./types")).toBe("graph/types");
  });

  it("resolves a same-dir relative import WITH an explicit extension", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "./types.ts")).toBe("graph/types");
  });

  it("resolves parent-dir relative imports (`../x`)", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "../db/queries.ts")).toBe("db/queries");
    expect(r.resolve("daemon/src/graph/ingest.ts", "../native/process.ts")).toBe("native/process");
    expect(r.resolve("daemon/src/graph/ingest.ts", "../util/log.ts")).toBe("util/log");
  });

  it("resolves `../models/registry.ts` to the registry module id", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "../models/registry.ts")).toBe("models/registry");
  });

  it("resolves a directory import to `<dir>/index.*`", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "../widgets")).toBe("widgets/index");
  });

  it("resolves a `.js` specifier to a `.ts` source", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "./idScheme.js")).toBe("graph/idScheme");
  });

  it("leaves a bare/external specifier UNRESOLVED", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "preact")).toBeNull();
    expect(r.resolve("daemon/src/graph/ingest.ts", "node:fs")).toBeNull();
    expect(r.resolve("daemon/src/graph/ingest.ts", "@noble/hashes/blake3")).toBeNull();
  });

  it("leaves a relative path with no matching module UNRESOLVED", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "./does-not-exist")).toBeNull();
  });

  it("does not resolve a `~/` alias without a tsconfig (no repoRoot)", () => {
    expect(r.resolve("daemon/src/graph/ingest.ts", "~/api/client")).toBeNull();
  });

  it("falls back to a file-stem-derived module id when a file has NO `module` node", () => {
    // `useQuery.ts` is parsed as a top-level `function` (arrow-const default
    // export) with id `components/useQuery` and NO synthetic `module` node — yet
    // `./useQuery` should still resolve to that real entity id.
    const noModuleNodes: GraphNode[] = [
      mod("viewer/src/components/SearchResults.tsx", "components/SearchResults"),
      entity("viewer/src/components/useQuery.ts", "components/useQuery", "useQuery"),
      // A sibling entity in the same file (must not perturb the derived mapping).
      entity("viewer/src/components/useQuery.ts", "components/useQuery/sub", "sub"),
    ];
    const rr = new SpecifierResolver(noModuleNodes, "");
    expect(rr.resolve("viewer/src/components/SearchResults.tsx", "./useQuery")).toBe("components/useQuery");
  });

  it("does NOT invent a target for a module-less file with no matching id", () => {
    // File has only deeply-nested entity ids; no node equals the derived
    // `<scope>/<stem>` id, so we must not fabricate a dangling target.
    const nodes2: GraphNode[] = [
      mod("daemon/src/a/caller.ts", "a/caller"),
      entity("daemon/src/a/other.ts", "a/other/onlyDeep", "onlyDeep"),
    ];
    const rr = new SpecifierResolver(nodes2, "");
    expect(rr.resolve("daemon/src/a/caller.ts", "./other")).toBeNull();
  });
});

describe("SpecifierResolver — tsconfig alias (`~/*` → `src/*`)", () => {
  it("expands a `~/` alias via the nearest tsconfig baseUrl+paths", () => {
    // Real on-disk tsconfig so the nearest-tsconfig walk + JSONC parse run.
    const root = mkdtempSync(join(tmpdir(), "hayven-alias-"));
    mkdirSync(join(root, "viewer", "src", "api"), { recursive: true });
    mkdirSync(join(root, "viewer", "src", "components"), { recursive: true });
    writeFileSync(
      join(root, "viewer", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } },
      }),
    );

    const nodes: GraphNode[] = [
      mod("viewer/src/api/client.ts", "api/client"),
      mod("viewer/src/components/useQuery.tsx", "components/useQuery"),
      mod("viewer/src/components/SearchResults.tsx", "components/SearchResults"),
    ];
    const r = new SpecifierResolver(nodes, root);

    // `~/api/client` from a viewer src file → `api/client`.
    expect(r.resolve("viewer/src/components/SearchResults.tsx", "~/api/client")).toBe("api/client");
    // `./useQuery` (relative, .tsx extension probe) → `components/useQuery`.
    expect(r.resolve("viewer/src/components/SearchResults.tsx", "./useQuery")).toBe("components/useQuery");
    // A bare import is still external.
    expect(r.resolve("viewer/src/components/SearchResults.tsx", "preact")).toBeNull();
  });

  it("tolerates JSONC comments + trailing commas in tsconfig", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-jsonc-"));
    mkdirSync(join(root, "src", "api"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      `{
        // app config
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "~/*": ["src/*"], }, /* trailing comma + block comment */
        },
      }`,
    );
    const nodes: GraphNode[] = [mod("src/api/client.ts", "api/client")];
    const r = new SpecifierResolver(nodes, root);
    expect(r.resolve("src/components/x.ts", "~/api/client")).toBe("api/client");
  });
});

describe("resolveEdges — import specifier resolution (Tier-1)", () => {
  const nodes: GraphNode[] = [
    mod("daemon/src/graph/ingest.ts", "graph/ingest"),
    mod("daemon/src/graph/idScheme.ts", "graph/idScheme"),
    mod("daemon/src/graph/types.ts", "graph/types"),
    mod("daemon/src/db/queries.ts", "db/queries"),
  ];

  it("resolves relative import edges to their module ids; leaves bare external `?:`", () => {
    const raw: RawEdge[] = [
      { src_file: "daemon/src/graph/ingest.ts", src_name: "ingest", dst_name: "./idScheme.ts", kind: "import" },
      { src_file: "daemon/src/graph/ingest.ts", src_name: "ingest", dst_name: "./types.ts", kind: "import" },
      { src_file: "daemon/src/graph/ingest.ts", src_name: "ingest", dst_name: "../db/queries.ts", kind: "import" },
      { src_file: "daemon/src/graph/ingest.ts", src_name: "ingest", dst_name: "@noble/hashes/blake3", kind: "import" },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw);
    const dsts = resolved.map((e) => e.dst).sort();
    expect(dsts).toEqual(["db/queries", "graph/idScheme", "graph/types"]);
    // The bare import stays unresolved with its raw specifier.
    expect(unresolved.map((e) => e.dst)).toEqual(["?:@noble/hashes/blake3"]);
  });

  it("does not affect a non-import edge that resolves by name", () => {
    const callerNodes: GraphNode[] = [
      ...nodes,
      entity("daemon/src/graph/ingest.ts", "graph/ingest/runIngest", "runIngest"),
      entity("daemon/src/graph/ingest.ts", "graph/ingest/resolveEdges", "resolveEdges"),
    ];
    const raw: RawEdge[] = [
      { src_file: "daemon/src/graph/ingest.ts", src_name: "runIngest", dst_name: "resolveEdges", kind: "static_call" },
    ];
    const { resolved } = resolveEdges(callerNodes, raw);
    expect(resolved.map((e) => e.dst)).toEqual(["graph/ingest/resolveEdges"]);
  });
});

describe("resolveEdges — Tier-2 member-call resolution (contract fields)", () => {
  // `import { api } from "~/api/client"` + `api.search(...)`.
  const nodes: GraphNode[] = [
    mod("viewer/src/api/client.ts", "api/client"),
    mod("viewer/src/components/SearchResults.tsx", "components/SearchResults"),
    entity("viewer/src/components/SearchResults.tsx", "components/SearchResults/Results", "Results"),
    // The member on the imported module, under `<moduleId>/<receiver>/<member>`.
    entity("viewer/src/api/client.ts", "api/client/api/search", "search"),
  ];

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "hayven-t2-"));
    mkdirSync(join(r, "viewer", "src", "api"), { recursive: true });
    writeFileSync(
      join(r, "viewer", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }),
    );
    return r;
  }

  it("resolves `api.search()` through the import binding to the module member", () => {
    const raw: RawEdge[] = [
      {
        src_file: "viewer/src/components/SearchResults.tsx",
        src_name: "Results",
        dst_name: "search",
        kind: "static_call",
        receiver: "api",
      },
      {
        src_file: "viewer/src/components/SearchResults.tsx",
        src_name: "Results",
        dst_name: "~/api/client",
        kind: "import",
        local: ["api"],
      },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: root() });
    const callEdge = resolved.find((e) => e.kind === "static_call");
    expect(callEdge?.dst).toBe("api/client/api/search");
  });

  it("no-ops gracefully when contract fields are absent (member call stays name-resolved/`?:`)", () => {
    const raw: RawEdge[] = [
      {
        src_file: "viewer/src/components/SearchResults.tsx",
        src_name: "Results",
        dst_name: "search",
        kind: "static_call",
        // no `receiver` — exactly today's stream
      },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw, { repoRoot: root() });
    // `search` resolves by unique-name to the only `search` entity (existing behavior).
    expect(resolved.map((e) => e.dst).concat(unresolved.map((e) => e.dst)))
      .toContain("api/client/api/search");
  });
});

describe("resolveEdges — Tier-2 multi-segment receiver chains", () => {
  // `import api from "~/api/client"` + `api.client.search(...)`. The chain ROOT
  // `api` binds to the import; the intermediate segment `client` + member
  // `search` resolve to `<moduleId>/client/search`.
  const nodes: GraphNode[] = [
    mod("viewer/src/api/client.ts", "api/client"),
    mod("viewer/src/components/GraphView.tsx", "components/GraphView"),
    entity("viewer/src/components/GraphView.tsx", "components/GraphView/View", "View"),
    entity("viewer/src/api/client.ts", "api/client/client/search", "search", "method"),
  ];

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "hayven-chain-"));
    mkdirSync(join(r, "viewer", "src", "api"), { recursive: true });
    writeFileSync(
      join(r, "viewer", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }),
    );
    return r;
  }

  it("resolves `api.client.search()` through the chain root binding", () => {
    const raw: RawEdge[] = [
      {
        src_file: "viewer/src/components/GraphView.tsx",
        src_name: "View",
        dst_name: "search",
        kind: "static_call",
        receiver: "client", // immediate object (back-compat field)
        // additive chain root→object — cast since types.ts (other lane) lacks it
        receiver_chain: ["api", "client"],
      } as RawEdge & { receiver_chain: string[] },
      {
        src_file: "viewer/src/components/GraphView.tsx",
        src_name: "View",
        dst_name: "~/api/client",
        kind: "import",
        local: ["api"],
      },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: root() });
    const callEdge = resolved.find((e) => e.kind === "static_call");
    expect(callEdge?.dst).toBe("api/client/client/search");
  });

  it("a chain whose root binds to nothing falls back to name resolution", () => {
    const raw: RawEdge[] = [
      {
        src_file: "viewer/src/components/GraphView.tsx",
        src_name: "View",
        dst_name: "search",
        kind: "static_call",
        receiver: "client",
        receiver_chain: ["unbound", "client"],
      } as RawEdge & { receiver_chain: string[] },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, raw, { repoRoot: root() });
    // No import binds `unbound`; `search` resolves by unique name instead.
    expect(resolved.map((e) => e.dst).concat(unresolved.map((e) => e.dst)))
      .toContain("api/client/client/search");
  });
});

describe("resolveEdges — Astro template component-usage edges", () => {
  // Frontmatter `import Stats from "~/components/Stats.tsx"` + template `<Stats/>`.
  // The component usage edge (receiver === dst_name, no chain) resolves to the
  // imported MODULE itself.
  const nodes: GraphNode[] = [
    // `Stats.tsx`'s default export is a function node sharing the file's derived
    // module id `components/Stats` (matches the real graph — see dogfood).
    entity("viewer/src/components/Stats.tsx", "components/Stats", "Stats"),
    mod("viewer/src/pages/index.astro", "pages/index"),
  ];

  function root(): string {
    const r = mkdtempSync(join(tmpdir(), "hayven-astro-"));
    mkdirSync(join(r, "viewer", "src", "components"), { recursive: true });
    mkdirSync(join(r, "viewer", "src", "pages"), { recursive: true });
    writeFileSync(
      join(r, "viewer", "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } } }),
    );
    return r;
  }

  it("resolves `<Stats/>` usage to the imported component module", () => {
    const raw: RawEdge[] = [
      {
        src_file: "viewer/src/pages/index.astro",
        src_name: "index",
        dst_name: "Stats",
        kind: "static_call",
        receiver: "Stats", // component usage: receiver === dst_name, no chain
      },
      {
        src_file: "viewer/src/pages/index.astro",
        src_name: "index",
        dst_name: "~/components/Stats.tsx",
        kind: "import",
        local: ["Stats"],
      },
    ];
    const { resolved } = resolveEdges(nodes, raw, { repoRoot: root() });
    const callEdge = resolved.find((e) => e.kind === "static_call");
    expect(callEdge?.dst).toBe("components/Stats");
  });
});
