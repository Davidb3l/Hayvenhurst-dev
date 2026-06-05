import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function setupApp(viewerDist: string | null) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-viewer-test-"));
  const paths = hayvenPathsFor(repoRoot);
  if (viewerDist) {
    // Override the auto-resolved viewerDist for this test.
    (paths as unknown as { viewerDist: string }).viewerDist = viewerDist;
  }
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
  return app;
}

describe("viewer routes", () => {
  it("reports built:false when the viewer dist is missing", async () => {
    // Point at a directory we know doesn't exist.
    const missing = join(tmpdir(), `hayven-no-viewer-${Date.now()}`);
    const app = setupApp(missing);
    const res = await app.handle(new Request("http://localhost/__viewer/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { built: boolean; root: string };
    expect(body.built).toBe(false);
    expect(body.root).toBe(missing);
  });

  it("serves index.html from the viewer dist when available", async () => {
    const dist = mkdtempSync(join(tmpdir(), "hayven-fake-dist-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>fake</title>");
    const app = setupApp(dist);

    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("fake");
  });

  it("falls back to /node/index.html for any /node/* path (SPA shell)", async () => {
    const dist = mkdtempSync(join(tmpdir(), "hayven-fake-dist-shell-"));
    mkdirSync(join(dist, "node"), { recursive: true });
    writeFileSync(
      join(dist, "node", "index.html"),
      "<!doctype html><title>node-shell</title>",
    );
    const app = setupApp(dist);

    // A deep, unknown id — must still return the shell.
    const res = await app.handle(
      new Request("http://localhost/node/auth/login/loginHandler/"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("node-shell");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("returns 503 on /node/* when no viewer build is present", async () => {
    const missing = join(tmpdir(), `hayven-no-viewer-${Date.now()}-2`);
    const app = setupApp(missing);
    const res = await app.handle(new Request("http://localhost/node/anything/"));
    expect(res.status).toBe(503);
  });

  it("api routes are not eaten by the static catch-all", async () => {
    const dist = mkdtempSync(join(tmpdir(), "hayven-fake-dist-api-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    const app = setupApp(dist);
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
