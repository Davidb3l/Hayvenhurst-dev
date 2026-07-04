/**
 * SURFACE #3 — the transparent context proxy (`src/proxy/`).
 *
 * Two layers, both driven against a tiny REAL fixture index (an in-memory `Db`
 * over a temp on-disk repo — the same idiom as `mcp_context.test.ts`):
 *
 *   1. PURE CORE (`rewriteMessagesForContext`): a `<file path="app.ts">` whole-file
 *      paste + a live instruction naming one symbol → the block is replaced by a
 *      strictly-smaller graph pack of just that symbol; plus the three never-worse
 *      fallbacks (file not indexed / not a whole-file paste / no in-file symbol
 *      matched the intent) leave the block byte-for-byte intact.
 *   2. FORWARDING SHELL (`createProxyHandler`): a STUB upstream `fetch` captures
 *      what the proxy forwards — assert POST /v1/messages forwards the REWRITTEN
 *      (smaller) body, a non-messages path is relayed untouched, and a malformed
 *      body is forwarded verbatim (never a 500).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  rewriteMessagesForContext,
  type MessagesRequest,
} from "../src/proxy/context_rewrite.ts";
import { createProxyHandler } from "../src/proxy/server.ts";
import { PROVIDERS } from "../src/proxy/providers.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

// Build an `app.ts` of N functions (8 lines each) with a leading import header,
// returning the content + each function's exact 1-based line range. Big enough
// that a single-function slice is comfortably smaller than the whole file.
function buildAppFile(
  names: string[],
): { content: string; ranges: Record<string, [number, number]> } {
  const lines: string[] = [`import { z } from "./z";`, ``];
  const ranges: Record<string, [number, number]> = {};
  for (const name of names) {
    const start = lines.length + 1;
    lines.push(
      `export function ${name}(): number {`,
      `  // ${name} computes the ${name} total`,
      `  const a = 1;`,
      `  const b = 2;`,
      `  const c = 3;`,
      `  const d = 4;`,
      `  return a + b + c + d;`,
      `}`,
    );
    ranges[name] = [start, lines.length];
    lines.push(``);
  }
  return { content: lines.join("\n") + "\n", ranges };
}

function writeRepo(files: ReadonlyArray<readonly [string, string]>): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-proxy-"));
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
  name: string,
  file: string,
  range: [number, number],
  kind: NodeKind = "function",
  summary?: string,
) {
  db.upsertNode({
    id,
    name,
    qualified_name: id,
    kind,
    language: "typescript",
    file,
    range,
    ast_hash: "h",
    summary,
    last_seen: 0,
    logical_clock: 0,
  });
}

const FN_NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

// DISTINCT summaries so a focused instruction resolves to ONE function (shared
// tokens would resolve the intent to the whole file → a pack that isn't smaller →
// the never-worse fallback, which is correct but not what these tests exercise).
const FN_SUMMARY: Record<string, string> = {
  alpha: "Parses the login authentication bearer token.",
  beta: "Renders the dashboard chart widget.",
  gamma: "Compresses the upload payload buffer.",
  delta: "Schedules the nightly database backup job.",
  epsilon: "Validates the billing invoice address.",
  zeta: "Resolves the DNS hostname cache entry.",
};

/** Seed the fixture: a real on-disk app.ts + its indexed nodes, plus an
 *  un-indexed notes.md on disk. Returns the db, repo root, and the file body. */
function makeFixture(): { db: Db; root: string; appBody: string } {
  const { content, ranges } = buildAppFile(FN_NAMES);
  const notes = "# Notes\n\nThis markdown file is on disk but is NOT indexed as code.\n";
  const root = writeRepo([
    ["app.ts", content],
    ["notes.md", notes],
  ]);
  const db = new Db(":memory:");
  db.migrate();
  node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
  for (const name of FN_NAMES) {
    node(db, `app.ts::${name}`, name, "app.ts", ranges[name]!, "function", FN_SUMMARY[name]);
  }
  return { db, root, appBody: content };
}

