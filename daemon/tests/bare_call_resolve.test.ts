/**
 * Regression tests for BARE-CALL edge resolution through imports.
 *
 * The foreign-repo bug: a function imported across nested dirs
 * (`import { fn } from '../lib/access.ts'`) and called BARE (no receiver) inside
 * an anonymous builder callback produced edges the daemon DROPPED, so
 * `refs`/`impact` returned 0. Two root causes, both fixed in `resolveEdges`:
 *
 *   1. The native extractor sets a call's `src_name` to the enclosing
 *      definition's QUALIFIED name (`thing/resolve`, `Cls.method`) — or, when
 *      there is no nameable enclosing definition, to the FILE PATH. The src
 *      lookup keyed only by `name`, so method-/file-scoped calls never matched
 *      and the edge was dropped. We now key the src lookup by qualified_name and
 *      fall the file-path case back to the file's MODULE node.
 *   2. A bare call's DST resolved only via the global name index. When the
 *      callee name is ambiguous (or only reachable through the import) the
 *      import binding in THIS file pins the target — we now reuse the same
 *      specifier→module resolution the import edge uses and look for
 *      `<module>/<callee>`.
 *
 * These tests drive `resolveEdges` directly with synthetic nodes/edges that
 * mirror exactly what the native binary emits for the `/tmp/res2` and
 * `/tmp/res-repro` repros, so they fail loudly if either path regresses.
 */
import { describe, expect, it } from "bun:test";

import { resolveEdges } from "../src/graph/ingest.ts";
import type { GraphNode, RawEdge } from "../src/graph/types.ts";

