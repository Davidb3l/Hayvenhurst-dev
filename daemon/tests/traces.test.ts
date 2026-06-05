import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function makeApp() {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-traces-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  const app = buildApp({
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
  return { app, db };
}

async function post(app: ReturnType<typeof makeApp>["app"], body: unknown): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/traces/observations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/traces/observations", () => {
  it("persists a valid batch and reports it via /api/stats", async () => {
    const { app, db } = makeApp();
    const ts = 1_715_789_520;
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [
        { src: "auth/login_handler", dst: "auth/validate_session", ts, observed: 5, weight: 500 },
        { src: "auth/login_handler", dst: "auth/issue_token", ts, observed: 3, weight: 300 },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; accepted: number };
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(2);

    expect(db.observationsCount()).toBe(2);

    const statsRes = await app.handle(new Request("http://localhost/api/stats"));
    const stats = (await statsRes.json()) as { traces: number; last_trace: number | null };
    expect(stats.traces).toBe(2);
    expect(stats.last_trace).toBe(ts);
  });

  it("rejects payloads where weight does not match observed * sample_rate", async () => {
    const { app, db } = makeApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [
        { src: "a", dst: "b", ts: 1, observed: 5, weight: 450 /* off by more than ±1 */ },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("weight mismatch");
    expect(db.observationsCount()).toBe(0);
  });

  it("allows ±1 rounding slack between weight and observed * sample_rate", async () => {
    const { app } = makeApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [{ src: "a", dst: "b", ts: 1, observed: 5, weight: 501 }],
    });
    expect(res.status).toBe(200);
  });

  it("rejects malformed envelopes (missing source / sample_rate / observations)", async () => {
    const { app } = makeApp();
    const r1 = await post(app, { sample_rate: 100, observations: [] });
    expect(r1.status).toBe(400);
    const r2 = await post(app, { source: "python", observations: [] });
    expect(r2.status).toBe(400);
    const r3 = await post(app, { source: "python", sample_rate: 100, observations: "nope" });
    expect(r3.status).toBe(400);
  });
});
