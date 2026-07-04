/**
 * SURFACE #3 — graph-aware history compaction, GEMINI wire shape
 * (`src/proxy/history_compact_gemini.ts`).
 *
 * Mirrors `proxy_compact.test.ts` (the Anthropic path) on the Gemini request
 * shape: a request is `{ contents: [...] }`; a read CALL is a part
 * `{ functionCall:{ name, args } }` (path in `args.path`/`.file_path`), and a
 * read RESPONSE is a part `{ functionResponse:{ name, response } }` (the file
 * text under `response.content`/`.result`/`.output`/`.text`). These tests prove
 * the compactor (a) DETECTS old read responses paired by NAME+recency, (b)
 * compacts to the task-relevant SLICE when intent resolves (else a recovery
 * POINTER), (c) keeps the last N turns full (recency window), and (d) is a no-op
 * when no read functionCall is present — all never-worse / never-mutate.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  compactGeminiHistory,
  type GeminiRequest,
} from "../src/proxy/history_compact_gemini.ts";
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
  const root = mkdtempSync(join(tmpdir(), "hayven-gemini-compact-"));
  const abs = join(root, "app.ts");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const db = new Db(":memory:");
  db.migrate();
  node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
  for (const n of NAMES) node(db, `app.ts::${n}`, n, "app.ts", ranges[n]!, "function", FN_SUMMARY[n]);
  return { db, root, appBody: content };
}

/** A Gemini loop transcript: a model turn that CALLS Read(app.ts), a user turn
 *  with the functionResponse carrying the file text, then `pad` more turns, then
 *  the instruction — so the read sits in the OLD zone when keepRecent is small.
 *  `respKey` controls which response key the file text is written under. */
function readLoop(
  appBody: string,
  instruction: string,
  pad: number,
  respKey: "content" | "result" | "output" | "text" = "content",
): GeminiRequest {
  const contents: GeminiRequest["contents"] = [
    { role: "model", parts: [
      { text: "let me read the file" },
      { functionCall: { name: "Read", args: { path: "app.ts" } } },
    ] },
    { role: "user", parts: [
      { functionResponse: { name: "Read", response: { [respKey]: appBody } } },
    ] },
  ];
  for (let i = 0; i < pad; i++) {
    contents.push({ role: "model", parts: [{ text: `thinking step ${i}` }] });
    contents.push({ role: "user", parts: [{ text: `continue ${i}` }] });
  }
  contents.push({ role: "user", parts: [{ text: instruction }] });
  return { model: "gemini-x", contents };
}

/** Get the (possibly compacted) Read functionResponse text, from whichever of
 *  the conventional keys carries the string. */
function responseTextOf(body: GeminiRequest): string {
  for (const turn of body.contents) {
    if (!Array.isArray(turn.parts)) continue;
    for (const p of turn.parts) {
      const fr = (p as Record<string, unknown>)["functionResponse"] as
        | { name?: string; response?: Record<string, unknown> }
        | undefined;
      if (fr && fr.name === "Read" && fr.response) {
        for (const k of ["content", "result", "output", "text"]) {
          const v = fr.response[k];
          if (typeof v === "string") return v;
        }
      }
    }
  }
  return "";
}

