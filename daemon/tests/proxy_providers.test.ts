/**
 * SURFACE #3 — the proxy's PROVIDER ADAPTERS (`src/proxy/providers.ts`).
 *
 * The packing core is provider-agnostic; these tests prove each vendor binding
 * walks its own request shape correctly: a `<file path="app.ts">` whole-file paste
 * + a focused instruction is packed down to one symbol's slice for OpenAI Chat
 * Completions and Google Gemini generateContent (string + parts content shapes),
 * the `matchPath` routing is right per vendor, and the forwarding shell preserves
 * Gemini's model-in-path on the way upstream.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { PROVIDERS, providerById } from "../src/proxy/providers.ts";
import { createProxyHandler } from "../src/proxy/server.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

const FN_SUMMARY: Record<string, string> = {
  alpha: "Parses the login authentication bearer token.",
  beta: "Renders the dashboard chart widget.",
  gamma: "Compresses the upload payload buffer.",
  delta: "Schedules the nightly database backup job.",
  epsilon: "Validates the billing invoice address.",
  zeta: "Resolves the DNS hostname cache entry.",
};

function buildAppFile(names: string[]): { content: string; ranges: Record<string, [number, number]> } {
  const lines: string[] = [`import { z } from "./z";`, ``];
  const ranges: Record<string, [number, number]> = {};
  for (const name of names) {
    const start = lines.length + 1;
    lines.push(
      `export function ${name}(): number {`,
      `  const a = 1;`, `  const b = 2;`, `  const c = 3;`, `  const d = 4;`,
      `  return a + b + c + d;`, `}`,
    );
    ranges[name] = [start, lines.length];
    lines.push(``);
  }
  return { content: lines.join("\n") + "\n", ranges };
}

function node(db: Db, id: string, name: string, file: string, range: [number, number],
  kind: NodeKind = "function", summary?: string) {
  db.upsertNode({
    id, name, qualified_name: id, kind, language: "typescript", file, range,
    ast_hash: "h", summary, last_seen: 0, logical_clock: 0,
  });
}

const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

function makeFixture(): { db: Db; root: string; appBody: string } {
  const { content, ranges } = buildAppFile(NAMES);
  const root = mkdtempSync(join(tmpdir(), "hayven-prov-"));
  const abs = join(root, "app.ts");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const db = new Db(":memory:");
  db.migrate();
  node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
  for (const n of NAMES) node(db, `app.ts::${n}`, n, "app.ts", ranges[n]!, "function", FN_SUMMARY[n]);
  return { db, root, appBody: content };
}

const INSTRUCTION = "fix the alpha login bearer token parsing";
const fileMarker = (body: string): string => `<file path="app.ts">\n${body}</file>`;

describe("proxy providers — path routing", () => {
  it("each provider matches only its own chat path", () => {
    expect(PROVIDERS.anthropic.matchPath("/v1/messages")).toBe(true);
    expect(PROVIDERS.openai.matchPath("/v1/chat/completions")).toBe(true);
    expect(PROVIDERS.gemini.matchPath("/v1beta/models/gemini-1.5-pro:generateContent")).toBe(true);
    expect(PROVIDERS.gemini.matchPath("/v1beta/models/gemini-1.5-pro:streamGenerateContent")).toBe(true);
    // cross-matches are false
    expect(PROVIDERS.anthropic.matchPath("/v1/chat/completions")).toBe(false);
    expect(PROVIDERS.openai.matchPath("/v1/messages")).toBe(false);
    expect(PROVIDERS.gemini.matchPath("/v1/messages")).toBe(false);
  });

  it("providerById resolves known ids and rejects unknown", () => {
    expect(providerById("openai")?.id).toBe("openai");
    expect(providerById("gemini")?.id).toBe("gemini");
    expect(providerById("nope")).toBeUndefined();
  });
});

describe("proxy providers — OpenAI Chat Completions", () => {
  it("packs a string-content user message", () => {
    const { db, root, appBody } = makeFixture();
    const body = {
      model: "gpt-x",
      messages: [{ role: "user", content: `${INSTRUCTION}\n\n${fileMarker(appBody)}` }],
    };
    const { body: out, stats, changed } = PROVIDERS.openai.rewrite(db, root, body);
    expect(changed).toBe(true);
    expect(stats.filesPacked).toBe(1);
    const text = (out as unknown as typeof body).messages[0]!.content as string;
    expect(text).toContain("[hayven context proxy]");
    expect(text).toContain("function alpha");
    expect(text).not.toContain("function zeta");
    db.close();
  });

  it("packs an array (text-parts) content message", () => {
    const { db, root, appBody } = makeFixture();
    const body = {
      model: "gpt-x",
      messages: [
        { role: "system", content: "you are a senior engineer" },
        {
          role: "user",
          content: [
            { type: "text", text: INSTRUCTION },
            { type: "text", text: fileMarker(appBody) },
          ],
        },
      ],
    };
    const { stats, changed } = PROVIDERS.openai.rewrite(db, root, body);
    expect(changed).toBe(true);
    expect(stats.filesPacked).toBe(1);
    db.close();
  });
});

describe("proxy providers — Google Gemini generateContent", () => {
  it("packs a contents/parts request, intent from systemInstruction + user parts", () => {
    const { db, root, appBody } = makeFixture();
    const body = {
      systemInstruction: { parts: [{ text: INSTRUCTION }] },
      contents: [
        { role: "user", parts: [{ text: "here is the file" }, { text: fileMarker(appBody) }] },
      ],
    };
    const { body: out, stats, changed } = PROVIDERS.gemini.rewrite(db, root, body);
    expect(changed).toBe(true);
    expect(stats.filesPacked).toBe(1);
    const parts = (out as unknown as typeof body).contents[0]!.parts;
    const joined = parts.map((p) => (p as { text: string }).text).join("\n");
    expect(joined).toContain("[hayven context proxy]");
    expect(joined).toContain("function alpha");
    expect(joined).not.toContain("function zeta");
    db.close();
  });

  it("leaves a request with no <file> marker unchanged", () => {
    const { db, root } = makeFixture();
    const body = { contents: [{ role: "user", parts: [{ text: "just chatting about alpha" }] }] };
    const { changed, stats } = PROVIDERS.gemini.rewrite(db, root, body);
    expect(changed).toBe(false);
    expect(stats.filesDetected).toBe(0);
    db.close();
  });
});

describe("proxy providers — forwarding shell preserves the Gemini model-in-path", () => {
  it("rewrites and forwards to the SAME :generateContent path", async () => {
    const { db, root, appBody } = makeFixture();
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const handler = createProxyHandler({
      db, repoRoot: root, upstream: "https://gen.example",
      provider: PROVIDERS.gemini, fetchImpl, onSavings: () => {},
    });

    const path = "/v1beta/models/gemini-1.5-pro:generateContent";
    const reqBody = JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCTION }] },
      contents: [{ role: "user", parts: [{ text: fileMarker(appBody) }] }],
    });
    const res = await handler(
      new Request("http://localhost" + path + "?key=REDACTED", { method: "POST", body: reqBody }),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://gen.example" + path + "?key=REDACTED"); // model-in-path + query preserved
    expect(calls[0]!.body).toContain("[hayven context proxy]"); // rewritten
    expect(calls[0]!.body).not.toContain("function zeta");
    db.close();
  });
});

describe("proxy providers — history-compaction dispatch (registry wiring)", () => {
  it("each provider exposes collectIntent + compactHistory and compacts its own read history", () => {
    const { db, root, appBody } = makeFixture();
    // An OpenAI read history: assistant Read tool_call + tool result (full file),
    // padded so the read is OLD, then the instruction.
    const openaiBody = {
      model: "gpt-x",
      messages: [
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "app.ts" }) } }] },
        { role: "tool", tool_call_id: "c1", content: appBody },
        { role: "assistant", content: "thinking" },
        { role: "user", content: "continue" },
        { role: "user", content: INSTRUCTION },
      ],
    };
    const oi = PROVIDERS.openai.collectIntent(openaiBody);
    expect(oi).toContain("alpha");
    const oc = PROVIDERS.openai.compactHistory(db, root, openaiBody, oi, { keepRecentMessages: 2 });
    expect(oc.changed).toBe(true);
    expect(oc.stats.occurrencesCompacted).toBe(1);

    // A Gemini read history: model functionCall + user functionResponse (full
    // file under `content`), padded old, then the instruction.
    const geminiBody = {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "Read", args: { path: "app.ts" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "Read", response: { content: appBody } } }] },
        { role: "model", parts: [{ text: "thinking" }] },
        { role: "user", parts: [{ text: "continue" }] },
        { role: "user", parts: [{ text: INSTRUCTION }] },
      ],
    };
    const gi = PROVIDERS.gemini.collectIntent(geminiBody);
    expect(gi).toContain("alpha");
    const gc = PROVIDERS.gemini.compactHistory(db, root, geminiBody, gi, { keepRecentMessages: 2 });
    expect(gc.changed).toBe(true);
    expect(gc.stats.occurrencesCompacted).toBe(1);

    // Non-conforming body → unchanged (the guard path).
    expect(PROVIDERS.gemini.compactHistory(db, root, { nope: 1 }, "x").changed).toBe(false);
    db.close();
  });
});
