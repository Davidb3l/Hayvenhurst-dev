/**
 * LANE B / KNOWN_ISSUES #5 — static viewer assets were contained LEXICALLY.
 *
 * `resolveStatic` used `relative()` with a `..`-prefix check and no realpath
 * hop. `resolve()` does not follow symlinks and `relative()` only compares
 * strings, so a symlink planted inside the built viewer directory pointed
 * anywhere on disk and was served with a 200. Severity is low — it needs write
 * access to the build output — but it was the THIRD copy of a containment check
 * in this codebase, and the other two had already drifted apart in exactly this
 * way. The fix routes it through `containWithinRoot`, the shared helper the
 * packer's path gate uses.
 *
 * These tests drive the real Elysia app, because the bug is only observable in
 * what gets SERVED: `resolveStatic` is private, and a unit test of the helper
 * alone would not catch a route that bypasses it (the `/node/*` SPA shell and
 * the root `index.html` fallback both used to `join()` straight past it).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { buildApp } from "../src/daemon/server.ts";
import { Db } from "../src/db/queries.ts";
import { createLogger } from "../src/util/log.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { makeTestCrdtState } from "./_helpers.ts";

const CANARY = "CANARY-LANE-B-VIEWER-SYMLINK";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `hayven-laneb-viewer-${tag}-`));
  dirs.push(d);
  return d;
}

function appFor(viewerDist: string) {
  const repoRoot = tmp("repo");
  const paths = hayvenPathsFor(repoRoot);
  (paths as unknown as { viewerDist: string }).viewerDist = viewerDist;
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

/** A built viewer plus an out-of-tree secret, and the symlinks an attacker with
 *  write access to the build output would plant. */
function makeDist(): { dist: string; secretDir: string } {
  const dist = tmp("dist");
  const secretDir = tmp("secret");
  writeFileSync(join(secretDir, "secret.txt"), `${CANARY}\n`);
  writeFileSync(join(secretDir, "index.html"), `<!doctype html>${CANARY}\n`);

  writeFileSync(join(dist, "index.html"), "<!doctype html><title>real</title>");
  mkdirSync(join(dist, "node"), { recursive: true });
  writeFileSync(join(dist, "node", "index.html"), "<!doctype html><title>node-shell</title>");
  mkdirSync(join(dist, "_astro"), { recursive: true });
  writeFileSync(join(dist, "_astro", "app.a1b2c3.css"), "body{color:red}");

  // (a) a symlinked FILE inside the build output
  symlinkSync(join(secretDir, "secret.txt"), join(dist, "leak.txt"));
  // (b) a symlinked DIRECTORY — the containment check has to survive the
  //     directory hop, not just the final component
  symlinkSync(secretDir, join(dist, "leakdir"));
  // (c) a symlinked directory, reached via the DIRECTORY branch of
  //     resolveStatic
  symlinkSync(secretDir, join(dist, "leakindex"));
  // (d) a REAL directory whose index.html is the symlink. This is the only
  //     shape that actually reaches the directory branch's own containment
  //     check — with (c), the first hop already refuses, so (c) alone cannot
  //     tell a gated `<dir>/index.html` from an ungated `join()`.
  mkdirSync(join(dist, "realdir"), { recursive: true });
  symlinkSync(join(secretDir, "index.html"), join(dist, "realdir", "index.html"));
  return { dist, secretDir };
}

describe("#5 — a symlink inside the viewer build is not served", () => {
  it("refuses a symlinked FILE", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(new Request("http://localhost/leak.txt"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(CANARY);
  });

  it("refuses a file reached THROUGH a symlinked directory", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(new Request("http://localhost/leakdir/secret.txt"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(CANARY);
  });

  it("refuses a SYMLINKED index.html inside a REAL directory", async () => {
    // The only shape that reaches the directory branch's own containment
    // check: `<dir>/index.html` used to be built with a bare `join()` and
    // returned with no check at all. A symlinked DIRECTORY (below) cannot
    // pin this — the first hop already refuses it.
    const { dist } = makeDist();
    const res = await appFor(dist).handle(new Request("http://localhost/realdir/"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(CANARY);
  });

  it("refuses the directory-index hop through a symlinked directory", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(new Request("http://localhost/leakindex/"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(CANARY);
  });

  it("refuses a symlink under the /node/* SPA route", async () => {
    // The `/node/*` handler tries a direct static hit BEFORE falling back to
    // the shell, so it is a second, independent way into `resolveStatic`.
    const { dist } = makeDist();
    mkdirSync(join(dist, "node", "sub"), { recursive: true });
    const secret = join(dist, "..", "escape.txt");
    writeFileSync(secret, `${CANARY}\n`);
    dirs.push(secret);
    symlinkSync(secret, join(dist, "node", "leak.txt"));

    const res = await appFor(dist).handle(new Request("http://localhost/node/leak.txt"));
    // Falls through to the SPA shell rather than serving the link target.
    expect(await res.text()).not.toContain(CANARY);
  });

  it("still refuses plain lexical traversal", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(new Request("http://localhost/../secret.txt"));
    expect(await res.text()).not.toContain(CANARY);
  });
});

describe("#5 — the negative controls: the real viewer still works", () => {
  it("serves the root index.html", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("real");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves a hashed asset with the long-cache header", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(
      new Request("http://localhost/_astro/app.a1b2c3.css"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("serves the /node/* SPA shell for a deep unknown id", async () => {
    const { dist } = makeDist();
    const res = await appFor(dist).handle(
      new Request("http://localhost/node/auth/login/loginHandler/"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("node-shell");
  });

  it("serves a nested directory's index.html", async () => {
    const { dist } = makeDist();
    mkdirSync(join(dist, "about"), { recursive: true });
    writeFileSync(join(dist, "about", "index.html"), "<!doctype html><title>about</title>");
    const res = await appFor(dist).handle(new Request("http://localhost/about/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("about");
  });

  it("works when the viewer dist itself is reached via a SYMLINKED root", async () => {
    // The mirror-image failure a naive realpath check introduces: on macOS
    // `/tmp` (and every `mkdtemp` path under it) IS a symlink, so a root
    // compared only against its lexical spelling refuses everything.
    const { dist } = makeDist();
    const linkParent = tmp("linkroot");
    const linked = join(linkParent, "dist-link");
    symlinkSync(dist, linked);
    const res = await appFor(linked).handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("real");
  });
});
