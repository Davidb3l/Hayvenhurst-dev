/**
 * A1 — `hayven mcp` must not read files outside the repo.
 *
 * `makeFileReader` in `db/context_pack.ts` did `isAbsolute(file) ? file :
 * join(repoRoot, file)` with NO containment check, and the MCP server passed the
 * client-supplied `file` argument straight into `contextForChange`. So
 * `tools/call {name:"context_for_change", arguments:{file:"/etc/passwd", …}}`
 * returned the file's contents — and so did `../outside/secret.txt` and a
 * symlink inside the repo pointing at `~/.ssh/`. Any MCP host, or a prompt
 * injection sitting inside an indexed source file, could pull `.env` /
 * `~/.aws/credentials` into a model prompt.
 *
 * These tests pin BOTH layers: the library gate (`resolveWithinRepo` in the file
 * reader, which protects every caller — CLI, daemon route, proxy) and the wire
 * gate in the MCP server (which turns a silent empty pack into a visible
 * protocol error and rejects absolute paths outright).
 *
 * Every "must refuse" assertion checks for the SECRET STRING, not just for a
 * null/error return — a refusal that still leaked the bytes somewhere else in
 * the response would pass a shape-only assertion.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildContextPackForChange,
  resolveWithinRepo,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import {
  createContextMcpServer,
  type ContextMcpServer,
  type JsonRpcResponse,
} from "../src/mcp/context_server.ts";
import type { NodeKind } from "../src/graph/types.ts";

/** The canary. If this string appears anywhere in a response, we leaked. */
const SECRET = "SUPER-SECRET-AWS-KEY-DO-NOT-LEAK";

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

/**
 * A sandbox holding a repo AND a sibling "outside" dir with a secret in it, so
 * the escape we test for is a real escape to a real readable file (a test that
 * only tries a nonexistent path would pass with the guard deleted).
 */
function makeSandbox(): { root: string; outsideSecret: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "hayven-fixa-path-"));
  dirs.push(sandbox);
  const root = join(sandbox, "repo");
  const outside = join(sandbox, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "multi.ts"), MULTI_TS);
  const outsideSecret = join(outside, "secret.txt");
  writeFileSync(outsideSecret, `${SECRET}\nline2\nline3\n`);
  // A symlink INSIDE the repo pointing OUT: the lexical check alone cannot see
  // this, which is why the reader takes a realpath hop.
  symlinkSync(outsideSecret, join(root, "linked-secret.txt"));
  return { root, outsideSecret };
}

function makeServer(root: string): ContextMcpServer {
  const db = new Db(":memory:");
  db.migrate();
  const node = (id: string, file: string, range: [number, number]) =>
    db.upsertNode({
      id,
      name: id.split("::").pop() ?? id,
      qualified_name: id,
      kind: "function" as NodeKind,
      language: "typescript",
      file,
      range,
      ast_hash: "h",
      last_seen: 0,
      logical_clock: 0,
    });
  node("multi.ts::one", "multi.ts", [3, 5]);
  node("multi.ts::two", "multi.ts", [7, 9]);
  return createContextMcpServer(db, root);
}

/** Fire `context_for_change` and hand back the WHOLE serialized response, so a
 *  leak anywhere in it (text, structuredContent, notes) is visible. */
function callForChange(
  server: ContextMcpServer,
  file: string,
  regions: Array<{ startLine: number; endLine: number }> = [{ startLine: 1, endLine: 3 }],
): { resp: JsonRpcResponse | null; raw: string } {
  const resp = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "context_for_change", arguments: { file, regions } },
  });
  return { resp, raw: JSON.stringify(resp) };
}

function errorMessage(resp: JsonRpcResponse | null): string {
  expect(resp).not.toBeNull();
  const e = (resp as { error?: { message: string } }).error;
  expect(e).toBeDefined();
  return e!.message;
}

