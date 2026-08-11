/**
 * HAYV-7 TASK A - `stop` and `status` are PORT-AWARE.
 *
 * Field evidence: two daemons ran side by side for a day; `hayven daemon stop`
 * stopped the pidfile-tracked one, then a second `stop` printed "daemon is not
 * running" while pid 64618 still LISTENED on :7777 and answered /api/health.
 * `status` said "stopped" over the same state, and `sirius doctor` read it as
 * green. The pidfile is not the world: every "not running" conclusion must
 * also probe the configured daemon address.
 *
 * The orphan here is a REAL child process running a minimal hayven-shaped
 * health endpoint (the same structural shape `probeDaemon` verifies), so
 * `stop` genuinely signals and reaps a live process rather than a mock.
 *
 * Sandbox rules (see fix_e_daemon_pidfiles.test.ts, whose patterns this file
 * reuses): throwaway $HAYVEN_HOME, EPHEMERAL ports only - a real daemon serves
 * this machine's :7777 and must never be touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryFile } from "../src/daemon/registry.ts";
import { VERSION } from "../src/version.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** Ask the OS for a port nobody is using, then release it. */
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
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new Error(`test precondition failed: something is already answering on port ${port}`);
}

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
 * The orphan: a real child serving a hayven-shaped /api/health on `port`,
 * reporting its own pid (or omitting it, to model a pre-Task-C build).
 */
const ORPHAN_SCRIPT = `
const port = Number(process.env["ORPHAN_PORT"]);
const withPid = process.env["ORPHAN_WITH_PID"] === "1";
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    if (new URL(req.url).pathname !== "/api/health") return new Response("nope", { status: 404 });
    const body = {
      ok: true,
      version: process.env["ORPHAN_VERSION"],
      root: process.env["ORPHAN_ROOT"],
      projects: [{ alias: "orphan-repo", root: process.env["ORPHAN_ROOT"] }],
    };
    if (withPid) body.pid = process.pid;
    return Response.json(body);
  },
});
`;

async function spawnOrphan(
  port: number,
  root: string,
  opts: { withPid: boolean },
): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn({
    cmd: ["bun", "-e", ORPHAN_SCRIPT],
    env: {
      ...(process.env as Record<string, string>),
      ORPHAN_PORT: String(port),
      ORPHAN_ROOT: root,
      ORPHAN_VERSION: VERSION,
      ORPHAN_WITH_PID: opts.withPid ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Wait until it genuinely answers - `stop`/`status` probe with a 2 s budget.
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new Error("orphan fixture never came up");
}

/**
 * Run the CLI ASYNCHRONOUSLY. `stop` waits for the signalled pid to actually
 * die, and the orphan is a child of THIS test process - under `spawnSync` the
 * test's event loop is blocked, the dead orphan is never reaped, and
 * `kill(pid, 0)` keeps answering for the zombie, so `stop` times out on a
 * process that exited instantly. (A real orphan is reaped by init; the zombie
 * is purely a fixture artifact.) Async spawn keeps the loop free to reap.
 */
async function runCli(
  cmd: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("HAYV-7 TASK A: stop and status see the orphan the pidfile cannot", () => {
  let home: string;
  let workspace: string;
  let priorHome: string | undefined;
  let orphan: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    priorHome = process.env["HAYVEN_HOME"];
    home = mkdtempSync(join(tmpdir(), "hayven-orphan-home-"));
    mkdirSync(join(home, ".hayven"), { recursive: true });
    process.env["HAYVEN_HOME"] = home;
    if (!registryFile().startsWith(home)) {
      throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
    }
    workspace = mkdtempSync(join(tmpdir(), "hayven-orphan-ws-"));
  });

  afterEach(async () => {
    if (orphan) {
      try {
        orphan.kill("SIGKILL");
        await orphan.exited;
      } catch {
        /* already gone */
      }
      orphan = null;
    }
    if (priorHome === undefined) delete process.env["HAYVEN_HOME"];
    else process.env["HAYVEN_HOME"] = priorHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("status: no pidfile + live listener => reports the ORPHAN with its pid, never 'stopped'", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "repo", port);
    orphan = await spawnOrphan(port, repo, { withPid: true });

    const r = await runCli(["bun", CLI, "daemon", "status"], repo, childEnv(home, port));
    const out = r.stdout;
    // Pre-fix: printed exactly "stopped" and exited 1 while the orphan served.
    expect(out).not.toContain("stopped");
    expect(out).toContain("orphan");
    expect(out).toContain(`pid ${orphan.pid}`);
    expect(out).toContain(`127.0.0.1:${port}`);
    expect(r.exitCode).toBe(3);
  }, 30_000);

  it("stop: no pidfile + live listener => names the orphan, prints what it serves, and STOPS it", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "repo", port);
    orphan = await spawnOrphan(port, repo, { withPid: true });

    const r = await runCli(["bun", CLI, "daemon", "stop"], repo, childEnv(home, port));
    const out = r.stdout;
    // Pre-fix: exactly the incident's lie - "daemon is not running", exit 0,
    // orphan untouched.
    expect(out).not.toContain("daemon is not running");
    expect(out).toContain(`pid ${orphan.pid}`);
    // The blast radius is on record BEFORE the signal: what the orphan served.
    expect(out).toContain("orphan-repo");
    expect(r.exitCode).toBe(0);
    // The orphan process is genuinely gone and the port is quiet.
    await orphan.exited;
    orphan = null;
    await assertPortUnanswered(port);
  }, 30_000);

  it("stop: DEAD-pid pidfile + live listener => still finds and stops the orphan", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "repo", port);
    // A pidfile naming a pid that is verifiably dead.
    const dead = Bun.spawn({ cmd: ["sleep", "0"] });
    await dead.exited;
    writeFileSync(join(repo, ".hayven", "daemon.pid"), `${dead.pid}\n`, "utf8");
    orphan = await spawnOrphan(port, repo, { withPid: true });

    const r = await runCli(["bun", CLI, "daemon", "stop"], repo, childEnv(home, port));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`pid ${orphan.pid}`);
    await orphan.exited;
    orphan = null;
    await assertPortUnanswered(port);
  }, 30_000);

  it("stop: orphan WITHOUT a pid in its health (old build) => refuses to guess, prints the manual recovery", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "repo", port);
    orphan = await spawnOrphan(port, repo, { withPid: false });

    const r = await runCli(["bun", CLI, "daemon", "stop"], repo, childEnv(home, port));
    const err = r.stderr;
    // No verified pid => no signal. But NEVER the bare "not running" lie:
    // the user gets the address, the fact, and the exact recovery commands.
    expect(r.stdout + err).not.toContain("daemon is not running");
    expect(err).toContain(`127.0.0.1:${port}`);
    expect(err).toContain("lsof");
    expect(r.exitCode).toBe(1);
    // And it did NOT kill anything blind: the orphan is still alive.
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    expect(res.ok).toBe(true);
  }, 30_000);
});
