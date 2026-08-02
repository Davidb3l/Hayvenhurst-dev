/**
 * E4 — only the PRIMARY project got a pidfile.
 *
 * `hayven daemon stop`/`status` read the CWD project's `.hayven/daemon.pid`, but
 * the daemon wrote only `primaryPaths.pidFile`. Verified live against the
 * running daemon at review time: of its 5 served projects, only 2 had a
 * `daemon.pid` at all. From any other served repo, `stop` printed "daemon is not
 * running" and exited 0 while the daemon was actively serving that repo,
 * `status` said `stopped` and exited 1, and the duplicate-spawn guard in
 * `startDetachedDaemon` was permanently dead there (its `daemonStatus` was
 * always `stopped`, so an unreachable probe led straight to `spawn`).
 *
 * This has to be an INTEGRATION test: the pidfile bookkeeping lives in closures
 * inside `startForegroundDaemon`, which binds a port and never returns. So we
 * run a REAL daemon as a child process, fully sandboxed:
 *   - `HAYVEN_HOME` points at a tmp dir, so the developer's real
 *     `~/.hayven/projects.json` is never read or written,
 *   - `HAYVEN_PORT` points every child at an OS-assigned free port. This is NOT
 *     optional: `hayven daemon register` derives its base URL from the config's
 *     `daemon_port` and HOT-ADDS to whatever daemon answers there. With the
 *     default 7777 it registers the throwaway fixture into the developer's REAL
 *     daemon and its REAL registry. (An earlier draft of this file did exactly
 *     that.) The test asserts the port is unanswered as an explicit precondition
 *     rather than assuming it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readIdentityFile, readPidFile } from "../src/daemon/lifecycle.ts";
import { registryFile } from "../src/daemon/registry.ts";
import { Db } from "../src/db/queries.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** Ask the OS for a port nobody is using, then release it. Never assumes a
 *  fixed port is free — the developer's real daemon owns 7777. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("could not obtain a free port from the OS");
  return port;
}

/** A minimal initialized project: `.hayven/` with a config pinned to `port`. */
function makeProject(parent: string, name: string, port: number): string {
  const root = join(parent, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  writeFileSync(
    join(root, ".hayven", "config.json"),
    JSON.stringify({ daemon_host: "127.0.0.1", daemon_port: port }),
    "utf8",
  );
  return root;
}

/** PRECONDITION, asserted rather than assumed: nothing answers on `port`. */
async function assertPortUnanswered(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
  } catch {
    return; // connection refused — what we want
  }
  throw new Error(`test precondition failed: something is already answering on port ${port}`);
}

/** Child env: registry sandboxed to a tmp HOME, daemon pinned to a free port. */
function childEnv(home: string, port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HAYVEN_HOME: home,
    HAYVEN_PORT: String(port),
    HAYVEN_HOST: "127.0.0.1",
    HAYVEN_LOG_LEVEL: "warn",
  };
}


/**
 * Enter the registry sandbox for one test, and TRIP LOUDLY if it did not take.
 *
 * Two independent leak channels reach the developer's real state, and closing
 * only one is not enough:
 *   1. The registry FILE — anything reaching `registerProject` resolves
 *      `registryFile()` from `$HAYVEN_HOME`. The assertion below converts a
 *      silent leak into an immediate failure (the pattern in `registry.test.ts`).
 *   2. The live DAEMON — `hayven daemon register` POSTs to the port in the
 *      project's own config and HOT-ADDS to whatever answers. At the default
 *      7777 that is the developer's REAL daemon, whose own `$HAYVEN_HOME` is the
 *      real one, so sandboxing (1) does not help at all. Every fixture therefore
 *      pins `daemon_port` to a free port and asserts nothing answers there.
 * This mechanism is how the real registry accumulated dead `/tmp` roots.
 */