describe("gemini history compaction — detect + compact OLD read functionResponses", () => {
  it("compacts an old read to the task-relevant SLICE when intent resolves", () => {
    const { db, root, appBody } = makeFixture();
    const body = readLoop(appBody, "fix the alpha login bearer token", 2);
    const { body: out, stats, changed } = compactGeminiHistory(
      db, root, body, "fix the alpha login bearer token", { keepRecentMessages: 2 },
    );
    expect(changed).toBe(true);
    expect(stats.occurrencesCompacted).toBe(1);
    expect(stats.savedTokens).toBeGreaterThan(0);
    const tr = responseTextOf(out);
    expect(tr).toContain("compacted to the slice relevant to your task");
    expect(tr).toContain("function alpha");
    expect(tr).not.toContain("function zeta"); // unrelated symbols dropped
    expect(stats.perFile[0]!.kind).toBe("slice");
  });

  it("falls back to a recovery POINTER when no symbol resolves", () => {
    const { db, root, appBody } = makeFixture();
    const body = readLoop(appBody, "zzqxwvk unrelated nonsense", 2);
    const { body: out, stats, changed } = compactGeminiHistory(
      db, root, body, "zzqxwvk unrelated nonsense", { keepRecentMessages: 2 },
    );
    expect(changed).toBe(true);
    expect(stats.perFile[0]!.kind).toBe("pointer");
    const tr = responseTextOf(out);
    expect(tr).toContain("elided from older context");
    expect(tr).toContain("app.ts");
    expect(tr).not.toContain("function alpha"); // full content gone, pointer only
  });

  it("preserves the response key the file text was under (here: result)", () => {
    const { db, root, appBody } = makeFixture();
    const body = readLoop(appBody, "fix the alpha login bearer token", 2, "result");
    const { body: out, changed } = compactGeminiHistory(
      db, root, body, "fix the alpha login bearer token", { keepRecentMessages: 2 },
    );
    expect(changed).toBe(true);
    // The compacted text must land back under `result`, not under `content`.
    for (const turn of out.contents) {
      for (const p of turn.parts ?? []) {
        const fr = (p as Record<string, unknown>)["functionResponse"] as
          | { name?: string; response?: Record<string, unknown> }
          | undefined;
        if (fr && fr.name === "Read" && fr.response) {
          expect(typeof fr.response["result"]).toBe("string");
          expect(fr.response["content"]).toBeUndefined();
          expect(String(fr.response["result"])).toContain("compacted to the slice");
        }
      }
    }
  });
});

describe("gemini history compaction — never-worse guards", () => {
  it("leaves recent reads intact (recency window)", () => {
    const { db, root, appBody } = makeFixture();
    // pad 0 → the read is in the last few turns; keepRecent 8 covers everything.
    const body = readLoop(appBody, "fix the alpha login token", 0);
    const { changed, stats } = compactGeminiHistory(
      db, root, body, "fix the alpha login token", { keepRecentMessages: 8 },
    );
    expect(changed).toBe(false);
    expect(stats.occurrencesCompacted).toBe(0);
    const tr = responseTextOf(body);
    expect(tr).toContain("function zeta"); // full file still present
  });

  it("does not compact a tiny read (pointer wouldn't be smaller)", () => {
    const { db, root } = makeFixture();
    const tiny = "ok\n";
    const body: GeminiRequest = {
      model: "gemini-x",
      contents: [
        { role: "model", parts: [
          { functionCall: { name: "Read", args: { path: "app.ts" } } },
        ] },
        { role: "user", parts: [
          { functionResponse: { name: "Read", response: { content: tiny } } },
        ] },
        { role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "b" }] },
        { role: "model", parts: [{ text: "c" }] }, { role: "user", parts: [{ text: "fix alpha" }] },
      ],
    };
    const { changed } = compactGeminiHistory(db, root, body, "fix alpha", { keepRecentMessages: 2 });
    expect(changed).toBe(false);
  });

  it("does nothing when there are no Read functionCalls", () => {
    const { db, root } = makeFixture();
    const body: GeminiRequest = {
      model: "gemini-x",
      contents: [
        { role: "user", parts: [{ text: "just chatting" }] },
        { role: "model", parts: [{ text: "sure" }] },
        { role: "user", parts: [{ text: "more" }] },
        { role: "model", parts: [{ text: "ok" }] },
        { role: "user", parts: [{ text: "fix alpha" }] },
      ],
    };
    const { changed } = compactGeminiHistory(db, root, body, "fix alpha", { keepRecentMessages: 1 });
    expect(changed).toBe(false);
  });
});
