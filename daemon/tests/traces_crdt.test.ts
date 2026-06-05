// Tests for the CRDT-backed trace ingest path. Verifies that POSTs land in
// the G-Set + on-disk op log AND keep the SQL `observations` denormalized
// read cache populated. The cross-language wire round-trip relies on
// `hayven-native`; we skip the restart/hydrate case when the binary is
// missing rather than fail loudly.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import { makeTestCrdtState } from "./_helpers.ts";

function makeApp(crdt = makeTestCrdtState()) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-traces-crdt-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  const app = buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt,
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  });
  return { app, db, crdt };
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

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  const candidates = [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const samplePayload = (ts: number) => ({
  source: "python",
  sample_rate: 100,
  observations: [
    { src: "auth/login_handler", dst: "auth/validate_session", ts, observed: 5, weight: 500 },
    { src: "auth/login_handler", dst: "auth/issue_token", ts, observed: 3, weight: 300 },
  ],
});

describe("POST /api/traces/observations — CRDT path", () => {
  it("appends one G-Set op per observation and keeps the SQL cache in sync", async () => {
    const { app, db, crdt } = makeApp();
    const res = await post(app, samplePayload(1_715_789_520));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number };
    expect(body.accepted).toBe(2);

    expect(crdt.gset.size).toBe(2);
    expect(db.observationsCount()).toBe(2);
  });

  it("each POST grows the G-Set (fresh HLCs make every op distinct)", async () => {
    const { app, crdt } = makeApp();
    const payload = samplePayload(1_715_789_520);
    await post(app, payload);
    await post(app, payload);
    // Two POSTs of two ops each = four distinct G-Set entries. The SQL cache
    // collapses by (src, dst, ts, source) ON CONFLICT — that's intentional —
    // but the G-Set's append-only semantics (PRD §6.2) keep both observations.
    expect(crdt.gset.size).toBe(4);
  });

  it("rejects observed > 65535 with HTTP 400", async () => {
    const { app, crdt, db } = makeApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 1,
      observations: [{ src: "a", dst: "b", ts: 1, observed: 70_000, weight: 70_000 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("uint16");
    expect(crdt.gset.size).toBe(0);
    expect(db.observationsCount()).toBe(0);
  });

  it("rejects weight > 65535 with HTTP 400", async () => {
    const { app, crdt } = makeApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 1000,
      observations: [{ src: "a", dst: "b", ts: 1, observed: 100, weight: 100_000 }],
    });
    expect(res.status).toBe(400);
    expect(crdt.gset.size).toBe(0);
  });

  it("surfaces the G-Set size on /api/stats", async () => {
    const { app } = makeApp();
    await post(app, samplePayload(1_715_789_520));
    const statsRes = await app.handle(new Request("http://localhost/api/stats"));
    const stats = (await statsRes.json()) as { traces: number; gset_ops: number };
    expect(stats.traces).toBe(2);
    expect(stats.gset_ops).toBe(2);
  });
});

// Hydrate-from-disk needs the native binary for wire encode/decode. Skip
// gracefully in environments where it hasn't been built (matches the
// pattern in crdt_oplog.test.ts).
const maybeDescribe = findBinary() === null ? describe.skip : describe;

maybeDescribe("POST /api/traces/observations — restart hydrate", () => {
  it("hydrates the G-Set back to its prior size after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-traces-restart-"));
    try {
      const crdtRoot = join(dir, "crdt");
      const configFile = join(dir, "config.json");
      const crdt1 = new CrdtState({ crdtRoot, configFile, skipHydrate: true });
      const { app } = makeApp(crdt1);
      await post(app, samplePayload(1_715_789_520));
      await post(app, samplePayload(1_715_789_700));
      const sizeBefore = crdt1.gset.size;
      expect(sizeBefore).toBe(4);
      crdt1.close();

      const crdt2 = new CrdtState({ crdtRoot, configFile });
      expect(crdt2.gset.size).toBe(sizeBefore);
      crdt2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
