// BL-4: the sync segment-name guard accepted impossible calendar dates
// (`9999-99-99`, `2026-13-40`, `0000-00-00`) because the shape regex
// `^\d{4}-\d{2}-\d{2}$` never checked that the date is real. These reach the
// 400 path BEFORE any segment read, so no native binary is needed.
//
// NB: `app.handle` is hostname-sensitive — always `http://localhost/...`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

describe("sync segment-name date validation (BL-4)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function makeApp() {
    const dir = mkdtempSync(join(tmpdir(), "hayven-segname-"));
    cleanups.push(dir);
    const paths = hayvenPathsFor(dir);
    const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile, skipHydrate: true });
    const db = new Db(":memory:");
    db.migrate();
    return buildApp({
      db,
      config: DEFAULT_CONFIG,
      paths,
      logger: createLogger({ toFile: false, toStderr: false }),
      crdt,
      daemonVersion: "test",
      ingest: { current: () => null, start: async () => { throw new Error("not used"); } },
    });
  }

  async function batchStatus(app: ReturnType<typeof buildApp>, path: string): Promise<number> {
    const res = await app.handle(
      new Request("http://localhost/api/sync/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "gset", path }),
      }),
    );
    return res.status;
  }

  test("rejects impossible calendar dates with 400", async () => {
    const app = makeApp();
    for (const bad of ["9999-99-99", "2026-13-40", "0000-00-00", "2026-02-30", "2026-00-15"]) {
      expect(await batchStatus(app, bad)).toBe(400);
    }
  });

  test("keeps rejecting path-traversal and malformed shapes with 400", async () => {
    const app = makeApp();
    for (const bad of ["../etc/passwd", "2026-01-01/..", "/abs/2026-01-01", "2026-1-1", "not-a-date"]) {
      expect(await batchStatus(app, bad)).toBe(400);
    }
  });

  test("a real date is accepted (404 segment-not-found, NOT 400 bad-path)", async () => {
    const app = makeApp();
    // Valid shape + real date passes the guard; the segment doesn't exist on a
    // fresh log, so we expect 404 (proving we got past the 400 name check).
    const res = await app.handle(
      new Request("http://localhost/api/sync/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "gset", path: "2026-02-28" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
