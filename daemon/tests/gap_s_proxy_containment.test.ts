/**
 * GAP S1 — the proxy kept its own LEXICAL-ONLY copies of containment.
 *
 * `proxy/context_rewrite.ts` and `proxy/history_compact.ts` each carried a
 * byte-identical private `toRepoRelative` that compared only the LEXICALLY
 * resolved path against the repo root. Neither got the realpath hop that
 * `resolveWithinRepo` grew, so they disagreed with the packer in both
 * directions:
 *
 *   - ESCAPE: an in-repo name symlinked to an out-of-tree file was BLESSED, and
 *     `context_rewrite.ts` then `readFileSync`'d it — an unbounded, potentially
 *     BLOCKING read of a file outside the repository on the request path of a
 *     process that talks to a third-party API. (The bytes were only compared,
 *     never inserted into the outgoing prompt — see the lane report — but the
 *     read itself is the same FIFO/oversize wedge the packer was hardened
 *     against, and the gate was simply wrong.)
 *   - MIRROR: with the repo root and the incoming path spelled through
 *     different sides of a symlink — the everyday macOS `/tmp` vs `/private/tmp`
 *     case, and exactly what a harness's absolute `Read` `file_path` produces —
 *     every path was REFUSED, so compaction silently degraded to bare pointers
 *     and the proxy delivered none of the graph-aware savings it reported.
 *
 * Both now delegate to the packer's `resolveRepoPath`, so there is one gate.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewriteMessagesForContext, type MessagesRequest } from "../src/proxy/context_rewrite.ts";
import { compactAnthropicHistory, compactOneRead } from "../src/proxy/history_compact.ts";
import { Db } from "../src/db/queries.ts";
import type { NodeKind } from "../src/graph/types.ts";

const CANARY = "CANARY-GAP-S1-OUT-OF-TREE";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FN_SUMMARY: Record<string, string> = {
  alpha: "Parses the login authentication bearer token.",
  beta: "Renders the dashboard chart widget.",
  gamma: "Compresses the upload payload buffer.",
  delta: "Schedules the nightly database backup job.",
  epsilon: "Validates the billing invoice address.",
  zeta: "Resolves the DNS hostname cache entry.",
};
const NAMES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

function buildAppFile(names: string[]): {
  content: string;
  ranges: Record<string, [number, number]>;
} {
  const lines: string[] = [`import { z } from "./z";`, ``];
  const ranges: Record<string, [number, number]> = {};
  for (const name of names) {
    const start = lines.length + 1;
    lines.push(
      `export function ${name}(): number {`,
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

function node(
  db: Db,
  id: string,
  name: string,
  file: string,
  range: [number, number],
  kind: NodeKind = "function",
  summary?: string,
): void {
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

/**
 * A repo whose root is reachable BOTH as its real path and through a symlink,
 * plus an out-of-tree secret that an in-repo `env.ts` points at.
 */
function makeFixture(): {
  db: Db;
  realRoot: string;
  linkRoot: string;
  appBody: string;
  secretBody: string;
} {
  const base = mkdtempSync(join(tmpdir(), "hayven-gap-s1-"));
  dirs.push(base);
  const realRoot = join(base, "real-repo");
  const linkRoot = join(base, "link-repo");
  const outside = join(base, "outside");
  mkdirSync(realRoot, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(realRoot, linkRoot);

  const { content, ranges } = buildAppFile(NAMES);
  writeFileSync(join(realRoot, "app.ts"), content);

  // An out-of-tree file with a SOURCE extension, so nothing but containment can
  // refuse it, reached through an innocuous in-repo name.
  const secretBody =
    `export const AWS_SECRET_ACCESS_KEY = "${CANARY}";\n` +
    `export function alpha(): number { return 1; }\n` +
    `// padding so the whole-file check has more than 40 chars to match on\n`;
  writeFileSync(join(outside, "secret.ts"), secretBody);
  symlinkSync(join(outside, "secret.ts"), join(realRoot, "env.ts"));

  const db = new Db(":memory:");
  db.migrate();
  node(db, "app.ts::module", "app.ts", "app.ts", [1, 1], "module");
  for (const n of NAMES) {
    node(db, `app.ts::${n}`, n, "app.ts", ranges[n]!, "function", FN_SUMMARY[n]);
  }
  // `env.ts` is INDEXED — the realistic shape of the attack. Without nodes the
  // rewrite would bail as "not-indexed" before containment ever mattered, and
  // the test would pass with the guard removed.
  node(db, "env.ts::module", "env.ts", "env.ts", [1, 1], "module");
  node(db, "env.ts::alpha", "alpha", "env.ts", [2, 2], "function", FN_SUMMARY["alpha"]);
  return { db, realRoot, linkRoot, appBody: content, secretBody };
}

function bodyWith(instruction: string, filePath: string, fileBody: string): MessagesRequest {
  return {
    model: "claude-x",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `${instruction}\n\n<file path="${filePath}">\n${fileBody}</file>`,
          },
        ],
      },
    ],
  };
}

