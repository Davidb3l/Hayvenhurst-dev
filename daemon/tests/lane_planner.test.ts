/**
 * GRAPH-COMPUTED disjoint-lane planner (`db/lane_planner.ts`).
 *
 * The headline contract: a change-set is partitioned into lanes that are
 * pairwise disjoint in BOTH files and symbols, so each lane is a collision-free
 * parallel-agent assignment. The interesting cases are the TRANSITIVE ones grep
 * can't see — two seeds with no textual overlap that nevertheless share a deep
 * dependent (symbol overlap) or whose dependents land in the same file (file
 * overlap) MUST merge into one serialized lane.
 *
 * Fixtures are synthetic in-memory graphs (no native binary): nodes via
 * `db.upsertNode`, INCOMING blast-radius edges via `db.upsertEdge`. Recall
 * `impactOf` walks INCOMING edges — an edge `caller → callee` means "changing
 * callee affects caller", so the seed is the `dst` and its dependents are the
 * `src`s. Same seeding pattern as `affected_tests.test.ts`.
 */
import { describe, expect, it } from "bun:test";

import { Db } from "../src/db/queries.ts";
import type { EdgeKind } from "../src/graph/types.ts";
import { planLanes } from "../src/db/lane_planner.ts";

/** Index a node with a distinct bare `name` so it resolves unambiguously. */
function seedNode(db: Db, id: string, name: string, file: string | null): void {
  db.upsertNode({
    id,
    name,
    qualified_name: name,
    kind: "function",
    language: "typescript",
    // NodeRow.file is nullable even though GraphNode types it `string`; cast so
    // the fixture can exercise the file-less path.
    file: file as string,
    range: [1, 10],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** An INCOMING blast-radius edge: `caller → callee` means changing `callee`
 *  (the dst) affects `caller` (the src). `impactOf(callee)` reaches `caller`. */
function callerEdge(db: Db, caller: string, callee: string, kind: EdgeKind = "static_call"): void {
  db.upsertEdge({ src: caller, dst: callee, kind, weight: 1, last_seen: 0 });
}

function freshDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  return db;
}

/** Assert the returned lanes are pairwise disjoint in BOTH files and symbols —
 *  the planner's core safety invariant. */
function expectPairwiseDisjoint(lanes: { files: string[]; symbols: string[] }[]): void {
  for (let i = 0; i < lanes.length; i++) {
    for (let j = i + 1; j < lanes.length; j++) {
      const sharedSym = lanes[i]!.symbols.filter((s) => lanes[j]!.symbols.includes(s));
      const sharedFile = lanes[i]!.files.filter((f) => lanes[j]!.files.includes(f));
      expect(sharedSym).toEqual([]);
      expect(sharedFile).toEqual([]);
    }
  }
}

describe("planLanes — independent seeds split into disjoint lanes", () => {
  it("two seeds with non-overlapping blast radius → 2 disjoint lanes", () => {
    const db = freshDb();
    // Two fully separate subgraphs. symA ← depA (in fileA); symB ← depB (in fileB).
    seedNode(db, "src/a/symA", "symA", "src/a.ts");
    seedNode(db, "src/a/depA", "depA", "src/a.ts");
    seedNode(db, "src/b/symB", "symB", "src/b.ts");
    seedNode(db, "src/b/depB", "depB", "src/b.ts");
    callerEdge(db, "src/a/depA", "src/a/symA"); // depA calls symA
    callerEdge(db, "src/b/depB", "src/b/symB"); // depB calls symB

    const plan = planLanes(db, { symbols: ["src/a/symA", "src/b/symB"] });

    expect(plan.lanes).toHaveLength(2);
    expectPairwiseDisjoint(plan.lanes);
    // Exact grouping: lane A holds symA + its dependent depA; lane B holds symB + depB.
    expect(plan.lanes[0]!.seeds).toEqual(["src/a/symA"]);
    expect(plan.lanes[0]!.symbols).toEqual(["src/a/depA", "src/a/symA"]);
    expect(plan.lanes[0]!.files).toEqual(["src/a.ts"]);
    expect(plan.lanes[1]!.seeds).toEqual(["src/b/symB"]);
    expect(plan.lanes[1]!.symbols).toEqual(["src/b/depB", "src/b/symB"]);
    expect(plan.lanes[1]!.files).toEqual(["src/b.ts"]);
    expect(plan.note).toBe("2 seeds → 2 disjoint lanes");
  });
});

describe("planLanes — symbol-overlap coupling (the transitive case grep misses)", () => {
  it("two seeds whose blast radii share a dependent node → 1 merged lane", () => {
    const db = freshDb();
    // shared ← symA  AND  shared ← symB: a single dependent transitively impacted
    // by BOTH seeds. Textually independent, graph-coupled → must serialize.
    seedNode(db, "src/a/symA", "symA", "src/a.ts");
    seedNode(db, "src/b/symB", "symB", "src/b.ts");
    seedNode(db, "src/shared", "shared", "src/shared.ts");
    callerEdge(db, "src/shared", "src/a/symA"); // shared depends on symA
    callerEdge(db, "src/shared", "src/b/symB"); // shared depends on symB

    const plan = planLanes(db, { symbols: ["src/a/symA", "src/b/symB"] });

    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]!.seeds).toEqual(["src/a/symA", "src/b/symB"]);
    expect(plan.lanes[0]!.symbols).toEqual(["src/a/symA", "src/b/symB", "src/shared"]);
    expect(plan.lanes[0]!.files).toEqual(["src/a.ts", "src/b.ts", "src/shared.ts"]);
    expect(plan.note).toBe("2 seeds → 1 disjoint lane; 2 seeds coupled via shared blast radius");
  });
});

