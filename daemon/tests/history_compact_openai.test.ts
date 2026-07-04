/**
 * SURFACE #3 — graph-aware history compaction, OpenAI Chat Completions shape
 * (`src/proxy/history_compact_openai.ts`).
 *
 * Mirrors `proxy_compact.test.ts` (the Anthropic suite) over the OpenAI wire:
 * a tool CALL is an assistant message with `tool_calls:[{id, function:{name,
 * arguments}}]` (arguments a JSON string) and a tool RESULT is its own
 * `{role:"tool", tool_call_id, content}` message. We prove the compactor
 * (a) compacts an OLD read to the task-relevant SLICE when intent resolves,
 * (b) falls back to a recovery POINTER otherwise, (c) keeps recent reads full
 * (recency window), and (d) is a no-op when there are no Read tool calls.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compactOpenAIHistory } from "../src/proxy/history_compact_openai.ts";
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
const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

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

function makeFixture(): { db: Db; root: string; appBody: string } {
  const { content, ranges } = buildAppFile(NAMES);
  const root = mkdtempSync(join(tmpdir(), "hayven-compact-openai-"));
  const abs = join(root, "app.ts");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const db = new Db(":memory:");
  db.migrate();
  node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
  for (const n of NAMES) node(db, `app.ts::${n}`, n, "app.ts", ranges[n]!, "function", FN_SUMMARY[n]);
  return { db, root, appBody: content };
}

/** An OpenAI loop transcript: an early assistant tool_call reading app.ts, then
 *  its `role:"tool"` result, then `pad` more turns, then the instruction — so the
 *  read sits in the OLD zone when keepRecent is small. */
function readLoop(appBody: string, instruction: string, pad: number): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [
    {
      role: "assistant",
      content: "let me read the file",
      tool_calls: [
        { id: "tc1", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "app.ts" }) } },
      ],
    },
    { role: "tool", tool_call_id: "tc1", content: appBody },
  ];
  for (let i = 0; i < pad; i++) {
    messages.push({ role: "assistant", content: `thinking step ${i}` });
    messages.push({ role: "user", content: `continue ${i}` });
  }
  messages.push({ role: "user", content: instruction });
  return { model: "gpt-x", messages };
}

/** Get the (possibly compacted) tool-result content for tc1. */
function toolResultOf(body: unknown): string {
  const b = body as { messages?: unknown[] };
  for (const m of b.messages ?? []) {
    const rec = m as Record<string, unknown>;
    if (rec["role"] === "tool" && rec["tool_call_id"] === "tc1") {
      return typeof rec["content"] === "string" ? rec["content"] : JSON.stringify(rec["content"]);
    }
  }
  return "";
}

describe("openai history compaction — detect + compact OLD native Read results", () => {
  it("compacts an old read to the task-relevant SLICE when intent resolves", () => {
    const { db, root, appBody } = makeFixture();
    const body = readLoop(appBody, "fix the alpha login bearer token", 2);
    const { body: out, stats, changed } = compactOpenAIHistory(
      db, root, body, "fix the alpha login bearer token", { keepRecentMessages: 2 },
    );
    expect(changed).toBe(true);
    expect(stats.occurrencesCompacted).toBe(1);
    expect(stats.savedTokens).toBeGreaterThan(0);
    const tr = toolResultOf(out);
    expect(tr).toContain("compacted to the slice relevant to your task");
    expect(tr).toContain("function alpha");
    expect(tr).not.toContain("function zeta"); // unrelated symbols dropped
    expect(stats.perFile[0]!.kind).toBe("slice");
  });

  it("falls back to a recovery POINTER when no symbol resolves", () => {
    const { db, root, appBody } = makeFixture();
    const body = readLoop(appBody, "zzqxwvk unrelated nonsense", 2);
    const { body: out, stats, changed } = compactOpenAIHistory(
      db, root, body, "zzqxwvk unrelated nonsense", { keepRecentMessages: 2 },
    );
    expect(changed).toBe(true);
    expect(stats.perFile[0]!.kind).toBe("pointer");
    const tr = toolResultOf(out);
    expect(tr).toContain("elided from older context");
    expect(tr).toContain("app.ts");
    expect(tr).not.toContain("function alpha"); // full content gone, pointer only
  });
});

describe("openai history compaction — never-worse guards", () => {
  it("leaves recent reads intact (recency window)", () => {
    const { db, root, appBody } = makeFixture();
    // pad 0 → the read is in the last few messages; keepRecent 8 covers everything.
    const body = readLoop(appBody, "fix the alpha login token", 0);
    const { changed, stats } = compactOpenAIHistory(
      db, root, body, "fix the alpha login token", { keepRecentMessages: 8 },
    );
    expect(changed).toBe(false);
    expect(stats.occurrencesCompacted).toBe(0);
    const tr = toolResultOf(body);
    expect(tr).toContain("function zeta"); // full file still present
  });

  it("does not compact a tiny read (pointer wouldn't be smaller)", () => {
    const { db, root } = makeFixture();
    const tiny = "ok\n";
    const body: Record<string, unknown> = {
      model: "gpt-x",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: "tc1", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: "app.ts" }) } },
          ],
        },
        { role: "tool", tool_call_id: "tc1", content: tiny },
        { role: "assistant", content: "a" }, { role: "user", content: "b" },
        { role: "assistant", content: "c" }, { role: "user", content: "fix alpha" },
      ],
    };
    const { changed } = compactOpenAIHistory(db, root, body, "fix alpha", { keepRecentMessages: 2 });
    expect(changed).toBe(false);
  });

  it("does nothing when there are no Read tool calls", () => {
    const { db, root } = makeFixture();
    const body: Record<string, unknown> = {
      model: "gpt-x",
      messages: [
        { role: "user", content: "just chatting" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "more" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "fix alpha" },
      ],
    };
    const { changed } = compactOpenAIHistory(db, root, body, "fix alpha", { keepRecentMessages: 1 });
    expect(changed).toBe(false);
  });
});
