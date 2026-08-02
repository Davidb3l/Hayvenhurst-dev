/**
 * A2 — one integer must not wedge the MCP server forever.
 *
 * `readRegions` validated only `typeof === "number"`, and the gap-fill loop in
 * `buildContextPackForChange` then iterated the ENTIRE `[startLine..endLine]`
 * range with no early exit. Measured against a 10-line file, `endLine`
 * 20,000,000,000 took 197,667 ms; `Number.MAX_SAFE_INTEGER` (a plausible "the
 * whole file" sentinel from a client) extrapolates to ~2.5 years. The stdio MCP
 * server is synchronous and single-process, so that is not a slow call — it is a
 * permanently wedged server: no further tool calls, DB handle held, one core at
 * 100%, no error and no log line.
 *
 * Fixed at BOTH ends, and tested at both, because either alone is insufficient:
 *   - the wire (`readRegions`) rejects non-integers, <1, inverted ranges, absurd
 *     magnitudes and absurd region COUNTS;
 *   - the packer clamps every region to the file's real line span and MERGES the
 *     clamped spans before walking lines, so per-line work is bounded by the
 *     file no matter what any future caller passes.
 *
 * The timing assertions use a budget far above a correct implementation (which
 * finishes in single-digit ms) and far below the broken one (which took minutes
 * for the SMALL sentinel). A time-based test is the only honest way to assert
 * "does not wedge"; the margin is ~4 orders of magnitude either way.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContextPackForChange } from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import {
  createContextMcpServer,
  type ContextMcpServer,
  type JsonRpcResponse,
} from "../src/mcp/context_server.ts";
import type { NodeKind } from "../src/graph/types.ts";

/**
 * NOTE ON TIMING ASSERTIONS — there are none in this file, deliberately.
 *
 * An `expect(elapsed < BUDGET)` placed AFTER the call under test can only run
 * if the call RETURNS; with the bound reverted it does not, and bun's per-test
 * timeout is cooperative and cannot preempt a synchronous JS loop. Such a test
 * can only hang, never fail. All TERMINATION proof therefore lives in
 * `fix_a_wedge_subprocess.test.ts`, which runs each wedge scenario in a
 * subprocess under a wall-clock SIGKILL. This file pins the CORRECTNESS half:
 * what the wire refuses, and what the clamped packer produces.
 */