describe("planLanes — file-overlap coupling", () => {
  it("two seeds in DIFFERENT files whose dependents share a file → merged", () => {
    const db = freshDb();
    // symA and symB are defined in distinct files and have NO shared symbol, but
    // their respective dependents (depA, depB) both live in src/shared.ts. The
    // file-overlap rule alone must merge them.
    seedNode(db, "src/a/symA", "symA", "src/a.ts");
    seedNode(db, "src/b/symB", "symB", "src/b.ts");
    seedNode(db, "src/shared/depA", "depA", "src/shared.ts");
    seedNode(db, "src/shared/depB", "depB", "src/shared.ts");
    callerEdge(db, "src/shared/depA", "src/a/symA"); // depA (in shared.ts) calls symA
    callerEdge(db, "src/shared/depB", "src/b/symB"); // depB (in shared.ts) calls symB

    const plan = planLanes(db, { symbols: ["src/a/symA", "src/b/symB"] });

    expect(plan.lanes).toHaveLength(1);
    // No symbol overlap — coupling is purely via the shared FILE src/shared.ts.
    expect(plan.lanes[0]!.seeds).toEqual(["src/a/symA", "src/b/symB"]);
    expect(plan.lanes[0]!.symbols).toEqual([
      "src/a/symA",
      "src/b/symB",
      "src/shared/depA",
      "src/shared/depB",
    ]);
    expect(plan.lanes[0]!.files).toEqual(["src/a.ts", "src/b.ts", "src/shared.ts"]);
  });
});