function mod(file: string, id: string): GraphNode {
  const name = id.split("/").pop()!;
  return {
    id,
    name,
    qualified_name: name,
    kind: "module",
    language: "typescript",
    file,
    range: [1, 1],
    ast_hash: `mod-${file}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

function entity(
  file: string,
  id: string,
  name: string,
  qualifiedName: string,
  kind: GraphNode["kind"] = "function",
): GraphNode {
  return {
    id,
    name,
    qualified_name: qualifiedName,
    kind,
    language: "typescript",
    file,
    range: [1, 5],
    ast_hash: `e-${id}`,
    last_seen: 0,
    logical_clock: 0,
  };
}

/** Resolve and return the set of `${src}->${dst}` strings for `static_call`. */
function callEdges(nodes: GraphNode[], edges: RawEdge[]): string[] {
  const { resolved } = resolveEdges(nodes, edges, { repoRoot: "" });
  return resolved
    .filter((e) => e.kind === "static_call")
    .map((e) => `${e.src}->${e.dst}`);
}

describe("bare-call resolution through a parent-relative import", () => {
  // src/lib/access.ts exports checkProjectWriteAccess; src/graphql/photo.ts
  // imports it parent-relative (`../lib/access.ts`) and calls it bare inside a
  // builder resolver whose enclosing definition the extractor named
  // `field/resolve`.
  const nodes: GraphNode[] = [
    mod("src/lib/access.ts", "lib/access"),
    entity(
      "src/lib/access.ts",
      "lib/access/checkProjectWriteAccess",
      "checkProjectWriteAccess",
      "checkProjectWriteAccess",
    ),
    mod("src/graphql/photo.ts", "graphql/photo"),
    entity(
      "src/graphql/photo.ts",
      "graphql/photo/field/resolve",
      "resolve",
      "field/resolve",
      "method",
    ),
  ];

  it("resolves a bare call whose src_name is a method qualified_name", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/graphql/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["checkProjectWriteAccess"],
      },
      {
        // src_name is the enclosing resolver's QUALIFIED name, not its bare name.
        src_file: "src/graphql/photo.ts",
        src_name: "field/resolve",
        dst_name: "checkProjectWriteAccess",
        kind: "static_call",
      },
    ];
    expect(callEdges(nodes, edges)).toEqual([
      "graphql/photo/field/resolve->lib/access/checkProjectWriteAccess",
    ]);
  });

  it("attributes a file-path src_name (no enclosing def) to the module node", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/graphql/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["checkProjectWriteAccess"],
      },
      {
        // The extractor's fallback: no nameable enclosing definition → file path.
        src_file: "src/graphql/photo.ts",
        src_name: "src/graphql/photo.ts",
        dst_name: "checkProjectWriteAccess",
        kind: "static_call",
      },
    ];
    expect(callEdges(nodes, edges)).toEqual([
      "graphql/photo->lib/access/checkProjectWriteAccess",
    ]);
  });
});

describe("bare-call resolution disambiguates via the import binding", () => {
  // Two files both define `helper`; the importing file pins which one via its
  // import. The global name index is AMBIGUOUS here, so only the import-binding
  // path can resolve it correctly.
  const nodes: GraphNode[] = [
    mod("src/a/util.ts", "a/util"),
    entity("src/a/util.ts", "a/util/helper", "helper", "helper"),
    mod("src/b/util.ts", "b/util"),
    entity("src/b/util.ts", "b/util/helper", "helper", "helper"),
    mod("src/feature.ts", "feature"),
    entity("src/feature.ts", "feature/run", "run", "run"),
  ];

  it("resolves an ambiguous bare-callee to the imported module's symbol", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/feature.ts",
        src_name: "feature",
        dst_name: "./a/util.ts",
        kind: "import",
        local: ["helper"],
      },
      {
        src_file: "src/feature.ts",
        src_name: "run",
        dst_name: "helper",
        kind: "static_call",
      },
    ];
    // Without the import-binding path this would be AMBIGUOUS (two `helper`s)
    // and land unresolved; the import pins `a/util/helper`.
    expect(callEdges(nodes, edges)).toEqual(["feature/run->a/util/helper"]);
  });
});

describe("bare-call resolution — barrel / index import", () => {
  // `import { fn } from '../lib'` resolves to `../lib/index.ts`, whose module
  // re-exports `fn` defined under it. The specifier resolver's `/index` probe +
  // the `<module>/<callee>` lookup resolve the bare call.
  const nodes: GraphNode[] = [
    mod("src/lib/index.ts", "lib/index"),
    entity("src/lib/index.ts", "lib/index/doThing", "doThing", "doThing"),
    mod("src/app.ts", "app"),
    entity("src/app.ts", "app/main", "main", "main"),
  ];

  it("resolves a bare call imported from a directory/index module", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/app.ts",
        src_name: "app",
        dst_name: "./lib",
        kind: "import",
        local: ["doThing"],
      },
      {
        src_file: "src/app.ts",
        src_name: "main",
        dst_name: "doThing",
        kind: "static_call",
      },
    ];
    expect(callEdges(nodes, edges)).toEqual(["app/main->lib/index/doThing"]);
  });
});

describe("bare-call resolution — aliased import", () => {
  // `import { checkAccess as ca } from '../lib/access'` then `ca()`. The local
  // binding is `ca`; the real entity keeps its export name `checkAccess`. The
  // native side now carries the `{local:"ca", imported:"checkAccess"}` pair so
  // the resolver can recover the export name and resolve `<module>/checkAccess`.
  const nodes: GraphNode[] = [
    mod("src/lib/access.ts", "lib/access"),
    entity("src/lib/access.ts", "lib/access/checkAccess", "checkAccess", "checkAccess"),
    mod("src/g/photo.ts", "g/photo"),
    entity("src/g/photo.ts", "g/photo/x/resolve", "resolve", "x/resolve", "method"),
  ];

  it("resolves an aliased bare call to the real exported symbol", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/g/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["ca"],
        // Additive contract: the {local, imported} pair the native side now emits.
        import_aliases: [{ local: "ca", imported: "checkAccess" }],
      } as RawEdge & { import_aliases: Array<{ local: string; imported: string }> },
      {
        src_file: "src/g/photo.ts",
        src_name: "x/resolve",
        dst_name: "ca",
        kind: "static_call",
      },
    ];
    expect(callEdges(nodes, edges)).toEqual([
      "g/photo/x/resolve->lib/access/checkAccess",
    ]);
  });

  it("LEGACY (no import_aliases): stays honest-unresolved, never a fake module edge", () => {
    // An older binary that doesn't emit `import_aliases`: the export name isn't
    // recoverable from `ca` alone, so we must NOT invent a `…->lib/access`
    // module edge — it stays unresolved. (Byte-compatible-with-old-payloads
    // guarantee: the additive field is the ONLY thing that makes it resolve.)
    const edges: RawEdge[] = [
      {
        src_file: "src/g/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["ca"],
      },
      {
        src_file: "src/g/photo.ts",
        src_name: "x/resolve",
        dst_name: "ca",
        kind: "static_call",
      },
    ];
    const { resolved, unresolved } = resolveEdges(nodes, edges, { repoRoot: "" });
    const calls = resolved.filter((e) => e.kind === "static_call");
    expect(calls.map((e) => e.dst)).not.toContain("lib/access");
    expect(unresolved.some((e) => e.kind === "static_call" && e.dst === "?:ca")).toBe(true);
  });
});

describe("namespace-import member call resolution", () => {
  // `import * as access from './access'; access.checkAccess()`. The local
  // binding `access` binds to the MODULE; the member call resolves to
  // `<module>/checkAccess` via the existing Tier-2 `<mod>/<dst>` candidate.
  const nodes: GraphNode[] = [
    mod("src/lib/access.ts", "lib/access"),
    entity("src/lib/access.ts", "lib/access/checkAccess", "checkAccess", "checkAccess"),
    mod("src/g/photo.ts", "g/photo"),
    entity("src/g/photo.ts", "g/photo/x/resolve", "resolve", "x/resolve", "method"),
  ];

  it("resolves ns.fn() to <module>/fn", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/g/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["access"],
      },
      {
        src_file: "src/g/photo.ts",
        src_name: "x/resolve",
        dst_name: "checkAccess",
        kind: "static_call",
        receiver: "access",
      },
    ];
    expect(callEdges(nodes, edges)).toEqual([
      "g/photo/x/resolve->lib/access/checkAccess",
    ]);
  });
});

describe("aliased namespace-like member call resolution", () => {
  // `import { obj as o } from './m'; o.fn()`. Receiver `o` is an alias of the
  // exported `obj`; resolution should try `<mod>/obj/fn` via the receiver alias.
  const nodes: GraphNode[] = [
    mod("src/m.ts", "m"),
    entity("src/m.ts", "m/obj/fn", "fn", "obj/fn", "method"),
    mod("src/app.ts", "app"),
    entity("src/app.ts", "app/run", "run", "run"),
  ];

  it("resolves o.fn() to <mod>/obj/fn via the receiver alias", () => {
    const edges: RawEdge[] = [
      {
        src_file: "src/app.ts",
        src_name: "app",
        dst_name: "./m.ts",
        kind: "import",
        local: ["o"],
        import_aliases: [{ local: "o", imported: "obj" }],
      } as RawEdge & { import_aliases: Array<{ local: string; imported: string }> },
      {
        src_file: "src/app.ts",
        src_name: "run",
        dst_name: "fn",
        kind: "static_call",
        receiver: "o",
      },
    ];
    expect(callEdges(nodes, edges)).toEqual(["app/run->m/obj/fn"]);
  });
});
