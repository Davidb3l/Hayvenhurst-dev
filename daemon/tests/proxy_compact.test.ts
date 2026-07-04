/**
 * SURFACE #3 — graph-aware history compaction (`src/proxy/history_compact.ts`).
 *
 * The re-send multiplier: a file read early in a loop is re-sent in the history
 * every turn after. These tests prove the compactor (a) DETECTS native `Read`
 * tool results (not `<file>`-wrapped), (b) keeps the last N messages full and only
 * compacts OLDER reads, (c) compacts to the task-relevant SLICE when intent
 * resolves (else a recovery POINTER), and (d) is never-worse (a small read, or a
 * recent one, is left intact). Plus a server integration with `--compact-history`.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compactAnthropicHistory } from "../src/proxy/history_compact.ts";
import { createProxyHandler } from "../src/proxy/server.ts";
import { PROVIDERS } from "../src/proxy/providers.ts";
import type { MessagesRequest } from "../src/proxy/context_rewrite.ts";
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
  const root = mkdtempSync(join(tmpdir(), "hayven-compact-"));
  const abs = join(root, "app.ts");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const db = new Db(":memory:");
  db.migrate();
  node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
  for (const n of NAMES) node(db, `app.ts::${n}`, n, "app.ts", ranges[n]!, "function", FN_SUMMARY[n]);
  return { db, root, appBody: content };
}

/** A loop transcript: an early Read of app.ts, then `pad` more turns, then the
 *  instruction — so the read sits in the OLD zone when keepRecent is small. */
function readLoop(appBody: string, instruction: string, pad: number): MessagesRequest {
  const msgs: MessagesRequest["messages"] = [
    { role: "assistant", content: [
      { type: "text", text: "let me read the file" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "app.ts" } } as never,
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu1", content: appBody } as never,
    ] },
  ];
  for (let i = 0; i < pad; i++) {
    msgs.push({ role: "assistant", content: `thinking step ${i}` });
    msgs.push({ role: "user", content: `continue ${i}` });
  }
  msgs.push({ role: "user", content: instruction });
  return { model: "claude-x", messages: msgs };
}

/** Get the (possibly compacted) tool_result content for tu1. */
function toolResultOf(body: MessagesRequest): string {
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      const rec = b as Record<string, unknown>;
      if (rec["type"] === "tool_result" && rec["tool_use_id"] === "tu1") {
        return typeof rec["content"] === "string" ? rec["content"] : JSON.stringify(rec["content"]);
      }
    }
  }
  return "";
}

describe("history compaction — detect + compact OLD native Read results", () => {
  it("compacts an old read to the task-relevant SLICE when intent resolves", () => {
    const { db, root, appBody } = makeFixture();
    const body = readLoop(appBody, "fix the alpha login bearer token", 2);
    const { body: out, stats, changed } = compactAnthropicHistory(
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
    const { body: out, stats, changed } = compactAnthropicHistory(
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

describe("history compaction — never-worse guards", () => {
  it("leaves recent reads intact (recency window)", () => {
    const { db, root, appBody } = makeFixture();
    // pad 0 → the read is in the last few messages; keepRecent 8 covers everything.
    const body = readLoop(appBody, "fix the alpha login token", 0);
    const { changed, stats } = compactAnthropicHistory(
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
    const body: MessagesRequest = {
      model: "claude-x",
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "app.ts" } } as never,
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: tiny } as never] },
        { role: "assistant", content: "a" }, { role: "user", content: "b" },
        { role: "assistant", content: "c" }, { role: "user", content: "fix alpha" },
      ],
    };
    const { changed } = compactAnthropicHistory(db, root, body, "fix alpha", { keepRecentMessages: 2 });
    expect(changed).toBe(false);
  });

  it("does nothing when there are no Read tool_uses", () => {
    const { db, root } = makeFixture();
    const body: MessagesRequest = {
      model: "claude-x",
      messages: [
        { role: "user", content: "just chatting" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "more" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "fix alpha" },
      ],
    };
    const { changed } = compactAnthropicHistory(db, root, body, "fix alpha", { keepRecentMessages: 1 });
    expect(changed).toBe(false);
  });
});

/** A loop transcript that READS app.ts early, pads, then EDITS app.ts later (an
 *  Edit tool_use) — so when keepRecent is small the read is OLD but the file is
 *  flagged edited. `editName` (`undefined` → no edit) controls the trailing edit;
 *  `editTool` lets us exercise the different edit tool names + input fields. */
function readThenEditLoop(
  appBody: string,
  instruction: string,
  pad: number,
  edit?: { tool: string; field: "file_path" | "path"; path: string },
): MessagesRequest {
  const msgs: MessagesRequest["messages"] = [
    { role: "assistant", content: [
      { type: "text", text: "let me read the file" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "app.ts" } } as never,
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "tu1", content: appBody } as never,
    ] },
  ];
  if (edit) {
    msgs.push({ role: "assistant", content: [
      { type: "tool_use", id: "tu-edit", name: edit.tool, input: { [edit.field]: edit.path } } as never,
    ] });
    msgs.push({ role: "user", content: [
      { type: "tool_result", tool_use_id: "tu-edit", content: "ok edited" } as never,
    ] });
  }
  for (let i = 0; i < pad; i++) {
    msgs.push({ role: "assistant", content: `thinking step ${i}` });
    msgs.push({ role: "user", content: `continue ${i}` });
  }
  msgs.push({ role: "user", content: instruction });
  return { model: "claude-x", messages: msgs };
}

