/**
 * A3 — `runStdioLoop`'s pending-line buffer must be capped.
 *
 * The loop did `buf += chunk` with no size limit, so a client that opens the
 * pipe and never sends a newline grows the buffer until the process is
 * OOM-killed — taking the whole MCP server (and its read DB handle) with it.
 *
 * The cap is {@link MAX_PENDING_LINE_CHARS}; these tests drive the REAL default,
 * not an injected one, because the value is the thing being asserted. Framing is
 * already broken once a line blows the cap, so the loop refuses it with a
 * JSON-RPC error and RESYNCHRONISES at the next newline — which is the second
 * thing pinned here: the server must still answer the request that follows.
 */
import { describe, expect, it } from "bun:test";

import { Db } from "../src/db/queries.ts";
import {
  createContextMcpServer,
  runStdioLoop,
  MAX_PENDING_LINE_CHARS,
  MAX_RESPONSE_CHARS,
  type ContextMcpServer,
} from "../src/mcp/context_server.ts";

function makeServer(): ContextMcpServer {
  const db = new Db(":memory:");
  db.migrate();
  return createContextMcpServer(db, "/nonexistent-repo-root-for-framing-tests");
}

/** Feed `chunks` through the loop and collect every written line. */
async function drive(chunks: string[]): Promise<Record<string, unknown>[]> {
  const server = makeServer();
  const out: string[] = [];
  async function* input(): AsyncGenerator<string> {
    for (const c of chunks) yield c;
  }
  await runStdioLoop(server, input(), (line) => out.push(line));
  server.close();
  return out.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A run of `n` chars with no newline anywhere in it. */
function filler(n: number): string {
  return "x".repeat(n);
}

const PING = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n";

describe("A3 — runStdioLoop pending-line cap", () => {
  it("exports a finite, non-absurd cap", () => {
    expect(Number.isFinite(MAX_PENDING_LINE_CHARS)).toBe(true);
    expect(MAX_PENDING_LINE_CHARS).toBeGreaterThan(1024 * 1024); // room for a real `prior`
    expect(MAX_PENDING_LINE_CHARS).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it("refuses a newline-less line past the cap instead of buffering it", async () => {
    // Eight chunks each an eighth of the cap, plus one more — no newline until
    // the very end. Unfixed, this just keeps growing.
    const chunk = filler(Math.ceil(MAX_PENDING_LINE_CHARS / 8));
    const responses = await drive([...Array.from({ length: 9 }, () => chunk), "\n"]);
    expect(responses.length).toBe(1);
    const err = responses[0]!["error"] as { code: number; message: string };
    expect(err).toBeDefined();
    expect(err.message).toMatch(/line exceeds .* chars — discarded/);
    expect(responses[0]!["id"]).toBeNull();
  });

  it("resynchronises at the next newline and answers the following request", async () => {
    const chunk = filler(Math.ceil(MAX_PENDING_LINE_CHARS / 8));
    const responses = await drive([
      ...Array.from({ length: 9 }, () => chunk),
      // The tail of the discarded line, then a clean frame boundary, then a
      // perfectly good request that MUST still be served.
      `${filler(64)}\n${PING}`,
    ]);
    expect(responses.length).toBe(2);
    expect((responses[0]!["error"] as { message: string }).message).toMatch(
      /line exceeds .* chars — discarded/,
    );
    expect(responses[1]!["id"]).toBe(7);
    expect(responses[1]!["result"]).toEqual({});
  });

  it("does not flush the discarded tail as a request at end of stream", async () => {
    const chunk = filler(Math.ceil(MAX_PENDING_LINE_CHARS / 8));
    // Stream ends mid-oversized-line: exactly ONE error, never a second parse
    // error from flushing the leftovers.
    const responses = await drive([...Array.from({ length: 9 }, () => chunk), filler(64)]);
    expect(responses.length).toBe(1);
    expect((responses[0]!["error"] as { message: string }).message).toMatch(
      /line exceeds .* chars — discarded/,
    );
  });

  it("caps ABSOLUTELY, not just per chunk-boundary", async () => {
    // Review catch: the length test used to sit AFTER the newline-draining
    // loop, so an over-long line whose terminating newline arrived in the SAME
    // chunk as the overflow was drained (and JSON.parsed) before the check ever
    // ran. One chunk, over the cap, newline included — must still be refused.
    const responses = await drive([`${filler(MAX_PENDING_LINE_CHARS + 1000)}\n${PING}`]);
    expect(responses.length).toBe(2);
    expect((responses[0]!["error"] as { message: string }).message).toMatch(
      /line exceeds .* chars — discarded/,
    );
    // …and the request behind it on the same chunk is still served.
    expect(responses[1]!["id"]).toBe(7);
  });

  it("emits exactly one error per over-long line, twice in a row", async () => {
    const big = filler(MAX_PENDING_LINE_CHARS + 10);
    const responses = await drive([`${big}\n`, `${big}\n`, PING]);
    expect(responses.length).toBe(3);
    expect((responses[0]!["error"] as { message: string }).message).toMatch(/line exceeds/);
    expect((responses[1]!["error"] as { message: string }).message).toMatch(/line exceeds/);
    expect(responses[2]!["id"]).toBe(7);
  });

  it("does not corrupt a multibyte char split across chunks while skipping", async () => {
    // The decoder must run BEFORE the skip branch, or the second half of a
    // split UTF-8 sequence is dropped and the next line's first char is torn.
    const enc = new TextEncoder();
    const json = JSON.stringify({ jsonrpc: "2.0", id: "€uro", method: "ping" });
    const payload = enc.encode(json);
    // `€` is 3 bytes starting at this offset; cut one byte INTO it so the split
    // is genuinely mid-sequence rather than merely mid-string.
    const euroAt = enc.encode(json.slice(0, json.indexOf("€"))).length;
    const cut = euroAt + 1;
    const server = makeServer();
    const out: string[] = [];
    async function* input(): AsyncGenerator<Uint8Array> {
      yield enc.encode(filler(MAX_PENDING_LINE_CHARS + 10)); // blows the cap
      yield enc.encode("\n"); // resync
      yield payload.slice(0, cut);
      yield payload.slice(cut);
      yield enc.encode("\n");
    }
    await runStdioLoop(server, input(), (l) => out.push(l));
    server.close();
    const responses = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(responses.length).toBe(2);
    expect(responses[1]!["id"]).toBe("€uro");
  });

  it("passes normal traffic through untouched (the cap is not over-broad)", async () => {
    const responses = await drive([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`,
      // A split frame: the loop must still join the halves.
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }).slice(0, 20)}`,
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }).slice(20)}\n`,
      // A trailing line with NO newline still gets flushed.
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    ]);
    expect(responses.map((r) => r["id"])).toEqual([1, 2, 3]);
    for (const r of responses) expect(r["error"]).toBeUndefined();
  });

  it("caps the RESPONSE, not just the request", async () => {
    // Round 2: the input side was capped while the output side was not — the
    // wrong way round for an amplifier. A 156-BYTE request naming a 32 MiB
    // in-repo file produced a 67.1 MB response (430,000x), and 100 MiB reached
    // `RangeError: Out of memory` inside `JSON.stringify` — i.e. before a byte
    // could be written or logged. Drive it with a handler that returns an
    // oversized result directly, so the cap is what is under test rather than
    // the packer's file-size bound in front of it.
    const out: string[] = [];
    const huge = "y".repeat(MAX_RESPONSE_CHARS + 1024);
    const fake: ContextMcpServer = {
      handle: () => ({ jsonrpc: "2.0", id: 9, result: { content: huge } }),
      close: () => {},
    };
    async function* input(): AsyncGenerator<string> {
      yield PING;
    }
    await runStdioLoop(fake, input(), (l) => out.push(l));
    expect(out.length).toBe(1);
    const resp = JSON.parse(out[0]!) as Record<string, unknown>;
    // The oversized payload must not be on the wire at all.
    expect(out[0]!.length).toBeLessThan(MAX_RESPONSE_CHARS);
    expect(out[0]!).not.toContain(huge.slice(0, 1000));
    expect(resp["id"]).toBe(9);
    expect((resp["error"] as { message: string }).message).toMatch(/exceeds the .* limit/);
  });

  it("turns a non-serializable response into an error, not a crash", async () => {
    const out: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const fake: ContextMcpServer = {
      handle: () => ({ jsonrpc: "2.0", id: 11, result: cyclic }),
      close: () => {},
    };
    async function* input(): AsyncGenerator<string> {
      yield PING;
    }
    await runStdioLoop(fake, input(), (l) => out.push(l));
    expect(out.length).toBe(1);
    const resp = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(resp["id"]).toBe(11);
    expect((resp["error"] as { message: string }).message).toMatch(/could not be serialized/);
  });

  it("does not cap an ordinary-sized response", async () => {
    const out: string[] = [];
    const fake: ContextMcpServer = {
      handle: () => ({ jsonrpc: "2.0", id: 12, result: { content: "z".repeat(1024) } }),
      close: () => {},
    };
    async function* input(): AsyncGenerator<string> {
      yield PING;
    }
    await runStdioLoop(fake, input(), (l) => out.push(l));
    const resp = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(resp["error"]).toBeUndefined();
    expect((resp["result"] as { content: string }).content.length).toBe(1024);
  });

  it("still reports a parse error for a short malformed line", async () => {
    const responses = await drive(["not json\n"]);
    expect(responses.length).toBe(1);
    expect((responses[0]!["error"] as { message: string }).message).toBe("parse error");
  });
});
