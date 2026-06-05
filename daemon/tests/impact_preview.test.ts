/**
 * Unit tests for the `impact --preview` engine (`previewImpact`).
 *
 * The CORE value — classify dependents into DIRECT contract-breakers (depth-1)
 * vs TRANSITIVE (depth ≥ 2), ranked by blast radius — is pure graph logic and is
 * tested WITHOUT a native binary against a synthetic in-memory `Db` (a handful of
 * nodes + edges). The signature-contract enrichment is exercised two ways:
 *   - by injecting a fake `SignatureIndex` (no binary needed), and
 *   - by asserting it degrades gracefully (`contract: null`) when no binary /
 *     index is available.
 *
 * This mirrors the daemonless read pattern: open a `Db`, insert nodes + edges,
 * call the helper, assert the classification + ranking.
 */
import { describe, expect, test } from "bun:test";

import { Db } from "../src/db/queries.ts";
import { previewImpact, PREVIEW_ADVISORY } from "../src/db/impact_preview.ts";
import type { SignatureIndex } from "../src/conflict/native_signatures.ts";
import type { GraphNode, GraphEdge, NodeKind } from "../src/graph/types.ts";

let nodeSeq = 0;
function node(id: string, kind: NodeKind = "function", file = `${id}.ts`): GraphNode {
  return {
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id,
    kind,
    language: "typescript",
    file,
    range: [1, 10],
    ast_hash: `hash-${nodeSeq++}`,
    last_seen: 1,
    logical_clock: 1,
  };
}

function callEdge(src: string, dst: string, weight = 1): GraphEdge {
  return { src, dst, kind: "static_call", weight, last_seen: 1 };
}
function importEdge(src: string, dst: string, weight = 1): GraphEdge {
  return { src, dst, kind: "import", weight, last_seen: 1 };
}

/**
 * Build a synthetic blast radius:
 *
 *   target  <- caller_a (3 calls)  <- grand_a   <- great_a
 *           <- caller_b (1 call)
 *           <- importer_c (import only)
 *
 * So: depth-1 = {caller_a, caller_b, importer_c}; depth-2 = {grand_a};
 * depth-3 = {great_a}. unrelated/x is in the graph but not connected.
 */
function buildSampleDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  const nodes = [
    node("target"),
    node("caller_a"),
    node("caller_b"),
    node("importer_c"),
    node("grand_a"),
    node("great_a"),
    node("unrelated"),
  ];
  for (const n of nodes) db.upsertNode(n);
  const edges = [
    callEdge("caller_a", "target", 3),
    callEdge("caller_b", "target", 1),
    importEdge("importer_c", "target", 1),
    callEdge("grand_a", "caller_a", 1),
    callEdge("great_a", "grand_a", 1),
  ];
  for (const e of edges) db.upsertEdge(e);
  return db;
}