describe("planLanes — --changed style files input", () => {
  it("expands a file to all nodes defined in it, then plans over those seeds", () => {
    const db = freshDb();
    // src/mod.ts defines two entities (one, two) with separate dependents in
    // DIFFERENT files. A `--changed src/mod.ts` expands to {one, two} as seeds.
    seedNode(db, "src/mod/one", "one", "src/mod.ts");
    seedNode(db, "src/mod/two", "two", "src/mod.ts");
    seedNode(db, "src/dep_one", "depOne", "src/dep_one.ts");
    seedNode(db, "src/dep_two", "depTwo", "src/dep_two.ts");
    callerEdge(db, "src/dep_one", "src/mod/one");
    callerEdge(db, "src/dep_two", "src/mod/two");

    const plan = planLanes(db, { files: ["src/mod.ts"] });

    // Both file-defined entities became seeds.
    const allSeeds = plan.lanes.flatMap((l) => l.seeds).sort();
    expect(allSeeds).toEqual(["src/mod/one", "src/mod/two"]);

    // KEY file-overlap property: both seeds are DEFINED in src/mod.ts, so each
    // seed's radius-file set contains src/mod.ts → the file-overlap rule couples
    // them into ONE lane. This is exactly right — you can NOT hand two agents the
    // same source file, even when their downstream dependents are otherwise
    // disjoint. Two symbols in the same changed file always serialize.
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]!.seeds).toEqual(["src/mod/one", "src/mod/two"]);
    expect(plan.lanes[0]!.symbols).toEqual([
      "src/dep_one",
      "src/dep_two",
      "src/mod/one",
      "src/mod/two",
    ]);
    expect(plan.lanes[0]!.files).toEqual(["src/dep_one.ts", "src/dep_two.ts", "src/mod.ts"]);
  });

  it("splits two entities from a file when they live in SEPARATE files", () => {
    const db = freshDb();
    // Two changed files, one entity each, fully disjoint downstream → 2 lanes.
    // Proves the multi-file `--changed` path fans out when there's no overlap.
    seedNode(db, "src/a/one", "one", "src/a.ts");
    seedNode(db, "src/b/two", "two", "src/b.ts");
    seedNode(db, "src/dep_one", "depOne", "src/dep_one.ts");
    seedNode(db, "src/dep_two", "depTwo", "src/dep_two.ts");
    callerEdge(db, "src/dep_one", "src/a/one");
    callerEdge(db, "src/dep_two", "src/b/two");

    const plan = planLanes(db, { files: ["src/a.ts", "src/b.ts"] });
    expect(plan.lanes).toHaveLength(2);
    expectPairwiseDisjoint(plan.lanes);
    const allSeeds = plan.lanes.flatMap((l) => l.seeds).sort();
    expect(allSeeds).toEqual(["src/a/one", "src/b/two"]);
  });
});

describe("planLanes — edge cases", () => {
  it("empty input → no lanes, 'no seeds' note", () => {
    const db = freshDb();
    expect(planLanes(db, {})).toEqual({ lanes: [], note: "no seeds" });
    expect(planLanes(db, { files: [], symbols: [] })).toEqual({ lanes: [], note: "no seeds" });
  });

  it("a single seed → exactly one lane", () => {
    const db = freshDb();
    seedNode(db, "src/solo", "solo", "src/solo.ts");
    const plan = planLanes(db, { symbols: ["src/solo"] });
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]!.seeds).toEqual(["src/solo"]);
    expect(plan.lanes[0]!.symbols).toEqual(["src/solo"]);
    expect(plan.lanes[0]!.files).toEqual(["src/solo.ts"]);
    expect(plan.note).toBe("1 seed → 1 disjoint lane");
  });

  it("notes unresolved symbols and empty files, then skips them", () => {
    const db = freshDb();
    seedNode(db, "src/real", "real", "src/real.ts");
    const plan = planLanes(db, {
      symbols: ["src/real", "totally::nonexistent::zzz"],
      files: ["src/does_not_exist.ts"],
    });
    // Only the real symbol survives as a seed.
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]!.seeds).toEqual(["src/real"]);
    expect(plan.note).toBe(
      "1 seed → 1 disjoint lane (skipped 1 unresolved symbol, 1 empty file)",
    );
  });

  it("all input unresolvable → no lanes, with a skip annotation", () => {
    const db = freshDb();
    const plan = planLanes(db, {
      symbols: ["nope::nope"],
      files: ["ghost.ts"],
    });
    expect(plan.lanes).toEqual([]);
    expect(plan.note).toBe("no seeds (1 unresolved symbol, 1 empty file)");
  });

  it("respects maxDepth: a deep dependent past the cap doesn't couple seeds", () => {
    const db = freshDb();
    // symA ← mid ← deep, and symB ← deep (deep depends on BOTH symA-chain and
    // symB). At full depth, symA's radius reaches `deep`, which also sits in
    // symB's radius → coupled. At maxDepth=1, symA only reaches `mid`, so the two
    // radii are disjoint → 2 lanes. Proves the depth cap is honored.
    seedNode(db, "src/symA", "symA", "src/a.ts");
    seedNode(db, "src/mid", "mid", "src/mid.ts");
    seedNode(db, "src/deep", "deep", "src/deep.ts");
    seedNode(db, "src/symB", "symB", "src/b.ts");
    callerEdge(db, "src/mid", "src/symA"); // mid (depth1) → symA
    callerEdge(db, "src/deep", "src/mid"); // deep (depth2 from symA) → mid
    callerEdge(db, "src/deep", "src/symB"); // deep (depth1) → symB

    const deepPlan = planLanes(db, { symbols: ["src/symA", "src/symB"] });
    expect(deepPlan.lanes).toHaveLength(1); // coupled via `deep`

    const shallowPlan = planLanes(db, { symbols: ["src/symA", "src/symB"] }, { maxDepth: 1 });
    expect(shallowPlan.lanes).toHaveLength(2); // `deep` out of symA's reach → disjoint
    expectPairwiseDisjoint(shallowPlan.lanes);
  });

  it("dedups a symbol that is also a node in a supplied file", () => {
    const db = freshDb();
    // src/dup is both passed explicitly AND defined in the supplied file. It must
    // appear as a SINGLE seed, not two.
    seedNode(db, "src/dup", "dup", "src/file.ts");
    const plan = planLanes(db, { symbols: ["src/dup"], files: ["src/file.ts"] });
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]!.seeds).toEqual(["src/dup"]);
  });
});

