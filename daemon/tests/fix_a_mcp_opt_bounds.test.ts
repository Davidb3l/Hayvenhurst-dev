/**
 * A2, follow-on — the OTHER client-controlled MCP tool arguments.
 *
 * Found by review after the `regions` bounds landed: `regions` was hardened but
 * its siblings were not, and they are the same class of defect (a plausible
 * client value producing unbounded work or silent wrongness with no signal).
 *
 *   - `symbols` had no length cap, though every element costs a node lookup plus
 *     an FTS5 fuzzy resolve — a linear-cost wedge of the synchronous stdio
 *     server, and one 64 MB request line holds millions of short strings.
 *   - `packOptsFrom` checked only `typeof === "number"`, so
 *     `maxRefSliceLines: -1000000` produced slices with `endLine < startLine`
 *     (`[3, -999998]`) that flowed into `structuredContent.order` — the
 *     documented continuation token a builder threads back — and made
 *     `lineCount` hugely negative. Corrupt output, no error.
 *   - `maxCallers` / `importedSymbols` were ADVERTISED in both tools' input
 *     schemas but were complete no-ops: both tools route through
 *     `buildContextPackForSymbols`, and only the single-symbol `buildContextPack`
 *     implements those passes. A client asking for caller context got a pack
 *     without it and no indication.
 *
 * The knobs are now rejected loudly rather than accepted and ignored. That is a
 * deliberate behavior change over silently dropping them — flagged in the lane
 * report.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";
import {
  createContextMcpServer,
  type ContextMcpServer,
  type JsonRpcResponse,
} from "../src/mcp/context_server.ts";
import type { NodeKind } from "../src/graph/types.ts";

const MULTI_TS = `import { z } from "./z";

export interface Shape {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
  i: number;
  j: number;
  k: number;
  l: number;
  m: number;
}

export function one(s: Shape): number {
  return s.a;
}
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeServer(): ContextMcpServer {
  const root = mkdtempSync(join(tmpdir(), "hayven-fixa-opts-"));
  dirs.push(root);
  writeFileSync(join(root, "multi.ts"), MULTI_TS);
  const db = new Db(":memory:");
  db.migrate();
  const node = (id: string, range: [number, number], kind: NodeKind) =>
    db.upsertNode({
      id,
      name: id.split("::").pop() ?? id,
      qualified_name: id,
      kind,
      language: "typescript",
      file: "multi.ts",
      range,
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
  node("multi.ts::Shape", [3, 17], "class");
  node("multi.ts::one", [19, 21], "function");
  return createContextMcpServer(db, root);
}

function call(
  server: ContextMcpServer,
  name: string,
  args: Record<string, unknown>,
): JsonRpcResponse | null {
  return server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function errorMessage(resp: JsonRpcResponse | null): string {
  const e = (resp as { error?: { message: string } } | null)?.error;
  expect(e).toBeDefined();
  return e!.message;
}

function structured(resp: JsonRpcResponse | null): {
  text: string;
  order: unknown[];
  estTokens: number;
} {
  const result = (resp as { result: Record<string, unknown> }).result;
  expect(result["isError"]).toBeUndefined();
  return result["structuredContent"] as ReturnType<typeof structured>;
}

const SYMS = { symbols: ["multi.ts::one"] };

describe("follow-on — `symbols` is bounded", () => {
  it("refuses an absurd symbol count, and refuses it fast", () => {
    const server = makeServer();
    const many = Array.from({ length: 50_000 }, (_, i) => `sym${i}`);
    const t0 = performance.now();
    const resp = call(server, "context_for_symbols", { symbols: many });
    expect(errorMessage(resp)).toMatch(/too many symbols/i);
    expect(performance.now() - t0).toBeLessThan(2000);
    server.close();
  });

  it("still serves a normal symbol list", () => {
    const server = makeServer();
    expect(structured(call(server, "context_for_symbols", SYMS)).text).toContain(
      "function one",
    );
    server.close();
  });
});

describe("follow-on — numeric pack knobs cannot corrupt the output", () => {
  it("refuses a negative maxRefSliceLines instead of emitting inverted ranges", () => {
    const server = makeServer();
    const resp = call(server, "context_for_symbols", {
      ...SYMS,
      maxRefSliceLines: -1_000_000,
    });
    expect(errorMessage(resp)).toMatch(/`maxRefSliceLines` must be >= 1/);
    server.close();
  });

  it("refuses maxRefSliceLines: 0 (it yields a start..start-1 slice)", () => {
    const server = makeServer();
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, maxRefSliceLines: 0 })),
    ).toMatch(/`maxRefSliceLines` must be >= 1/);
    server.close();
  });

  it("refuses negative / fractional / absurd values on the count knobs", () => {
    const server = makeServer();
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, maxNeighbors: -1 })),
    ).toMatch(/`maxNeighbors` must be >= 0/);
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, maxHeaderLines: 2.5 })),
    ).toMatch(/`maxHeaderLines` must be an integer/);
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, maxHeaderLines: 1e18 })),
    ).toMatch(/`maxHeaderLines` must be <=/);
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, neighbors: "yes" })),
    ).toMatch(/`neighbors` must be a boolean/);
    server.close();
  });

  it("no accepted knob value can produce an inverted slice range", () => {
    // The positive half: every VALID value still yields well-formed slices.
    const server = makeServer();
    for (const maxRefSliceLines of [1, 2, 12, 1000]) {
      const sc = structured(
        call(server, "context_for_symbols", { ...SYMS, maxRefSliceLines }),
      );
      expect(sc.order.length).toBeGreaterThan(0);
      for (const ref of sc.order as Array<{ startLine: number; endLine: number }>) {
        expect(ref.endLine).toBeGreaterThanOrEqual(ref.startLine);
      }
      expect(sc.estTokens).toBeGreaterThan(0);
    }
    server.close();
  });

  it("accepts 0 for the caps that legitimately mean 'off'", () => {
    const server = makeServer();
    const sc = structured(call(server, "context_for_symbols", { ...SYMS, maxNeighbors: 0 }));
    expect(sc.text).toContain("function one");
    server.close();
  });
});

describe("follow-on — unsupported knobs are refused, not silently ignored", () => {
  it("refuses maxCallers on both tools with a reason", () => {
    const server = makeServer();
    expect(errorMessage(call(server, "context_for_symbols", { ...SYMS, maxCallers: 3 }))).toMatch(
      /`maxCallers` is not supported here/,
    );
    expect(
      errorMessage(
        call(server, "context_for_change", {
          file: "multi.ts",
          regions: [{ startLine: 20, endLine: 20 }],
          maxCallers: 3,
        }),
      ),
    ).toMatch(/`maxCallers` is not supported here/);
    server.close();
  });

  it("refuses importedSymbols on both tools with a reason", () => {
    const server = makeServer();
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, importedSymbols: true })),
    ).toMatch(/`importedSymbols` is not supported here/);
    // Even `false` is refused — accepting it would imply the knob works.
    expect(
      errorMessage(call(server, "context_for_symbols", { ...SYMS, importedSymbols: false })),
    ).toMatch(/`importedSymbols` is not supported here/);
    server.close();
  });

  it("enforces the additionalProperties:false it already advertises", () => {
    // Round 2: "refuse loudly, never accept-and-ignore" was a two-item
    // denylist, not a policy. `maxCallers` hard-errored while `maxCalers` (a
    // one-char typo of it) and `maxNeighbours` (British spelling) were
    // swallowed with byte-identical output and no signal — the exact failure
    // a client would be least likely to notice.
    const server = makeServer();
    for (const typo of ["maxCalers", "maxNeighbours", "maxRefSlicelines", "nieghbors"]) {
      expect(
        errorMessage(call(server, "context_for_symbols", { ...SYMS, [typo]: 4 })),
      ).toMatch(/unknown argument/);
      expect(
        errorMessage(
          call(server, "context_for_change", {
            file: "multi.ts",
            regions: [{ startLine: 20, endLine: 20 }],
            [typo]: 4,
          }),
        ),
      ).toMatch(/unknown argument/);
    }
    server.close();
  });

  it("the generic check does not swallow the SPECIFIC reasons", () => {
    // A dropped-but-real knob must still say WHY, not just "unknown".
    const server = makeServer();
    expect(errorMessage(call(server, "context_for_symbols", { ...SYMS, maxCallers: 3 }))).toMatch(
      /is not supported here/,
    );
    server.close();
  });

  it("`prior` and every advertised knob remain accepted", () => {
    // The negative control for the generic check: it must be derived from the
    // schema, so everything the schema lists still works.
    const server = makeServer();
    const first = structured(call(server, "context_for_symbols", SYMS));
    const sc = structured(
      call(server, "context_for_symbols", {
        ...SYMS,
        prior: first,
        neighbors: true,
        maxNeighbors: 5,
        maxHeaderLines: 40,
        maxRefSliceLines: 6,
      }),
    );
    expect(sc.text).toContain("function one");
    server.close();
  });

  it("no longer ADVERTISES the knobs it cannot honour", () => {
    const server = makeServer();
    const r = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (r as { result: { tools: Array<{ inputSchema: { properties: Record<string, unknown> } }> } })
      .result.tools;
    for (const t of tools) {
      expect(Object.keys(t.inputSchema.properties)).not.toContain("maxCallers");
      expect(Object.keys(t.inputSchema.properties)).not.toContain("importedSymbols");
    }
    server.close();
  });
});