function enterSandbox(): { home: string; workspace: string; priorHome: string | undefined } {
  const priorHome = process.env["HAYVEN_HOME"];
  const home = mkdtempSync(join(tmpdir(), "hayven-fixe-home-"));
  mkdirSync(join(home, ".hayven"), { recursive: true });
  process.env["HAYVEN_HOME"] = home;
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
  return { home, workspace: mkdtempSync(join(tmpdir(), "hayven-fixe-ws-")), priorHome };
}

function exitSandbox(box: { home: string; workspace: string; priorHome: string | undefined }): void {
  if (box.priorHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = box.priorHome;
  rmSync(box.home, { recursive: true, force: true });
  rmSync(box.workspace, { recursive: true, force: true });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("E4: every served project gets a pidfile", () => {
  let box: ReturnType<typeof enterSandbox>;
  let home: string;
  let workspace: string;
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    box = enterSandbox();
    home = box.home;
    workspace = box.workspace;
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
      child = null;
    }
    exitSandbox(box);
  });

  it("writes a pidfile in the NON-primary project too, naming the live daemon", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const primary = makeProject(workspace, "primary-repo", port);
    const secondary = makeProject(workspace, "secondary-repo", port);
    const env = childEnv(home, port);

    // Register the secondary FIRST so the daemon loads it from the registry.
    const reg = Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "register", secondary],
      cwd: secondary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(reg.exitCode).toBe(0);
    // Proof the sandbox held: with nothing on the free port, `register` reports
    // "no running daemon". If this ever says it hot-added, the test just wrote
    // into a REAL daemon and must fail loudly rather than pass quietly.
    expect(reg.stdout.toString()).toContain("no running daemon");

    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: primary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for it to actually serve both projects.
    const base = `http://127.0.0.1:${port}`;
    let served: string[] = [];
    for (let i = 0; i < 150; i++) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          const body = (await res.json()) as { projects?: Array<{ alias: string }> };
          served = (body.projects ?? []).map((p) => p.alias);
          if (served.length >= 2) break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    expect(served.length).toBe(2);

    const primaryPid = join(primary, ".hayven", "daemon.pid");
    const secondaryPid = join(secondary, ".hayven", "daemon.pid");

    // THE property: the NON-primary served repo has a pidfile too. Pre-fix this
    // file simply did not exist, so `stop`/`status` from that repo were no-ops.
    expect(existsSync(secondaryPid)).toBe(true);
    expect(existsSync(primaryPid)).toBe(true);
    // Both name the SAME live daemon — one process serves N projects.
    expect(readPidFile(secondaryPid)).toBe(readPidFile(primaryPid));
    expect(readPidFile(secondaryPid)).toBe(child.pid);
    // …and each carries the E5 identity sidecar, so `stop` from either repo can
    // prove the pid is this daemon before signalling it.
    expect(readIdentityFile(secondaryPid)?.pid).toBe(child.pid);

    // `hayven daemon status` run FROM the non-primary repo now agrees.
    const status = Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "status"],
      cwd: secondary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(status.exitCode).toBe(0); // pre-fix: 1, printing "stopped"
    expect(status.stdout.toString()).toContain("running");
  }, 45_000);

  it("removes EVERY project's pidfile on a clean shutdown", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const primary = makeProject(workspace, "primary-repo", port);
    const secondary = makeProject(workspace, "secondary-repo", port);
    const env = childEnv(home, port);

    Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "register", secondary],
      cwd: secondary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: primary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const secondaryPid = join(secondary, ".hayven", "daemon.pid");
    for (let i = 0; i < 150 && !existsSync(secondaryPid); i++) await sleep(100);
    expect(existsSync(secondaryPid)).toBe(true);

    child.kill("SIGTERM");
    await child.exited;
    child = null;

    // A daemon that leaves pidfiles behind makes the NEXT start refuse.
    expect(existsSync(secondaryPid)).toBe(false);
    expect(existsSync(join(primary, ".hayven", "daemon.pid"))).toBe(false);
  }, 45_000);
});

