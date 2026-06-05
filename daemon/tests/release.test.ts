// Tests for `hayven release <claim_id>` (daemon/src/cli/release.ts).
//
// Two layers:
//   1. Route layer — drive `DELETE /api/claims/:id` straight through the real
//      Elysia app (after registering a claim via POST) to confirm the wire
//      contract `release` depends on: 200 {ok} for a live claim, 404 for an
//      unknown / already-released id.
//   2. CLI layer — drive `runRelease` with `globalThis.fetch` monkeypatched to
//      route at the same in-process app, exercising the success / 404 /
//      missing-id / identity-mismatch / unreachable-daemon paths and asserting
//      the exit codes + user-facing output match `claim.ts`'s conventions.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { runRelease } from "../src/cli/release.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

type App = ReturnType<typeof buildApp>;

function makeApp(repoRoot: string): App {
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

async function postClaim(app: App, id: string, scope: string[]): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        agent: "tester",
        intent: "test claim",
        scope,
        fingerprint: "blake3:test",
        ttlSeconds: 60,
      }),
    }),
  );
}

/** Route the global fetch at an in-process app for the duration of `fn`. */
async function withFetchToApp(app: App, fn: () => Promise<void>): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    // Normalize to the localhost hostname Elysia's app.handle requires.
    const local = `http://localhost${url.pathname}${url.search}`;
    return app.handle(new Request(local, init));
  }) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

/** Capture stdout + stderr writes for the duration of `fn`. */
async function captureIo(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: string) => {
    out.push(typeof s === "string" ? s : String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: string) => {
    err.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/** A temp repo with a `.hayven/` so `requireProject()` resolves it. */
function makeProject(): string {
  // realpathSync so the root matches what `requireProject`/`detectRepoRoot`
  // resolves cwd to (macOS routes the tmpdir through a `/private` symlink) —
  // otherwise the identity guard would see a false mismatch in-test.
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "hayven-release-")));
  mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
  writeFileSync(join(repoRoot, ".hayven", "config.json"), JSON.stringify(DEFAULT_CONFIG));
  return repoRoot;
}

describe("DELETE /api/claims/:id (the wire route release uses)", () => {
  it("returns 200 {ok} for a live claim and 404 once it is gone", async () => {
    const app = makeApp(mkdtempSync(join(tmpdir(), "hayven-rel-route-")));
    expect((await postClaim(app, "claim_x", ["mod/a"])).status).toBe(201);

    const del = await app.handle(
      new Request("http://localhost/api/claims/claim_x", { method: "DELETE" }),
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, id: "claim_x" });

    // Already released → 404.
    const again = await app.handle(
      new Request("http://localhost/api/claims/claim_x", { method: "DELETE" }),
    );
    expect(again.status).toBe(404);
  });

  it("returns 404 for an unknown id", async () => {
    const app = makeApp(mkdtempSync(join(tmpdir(), "hayven-rel-route2-")));
    const del = await app.handle(
      new Request("http://localhost/api/claims/nope", { method: "DELETE" }),
    );
    expect(del.status).toBe(404);
  });
});

describe("runRelease CLI", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it("missing id → usage on stderr, exit 2 (no daemon contact)", async () => {
    const { code, err } = await captureIo(() => runRelease({ positionals: [], flags: {} }));
    expect(code).toBe(2);
    expect(err).toContain("usage: hayven release <claim_id>");
  });

  it("releases a live claim → friendly success, exit 0", async () => {
    const repoRoot = makeProject();
    const app = makeApp(repoRoot);
    expect((await postClaim(app, "claim_live", ["mod/a"])).status).toBe(201);
    process.chdir(repoRoot);

    const captured = await captureIo(async () => {
      let code = 0;
      await withFetchToApp(app, async () => {
        code = await runRelease({ positionals: ["claim_live"], flags: {} });
      });
      return code;
    });
    expect(captured.code).toBe(0);
    expect(captured.out).toContain("Claim released");
    expect(captured.out).toContain("claim_live");
  });

  it("unknown / already-released id → `no active claim`, exit 1", async () => {
    const repoRoot = makeProject();
    const app = makeApp(repoRoot);
    process.chdir(repoRoot);

    let code = -1;
    let err = "";
    const captured = await captureIo(async () => {
      await withFetchToApp(app, async () => {
        code = await runRelease({ positionals: ["ghost"], flags: {} });
      });
      return code;
    });
    err = captured.err;
    expect(captured.code).toBe(1);
    expect(err).toContain("no active claim `ghost`");
  });

  it("--json emits a structured payload with the status", async () => {
    const repoRoot = makeProject();
    const app = makeApp(repoRoot);
    expect((await postClaim(app, "claim_json", ["mod/b"])).status).toBe(201);
    process.chdir(repoRoot);

    let out = "";
    const captured = await captureIo(async () => {
      let code = 0;
      await withFetchToApp(app, async () => {
        code = await runRelease({ positionals: ["claim_json"], flags: { json: true } });
      });
      return code;
    });
    out = captured.out;
    expect(captured.code).toBe(0);
    const parsed = JSON.parse(out) as { status: number; ok?: boolean; id?: string };
    expect(parsed.status).toBe(200);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe("claim_json");
  });

  it("refuses when the daemon serves a DIFFERENT project (identity mismatch)", async () => {
    const repoRoot = makeProject();
    // The daemon's /api/health reports a foreign root, so the guard must refuse.
    const foreignRoot = mkdtempSync(join(tmpdir(), "hayven-foreign-"));
    const app = makeApp(foreignRoot);
    // Seed a claim on the foreign daemon so a missing guard would 200 the DELETE.
    expect((await postClaim(app, "claim_foreign", ["mod/c"])).status).toBe(201);
    process.chdir(repoRoot);

    let err = "";
    const captured = await captureIo(async () => {
      let code = 0;
      await withFetchToApp(app, async () => {
        code = await runRelease({ positionals: ["claim_foreign"], flags: {} });
      });
      return code;
    });
    err = captured.err;
    expect(captured.code).toBe(1);
    expect(err).toContain("DIFFERENT project");
    // The guard must short-circuit BEFORE the DELETE — the claim survives.
    const stillThere = await app.handle(new Request("http://localhost/api/claims"));
    const board = (await stillThere.json()) as { claims: Array<{ id: string }> };
    expect(board.claims.some((c) => c.id === "claim_foreign")).toBe(true);
  });

  it("unreachable daemon → friendly error, exit 1", async () => {
    const repoRoot = makeProject();
    process.chdir(repoRoot);

    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    try {
      const { code, err } = await captureIo(() =>
        runRelease({ positionals: ["whatever"], flags: {} }),
      );
      expect(code).toBe(1);
      expect(err).toContain("could not reach daemon");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