describe("A1 — resolveWithinRepo", () => {
  it("refuses an absolute path outside the repo", () => {
    const { root } = makeSandbox();
    expect(resolveWithinRepo(root, "/etc/passwd")).toBeNull();
  });

  it("refuses a `..` escape", () => {
    const { root } = makeSandbox();
    expect(resolveWithinRepo(root, "../outside/secret.txt")).toBeNull();
    expect(resolveWithinRepo(root, "a/../../outside/secret.txt")).toBeNull();
  });

  it("refuses a symlink inside the repo that points outside it", () => {
    const { root } = makeSandbox();
    expect(resolveWithinRepo(root, "linked-secret.txt")).toBeNull();
  });

  it("still resolves a legitimate in-repo file, canonicalized", () => {
    const { root } = makeSandbox();
    // The positive control. mkdtemp on macOS hands back a path under a symlink
    // (`/var` → `/private/var`), so this also pins the both-roots comparison —
    // a naive realpath-only check would refuse every real repo on this platform.
    // The RESULT is the realpath: returning the canonical location (rather than
    // the spelling we validated) is what closes the check-then-read window.
    const canonical = join(realpathSync(root), "multi.ts");
    expect(resolveWithinRepo(root, "multi.ts")).toBe(canonical);
    expect(resolveWithinRepo(root, "./multi.ts")).toBe(canonical);
  });

  it("accepts an ABSOLUTE path that is inside the repo", () => {
    const { root } = makeSandbox();
    const canonical = join(realpathSync(root), "multi.ts");
    expect(resolveWithinRepo(root, join(root, "multi.ts"))).toBe(canonical);
  });

  it("accepts the SYMLINKED spelling of a realpath'd repoRoot (and vice versa)", () => {
    // Asymmetry caught in review: with `repoRoot` given as the realpath and an
    // absolute `file` given via the symlinked spelling, the purely lexical
    // check refused a file that is plainly inside the repo. Both spellings of
    // both arguments must agree.
    const { root } = makeSandbox();
    const realRoot = realpathSync(root);
    const canonical = join(realRoot, "multi.ts");
    expect(resolveWithinRepo(realRoot, join(root, "multi.ts"))).toBe(canonical);
    expect(resolveWithinRepo(root, join(realRoot, "multi.ts"))).toBe(canonical);
  });
});

describe("A1 — the packer never reads outside the repo", () => {
  it("returns no pack (and no bytes) for an absolute out-of-repo file", () => {
    const { root } = makeSandbox();
    const db = new Db(":memory:");
    db.migrate();
    const pack = buildContextPackForChange(db, root, "/etc/hosts", [
      { startLine: 1, endLine: 3 },
    ]);
    expect(pack).toBeNull();
    db.close();
  });

  it("returns no pack (and no bytes) for a `..` escape to a real secret", () => {
    const { root } = makeSandbox();
    const db = new Db(":memory:");
    db.migrate();
    const pack = buildContextPackForChange(db, root, "../outside/secret.txt", [
      { startLine: 1, endLine: 3 },
    ]);
    expect(pack).toBeNull();
    expect(JSON.stringify(pack)).not.toContain(SECRET);
    db.close();
  });

  it("returns no pack for an in-repo symlink pointing outside", () => {
    const { root } = makeSandbox();
    const db = new Db(":memory:");
    db.migrate();
    const pack = buildContextPackForChange(db, root, "linked-secret.txt", [
      { startLine: 1, endLine: 3 },
    ]);
    expect(pack).toBeNull();
    expect(JSON.stringify(pack)).not.toContain(SECRET);
    db.close();
  });
});

describe("A1 — the MCP wire refuses escapes loudly", () => {
  it("rejects an absolute `file` as invalid params", () => {
    const { root } = makeSandbox();
    const server = makeServer(root);
    const { resp, raw } = callForChange(server, "/etc/passwd");
    expect(errorMessage(resp)).toMatch(/repo-relative/i);
    expect(raw).not.toContain("root:");
    server.close();
  });

  it("rejects a `..` escape and never returns the secret", () => {
    const { root } = makeSandbox();
    const server = makeServer(root);
    const { resp, raw } = callForChange(server, "../outside/secret.txt");
    expect(errorMessage(resp)).toMatch(/outside the repository/i);
    expect(raw).not.toContain(SECRET);
    server.close();
  });

  it("rejects a symlinked escape and never returns the secret", () => {
    const { root } = makeSandbox();
    const server = makeServer(root);
    const { resp, raw } = callForChange(server, "linked-secret.txt");
    expect(errorMessage(resp)).toMatch(/outside the repository/i);
    expect(raw).not.toContain(SECRET);
    server.close();
  });

  it("still packs a legitimate in-repo file (the guard is not over-broad)", () => {
    const { root } = makeSandbox();
    const server = makeServer(root);
    const { resp } = callForChange(server, "multi.ts", [{ startLine: 4, endLine: 4 }]);
    const result = (resp as { result: Record<string, unknown> }).result;
    expect(result["isError"]).toBeUndefined();
    const sc = result["structuredContent"] as { text: string };
    expect(sc.text).toContain("function one");
    server.close();
  });
});