describe("E6: a live-removed project stays recoverable", () => {
  let box: ReturnType<typeof enterSandbox>;
  let home: string;
  let workspace: string;
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    box = enterSandbox();
    home = box.home;
    workspace = box.workspace;
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
      child = null;
    }
    exitSandbox(box);
  });

  it("DELETE stops serving it but KEEPS the registration, and it can be re-added", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const primary = makeProject(workspace, "primary-repo", port);
    const secondary = makeProject(workspace, "secondary-repo", port);
    const env = childEnv(home, port);

    Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "register", secondary],
      cwd: secondary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: primary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const base = `http://127.0.0.1:${port}`;
    const aliases = async (): Promise<string[]> => {
      const res = await fetch(`${base}/api/health`);
      const body = (await res.json()) as { projects?: Array<{ alias: string }> };
      return (body.projects ?? []).map((p) => p.alias).sort();
    };
    for (let i = 0; i < 150; i++) {
      try {
        if ((await aliases()).length >= 2) break;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    expect(await aliases()).toEqual(["primary-repo", "secondary-repo"]);

    const del = await fetch(`${base}/api/projects/secondary-repo`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await aliases()).toEqual(["primary-repo"]);

    // (1) The registration SURVIVES. `DELETE /api/projects/:alias` is documented
    // as "stop serving it live"; it used to call `unregisterProject`, so an
    // unauthenticated localhost call permanently FORGOT the repo.
    const list = Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "projects", "--json"],
      cwd: primary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const registered = (JSON.parse(list.stdout.toString()) as Array<{ root: string }>).map(
      (e) => e.root,
    );
    // The registry stores symlink-resolved roots (/var -> /private/var on macOS).
    expect(registered).toContain(realpathSync(secondary));

    // (2) It is RE-ADDABLE. The old code dropped it from the routing map but left
    // it in `runtimes` on a shutdown failure, so `addProjectLive` matched it by
    // canonical root and answered "already served" forever while every read with
    // that alias silently fell back to the PRIMARY project's index.
    const readd = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: secondary }),
    });
    expect(readd.status).toBeLessThan(300);
    expect(await aliases()).toEqual(["primary-repo", "secondary-repo"]);
  }, 45_000);
});

describe("E7: the live-project cap applies at STARTUP, not just on hot-add", () => {
  let box: ReturnType<typeof enterSandbox>;
  let home: string;
  let workspace: string;
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    box = enterSandbox();
    home = box.home;
    workspace = box.workspace;
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
      child = null;
    }
    exitSandbox(box);
  });

  it("loads at most MAX_LIVE_PROJECTS and NAMES the ones it skipped", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const primary = makeProject(workspace, "primary-repo", port);
    const env = childEnv(home, port);

    // 70 registered repos. Each one the daemon opens costs a Db, a long-lived
    // `hayven-native watch` child and a 2 s branch poller — and the registry only
    // ever grows, so before the fix a dev who had once started a daemon in 200
    // repos silently got 200 watcher processes on the next start.
    const roots: string[] = [];
    for (let i = 0; i < 70; i++) roots.push(makeProject(workspace, `repo-${i}`, port));
    // Write the registry directly: 70 `daemon register` subprocesses would
    // dominate the runtime and add nothing to what is being tested.
    writeFileSync(
      join(home, ".hayven", "projects.json"),
      JSON.stringify({
        version: 1,
        projects: roots.map((root, i) => ({ alias: `repo-${i}`, root })),
      }),
      "utf8",
    );

    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: primary,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const base = `http://127.0.0.1:${port}`;
    let served = 0;
    for (let i = 0; i < 300; i++) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          const body = (await res.json()) as { projects?: unknown[] };
          served = body.projects?.length ?? 0;
          if (served > 0) break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }

    // THE property: bounded. 71 were registered (70 + the primary); the cap is 64.
    expect(served).toBe(64);

    // …and it is NOT silent. A user whose repo stopped being served must be able
    // to find out why and which repos were dropped.
    child.kill("SIGTERM");
    const stderr = await new Response(child.stderr as ReadableStream).text();
    child = null;
    expect(stderr).toContain("were NOT loaded");
    expect(stderr).toMatch(/repo-\d+/);
  }, 90_000);
});

