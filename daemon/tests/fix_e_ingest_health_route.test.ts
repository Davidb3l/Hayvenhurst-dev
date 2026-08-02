/**
 * E1 (observability) + E10 (error-message leakage).
 *
 * The incident ran for six hours and 11,600 ingest cycles with NO interface
 * that could have shown it: the only evidence lived in a 576 MB log nobody was
 * reading. `GET /api/ingest/health` is that interface — per-project breaker
 * state and watcher backlog — and `POST /api/ingest/health/reset` is the
 * documented way out of a tripped breaker.
 *
 * E10 also: `onError` echoed `error.message` straight back to the caller, and
 * those messages routinely embed absolute filesystem paths, leaking the account
 * name and on-disk layout to anything that can reach the port.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import {
  buildMultiProjectApp,
  redactHomePaths,
  type IngestHealth,
  type ServerDependencies,
} from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function health(over: Partial<IngestHealth> = {}): IngestHealth {
  return {
    consecutiveFailures: 0,
    tripped: false,
    tripReason: null,
    trippedAt: null,
    lastError: null,
    lastManualError: null,
    autoRunsInWindow: 0,
    autoRunLimitPerWindow: 30,
    rateWindowMs: 3_600_000,
    minIntervalMs: 30_000,
    rateLimitedWaits: 0,
    limiterActive: 0,
    limiterWaiting: 0,
    fullIngestQueued: false,
    fullIngestsCoalesced: 0,
    pendingWatchEvents: 0,
    watchBatchInFlight: false,
    watchOverflowInFlight: false,
    watchOverflowsCoalesced: 0,
    ...over,
  };
}

function depsFor(state: { h: IngestHealth; resets: number }): ServerDependencies {
  const db = new Db(":memory:");
  db.migrate();
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-fixe-health-"));
  return {
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
    ingestHealth: () => state.h,
    resetIngestBreaker: () => {
      state.resets += 1;
      state.h = health();
    },
  };
}

function mkApp(alpha: { h: IngestHealth; resets: number }, beta: { h: IngestHealth; resets: number }) {
  return buildMultiProjectApp({
    primary: "alpha",
    projects: new Map<string, ServerDependencies>([
      ["alpha", depsFor(alpha)],
      ["beta", depsFor(beta)],
    ]),
    logger: createLogger({ toFile: false, toStderr: false }),
    daemonVersion: "test",
  });
}

describe("E1: the runaway loop is observable over HTTP", () => {
  it("reports every project's breaker + backlog, and names the tripped ones", async () => {
    const alpha = { h: health(), resets: 0 };
    const beta = {
      h: health({
        tripped: true,
        tripReason: "rate",
        trippedAt: "2026-08-01T00:00:00.000Z",
        consecutiveFailures: 5,
        autoRunsInWindow: 30,
        lastError: "parse timed out",
        pendingWatchEvents: 4453, // the incident's real batch size
        fullIngestsCoalesced: 49,
      }),
      resets: 0,
    };
    const app = mkApp(alpha, beta);

    const res = await app.handle(new Request("http://localhost/api/ingest/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      tripped: string[];
      projects: Array<IngestHealth & { alias: string }>;
    };

    expect(body.ok).toBe(true);
    // A single field a human or a monitor can look at to answer "is anything
    // melting down?" — the question the incident had no answer to.
    expect(body.tripped).toEqual(["beta"]);
    expect(body.projects.map((p) => p.alias).sort()).toEqual(["alpha", "beta"]);
    const b = body.projects.find((p) => p.alias === "beta")!;
    expect(b.consecutiveFailures).toBe(5);
    // The reason the incident actually needed: too much SUCCESSFUL work.
    expect(b.tripReason).toBe("rate");
    expect(b.autoRunsInWindow).toBe(30);
    expect(b.lastError).toBe("parse timed out");
    expect(b.pendingWatchEvents).toBe(4453);
    expect(b.fullIngestsCoalesced).toBe(49);
  });

  it("resets the SELECTED project's breaker, not the primary's", async () => {
    const alpha = { h: health(), resets: 0 };
    const beta = { h: health({ tripped: true, consecutiveFailures: 5 }), resets: 0 };
    const app = mkApp(alpha, beta);

    const res = await app.handle(
      new Request("http://localhost/api/ingest/health/reset?project=beta", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true, reset: true });

    expect(beta.resets).toBe(1);
    expect(alpha.resets).toBe(0); // the un-selected project was NOT touched
  });

  it("refuses a reset addressed to a project this daemon does not serve", async () => {
    const app = mkApp({ h: health(), resets: 0 }, { h: health(), resets: 0 });
    const res = await app.handle(
      new Request("http://localhost/api/ingest/health/reset?project=gone", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("E10: error messages do not leak absolute paths", () => {
  it("replaces the home directory with ~", () => {
    const home = process.env["HOME"]!;
    const msg = `ENOENT: no such file or directory, open '${home}/code/secret-repo/.hayven/index.sqlite'`;
    const out = redactHomePaths(msg);
    expect(out).not.toContain(home);
    expect(out).toContain("~/code/secret-repo/.hayven/index.sqlite");
  });

  it("redacts EVERY occurrence, not just the first", () => {
    const home = process.env["HOME"]!;
    const out = redactHomePaths(`copy ${home}/a to ${home}/b`);
    expect(out).not.toContain(home);
    expect(out).toBe("copy ~/a to ~/b");
  });

  it("leaves messages with no home path untouched", () => {
    expect(redactHomePaths("ingest already running")).toBe("ingest already running");
  });
});

describe("SECURITY: a web page cannot drive this unauthenticated daemon", () => {
  it("REFUSES a cross-origin mutation", async () => {
    const alpha = { h: health(), resets: 0 };
    const beta = { h: health({ tripped: true }), resets: 0 };
    const app = mkApp(alpha, beta);

    const res = await app.handle(
      new Request("http://localhost/api/ingest/health/reset?project=beta", {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
      }),
    );

    expect(res.status).toBe(403);
    // CRITICAL: the refused mutation had no effect.
    expect(beta.resets).toBe(0);
  });

  it("allows a same-origin mutation (the viewer is served from here)", async () => {
    const alpha = { h: health(), resets: 0 };
    const beta = { h: health({ tripped: true }), resets: 0 };
    const app = mkApp(alpha, beta);

    const res = await app.handle(
      new Request("http://localhost/api/ingest/health/reset?project=beta", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:7777" },
      }),
    );

    expect(res.status).toBe(200);
    expect(beta.resets).toBe(1);
  });

  it("allows a mutation with NO Origin at all (the CLI, curl)", async () => {
    const alpha = { h: health(), resets: 0 };
    const beta = { h: health({ tripped: true }), resets: 0 };
    const app = mkApp(alpha, beta);

    const res = await app.handle(
      new Request("http://localhost/api/ingest/health/reset?project=beta", { method: "POST" }),
    );

    expect(res.status).toBe(200);
    expect(beta.resets).toBe(1);
  });

  it("still answers cross-origin READS (opaque to the caller, and the viewer needs them)", async () => {
    const app = mkApp({ h: health(), resets: 0 }, { h: health(), resets: 0 });
    const res = await app.handle(
      new Request("http://localhost/api/ingest/health", {
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(res.status).toBe(200);
  });
});