/** Like {@link makeFixture} but the on-disk read content is PADDED with comment
 *  banners + blank lines between functions, so a slice of the file's symbols is
 *  meaningfully SMALLER than the raw read (which carries all that non-symbol
 *  filler) — letting the edited-symbol slice clear the never-worse-on-bytes gate
 *  even when it retains every symbol. The Db node ranges stay the real symbol
 *  spans; the extra read bytes are filler the slice legitimately drops. */
function makeFixturePadded(): { db: Db; root: string; appBody: string } {
  const { db, root, appBody } = makeFixture();
  // Re-inflate the read body the agent saw with filler the indexed symbols omit.
  const banner = "// " + "=".repeat(70) + "\n";
  const filler = (banner + "// padding line\n".repeat(8) + "\n");
  const inflated = filler + appBody.split("\n\n").join("\n\n" + filler) + filler;
  return { db, root, appBody: inflated };
}

describe("history compaction — #5 retain EDITED / recently-referenced symbols", () => {
  // An intent that does NOT resolve to any in-file symbol — without the edited
  // bias this read compacts to a bare POINTER (its code is dropped). The file is
  // edited later, so the edited bias must keep the file's symbols in the slice.
  const DRIFTED_INTENT = "zzqxwvk unrelated nonsense";

  it("keeps the edited file's symbols in the slice when the read drifted (edited code survives)", () => {
    const { db, root, appBody } = makeFixturePadded();
    const body = readThenEditLoop(
      appBody, DRIFTED_INTENT, 2,
      { tool: "Edit", field: "file_path", path: "app.ts" },
    );
    const { body: out, stats, changed } = compactAnthropicHistory(
      db, root, body, DRIFTED_INTENT, { keepRecentMessages: 2 },
    );
    expect(changed).toBe(true);
    // It's a SLICE, not a bare pointer — the actively-edited code survived.
    expect(stats.perFile[0]!.kind).toBe("slice");
    const tr = toolResultOf(out);
    expect(tr).toContain("compacted to the slice relevant to your task");
    expect(tr).toContain("function alpha"); // edited file's symbols retained
    expect(stats.savedTokens).toBeGreaterThan(0); // still strictly smaller
  });

  it("without the edit, the same drifted read compacts to a bare POINTER (baseline)", () => {
    const { db, root, appBody } = makeFixture();
    const body = readThenEditLoop(appBody, DRIFTED_INTENT, 2 /* no edit */);
    const { body: out, stats } = compactAnthropicHistory(
      db, root, body, DRIFTED_INTENT, { keepRecentMessages: 2 },
    );
    expect(stats.perFile[0]!.kind).toBe("pointer");
    const tr = toolResultOf(out);
    expect(tr).toContain("elided from older context");
    expect(tr).not.toContain("function alpha"); // code dropped — the problem #5 fixes
  });

  it("an explicit opts.editedFiles set (out-of-band) also retains the file's symbols", () => {
    const { db, root, appBody } = makeFixturePadded();
    const body = readThenEditLoop(appBody, DRIFTED_INTENT, 2 /* no edit tool_use */);
    const { body: out, stats } = compactAnthropicHistory(
      db, root, body, DRIFTED_INTENT,
      { keepRecentMessages: 2, editedFiles: new Set(["app.ts"]) },
    );
    expect(stats.perFile[0]!.kind).toBe("slice");
    expect(toolResultOf(out)).toContain("function alpha");
  });

  it("collects edits from the `path` field and str_replace-style tool names too", () => {
    const { db, root, appBody } = makeFixturePadded();
    const body = readThenEditLoop(
      appBody, DRIFTED_INTENT, 2,
      { tool: "str_replace_based_edit_tool", field: "path", path: "app.ts" },
    );
    const { stats } = compactAnthropicHistory(
      db, root, body, DRIFTED_INTENT, { keepRecentMessages: 2 },
    );
    expect(stats.perFile[0]!.kind).toBe("slice");
  });

  it("a DIFFERENT edited file does NOT bias an unrelated read (no false retention)", () => {
    const { db, root, appBody } = makeFixture();
    const body = readThenEditLoop(
      appBody, DRIFTED_INTENT, 2,
      { tool: "Edit", field: "file_path", path: "other.ts" }, // edits a different file
    );
    const { stats } = compactAnthropicHistory(
      db, root, body, DRIFTED_INTENT, { keepRecentMessages: 2 },
    );
    // app.ts was not edited → drifted read still falls back to a pointer.
    expect(stats.perFile[0]!.kind).toBe("pointer");
  });

  it("regression guard — with NO edited files the output is byte-identical to today", () => {
    const { db, root, appBody } = makeFixture();
    // Use the original readLoop (no edit tool_use) for both arms.
    const intents = ["fix the alpha login bearer token", DRIFTED_INTENT];
    for (const intent of intents) {
      const baseline = compactAnthropicHistory(
        db, root, readLoop(appBody, intent, 2), intent, { keepRecentMessages: 2 },
      );
      const withEmpty = compactAnthropicHistory(
        db, root, readLoop(appBody, intent, 2), intent,
        { keepRecentMessages: 2, editedFiles: new Set() },
      );
      // Byte-identical bodies (and identical compaction outcome).
      expect(JSON.stringify(withEmpty.body)).toBe(JSON.stringify(baseline.body));
      expect(withEmpty.changed).toBe(baseline.changed);
      expect(withEmpty.stats.perFile[0]?.kind).toBe(baseline.stats.perFile[0]?.kind);
    }
  });

  it("never-worse still holds — a tiny edited read is left intact (no slice grows it)", () => {
    const { db, root } = makeFixture();
    const tiny = "ok\n";
    const body: MessagesRequest = {
      model: "claude-x",
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "app.ts" } } as never,
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: tiny } as never] },
        { role: "assistant", content: [
          { type: "tool_use", id: "tu-edit", name: "Edit", input: { file_path: "app.ts" } } as never,
        ] },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" }, { role: "user", content: "fix alpha" },
      ],
    };
    const { changed } = compactAnthropicHistory(db, root, body, "fix alpha", { keepRecentMessages: 2 });
    // Even though app.ts is edited, the original read is tiny — a slice would be
    // LARGER, so never-worse leaves it untouched.
    expect(changed).toBe(false);
  });
});

describe("history compaction — server integration (--compact-history)", () => {
  it("compacts old reads end-to-end and forwards the smaller body", async () => {
    const { db, root, appBody } = makeFixture();
    const calls: Array<{ body: string }> = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const handler = createProxyHandler({
      db, repoRoot: root, upstream: "https://up.example",
      provider: PROVIDERS.anthropic, fetchImpl, onSavings: () => {},
      compact: { keepRecentMessages: 2 },
    });

    const body = readLoop(appBody, "fix the alpha login token", 2);
    const res = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain("compacted to the slice relevant to your task");
    expect(calls[0]!.body).not.toContain("function zeta");
    db.close();
  });
});