describe("E3: the daemon's full re-ingest is IDEMPOTENT", () => {
  // `cli/daemon.ts`'s `fullIngest` called `drainIngest` with NO `clearGraph()`,
  // while `cli/ingest.ts` has always cleared and explains why: edges accumulate
  // `weight +=` on conflict, so a repeated whole-repo ingest doubled every edge
  // weight (measured 1 -> 3 -> 6 -> 9 -> 12 over successive runs). `weight` is a
  // RANKING signal, so a long-lived daemon's results drifted further from truth
  // the longer it ran — and deleted symbols never left the index at all.
  //
  // Lane B has since made the full-ingest edge write `replaceEdges` (SET, not
  // accumulate), which independently fixes the weight half. The clear is still
  // required for the OTHER half — dropping nodes whose file the parse no longer
  // reports — so this test pins BOTH.
  let box: ReturnType<typeof enterSandbox>;
  let home: string;
  let workspace: string;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  const nativeBin = join(import.meta.dir, "..", "..", "native", "target", "release", "hayven-native");

  beforeEach(() => {
    box = enterSandbox();
    home = box.home;
    workspace = box.workspace;
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
      child = null;
    }
    exitSandbox(box);
  });

  it("repeated full re-ingests do not inflate edge weights, and DROP deleted symbols", async () => {
    if (!existsSync(nativeBin)) {
      // Honest skip rather than a green test that proved nothing.
      throw new Error(`hayven-native not built at ${nativeBin} — build it to run this test`);
    }
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "idem-repo", port);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "lib.ts"),
      "export function helper(): number {\n  return 1;\n}\n",
      "utf8",
    );
    writeFileSync(
      join(repo, "src", "main.ts"),
      "import { helper } from './lib.ts';\nexport function main(): number {\n  return helper();\n}\n",
      "utf8",
    );
    writeFileSync(
      join(repo, "src", "doomed.ts"),
      "export function willBeDeleted(): number {\n  return 42;\n}\n",
      "utf8",
    );

    const env = { ...childEnv(home, port), HAYVEN_NATIVE_BIN: nativeBin };
    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }

    const ingest = async (): Promise<void> => {
      const res = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ full: true }),
      });
      expect(res.status).toBe(200);
    };
    const maxEdgeWeight = (): number => {
      const db = new Db(join(repo, ".hayven", "index.sqlite"), { readonly: true });
      const row = db.handle
        .query<{ w: number }, []>("SELECT COALESCE(MAX(weight), 0) AS w FROM edges")
        .get();
      const w = row?.w ?? 0;
      db.close();
      return w;
    };
    const hasNode = (namePart: string): boolean => {
      const db = new Db(join(repo, ".hayven", "index.sqlite"), { readonly: true });
      const row = db.handle
        .query<{ c: number }, [string]>("SELECT COUNT(*) AS c FROM nodes WHERE name = ?")
        .get(namePart);
      const found = (row?.c ?? 0) > 0;
      db.close();
      return found;
    };

    await ingest();
    const afterFirst = maxEdgeWeight();
    expect(afterFirst).toBeGreaterThan(0); // the fixture really does produce edges
    expect(hasNode("willBeDeleted")).toBe(true);

    await ingest();
    await ingest();
    const afterThird = maxEdgeWeight();

    // (1) IDEMPOTENT WEIGHTS. Pre-fix this walked 1 -> 3 -> 6 -> 9 -> 12.
    expect(afterThird).toBe(afterFirst);

    // (2) DELETED SYMBOLS LEAVE. Nothing but the clear removes a node whose file
    // the parse no longer reports, so without it `willBeDeleted` lived forever.
    rmSync(join(repo, "src", "doomed.ts"), { force: true });
    await ingest();
    expect(hasNode("willBeDeleted")).toBe(false);
    expect(maxEdgeWeight()).toBe(afterFirst); // still not inflating
  }, 120_000);
});

