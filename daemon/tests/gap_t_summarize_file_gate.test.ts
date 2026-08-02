// LANE T / T2 — `hayven summarize`'s source-line reader is GATED.
//
// The failure being prevented: `readFirstSourceLine` built its path with a bare
// `join(repoRoot, node.file)` and read it. `node.file` is not trustworthy — on
// the daemon transport the row arrives over HTTP from whatever daemon owns port
// 7777, and on either transport it was written by the indexer from repo
// content. So the reader accepted a traversal (`../../.ssh/id_rsa`), a symlink
// pointing out of the tree, an arbitrarily large blob, and — the one that turns
// a leak into a hang — a FIFO, on which `readFileSync` blocks FOREVER,
// synchronously and uninterruptibly.
//
// The gate is the packer's (`db/context_pack.ts`), imported rather than
// re-implemented, so containment and the credential denylist stay defined once.
//
// NOTE ON THE FIFO CASE: it is asserted with a wall-clock bound because an
// un-gated read there does not fail, it never returns — the pre-fix code hangs
// the whole test process rather than reporting anything.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFirstSourceLine } from "../src/cli/summarize.ts";
import { MAX_PACK_FILE_BYTES } from "../src/db/context_pack.ts";
import type { GraphNode } from "../src/graph/types.ts";
import type { ProjectContext } from "../src/cli/_shared.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function newRepo(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapt-gate-")));
  dirs.push(d);
  return d;
}

function ctxFor(repoRoot: string): ProjectContext {
  return {
    paths: hayvenPathsFor(repoRoot),
    config: DEFAULT_CONFIG,
    configSources: [],
  };
}

function nodeFor(file: string, range: [number, number] = [1, 50]): GraphNode {
  return {
    id: "mod/a",
    name: "a",
    qualified_name: "a",
    kind: "function",
    language: "typescript",
    file,
    range,
    ast_hash: "blake3:test",
    last_seen: 0,
    logical_clock: 0,
  };
}

describe("T2 — readFirstSourceLine is gated by the packer's resolver", () => {
  it("reads the first non-blank line of an in-repo file (the happy path still works)", () => {
    const repo = newRepo();
    writeFileSync(join(repo, "a.ts"), "\n\n  export function a() {}\nmore\n");
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("a.ts"))).toBe("export function a() {}");
  });

  it("refuses a path that traverses out of the repo", () => {
    const repo = newRepo();
    const outside = join(repo, "..", "outside-secret.txt");
    writeFileSync(outside, "TOP SECRET\n");
    dirs.push(outside);
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("../outside-secret.txt"))).toBeUndefined();
  });

  it("refuses an absolute path outside the repo", () => {
    const repo = newRepo();
    const other = newRepo();
    writeFileSync(join(other, "secret.txt"), "TOP SECRET\n");
    expect(readFirstSourceLine(ctxFor(repo), nodeFor(join(other, "secret.txt")))).toBeUndefined();
  });

  it("refuses a symlink INSIDE the repo that points out of it", () => {
    const repo = newRepo();
    const other = newRepo();
    writeFileSync(join(other, "secret.txt"), "TOP SECRET\n");
    symlinkSync(join(other, "secret.txt"), join(repo, "link.ts"));
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("link.ts"))).toBeUndefined();
  });

  it("refuses a credential-shaped file even though it IS inside the repo", () => {
    // Containment alone says nothing about `.env` — it is in the repo root.
    const repo = newRepo();
    writeFileSync(join(repo, ".env"), "API_KEY=sk-live-do-not-leak\n");
    expect(readFirstSourceLine(ctxFor(repo), nodeFor(".env"))).toBeUndefined();

    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git", "config"), "[remote]\n  url = https://tok@host/x\n");
    expect(readFirstSourceLine(ctxFor(repo), nodeFor(".git/config"))).toBeUndefined();
  });

  it("refuses a file over the packer's size cap", () => {
    const repo = newRepo();
    const big = join(repo, "big.ts");
    writeFileSync(big, "x");
    // Sparse: costs no disk blocks and no measurable time.
    truncateSync(big, MAX_PACK_FILE_BYTES + 1);
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("big.ts"))).toBeUndefined();
  });

  it("refuses a FIFO instead of blocking on it forever", () => {
    const repo = newRepo();
    const fifo = join(repo, "pipe.ts");
    const mk = Bun.spawnSync(["mkfifo", fifo]);
    if (mk.exitCode !== 0) return; // no mkfifo on this platform — nothing to assert

    const started = Date.now();
    // Un-gated, `readFileSync` on a FIFO with no writer never returns: this
    // assertion cannot fail, it can only hang, which is the point.
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("pipe.ts"))).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 10_000);

  it("still yields undefined for an ordinary missing file", () => {
    const repo = newRepo();
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("nope.ts"))).toBeUndefined();
  });

  it("honours the node's line range", () => {
    const repo = newRepo();
    writeFileSync(join(repo, "a.ts"), "first\nsecond\nthird\n");
    expect(readFirstSourceLine(ctxFor(repo), nodeFor("a.ts", [2, 3]))).toBe("second");
  });
});