describe("previewImpact — graph classification (no binary)", () => {
  test("returns null for an unresolvable id", () => {
    const db = buildSampleDb();
    try {
      expect(previewImpact(db, "does/not/exist/anywhere")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("classifies direct breakers (depth-1) vs transitive (depth ≥ 2)", () => {
    const db = buildSampleDb();
    try {
      const p = previewImpact(db, "target");
      expect(p).not.toBeNull();
      const preview = p!;
      expect(preview.symbol).toBe("target");
      expect(preview.resolved).toBeNull(); // exact match

      // Direct = the three depth-1 dependents.
      const directIds = preview.directBreakers.map((b) => b.id).sort();
      expect(directIds).toEqual(["caller_a", "caller_b", "importer_c"]);
      for (const b of preview.directBreakers) expect(b.depth).toBe(1);

      // Transitive = grand_a (depth 2) + great_a (depth 3).
      expect(preview.transitive.map((t) => t.id)).toEqual(["grand_a", "great_a"]);
      expect(preview.transitive.map((t) => t.depth)).toEqual([2, 3]);
    } finally {
      db.close();
    }
  });

  test("tags `via` (call vs import) and counts call sites", () => {
    const db = buildSampleDb();
    try {
      const preview = previewImpact(db, "target")!;
      const byId = new Map(preview.directBreakers.map((b) => [b.id, b]));
      expect(byId.get("caller_a")!.via).toBe("call");
      expect(byId.get("caller_a")!.callSites).toBe(3);
      expect(byId.get("caller_b")!.callSites).toBe(1);
      expect(byId.get("importer_c")!.via).toBe("import");
      expect(byId.get("importer_c")!.callSites).toBe(0);
    } finally {
      db.close();
    }
  });

  test("ranks direct breakers by blast radius: call sites, then sub-tree", () => {
    const db = buildSampleDb();
    try {
      const preview = previewImpact(db, "target")!;
      // caller_a: 3 call sites + drags grand_a/great_a → ranks first.
      // caller_b: 1 call site, no sub-tree.
      // importer_c: 0 call sites (import only) → last.
      expect(preview.directBreakers.map((b) => b.id)).toEqual([
        "caller_a",
        "caller_b",
        "importer_c",
      ]);
      // caller_a drags 2 transitive dependents (grand_a, great_a).
      expect(preview.directBreakers[0]!.subtree).toBe(2);
    } finally {
      db.close();
    }
  });

  test("ranks transitive dependents by depth ascending (proximity)", () => {
    const db = buildSampleDb();
    try {
      const preview = previewImpact(db, "target")!;
      const depths = preview.transitive.map((t) => t.depth);
      for (let i = 1; i < depths.length; i++) {
        expect(depths[i]!).toBeGreaterThanOrEqual(depths[i - 1]!);
      }
    } finally {
      db.close();
    }
  });

  test("a symbol with no dependents yields empty groups", () => {
    const db = buildSampleDb();
    try {
      const preview = previewImpact(db, "unrelated")!;
      expect(preview.directBreakers).toEqual([]);
      expect(preview.transitive).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("respects the depth cap", () => {
    const db = buildSampleDb();
    try {
      const preview = previewImpact(db, "target", { depth: 1 })!;
      // depth=1 → only direct breakers; transitive empty; walk reports capped.
      expect(preview.transitive).toEqual([]);
      expect(preview.directBreakers.length).toBe(3);
      expect(preview.capped).toBe(true);
    } finally {
      db.close();
    }
  });

  test("degrades gracefully when no binary/index is available (contract: null)", () => {
    const db = buildSampleDb();
    try {
      const preview = previewImpact(db, "target")!;
      expect(preview.contract).toBeNull();
      // The advisory caveat is always present regardless of enrichment.
      expect(preview.advisory).toBe(PREVIEW_ADVISORY);
    } finally {
      db.close();
    }
  });
});

describe("previewImpact — contract enrichment via injected signature index", () => {
  test("surfaces the symbol's contract when a signature index resolves it", () => {
    const db = buildSampleDb();
    // A fake index that returns a public 2-arity signature for `target`.
    const index: SignatureIndex = {
      size: 1,
      get(_file, qualifiedName, name) {
        if (qualifiedName === "target" || name === "target") {
          return {
            name: "target",
            arity: 2,
            params: ["a: number", "b: string"],
            returnType: "string",
            visibility: "public",
            hasCallable: true,
          };
        }
        return null;
      },
    };
    try {
      const preview = previewImpact(db, "target", { signatureIndex: index })!;
      expect(preview.contract).not.toBeNull();
      expect(preview.contract!.arity).toBe(2);
      expect(preview.contract!.returnType).toBe("string");
      expect(preview.contract!.visibility).toBe("public");
      expect(preview.contract!.summary).toContain("arity=2");
      expect(preview.contract!.summary).toContain("visibility: public");
      // Classification is unaffected by enrichment.
      expect(preview.directBreakers.length).toBe(3);
    } finally {
      db.close();
    }
  });

  test("contract stays null when the index has no signature for the symbol", () => {
    const db = buildSampleDb();
    const emptyIndex: SignatureIndex = { size: 0, get: () => null };
    try {
      const preview = previewImpact(db, "target", { signatureIndex: emptyIndex })!;
      expect(preview.contract).toBeNull();
      expect(preview.directBreakers.length).toBe(3);
    } finally {
      db.close();
    }
  });
});