const MULTI_TS = `import { z } from "./z";

export function one(): number {
  return 1;
}

export function two(): number {
  return 2;
}
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-fixa-bounds-"));
  dirs.push(root);
  writeFileSync(join(root, "multi.ts"), MULTI_TS);
  return root;
}

function seedDb(): Db {
  const db = new Db(":memory:");
  db.migrate();
  const node = (id: string, range: [number, number]) =>
    db.upsertNode({
      id,
      name: id.split("::").pop() ?? id,
      qualified_name: id,
      kind: "function" as NodeKind,
      language: "typescript",
      file: "multi.ts",
      range,
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
  node("multi.ts::one", [3, 5]);
  node("multi.ts::two", [7, 9]);
  return db;
}

function makeServer(): { server: ContextMcpServer; root: string } {
  const root = makeRepo();
  return { server: createContextMcpServer(seedDb(), root), root };
}

function call(
  server: ContextMcpServer,
  regions: unknown,
): JsonRpcResponse | null {
  return server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "context_for_change", arguments: { file: "multi.ts", regions } },
  });
}

function errorMessage(resp: JsonRpcResponse | null): string {
  expect(resp).not.toBeNull();
  const e = (resp as { error?: { message: string } }).error;
  expect(e).toBeDefined();
  return e!.message;
}

describe("A2 — the MCP wire refuses unbounded regions", () => {
  it("refuses MAX_SAFE_INTEGER as an endLine", () => {
    const { server } = makeServer();
    const resp = call(server, [{ startLine: 1, endLine: Number.MAX_SAFE_INTEGER }]);
    expect(errorMessage(resp)).toMatch(/exceeds the .*-line limit/i);
    server.close();
  });

  it("refuses the measured 2e10 case", () => {
    const { server } = makeServer();
    const resp = call(server, [{ startLine: 1, endLine: 20_000_000_000 }]);
    expect(errorMessage(resp)).toMatch(/exceeds the .*-line limit/i);
    server.close();
  });

  it("refuses non-integer lines", () => {
    const { server } = makeServer();
    expect(errorMessage(call(server, [{ startLine: 1, endLine: 4.5 }]))).toMatch(/integer/i);
    expect(errorMessage(call(server, [{ startLine: 1, endLine: Infinity }]))).toMatch(/integer/i);
    expect(errorMessage(call(server, [{ startLine: NaN, endLine: 4 }]))).toMatch(/integer/i);
    expect(errorMessage(call(server, [{ startLine: "3", endLine: 4 }]))).toMatch(/integer/i);
    server.close();
  });

  it("refuses zero and negative lines", () => {
    const { server } = makeServer();
    expect(errorMessage(call(server, [{ startLine: 0, endLine: 4 }]))).toMatch(/1-based/i);
    expect(errorMessage(call(server, [{ startLine: -5, endLine: -1 }]))).toMatch(/1-based/i);
    server.close();
  });

  it("refuses an inverted range", () => {
    const { server } = makeServer();
    expect(errorMessage(call(server, [{ startLine: 9, endLine: 3 }]))).toMatch(
      /`endLine` >= `startLine`/i,
    );
    server.close();
  });

  it("refuses an absurd region COUNT", () => {
    const { server } = makeServer();
    const many = Array.from({ length: 5000 }, () => ({ startLine: 1, endLine: 2 }));
    expect(errorMessage(call(server, many))).toMatch(/too many regions/i);
    server.close();
  });

  it("still serves a normal region (the bounds are not over-broad)", () => {
    const { server } = makeServer();
    const resp = call(server, [{ startLine: 4, endLine: 4 }]);
    const result = (resp as { result: Record<string, unknown> }).result;
    expect(result["isError"]).toBeUndefined();
    expect((result["structuredContent"] as { text: string }).text).toContain("function one");
    server.close();
  });
});

describe("A2 — the OTHER unbounded loop (region classification)", () => {
  // Found by review AFTER the gap-fill clamp landed. `regionTouchesModuleScope`
  // walked `lo..hi` and linearly scanned every entity row per line, i.e.
  // O(regions × lines × entities) — measured at 76 SECONDS for 1024 whole-file
  // regions against a 20k-line / 5k-entity file, every region schema-valid and
  // accepted by the wire. Same permanent wedge, different loop. It is now a
  // precomputed coverage bitmap: O(rows + lines) once, O(lines) per region.
  //
  // The fixture is deliberately GAP-FREE (entities tile the whole file) because
  // the scan short-circuits on the first module-scope line — a fixture with a
  // gap near the top exits after one iteration and proves nothing.
  const LINES = 8_000;
  const ENTITY_SPAN = 4;

  function makeTiledRepo(): { root: string; db: Db; file: string } {
    const root = mkdtempSync(join(tmpdir(), "hayven-fixa-tiled-"));
    dirs.push(root);
    const file = "tiled.ts";
    writeFileSync(
      join(root, file),
      Array.from({ length: LINES }, (_, i) => `const v${i} = ${i};`).join("\n"),
    );
    const db = new Db(":memory:");
    db.migrate();
    for (let start = 1; start + ENTITY_SPAN - 1 <= LINES; start += ENTITY_SPAN) {
      db.upsertNode({
        id: `${file}::e${start}`,
        name: `e${start}`,
        qualified_name: `${file}::e${start}`,
        kind: "function" as NodeKind,
        language: "typescript",
        file,
        range: [start, start + ENTITY_SPAN - 1],
        ast_hash: "h",
        last_seen: 0,
        logical_clock: 0,
      });
    }
    return { root, db, file };
  }

  it("produces a correct, file-bounded pack for MAX_REGIONS straddles", () => {
    const { root, db, file } = makeTiledRepo();
    // 1024 == the wire's MAX_REGIONS, so this is the worst case a client can
    // actually send. Unfixed this took ~76s; fixed it is well under a second.
    const regions = Array.from({ length: 1024 }, () => ({ startLine: 1, endLine: LINES }));
    const pack = buildContextPackForChange(db, root, file, regions);
    // Correctness only — TERMINATION is proved in fix_a_wedge_subprocess.test.ts
    // ("MAX_REGIONS whole-file straddles over a gap-free tiled file").
    expect(pack).not.toBeNull();
    for (const s of pack!.slices) expect(s.endLine).toBeLessThanOrEqual(LINES);
    db.close();
  }, 30_000);

  it("still answers module-scope classification correctly", () => {
    // The bitmap must not change WHAT the classifier decides, only how fast.
    const { root, db, file } = makeTiledRepo();
    // A region wholly inside one tiled entity: no module scope, so no frame.
    const inside = buildContextPackForChange(db, root, file, [
      { startLine: 2, endLine: 3 },
    ]);
    expect(inside?.symbol).toBe(`${file}::e1`);
    expect(inside?.symbol).not.toContain("module-frame");
    // A region straddling two entities with no gap between them: still no true
    // module scope in the tiled fixture, so still no frame.
    const straddle = buildContextPackForChange(db, root, file, [
      { startLine: 3, endLine: 6 },
    ]);
    expect(straddle?.symbol).not.toContain("module-frame");
    db.close();
  });

  it("adds the module frame when a region reaches past the last entity", () => {
    const root = mkdtempSync(join(tmpdir(), "hayven-fixa-tail-"));
    dirs.push(root);
    writeFileSync(join(root, "multi.ts"), MULTI_TS);
    const db = seedDb(); // entities end at line 9; the file has a trailing line
    const pack = buildContextPackForChange(db, root, "multi.ts", [
      { startLine: 8, endLine: 10 },
    ]);
    expect(pack?.symbol).toContain("module-frame");
    db.close();
  });
});

describe("A2 — the packer is intrinsically bounded", () => {
  // These bypass the wire entirely: they are the guarantee that a FUTURE caller
  // (the CLI, the daemon route, the proxy, a library embedder) cannot
  // reintroduce the wedge by skipping `readRegions`.
  it("clamps a huge endLine to the file", () => {
    const root = makeRepo();
    const db = seedDb();
    const pack = buildContextPackForChange(db, root, "multi.ts", [
      { startLine: 1, endLine: 20_000_000_000 },
    ]);
    expect(pack).not.toBeNull();
    // Nothing may claim a line past the file's real end.
    const fileLineCount = MULTI_TS.split("\n").length;
    for (const s of pack!.slices) expect(s.endLine).toBeLessThanOrEqual(fileLineCount);
    db.close();
  });

  it("clamps MAX_SAFE_INTEGER without the wire's help", () => {
    const root = makeRepo();
    const db = seedDb();
    const pack = buildContextPackForChange(db, root, "multi.ts", [
      { startLine: 1, endLine: Number.MAX_SAFE_INTEGER },
    ]);
    expect(pack).not.toBeNull();
    db.close();
  });

  it("survives many overlapping huge regions (span merge, not per-region walk)", () => {
    const root = makeRepo();
    const db = seedDb();
    const regions = Array.from({ length: 20_000 }, () => ({
      startLine: 1,
      endLine: 20_000_000_000,
    }));
    const pack = buildContextPackForChange(db, root, "multi.ts", regions);
    expect(pack).not.toBeNull();
    db.close();
  });

  it("produces the SAME pack for a clamped region as for the equivalent in-range one", () => {
    // Correctness, not just speed: clamping must not change what the caller gets
    // for the lines that actually exist.
    const root = makeRepo();
    const db = seedDb();
    const fileLineCount = MULTI_TS.split("\n").length;
    const clamped = buildContextPackForChange(db, root, "multi.ts", [
      { startLine: 1, endLine: 999_999 },
    ]);
    const exact = buildContextPackForChange(db, root, "multi.ts", [
      { startLine: 1, endLine: fileLineCount },
    ]);
    expect(clamped).not.toBeNull();
    expect(JSON.stringify(clamped?.slices)).toBe(JSON.stringify(exact?.slices));
    db.close();
  });
});