/** A request body with one user turn: an instruction + a `<file>` paste. */
function bodyWith(instruction: string, filePath: string, fileBody: string): MessagesRequest {
  return {
    model: "claude-x",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${instruction}\n\n<file path="${filePath}">\n${fileBody}</file>` },
        ],
      },
    ],
  };
}

/** Pull the single user text block out of a (rewritten) body. */
function userText(body: MessagesRequest): string {
  const c = body.messages[0]!.content;
  if (typeof c === "string") return c;
  const t = c.find((b) => b.type === "text") as { text: string } | undefined;
  return t?.text ?? "";
}

describe("context proxy — pure core rewrite (packs a whole-file paste)", () => {
  it("replaces the whole-file paste with a strictly-smaller slice of the named symbol", () => {
    const { db, root, appBody } = makeFixture();
    const body = bodyWith("Please fix the alpha login token parsing.", "app.ts", appBody);

    const { body: out, stats, changed } = rewriteMessagesForContext(db, root, body);

    expect(changed).toBe(true);
    expect(stats.filesDetected).toBe(1);
    expect(stats.filesPacked).toBe(1);
    expect(stats.perFile[0]!.action).toBe("packed");
    expect(stats.savedTokens).toBeGreaterThan(0);
    expect(stats.tokensAfter).toBeLessThan(stats.tokensBefore);

    const text = userText(out);
    expect(text).toContain("[hayven context proxy]");
    expect(text).toContain("function alpha"); // the requested symbol survives
    expect(text).not.toContain("function zeta"); // unrelated symbols are sliced out
    expect(text).not.toContain("function epsilon");
    // The instruction prose is preserved.
    expect(text).toContain("fix the alpha login token");
    db.close();
  });

  it("input body is not mutated (returns a new object)", () => {
    const { db, root, appBody } = makeFixture();
    const body = bodyWith("fix the alpha login token parsing", "app.ts", appBody);
    const before = JSON.stringify(body);
    rewriteMessagesForContext(db, root, body);
    expect(JSON.stringify(body)).toBe(before);
    db.close();
  });
});

describe("context proxy — never-worse fallbacks (block left intact)", () => {
  it("an un-indexed file is passed through unchanged", () => {
    const { db, root } = makeFixture();
    const notes = "# Notes\n\nThis markdown file is on disk but is NOT indexed as code.\n";
    const body = bodyWith("summarize the notes about alpha", "notes.md", notes);
    const { stats, changed } = rewriteMessagesForContext(db, root, body);
    expect(changed).toBe(false);
    expect(stats.perFile[0]!.action).toBe("not-indexed");
    expect(stats.savedTokens).toBe(0);
    db.close();
  });

  it("a paste that isn't the whole on-disk file is passed through", () => {
    const { db, root } = makeFixture();
    // A partial/edited snippet that does NOT contain the real file content.
    const body = bodyWith(
      "fix the alpha total",
      "app.ts",
      "export function alpha() { return 999; } // edited, not the real file\n",
    );
    const { stats, changed } = rewriteMessagesForContext(db, root, body);
    expect(changed).toBe(false);
    expect(stats.perFile[0]!.action).toBe("not-whole-file");
    db.close();
  });

  it("an instruction matching no in-file symbol is passed through", () => {
    const { db, root, appBody } = makeFixture();
    const body = bodyWith("zzqxwvk qqxzzwq unrelated nonsense", "app.ts", appBody);
    const { stats, changed } = rewriteMessagesForContext(db, root, body);
    expect(changed).toBe(false);
    expect(stats.perFile[0]!.action).toBe("no-intent");
    db.close();
  });

  it("a path escaping the repo root is refused", () => {
    const { db, root } = makeFixture();
    const body = bodyWith("fix it", "../../etc/passwd", "root:x:0:0:".padEnd(80, "y") + "\n");
    const { stats, changed } = rewriteMessagesForContext(db, root, body);
    expect(changed).toBe(false);
    expect(stats.perFile[0]!.action).toBe("unreadable");
    db.close();
  });
});

describe("context proxy — slice fidelity + multi-marker + content shapes", () => {
  it("preserves `$` patterns in the sliced code (no String.replace corruption)", () => {
    // alpha's body holds `$&` and `$$` — a STRING replacement would reinterpret
    // these and silently mangle the slice. The function-replacement fix keeps them.
    const content =
      [
        `import { z } from "./z";`,
        ``,
        `export function alpha(): string {`,
        `  // login bearer token parsing`,
        `  const sentinel = "$&$$";`,
        "  const price = `cost is $${z}`;",
        `  return sentinel + price;`,
        `}`,
        ``,
        `export function beta(): number { return 2; }`,
        `export function gamma(): number { return 3; }`,
        `export function delta(): number { return 4; }`,
        `export function epsilon(): number { return 5; }`,
        `export function zeta(): number { return 6; }`,
        ``,
      ].join("\n") + "\n";
    const root = writeRepo([["app.ts", content]]);
    const db = new Db(":memory:");
    db.migrate();
    node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
    node(db, "app.ts::alpha", "alpha", "app.ts", [3, 8], "function",
      "Parses the login authentication bearer token.");
    for (const [i, name] of ["beta", "gamma", "delta", "epsilon", "zeta"].entries()) {
      node(db, `app.ts::${name}`, name, "app.ts", [10 + i, 10 + i], "function",
        FN_SUMMARY[name]);
    }

    const body = bodyWith("fix the alpha login bearer token parsing", "app.ts", content);
    const { body: out, stats, changed } = rewriteMessagesForContext(db, root, body);

    expect(changed).toBe(true);
    expect(stats.perFile[0]!.action).toBe("packed");
    const text = userText(out);
    expect(text).toContain('"$&$$"'); // the dollar sentinel survives intact
    expect(text).toContain("cost is $${z}"); // the template literal survives
    db.close();
  });

  it("packs multiple markers across multiple files in one request", () => {
    // Bulky files (target + 4 padding fns) so a single-symbol slice clearly beats
    // the whole file — small files lose to the pack's own markdown overhead.
    const aBuilt = buildAppFile(["alpha", "p1", "p2", "p3", "p4"]);
    const bBuilt = buildAppFile(["render", "q1", "q2", "q3", "q4"]);
    const a = aBuilt.content;
    const b = bBuilt.content;
    const root = writeRepo([["a.ts", a], ["b.ts", b]]);
    const db = new Db(":memory:");
    db.migrate();
    node(db, "a.ts::module", "a.ts", "a.ts", [1, 1], "module");
    node(db, "b.ts::module", "b.ts", "b.ts", [1, 1], "module");
    node(db, "a.ts::alpha", "alpha", "a.ts", aBuilt.ranges["alpha"]!, "function",
      "Parses the login authentication bearer token.");
    node(db, "b.ts::render", "render", "b.ts", bBuilt.ranges["render"]!, "function",
      "Renders the dashboard chart widget.");
    for (const n of ["p1", "p2", "p3", "p4"])
      node(db, `a.ts::${n}`, n, "a.ts", aBuilt.ranges[n]!, "function", `Unrelated helper ${n}.`);
    for (const n of ["q1", "q2", "q3", "q4"])
      node(db, `b.ts::${n}`, n, "b.ts", bBuilt.ranges[n]!, "function", `Unrelated helper ${n}.`);

    const body: MessagesRequest = {
      model: "claude-x",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                `Wire the alpha login token into the render dashboard widget.\n\n` +
                `<file path="a.ts">\n${a}</file>\n\n<file path="b.ts">\n${b}</file>`,
            },
          ],
        },
      ],
    };
    const { stats, changed } = rewriteMessagesForContext(db, root, body);
    expect(changed).toBe(true);
    expect(stats.filesDetected).toBe(2);
    expect(stats.filesPacked).toBe(2);
    db.close();
  });

  it("handles a string-content message (not a block array)", () => {
    const { db, root, appBody } = makeFixture();
    const body: MessagesRequest = {
      model: "claude-x",
      messages: [
        {
          role: "user",
          content: `fix the alpha login token parsing\n\n<file path="app.ts">\n${appBody}</file>`,
        },
      ],
    };
    const { body: out, stats, changed } = rewriteMessagesForContext(db, root, body);
    expect(changed).toBe(true);
    expect(stats.perFile[0]!.action).toBe("packed");
    expect(typeof out.messages[0]!.content).toBe("string");
    expect(out.messages[0]!.content as string).toContain("[hayven context proxy]");
    db.close();
  });
});

