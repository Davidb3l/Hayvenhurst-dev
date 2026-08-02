/**
 * Round 2 — containment was never the whole story.
 *
 * `resolveWithinRepo` refused everything OUTSIDE the repo, and its docblock
 * claimed that stopped `.env` and `~/.ssh/id_rsa` being packed into a prompt.
 * It did not: `.env` IS in the repo root, so the boundary check says nothing
 * about it. The packer reads the raw file whether or not it is INDEXED, so
 * `.gitignore` — which the Rust walker honours, keeping these out of the graph
 * entirely — gave no protection on this path. Proven on a repo where only
 * `src/a.ts` was indexed: `.env`, `.git/config` (which carries an embedded token
 * whenever a remote URL has credentials) and `id_rsa` all came back in full.
 *
 * Also pinned here, same gate:
 *   - FILE TYPE. A FIFO inside the repo made `readFileSync` block forever,
 *     synchronously and uninterruptibly — the same permanent wedge of the
 *     single-process stdio MCP server that the region bound was added to
 *     prevent, through a different door. `routes/viewer.ts` already did an
 *     `isFile()` check; the security-hardened reader did not.
 *   - FILE SIZE. `readFileSync(...).split("\n")` had no bound at all, while the
 *     Rust indexer has always had one. A 200 MiB file cost +835 MB RSS and a
 *     32 MiB file turned a 156-byte request into a 67.1 MB response.
 *
 * Every "must refuse" assertion greps the WHOLE serialized response for the
 * canary, not just the return shape.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildContextPackForChange,
  MAX_PACK_FILE_BYTES,
  resolveWithinRepo,
} from "../src/db/context_pack.ts";
import { Db } from "../src/db/queries.ts";
import {
  createContextMcpServer,
  type ContextMcpServer,
  type JsonRpcResponse,
} from "../src/mcp/context_server.ts";
import type { NodeKind } from "../src/graph/types.ts";

const ENV_CANARY = "CANARY-ENV-SECRET";
const GIT_CANARY = "CANARY-GIT-TOKEN";
const KEY_CANARY = "CANARY-KEY-MATERIAL";

const A_TS = `import { x } from "./x";

export function fa(): number {
  return 1;
}
`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repo where ONLY `src/a.ts` is indexed, but real secrets sit beside it. */
function makeRepo(): { root: string; db: Db } {
  const root = mkdtempSync(join(tmpdir(), "hayven-fixa-secret-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".ssh"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), A_TS);
  writeFileSync(join(root, ".env"), `AWS_SECRET_ACCESS_KEY=${ENV_CANARY}\n`);
  writeFileSync(join(root, ".env.production"), `TOKEN=${ENV_CANARY}\n`);
  writeFileSync(
    join(root, ".git", "config"),
    `[remote "origin"]\n\turl = https://user:${GIT_CANARY}@github.com/x/y.git\n`,
  );
  writeFileSync(join(root, "id_rsa"), `-----BEGIN PRIVATE KEY-----\n${KEY_CANARY}\n`);
  writeFileSync(join(root, ".ssh", "known_hosts"), `github.com ssh-rsa ${KEY_CANARY}\n`);
  writeFileSync(join(root, "server.pem"), `-----BEGIN CERTIFICATE-----\n${KEY_CANARY}\n`);
  writeFileSync(join(root, ".npmrc"), `//registry.npmjs.org/:_authToken=${KEY_CANARY}\n`);

  const db = new Db(":memory:");
  db.migrate();
  db.upsertNode({
    id: "src/a.ts::fa",
    name: "fa",
    qualified_name: "src/a.ts::fa",
    kind: "function" as NodeKind,
    language: "typescript",
    file: "src/a.ts",
    range: [3, 5],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
  return { root, db };
}

function callForChange(
  server: ContextMcpServer,
  file: string,
): { resp: JsonRpcResponse | null; raw: string } {
  const resp = server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "context_for_change",
      arguments: { file, regions: [{ startLine: 1, endLine: 100 }] },
    },
  });
  return { resp, raw: JSON.stringify(resp) };
}

const SECRET_PATHS: Array<[string, string]> = [
  [".env", ENV_CANARY],
  [".env.production", ENV_CANARY],
  ["./.env", ENV_CANARY],
  ["src/../.env", ENV_CANARY],
  [".git/config", GIT_CANARY],
  ["id_rsa", KEY_CANARY],
  [".ssh/known_hosts", KEY_CANARY],
  ["server.pem", KEY_CANARY],
  [".npmrc", KEY_CANARY],
];

describe("round 2 — in-repo credential files are denied", () => {
  it("resolveWithinRepo refuses every one of them", () => {
    const { root, db } = makeRepo();
    for (const [rel] of SECRET_PATHS) {
      expect(resolveWithinRepo(root, rel)).toBeNull();
    }
    db.close();
  });

  it("the packer returns no pack and never the canary", () => {
    const { root, db } = makeRepo();
    for (const [rel, canary] of SECRET_PATHS) {
      const pack = buildContextPackForChange(db, root, rel, [
        { startLine: 1, endLine: 100 },
      ]);
      expect(pack).toBeNull();
      expect(JSON.stringify(pack)).not.toContain(canary);
    }
    db.close();
  });

  it("the MCP wire refuses them loudly and never returns the canary", () => {
    const { root, db } = makeRepo();
    const server = createContextMcpServer(db, root);
    for (const [rel, canary] of SECRET_PATHS) {
      const { resp, raw } = callForChange(server, rel);
      const err = (resp as { error?: { message: string } }).error;
      expect(err).toBeDefined();
      expect(raw).not.toContain(canary);
    }
    server.close();
  });

  it("an ABSOLUTE spelling of an in-repo secret is denied too", () => {
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, join(root, ".env"))).toBeNull();
    expect(resolveWithinRepo(root, join(root, ".git", "config"))).toBeNull();
    db.close();
  });

  it("a symlink from a benign in-repo name to an in-repo secret is denied", () => {
    // The denylist is on the RESOLVED path, so laundering `.env` through a
    // `.ts`-looking name does not get past it.
    const { root, db } = makeRepo();
    symlinkSync(join(root, ".env"), join(root, "src", "innocent.ts"));
    expect(resolveWithinRepo(root, "src/innocent.ts")).toBeNull();
    const pack = buildContextPackForChange(db, root, "src/innocent.ts", [
      { startLine: 1, endLine: 100 },
    ]);
    expect(JSON.stringify(pack)).not.toContain(ENV_CANARY);
    db.close();
  });

  it("does NOT deny ordinary source — including dotted and unindexed files", () => {
    // The negative control. Over-blocking here would silently break the
    // legitimate new-file case the denylist was shaped around.
    const { root, db } = makeRepo();
    expect(resolveWithinRepo(root, "src/a.ts")).not.toBeNull();
    // An UNINDEXED, brand-new file must still pack (module frame, no entities).
    writeFileSync(join(root, "src", "brand-new.ts"), "export const x = 1;\n");
    expect(resolveWithinRepo(root, "src/brand-new.ts")).not.toBeNull();
    expect(
      buildContextPackForChange(db, root, "src/brand-new.ts", [
        { startLine: 1, endLine: 1 },
      ]),
    ).not.toBeNull();
    // Names that merely LOOK adjacent to the denylist are fine.
    for (const ok of ["src/environment.ts", "src/keyboard.ts", "src/gitignore.ts"]) {
      writeFileSync(join(root, ok), "export const y = 1;\n");
      expect(resolveWithinRepo(root, ok)).not.toBeNull();
    }
    db.close();
  });
});

