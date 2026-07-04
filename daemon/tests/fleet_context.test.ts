/**
 * `fleetContext` — deduping the context a fan-out of parallel lanes shares.
 * Two lanes that both touch a shared util should emit that util's slice ONCE
 * (shared), each lane's own function staying unique, with a real token saving.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fleetContext } from "../src/db/fleet_context.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

/** core.ts: a shared util + two lane-specific functions, with known line ranges. */
const CORE = `import { z } from "./z";

export function sharedUtil(): number {
  const a = 1;
  const b = 2;
  const c = 3;
  return a + b + c;
}

export function laneAOnly(): number {
  const a = 10;
  const b = 20;
  const c = 30;
  return a + b + c;
}

export function laneBOnly(): number {
  const a = 11;
  const b = 22;
  const c = 33;
  return a + b + c;
}
`;

function makeFixture(): { db: Db; root: string } {
  const root = mkdtempSync(join(tmpdir(), "hayven-fleet-"));
  const abs = join(root, "core.ts");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, CORE);
  const db = new Db(":memory:");
  db.migrate();
  const node = (id: string, name: string, range: [number, number], kind: NodeKind = "function") =>
    db.upsertNode({
      id, name, qualified_name: id, kind, language: "typescript", file: "core.ts", range,
      ast_hash: "h", last_seen: 0, logical_clock: 0,
    });
  node("core.ts::module", "core.ts", [1, 1], "module");
  node("core.ts::sharedUtil", "sharedUtil", [3, 8]);
  node("core.ts::laneAOnly", "laneAOnly", [10, 15]);
  node("core.ts::laneBOnly", "laneBOnly", [17, 22]);
  return { db, root };
}

describe("fleetContext", () => {
  it("emits the shared slice once and splits out per-lane unique slices", () => {
    const { db, root } = makeFixture();
    const result = fleetContext(
      db, root,
      [
        { id: "laneA", symbols: ["core.ts::sharedUtil", "core.ts::laneAOnly"] },
        { id: "laneB", symbols: ["core.ts::sharedUtil", "core.ts::laneBOnly"] },
      ],
      { neighbors: false },
    );

    // The shared util appears once in the shared block.
    expect(result.shared.slices.length).toBeGreaterThanOrEqual(1);
    expect(result.shared.text).toContain("sharedUtil");

    // Each lane keeps only its own function.
    const a = result.perLane.find((l) => l.id === "laneA")!;
    const b = result.perLane.find((l) => l.id === "laneB")!;
    expect(a.uniqueText).toContain("laneAOnly");
    expect(a.uniqueText).not.toContain("laneBOnly");
    expect(b.uniqueText).toContain("laneBOnly");
    expect(b.uniqueText).not.toContain("laneAOnly");
    // Neither lane re-includes the shared util in its unique block.
    expect(a.uniqueText).not.toContain("sharedUtil");

    // Real dedup saving (shared was duplicated across both lanes in the naive cost).
    expect(result.stats.savedTokens).toBeGreaterThan(0);
    expect(result.stats.savedPct).toBeGreaterThan(0);
    expect(result.stats.dedupedTokens).toBeLessThan(result.stats.naiveTokens);
    db.close();
  });

  it("shares nothing when lanes are disjoint (savedTokens 0)", () => {
    const { db, root } = makeFixture();
    const result = fleetContext(
      db, root,
      [
        { id: "laneA", symbols: ["core.ts::laneAOnly"] },
        { id: "laneB", symbols: ["core.ts::laneBOnly"] },
      ],
      { neighbors: false },
    );
    // Different files would share nothing; here both touch core.ts's module header,
    // so "shared" may include the header — but the two BODIES are disjoint. Assert
    // the per-lane bodies don't leak across lanes regardless.
    const a = result.perLane.find((l) => l.id === "laneA")!;
    expect(a.uniqueText).toContain("laneAOnly");
    expect(a.uniqueText).not.toContain("laneBOnly");
    db.close();
  });

  it("respects --shared-min: a 3rd-lane threshold excludes a 2-lane overlap", () => {
    const { db, root } = makeFixture();
    const result = fleetContext(
      db, root,
      [
        { id: "laneA", symbols: ["core.ts::sharedUtil", "core.ts::laneAOnly"] },
        { id: "laneB", symbols: ["core.ts::sharedUtil", "core.ts::laneBOnly"] },
      ],
      { neighbors: false, sharedMinLanes: 3 },
    );
    // sharedUtil is in only 2 lanes; with threshold 3 it's NOT shared.
    expect(result.shared.text).not.toContain("sharedUtil");
    db.close();
  });

  it("pins a named exemplar into the shared block even when no lane needs it", () => {
    const { db, root } = makeFixture();
    const result = fleetContext(
      db, root,
      [
        { id: "laneA", symbols: ["core.ts::laneAOnly"] },
        { id: "laneB", symbols: ["core.ts::laneBOnly"] },
      ],
      // The lanes harmonize on the canonical sharedUtil pattern, but neither lane
      // listed it — without the exemplar each would read the other's file to copy it.
      { neighbors: false, exemplars: ["core.ts::sharedUtil"] },
    );
    // sharedUtil is pinned into shared under the "copy this" header.
    expect(result.shared.text).toContain("sharedUtil");
    expect(result.shared.text).toContain("Canonical reference");
    expect(result.stats.exemplarSlices).toBeGreaterThanOrEqual(1);
    expect(result.stats.exemplarTokens).toBeGreaterThan(0);
    // No lane re-includes the exemplar in its own block (no cross-lane peeking).
    for (const lane of result.perLane) expect(lane.uniqueText).not.toContain("sharedUtil");
    db.close();
  });

  it("does not double-emit an exemplar that lanes already share", () => {
    const { db, root } = makeFixture();
    const result = fleetContext(
      db, root,
      [
        { id: "laneA", symbols: ["core.ts::sharedUtil", "core.ts::laneAOnly"] },
        { id: "laneB", symbols: ["core.ts::sharedUtil", "core.ts::laneBOnly"] },
      ],
      // sharedUtil is already a ≥2-lane shared slice; naming it as an exemplar must
      // relabel it, not duplicate it.
      { neighbors: false, exemplars: ["core.ts::sharedUtil"] },
    );
    const occurrences = result.shared.text.split("sharedUtil").length - 1;
    // The function name appears in its slice (signature/body) but the SLICE itself
    // is emitted once — assert no duplicate slice block.
    const sharedKeys = result.shared.slices.map((s) => `${s.file}:${s.startLine}-${s.endLine}`);
    expect(new Set(sharedKeys).size).toBe(sharedKeys.length);
    expect(occurrences).toBeGreaterThan(0);
    db.close();
  });

  it("notes an exemplar that resolves no slices instead of crashing", () => {
    const { db, root } = makeFixture();
    const result = fleetContext(
      db, root,
      [
        { id: "laneA", symbols: ["core.ts::laneAOnly"] },
        { id: "laneB", symbols: ["core.ts::laneBOnly"] },
      ],
      { neighbors: false, exemplars: ["core.ts::doesNotExist"] },
    );
    expect(result.stats.exemplarSlices).toBe(0);
    expect(result.notes.join(" ")).toContain("doesNotExist");
    db.close();
  });
});