describe("D2 regression: one repo, two spellings, ONE runtime", () => {
  // Lane D's `registerProject` now stores the CANONICAL (realpath'd) root, while
  // `detectRepoRoot` returns a `resolve`d but NOT realpath'd one. The startup
  // loader's dedupe was a raw `entry.root === primaryRoot`, so under a symlinked
  // path component the two spellings differ, the dedupe MISSES, and the repo is
  // loaded TWICE: two `Db` handles and two `hayven-native watch` children on one
  // `.hayven/index.sqlite` WAL. `util/paths.ts` states the stakes plainly — two
  // writers on one WAL is corruption.
  //
  // This is the bug class that is invisible on Linux CI and destroys data on a
  // Mac, so the fixture makes the symlink explicit rather than relying on
  // /tmp -> /private/tmp happening to be a symlink on the host.
  let box: ReturnType<typeof enterSandbox>;
  let home: string;
  let workspace: string;
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    box = enterSandbox();
    home = box.home;
    workspace = box.workspace;
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
      child = null;
    }
    exitSandbox(box);
  });

  it("does not load the same repo twice when the registry and cwd spell it differently", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);

    // The real directory, plus a symlinked route to the SAME directory.
    const real = makeProject(workspace, "real-repo", port);
    const linkParent = join(workspace, "link");
    mkdirSync(linkParent, { recursive: true });
    const linked = join(linkParent, "real-repo");
    symlinkSync(real, linked);
    expect(realpathSync(linked)).toBe(realpathSync(real));
    expect(linked).not.toBe(real); // the two spellings really are different

    // The registry holds the SYMLINK spelling; the daemon starts with cwd at the
    // real one. Written directly so the raw string in the file is preserved.
    writeFileSync(
      join(home, ".hayven", "projects.json"),
      JSON.stringify({ version: 1, projects: [{ alias: "linked-alias", root: linked }] }),
      "utf8",
    );

    // `info` level so the per-project "index resolved" record is written: that
    // is the only direct evidence of how many times `initProject` ran.
    const env = { ...childEnv(home, port), HAYVEN_LOG_LEVEL: "info" };
    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: real,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const base = `http://127.0.0.1:${port}`;
    let projects: Array<{ alias: string; root: string }> = [];
    for (let i = 0; i < 200; i++) {
      try {
        const res = await fetch(`${base}/api/health`);
        if (res.ok) {
          const body = (await res.json()) as { projects?: Array<{ alias: string; root: string }> };
          projects = body.projects ?? [];
          if (projects.length > 0) break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }

    expect(projects.length).toBe(1);
    const canonical = projects.map((p) => realpathSync(p.root));
    expect(new Set(canonical).size).toBe(canonical.length);

    // THE property, and it CANNOT be read off `/api/health`: `registerProject`
    // is idempotent by canonical root, so it hands the primary back the EXISTING
    // entry's alias — meaning the duplicate `toLoad` entry carries the SAME
    // alias and `runtimes.set(alias, ...)` silently overwrites the first. The
    // served-project count therefore still reads 1 while TWO `initProject` calls
    // have already opened two `Db` handles and spawned two watchers on one WAL,
    // with the first runtime orphaned and never shut down. (An earlier draft of
    // this test asserted only on the count above, and PASSED with the fix
    // reverted — a vacuous test.) Count the per-project init directly instead.
    const logFile = join(home, ".hayven", "logs", "daemon.log");
    const initRecords = existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .split("\n")
          .filter((l) => l.includes('"msg":"index resolved"')).length
      : -1;
    expect(initRecords).toBe(1);
  }, 45_000);
});