describe("S1 — context_rewrite refuses a symlink that leaves the repo", () => {
  it("an in-repo name pointing out of the tree is `unreadable`, not read", () => {
    const { db, realRoot, secretBody } = makeFixture();
    const body = bodyWith("fix the alpha login bearer token", "env.ts", secretBody);
    const { body: out, stats, changed } = rewriteMessagesForContext(db, realRoot, body);

    // The gate fires BEFORE the read, so the marker is left byte-for-byte alone.
    expect(stats.perFile[0]!.action).toBe("unreadable");
    expect(changed).toBe(false);
    expect(stats.savedTokens).toBe(0);
    // REGRESSION GUARD, not an S1 pin: this one also holds under the OLD lexical
    // helper, because the bytes read there were only ever compared, never
    // inserted. Kept because "the payload gains no second life in the outgoing
    // body" is a property worth failing on if it ever stops being true; the
    // `action === "unreadable"` assertion above is what pins the gate.
    expect(JSON.stringify(out.messages).split(CANARY).length - 1).toBe(1);
    db.close();
  });

  it("REGRESSION GUARD: an absolute out-of-repo path is refused (also true before S1)", () => {
    // Verified to pass with the old lexical helper restored — `/etc/hosts` was
    // already outside the root prefix. It pins nothing NEW and is labelled so,
    // rather than sitting unlabelled among the tests that do.
    const { db, realRoot } = makeFixture();
    const body = bodyWith("fix the alpha login bearer token", "/etc/hosts", "127.0.0.1 x\n");
    const { stats, changed } = rewriteMessagesForContext(db, realRoot, body);
    expect(stats.perFile[0]!.action).toBe("unreadable");
    expect(changed).toBe(false);
    db.close();
  });

  it("in-repo source through the OTHER root spelling still packs (no mirror refusal)", () => {
    // repoRoot is the REAL path; the marker names the same file through the
    // symlinked spelling. The lexical helper refused this for no reason, which
    // is how the proxy could report healthy while saving nothing.
    const { db, realRoot, linkRoot, appBody } = makeFixture();
    const body = bodyWith(
      "fix the alpha login bearer token parsing",
      join(linkRoot, "app.ts"),
      appBody,
    );
    const { stats, changed } = rewriteMessagesForContext(db, realRoot, body);
    expect(stats.perFile[0]!.action).toBe("packed");
    expect(changed).toBe(true);
    expect(stats.savedTokens).toBeGreaterThan(0);
    db.close();
  });
});

describe("S1 — history_compact uses the same gate", () => {
  /** A transcript whose OLD zone holds one `Read` of `path`. */
  function readLoop(path: string, text: string, instruction: string): MessagesRequest {
    const msgs: MessagesRequest["messages"] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: path } } as never,
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: text } as never] },
    ];
    for (let i = 0; i < 3; i++) {
      msgs.push({ role: "assistant", content: `step ${i}` });
      msgs.push({ role: "user", content: `continue ${i}` });
    }
    msgs.push({ role: "user", content: instruction });
    return { model: "claude-x", messages: msgs };
  }

  function toolResultOf(body: MessagesRequest): string {
    for (const m of body.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        const rec = b as Record<string, unknown>;
        if (rec["type"] === "tool_result" && rec["tool_use_id"] === "tu1") {
          return typeof rec["content"] === "string"
            ? rec["content"]
            : JSON.stringify(rec["content"]);
        }
      }
    }
    return "";
  }

  it("MIRROR: an absolute path through the symlinked root still yields a SLICE", () => {
    // The everyday shape: the harness reports `/tmp/repo/app.ts` while the
    // daemon's repoRoot is the realpath `/private/tmp/repo`. The lexical helper
    // returned null here, so compaction fell all the way back to a bare pointer
    // and every graph-aware saving was silently lost.
    const { db, realRoot, linkRoot, appBody } = makeFixture();
    const instruction = "fix the alpha login bearer token";
    const body = readLoop(join(linkRoot, "app.ts"), appBody, instruction);
    const { body: out, stats, changed } = compactAnthropicHistory(db, realRoot, body, instruction, {
      keepRecentMessages: 2,
    });
    expect(changed).toBe(true);
    expect(stats.perFile[0]!.kind).toBe("slice");
    expect(toolResultOf(out)).toContain("function alpha");
    db.close();
  });

  it("ESCAPE: a symlink out of the tree gets a POINTER, never a slice", () => {
    const { db, realRoot, secretBody } = makeFixture();
    const instruction = "fix the alpha login bearer token";
    const out = compactOneRead(db, realRoot, "env.ts", secretBody, instruction, {});
    expect(out?.kind).toBe("pointer");
    expect(out?.text).not.toContain(CANARY);
    db.close();
  });
});