describe("planLanes — hub-saturation mitigation (maxHubDegree)", () => {
  /** Build a graph where symA and symB couple ONLY through a high-in-degree hub.
   *  The hub (a barrel `index.ts`) sits in BOTH seeds' blast radius (it depends on
   *  symA and symB) and is the SOLE shared node. We inflate its in-degree past a
   *  small maxHubDegree with `extra` additional incoming edges of a NON-blast-radius
   *  kind (`references`): `db.incoming(id).length` counts them (so the hub reads as
   *  high in-degree) but `impactOf` ignores them (so they never enter — and so never
   *  pollute — the seed radii). This keeps the hub the only thing the two radii share,
   *  matching "two seeds whose blast radii overlap ONLY at a hub node." */
  function hubGraph(db: Db, extra: number): void {
    seedNode(db, "src/a/symA", "symA", "src/a.ts");
    seedNode(db, "src/b/symB", "symB", "src/b.ts");
    seedNode(db, "src/index", "barrel", "src/index.ts");
    callerEdge(db, "src/index", "src/a/symA"); // hub depends on symA → in symA's radius
    callerEdge(db, "src/index", "src/b/symB"); // hub depends on symB → in symB's radius
    inflateInDegree(db, "src/index", extra);
  }

  /** Add `n` incoming `references` edges to `id` from throwaway ref-nodes. These
   *  raise `db.incoming(id).length` (the in-degree) without `impactOf` ever
   *  traversing them — `references` is not a call/import kind. */
  function inflateInDegree(db: Db, id: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const refId = `${id}/ref${i}`;
      seedNode(db, refId, `ref${i}`, `${id}/ref${i}.ts`);
      callerEdge(db, refId, id, "references"); // non-blast-radius edge kind
    }
  }

  it("without maxHubDegree the hub couples both seeds → 1 lane (today's behavior)", () => {
    const db = freshDb();
    hubGraph(db, 5); // hub in-degree = 7 (symA + symB + 5 ref edges)
    // symA's radius reaches the hub (hub depends on symA); symB's too. The hub is
    // their ONLY shared node → without hub logic they merge.
    const plan = planLanes(db, { symbols: ["src/a/symA", "src/b/symB"] });
    expect(plan.lanes).toHaveLength(1);
    expect(plan.lanes[0]!.seeds).toEqual(["src/a/symA", "src/b/symB"]);
    expect(plan.lanes[0]!.symbols).toContain("src/index");
    // No hub logic ran → the key is absent entirely (byte-identical shape).
    expect(plan.hubsExcluded).toBeUndefined();
  });

  it("with maxHubDegree below the hub's in-degree the seeds SPLIT into 2 disjoint lanes", () => {
    const db = freshDb();
    // hub in-degree = symA + symB + 5 ref edges = 7. maxHubDegree=3 < 7 → hub.
    hubGraph(db, 5);
    const plan = planLanes(
      db,
      { symbols: ["src/a/symA", "src/b/symB"] },
      { maxHubDegree: 3 },
    );
    expect(plan.lanes).toHaveLength(2);
    expectPairwiseDisjoint(plan.lanes);
    // The hub is excluded from coupling AND from the reported sets.
    expect(plan.hubsExcluded).toEqual(["src/index"]);
    for (const lane of plan.lanes) {
      expect(lane.symbols).not.toContain("src/index");
      expect(lane.files).not.toContain("src/index.ts");
    }
    // Each lane holds exactly its own seed (the hub was their only meeting point).
    const seedSets = plan.lanes.map((l) => l.seeds).sort();
    expect(seedSets).toEqual([["src/a/symA"], ["src/b/symB"]]);
    expect(plan.note).toContain("excluded 1 hub from coupling");
  });

  it("a NON-hub shared dependent still couples (no over-exclusion)", () => {
    const db = freshDb();
    // `shared` is depended on by ONLY symA and symB → in-degree 2. With a
    // maxHubDegree of 5 it is NOT a hub, so the genuine coupling must survive.
    seedNode(db, "src/a/symA", "symA", "src/a.ts");
    seedNode(db, "src/b/symB", "symB", "src/b.ts");
    seedNode(db, "src/shared", "shared", "src/shared.ts");
    callerEdge(db, "src/shared", "src/a/symA");
    callerEdge(db, "src/shared", "src/b/symB");

    const plan = planLanes(
      db,
      { symbols: ["src/a/symA", "src/b/symB"] },
      { maxHubDegree: 5 },
    );
    expect(plan.lanes).toHaveLength(1); // still coupled via the non-hub `shared`
    expect(plan.lanes[0]!.symbols).toContain("src/shared");
    expect(plan.hubsExcluded).toEqual([]); // hub logic ran, but nothing qualified
  });

  it("maxHubDegree undefined is identical to the no-arg call", () => {
    const db = freshDb();
    hubGraph(db, 5);
    const withUndef = planLanes(
      db,
      { symbols: ["src/a/symA", "src/b/symB"] },
      { maxHubDegree: undefined },
    );
    const noArg = planLanes(db, { symbols: ["src/a/symA", "src/b/symB"] });
    expect(withUndef).toEqual(noArg);
    expect(withUndef.hubsExcluded).toBeUndefined();
  });

  it("hubsExcluded is sorted and distinct across multiple hubs", () => {
    const db = freshDb();
    // TWO hubs (zeta, alpha) each shared by both seeds; each hub gets 5 extra
    // ref edges so its in-degree (2 seeds + 5) clears maxHubDegree=3. Their ids
    // are intentionally out of sort order to prove the output is sorted, and each
    // is reached by BOTH seeds to prove dedup (one entry per hub, not per seed).
    seedNode(db, "src/a/symA", "symA", "src/a.ts");
    seedNode(db, "src/b/symB", "symB", "src/b.ts");
    for (const hub of ["src/zeta", "src/alpha"]) {
      seedNode(db, hub, hub, `${hub}.ts`);
      callerEdge(db, hub, "src/a/symA");
      callerEdge(db, hub, "src/b/symB");
      inflateInDegree(db, hub, 5);
    }
    const plan = planLanes(
      db,
      { symbols: ["src/a/symA", "src/b/symB"] },
      { maxHubDegree: 3 },
    );
    // Both hubs excluded → seeds decouple into 2 disjoint lanes.
    expect(plan.lanes).toHaveLength(2);
    expectPairwiseDisjoint(plan.lanes);
    expect(plan.hubsExcluded).toEqual(["src/alpha", "src/zeta"]); // sorted, distinct
    expect(plan.note).toContain("excluded 2 hubs from coupling");
  });
});