describe("SECURITY: the daemon refuses to publish itself by accident", () => {
  let box: ReturnType<typeof enterSandbox>;
  let home: string;
  let workspace: string;

  beforeEach(() => {
    box = enterSandbox();
    home = box.home;
    workspace = box.workspace;
  });

  afterEach(() => {
    exitSandbox(box);
  });

  it("REFUSES `--host 0.0.0.0` without the explicit exposure opt-in", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "exposed-repo", port);

    const r = Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port), "--host", "0.0.0.0"],
      cwd: repo,
      env: childEnv(home, port),
      stdout: "pipe",
      stderr: "pipe",
    });

    // THE property: it does not start. Pre-fix it bound the wildcard, answered
    // 200 from the LAN, and printed nothing at all.
    expect(r.exitCode).toBe(2);
    const err = r.stderr.toString();
    expect(err).toContain("NO authentication");
    expect(err).toContain("--allow-remote-access");
    // Nothing is listening.
    await assertPortUnanswered(port);
  }, 45_000);

  it("does not suggest 0.0.0.0 in its own usage text", () => {
    const r = Bun.spawnSync({
      cmd: ["bun", CLI, "daemon", "help"],
      cwd: workspace,
      env: { ...(process.env as Record<string, string>), HAYVEN_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString() + r.stderr.toString();
    // The old hint read `--host requires a value, e.g. --host 0.0.0.0`, i.e. we
    // were actively recommending the dangerous value.
    expect(out).not.toContain("0.0.0.0");
    expect(out).toContain("--allow-remote-access");
  }, 30_000);

  it("binds loopback and says so, with no warning, on the default path", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "normal-repo", port);
    const child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: repo,
      env: childEnv(home, port),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      for (let i = 0; i < 200; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
        } catch {
          /* not up yet */
        }
        await sleep(100);
      }
      child.kill("SIGTERM");
      const out = await new Response(child.stdout as ReadableStream).text();
      expect(out).toContain("127.0.0.1");
      expect(out).not.toContain("REACHABLE FROM THE NETWORK");
    } finally {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
    }
  }, 45_000);
});

describe("E1 (corrected): branch re-point obeys the ingest rate limit", () => {
  // A re-point is a `clearGraph()` + whole-repo freshen. The poller only ever
  // backed off FAILED attempts, so a legitimately alternating branch key
  // (`git bisect run`, an interactive rebase) produced one full rebuild every
  // 2 s indefinitely and nothing noticed — every single one SUCCEEDED. The unit
  // test in fix_e_ingest_guard.test.ts pins `admitWholeRepoRun` itself; this one
  // pins that the POLLER actually calls it (mutating the call site to the old
  // `guard.allowed()` check leaves the unit test green).
  let box: ReturnType<typeof enterSandbox>;
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    box = enterSandbox();
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.exited;
      } catch {
        /* already gone */
      }
      child = null;
    }
    exitSandbox(box);
  });

  it("admits ONE rebuild for a branch key that keeps alternating", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(box.workspace, "flapping-repo", port);
    const git = (...args: string[]): void => {
      const r = Bun.spawnSync({ cmd: ["git", "-C", repo, ...args], stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    Bun.spawnSync({ cmd: ["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"] });
    git("branch", "other");

    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: repo,
      env: {
        ...childEnv(box.home, port),
        HAYVEN_LOG_LEVEL: "info",
        // A long interval makes the assertion crisp without a long test: the
        // poller ticks every 2 s, so ~12 s of flapping is ~6 chances to rebuild.
        HAYVEN_AUTO_INGEST_MIN_INTERVAL_MS: "600000",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }

    // Flap the branch for ~12 s, faster than the 2 s poll.
    for (let i = 0; i < 24; i++) {
      git("checkout", "-q", i % 2 === 0 ? "other" : "main");
      await sleep(500);
    }
    await sleep(2500);

    const log = readFileSync(join(box.home, ".hayven", "logs", "daemon.log"), "utf8");
    const detected = log.split("\n").filter((l) => l.includes('"msg":"watch: branch change detected"')).length;

    // THE property: the rate limit gates the re-point, so alternating branches
    // cost ONE rebuild, not one per poll tick.
    expect(detected).toBeLessThanOrEqual(1);
  }, 90_000);
});