describe("context proxy — forwarding shell (stub upstream)", () => {
  /** A stub `fetch` that records the last call and returns a canned 200. */
  function stub(): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("POST /v1/messages forwards the REWRITTEN body upstream", async () => {
    const { db, root, appBody } = makeFixture();
    const { fetchImpl, calls } = stub();
    const handler = createProxyHandler({
      db, repoRoot: root, upstream: "https://up.example",
      provider: PROVIDERS.anthropic, fetchImpl, onSavings: () => {},
    });

    const reqBody = JSON.stringify(bodyWith("fix the alpha login token parsing", "app.ts", appBody));
    const res = await handler(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test" },
        body: reqBody,
      }),
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://up.example/v1/messages");
    const forwarded = JSON.parse(calls[0]!.init!.body as string) as MessagesRequest;
    const fwdText = userText(forwarded);
    expect(fwdText).toContain("[hayven context proxy]"); // rewritten
    expect(fwdText).not.toContain("function zeta"); // sliced
    // Auth header is relayed, not stripped.
    expect(new Headers(calls[0]!.init!.headers).get("x-api-key")).toBe("sk-test");
    db.close();
  });

  it("strips upstream content-encoding/length from the relayed response (real-API gzip → ZlibError guard)", async () => {
    const { db, root, appBody } = makeFixture();
    // The runtime's fetch DECODES a gzipped upstream body before we relay it, but
    // leaves the stale `content-encoding`/`content-length` headers on the Response.
    // Re-advertising them makes a real client try to gunzip plain bytes (ZlibError
    // against live Anthropic). Stub a decoded body carrying those stale headers.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip", // stale: body is already decoded
          "content-length": "488", // stale: wrong for the decoded body
        },
      })) as unknown as typeof fetch;
    const handler = createProxyHandler({
      db, repoRoot: root, upstream: "https://up.example",
      provider: PROVIDERS.anthropic, fetchImpl, onSavings: () => {},
    });

    for (const path of ["/v1/messages", "/api/anything"]) {
      const res = await handler(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "sk-test" },
          body: JSON.stringify(bodyWith("fix alpha", "app.ts", appBody)),
        }),
      );
      expect(res.headers.get("content-encoding")).toBeNull(); // stripped
      expect(res.headers.get("content-length")).toBeNull(); // stripped
      expect(res.headers.get("content-type")).toBe("application/json"); // preserved
      expect(await res.json()).toEqual({ ok: true }); // body still readable
    }
    db.close();
  });

  it("a non-/v1/messages request is relayed untouched", async () => {
    const { db, root } = makeFixture();
    const { fetchImpl, calls } = stub();
    const handler = createProxyHandler({
      db, repoRoot: root, upstream: "https://up.example",
      provider: PROVIDERS.anthropic, fetchImpl, onSavings: () => {},
    });
    const res = await handler(new Request("http://localhost/v1/models", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("https://up.example/v1/models");
    db.close();
  });

  it("a malformed JSON body is forwarded verbatim, never a 500", async () => {
    const { db, root } = makeFixture();
    const { fetchImpl, calls } = stub();
    const handler = createProxyHandler({
      db, repoRoot: root, upstream: "https://up.example",
      provider: PROVIDERS.anthropic, fetchImpl, onSavings: () => {},
    });
    const res = await handler(
      new Request("http://localhost/v1/messages", { method: "POST", body: "{ not json" }),
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.init!.body).toBe("{ not json");
    db.close();
  });
});
