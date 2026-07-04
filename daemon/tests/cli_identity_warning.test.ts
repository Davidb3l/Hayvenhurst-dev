// Regression guard for the daemon-identity harmonization: the mutating CLI
// commands `node body` and `sync` must SURFACE the soft identity warning (via
// `reportIdentity` → a `note:` line) instead of silently dropping it, and must
// still abort with an `error:` on a hard project mismatch.
//
// Before the fix these two commands hand-rolled the identity block and printed
// the warning under a `warning:` prefix (node) — or dropped it entirely if the
// block ever diverged — bypassing the shared `reportIdentity` contract. We pin
// the post-fix behavior end-to-end through `runNode`/`runSync`.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { runNode } from "../src/cli/node.ts";
import { runSync } from "../src/cli/sync.ts";

/** Initialize a minimal .hayven/ project so requireProject() succeeds. */
function makeProject(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-cli-ident-"));
  mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
  writeFileSync(join(repoRoot, ".hayven", "config.json"), JSON.stringify(DEFAULT_CONFIG));
  return repoRoot;
}

/**
 * Route global fetch to an in-memory daemon stub. `health` controls the
 * /api/health response: a record body, "no-root" (old daemon → soft warning),
 * a foreign root (hard mismatch), or "unreachable". Any non-health request
 * returns a benign 200 so the command's own mutating request doesn't crash.
 */
function withDaemon(
  health: Record<string, unknown> | "no-root" | "unreachable",
  bodyResponse: Record<string, unknown>,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/health")) {
      if (health === "unreachable") throw new Error("ECONNREFUSED");
      const payload = health === "no-root" ? { ok: true, version: "old" } : health;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(bodyResponse), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return (async () => {
    try {
      await fn();
    } finally {
      globalThis.fetch = orig;
    }
  })();
}

/**
 * Capture stderr writes for the duration of `fn`. If `fn` throws AFTER writing
 * (e.g. sync proceeds past the identity check into merkle diffing with a stub
 * body), we still return the captured stderr — the identity `note:` we assert
 * on is written before any such later failure. `code` is -1 on throw.
 */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
  const errs: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (s: string) => {
    errs.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    let code = -1;
    try {
      code = await fn();
    } catch {
      // later-stage failure (post-identity) — captured stderr is what matters.
    }
    return { code, err: errs.join("") };
  } finally {
    process.stderr.write = origErr;
  }
}

describe("node body — daemon-identity warning is surfaced", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("prints a `note:` (not a dropped warning) when the daemon can't be verified", async () => {
    const repoRoot = makeProject();
    process.chdir(repoRoot);
    let result = { code: 0, err: "" };
    await withDaemon("no-root", { path: "(written)" }, async () => {
      result = await captureStderr(() =>
        runNode({ positionals: ["body", "some-id"], flags: { body: "new body text" } }),
      );
    });
    // The warning must be surfaced via the shared `note:` prefix, not dropped.
    expect(result.err).toContain("note:");
    expect(result.err).toContain("did not report a project root");
  });

  it("aborts with `error:` on a hard project mismatch", async () => {
    const repoRoot = makeProject();
    const foreign = mkdtempSync(join(tmpdir(), "hayven-foreign-"));
    process.chdir(repoRoot);
    let result = { code: 0, err: "" };
    await withDaemon({ ok: true, root: foreign }, { path: "(written)" }, async () => {
      result = await captureStderr(() =>
        runNode({ positionals: ["body", "some-id"], flags: { body: "new body text" } }),
      );
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("error:");
  });
});

describe("sync — daemon-identity warning is surfaced", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("prints a `note:` when the local daemon can't be verified", async () => {
    const repoRoot = makeProject();
    process.chdir(repoRoot);
    let result = { code: 0, err: "" };
    // The identity `note:` is written before any merkle exchange, so we assert
    // it's surfaced regardless of what the (stubbed) sync body does afterward.
    await withDaemon("no-root", { lww: "x", gset: "x", orset: "x" }, async () => {
      result = await captureStderr(() =>
        runSync({ positionals: ["http://peer.local:7777"], flags: {} }),
      );
    });
    expect(result.err).toContain("note:");
    expect(result.err).toContain("did not report a project root");
  });

  it("aborts with `error:` on a hard project mismatch", async () => {
    const repoRoot = makeProject();
    const foreign = mkdtempSync(join(tmpdir(), "hayven-foreign-sync-"));
    process.chdir(repoRoot);
    let result = { code: 0, err: "" };
    await withDaemon({ ok: true, root: foreign }, { lww: "x", gset: "x", orset: "x" }, async () => {
      result = await captureStderr(() =>
        runSync({ positionals: ["http://peer.local:7777"], flags: {} }),
      );
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain("error:");
  });
});
