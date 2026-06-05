// Tests for the daemon-identity hardening pass:
//   1. /api/health exposes the project `root` (so CLI clients can verify the
//      daemon on a shared port actually serves THIS project).
//   2. assertDaemonServesProject rejects a mismatched root, passes a matching
//      one, and tolerates an old daemon with no root field.
//   3. `daemon start --port` / `--host` overrides are parsed.
//   4. `config <key> <invalid>` yields a friendly `error:` (exit 1), not a
//      raw ConfigError stack trace.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { assertDaemonServesProject, type ProjectContext } from "../src/cli/_shared.ts";
import { parseArgs } from "../src/cli.ts";
import { runConfig } from "../src/cli/config.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function makeApp(repoRoot: string) {
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  return buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  });
}

/** A minimal ProjectContext with the given repo root. */
function ctxFor(repoRoot: string): ProjectContext {
  return {
    paths: hayvenPathsFor(repoRoot),
    config: DEFAULT_CONFIG,
    configSources: [],
  };
}

describe("/api/health identity", () => {
  it("includes the project root", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-ident-"));
    const app = makeApp(repoRoot);
    const res = await app.handle(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { ok: boolean; root: string };
    expect(body.ok).toBe(true);
    expect(body.root).toBe(repoRoot);
  });
});

describe("assertDaemonServesProject", () => {
  // Stub fetch by pointing the helper at an in-process Elysia app via a base
  // URL we intercept. Easiest: monkeypatch global fetch to route to app.handle.
  function withDaemon(
    health: Record<string, unknown> | "unreachable" | "no-root",
    fn: () => Promise<void>,
  ): Promise<void> {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (health === "unreachable") throw new Error("ECONNREFUSED");
      const payload = health === "no-root" ? { ok: true, version: "old" } : health;
      return new Response(JSON.stringify(payload), {
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

  it("passes when the daemon root matches", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-match-"));
    await withDaemon({ ok: true, root: repoRoot }, async () => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(repoRoot));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warning).toBeUndefined();
    });
  });

  it("rejects when the daemon serves a different root", async () => {
    const ours = mkdtempSync(join(tmpdir(), "hayven-ours-"));
    const theirs = mkdtempSync(join(tmpdir(), "hayven-theirs-"));
    await withDaemon({ ok: true, root: theirs }, async () => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(ours));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain(ours);
        expect(r.message).toContain(theirs);
      }
    });
  });

  it("tolerates an old daemon with no root field (warn, don't fail)", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-old-"));
    await withDaemon("no-root", async () => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(repoRoot));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warning).toContain("did not report a project root");
    });
  });

  it("does not fail hard when the daemon is unreachable", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-down-"));
    await withDaemon("unreachable", async () => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(repoRoot));
      expect(r.ok).toBe(true);
    });
  });
});

describe("daemon start --port / --host parsing", () => {
  it("parses --port as the flag value", () => {
    const p = parseArgs(["daemon", "start", "--port", "7878"]);
    expect(p.flags["port"]).toBe("7878");
  });

  it("parses --host as the flag value", () => {
    const p = parseArgs(["daemon", "start", "--host", "0.0.0.0"]);
    expect(p.flags["host"]).toBe("0.0.0.0");
  });

  it("treats a negative numeric flag value as a value, not a boolean", () => {
    const p = parseArgs(["query", "--limit", "-5"]);
    expect(p.flags["limit"]).toBe("-5");
  });
});

describe("config <key> <invalid> friendly error", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("returns exit 1 with a clean error (no stack trace) for an invalid value", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-cfg-"));
    mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
    writeFileSync(join(repoRoot, ".hayven", "config.json"), JSON.stringify(DEFAULT_CONFIG));
    process.chdir(repoRoot);

    const errs: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (s: string) => {
      errs.push(typeof s === "string" ? s : String(s));
      return true;
    };
    let code: number;
    try {
      // daemon_port must be an integer in 1..65535 — 0 is invalid.
      code = await runConfig({ positionals: ["daemon_port", "0"], flags: {} });
    } finally {
      process.stderr.write = origErr;
    }

    expect(code).toBe(1);
    const joined = errs.join("");
    expect(joined).toContain("error:");
    expect(joined).toContain("daemon_port");
    // Not a raw thrown stack.
    expect(joined).not.toContain("at validateConfig");
  });
});
