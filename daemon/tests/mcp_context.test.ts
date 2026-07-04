/**
 * Surface #2 — the `hayven-context` MCP server (`src/mcp/context_server.ts`).
 *
 * Drives the JSON-RPC surface END-TO-END against a tiny REAL fixture index (an
 * in-memory `Db` mirroring a temp on-disk repo — the same idiom as
 * `context_helper.test.ts`): handshake (`initialize` → `notifications/initialized`
 * → `tools/list`), then `tools/call` for BOTH tools, asserting the
 * StableContextResult shape comes back as `structuredContent`. The load-bearing
 * test is the `prior` ROUND-TRIP: feed a tool's own result back as the next
 * call's `prior` argument and assert the new render is append-only (prior text is
 * a strict prefix, `priorFullyPreserved`, `stablePrefixBytes` = prior byte len) —
 * i.e. the continuation really is carried as DATA, with no server-side session
 * state. Also covers the framing loop (`runStdioLoop`) and the error paths
 * (unknown tool, bad params, null-from-helper → `isError`).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createContextMcpServer,
  runStdioLoop,
  MCP_PROTOCOL_VERSION,
  type ContextMcpServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../src/mcp/context_server.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

// Two single-function files (a < m by id) + one two-entity file for the
// change-region path — same fixture shape as context_helper.test.ts.
const A_TS = `import { x } from "./x";

export function fa(): number {
  return 1;
}
`;
const M_TS = `import { x } from "./x";

export function fm(): number {
  return 9;
}
`;
const MULTI_TS = `import { z } from "./z";

export function one(): number {
  return 1;
}

export function two(): number {
  return 2;
}
`;

function writeRepo(files: ReadonlyArray<readonly [string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-mcp-"));
  for (const [rel, content] of files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function node(
  db: Db,
  id: string,
  file: string,
  range: [number, number],
  kind: NodeKind = "function",
) {
  db.upsertNode({
    id,
    name: id.split("::").pop() ?? id,
    qualified_name: id,
    kind,
    language: "typescript",
    file,
    range,
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

/** Seed the fixture graph + on-disk repo and build a server over it. */
function makeServer(): { server: ContextMcpServer; root: string } {
  const db = new Db(":memory:");
  db.migrate();
  const root = writeRepo([
    ["a.ts", A_TS],
    ["m.ts", M_TS],
    ["multi.ts", MULTI_TS],
  ]);
  node(db, "a.ts::fa", "a.ts", [3, 5]);
  node(db, "m.ts::fm", "m.ts", [3, 5]);
  node(db, "multi.ts::one", "multi.ts", [3, 5]);
  node(db, "multi.ts::two", "multi.ts", [7, 9]);
  return { server: createContextMcpServer(db, root), root };
}

/** A typed accessor for a successful response's result. */
function resultOf(resp: JsonRpcResponse | null): Record<string, unknown> {
  expect(resp).not.toBeNull();
  expect(resp).toHaveProperty("result");
  return (resp as { result: Record<string, unknown> }).result;
}

/** The StableContextResult carried in a tool result's structuredContent. */
function structured(resp: JsonRpcResponse | null): {
  text: string;
  contentKey: string;
  estTokens: number;
  order: unknown[];
  stablePrefixBytes: number;
  priorFullyPreserved: boolean;
  notes: string[];
} {
  const result = resultOf(resp);
  expect(result["isError"]).toBeUndefined();
  return result["structuredContent"] as ReturnType<typeof structured>;
}

const req = (
  id: number | null | undefined,
  method: string,
  params?: unknown,
): JsonRpcRequest => ({ jsonrpc: "2.0", id: id as number, method, params });

describe("hayven-context MCP — handshake", () => {
  it("initialize advertises the tools capability + protocol version", () => {
    const { server } = makeServer();
    const r = resultOf(server.handle(req(1, "initialize", { protocolVersion: "x" })));
    expect(r["protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
    expect(r["capabilities"]).toEqual({ tools: {} });
    expect((r["serverInfo"] as { name: string }).name).toBe("hayven-context");
    server.close();
  });

  it("notifications/initialized is a no-op with no reply", () => {
    const { server } = makeServer();
    expect(server.handle(req(undefined, "notifications/initialized"))).toBeNull();
    server.close();
  });

  it("tools/list returns both tools with input schemas", () => {
    const { server } = makeServer();
    const r = resultOf(server.handle(req(2, "tools/list")));
    const tools = r["tools"] as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "context_for_change",
      "context_for_symbols",
    ]);
    for (const t of tools) expect(t.inputSchema).toBeDefined();
    server.close();
  });
});

describe("hayven-context MCP — tools/call shape", () => {
  it("context_for_symbols returns a StableContextResult", () => {
    const { server } = makeServer();
    const sc = structured(
      server.handle(
        req(3, "tools/call", { name: "context_for_symbols", arguments: { symbols: ["a.ts::fa"] } }),
      ),
    );
    expect(typeof sc.text).toBe("string");
    expect(sc.text).toContain("function fa");
    expect(typeof sc.contentKey).toBe("string");
    expect(sc.estTokens).toBeGreaterThan(0);
    expect(Array.isArray(sc.order)).toBe(true);
    expect(sc.priorFullyPreserved).toBe(true);
    expect(sc.stablePrefixBytes).toBe(0); // no prior
    server.close();
  });

  it("context_for_change returns a StableContextResult for a changed region", () => {
    const { server } = makeServer();
    const sc = structured(
      server.handle(
        req(4, "tools/call", {
          name: "context_for_change",
          arguments: { file: "multi.ts", regions: [{ startLine: 4, endLine: 4 }] },
        }),
      ),
    );
    expect(sc.text).toContain("function one");
    expect(sc.text).not.toContain("function two");
    server.close();
  });
});