describe("round 2 — file TYPE gate (a FIFO must not wedge the server)", () => {
  // NOTE — the FIFO case is NOT driven in-process here. `readFileSync` on a
  // writer-less FIFO blocks synchronously and uninterruptibly, so an in-process
  // test could only HANG on a regression, never fail (bun's per-test timeout is
  // cooperative). It lives in `fix_a_wedge_subprocess.test.ts`, under a
  // wall-clock SIGKILL, where a hang is an observable failure.

  // S6 — the "a directory named as a file is refused" test that used to live
  // here PASSED WITH `statPackable` DELETED: driven through the packer,
  // `readFileSync` on a directory throws EISDIR by itself, so the assertion
  // documented the outcome instead of pinning the guard. It has moved to
  // `gap_s_packer_indexer_parity.test.ts`, where `isPackableFile` is asserted
  // DIRECTLY (removing the `isFile()` check fails it) — necessary now for a
  // second reason too: indexer parity refuses `src` earlier, for having no
  // extension, so no end-to-end probe can reach the file-type guard at all.
});

describe("round 2 — file SIZE gate", () => {
  it("mirrors the Rust walker's 8 MiB max_file_size", () => {
    expect(MAX_PACK_FILE_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses an oversized in-repo file instead of slurping it", () => {
    const { root, db } = makeRepo();
    const big = join(root, "src", "huge.ts");
    // Just over the cap, built from a repeated line so it is real text.
    const line = "export const padpadpadpadpadpadpadpadpadpadpadpadpadpad = 1;\n";
    writeFileSync(big, line.repeat(Math.ceil((MAX_PACK_FILE_BYTES + 1024) / line.length)));
    expect(statSync(big).size).toBeGreaterThan(MAX_PACK_FILE_BYTES);
    const pack = buildContextPackForChange(db, root, "src/huge.ts", [
      { startLine: 1, endLine: 10 },
    ]);
    expect(pack).toBeNull();
    db.close();
  });

  it("still reads a file just UNDER the cap (not over-broad)", () => {
    const { root, db } = makeRepo();
    const ok = join(root, "src", "large-ok.ts");
    const line = "export const padpadpadpadpadpadpadpadpadpadpadpadpadpad = 1;\n";
    writeFileSync(ok, line.repeat(Math.floor((MAX_PACK_FILE_BYTES - 4096) / line.length)));
    expect(statSync(ok).size).toBeLessThan(MAX_PACK_FILE_BYTES);
    expect(
      buildContextPackForChange(db, root, "src/large-ok.ts", [
        { startLine: 1, endLine: 10 },
      ]),
    ).not.toBeNull();
    db.close();
  });
});