describe("hayven-context MCP — append-only prior round-trip (statelessness)", () => {
  it("feeding a tool result back as `prior` yields an append-only preserved prefix", () => {
    const { server } = makeServer();
    // First: pack m.ts (sorts LAST in the total order).
    const first = structured(
      server.handle(
        req(5, "tools/call", { name: "context_for_symbols", arguments: { symbols: ["m.ts::fm"] } }),
      ),
    );
    // Then: grow to {m, a} — a.ts sorts FIRST, so the total order would rewrite
    // the prefix. Append-only (driven purely by the `prior` DATA we pass back)
    // must keep m.ts in place and append a.ts.
    const second = structured(
      server.handle(
        req(6, "tools/call", {
          name: "context_for_symbols",
          arguments: { symbols: ["m.ts::fm", "a.ts::fa"], prior: first },
        }),
      ),
    );
    expect(second.text.startsWith(first.text)).toBe(true);
    expect(second.priorFullyPreserved).toBe(true);
    expect(second.stablePrefixBytes).toBe(Buffer.byteLength(first.text, "utf8"));
    expect(second.text.length).toBeGreaterThan(first.text.length);
    expect(second.text).toContain("function fa");
    server.close();
  });

  it("a contextForChange prior interchangeably extends a contextForSymbols call", () => {
    const { server } = makeServer();
    const prior = structured(
      server.handle(
        req(7, "tools/call", {
          name: "context_for_change",
          arguments: { file: "multi.ts", regions: [{ startLine: 4, endLine: 4 }] },
        }),
      ),
    );
    const next = structured(
      server.handle(
        req(8, "tools/call", {
          name: "context_for_symbols",
          arguments: { symbols: ["multi.ts::one", "multi.ts::two"], prior },
        }),
      ),
    );
    expect(next.text.startsWith(prior.text)).toBe(true);
    expect(next.priorFullyPreserved).toBe(true);
    expect(next.text).toContain("function two");
    server.close();
  });
});

describe("hayven-context MCP — error paths (clean, never a crash)", () => {
  it("an unknown tool is an invalid-params JSON-RPC error", () => {
    const { server } = makeServer();
    const resp = server.handle(req(9, "tools/call", { name: "nope", arguments: {} }));
    expect(resp).toHaveProperty("error");
    expect((resp as { error: { code: number } }).error.code).toBe(-32602);
    server.close();
  });

  it("missing required args are an invalid-params error", () => {
    const { server } = makeServer();
    const r1 = server.handle(req(10, "tools/call", { name: "context_for_symbols", arguments: {} }));
    expect(r1).toHaveProperty("error");
    const r2 = server.handle(
      req(11, "tools/call", { name: "context_for_change", arguments: { regions: [] } }),
    );
    expect(r2).toHaveProperty("error");
    server.close();
  });

  it("an unresolved symbol set is a clean isError tool result, not a crash", () => {
    const { server } = makeServer();
    const result = resultOf(
      server.handle(
        req(12, "tools/call", {
          name: "context_for_symbols",
          arguments: { symbols: ["does.ts::notExist"] },
        }),
      ),
    );
    expect(result["isError"]).toBe(true);
    server.close();
  });

  it("an unknown method is method-not-found", () => {
    const { server } = makeServer();
    const resp = server.handle(req(13, "frobnicate"));
    expect((resp as { error: { code: number } }).error.code).toBe(-32601);
    server.close();
  });
});

describe("hayven-context MCP — stdio framing (runStdioLoop)", () => {
  it("processes newline-delimited requests and writes one response per line", async () => {
    const { server } = makeServer();
    const lines = [
      JSON.stringify(req(1, "initialize")),
      JSON.stringify(req(undefined, "notifications/initialized")), // no reply
      JSON.stringify(req(2, "tools/list")),
      JSON.stringify(
        req(3, "tools/call", { name: "context_for_symbols", arguments: { symbols: ["a.ts::fa"] } }),
      ),
    ].join("\n");
    // Feed it in two arbitrary chunks to exercise the split-line buffering.
    const mid = Math.floor(lines.length / 2);
    async function* chunks(): AsyncGenerator<string> {
      yield lines.slice(0, mid);
      yield lines.slice(mid);
    }
    const out: string[] = [];
    await runStdioLoop(server, chunks(), (line) => out.push(line));

    // 3 responses (the notification produced none); each is one '\n'-terminated line.
    expect(out.length).toBe(3);
    for (const line of out) expect(line.endsWith("\n")).toBe(true);
    const parsed = out.map((l) => JSON.parse(l) as JsonRpcResponse);
    expect(parsed.map((p) => (p as { id: unknown }).id)).toEqual([1, 2, 3]);
    server.close();
  });

  it("a malformed line yields a JSON-RPC parse error with id null", async () => {
    const { server } = makeServer();
    const out: string[] = [];
    async function* chunks(): AsyncGenerator<string> {
      yield "{ not json }\n";
    }
    await runStdioLoop(server, chunks(), (line) => out.push(line));
    expect(out.length).toBe(1);
    const parsed = JSON.parse(out[0]!) as { id: unknown; error: { code: number } };
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32700);
    server.close();
  });
});
