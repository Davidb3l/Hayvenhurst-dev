/**
 * HAYV-7 TASKS B + B2 - the double-start race is CLOSED at both ends.
 *
 * Field evidence: two daemons started ONE SECOND apart (two SessionStart
 * ensure-daemon hooks racing) and coexisted for a full day. Two independent
 * defects made that possible:
 *   B  - `startDetachedDaemon` ran probe -> decide -> spawn with no mutual
 *        exclusion, so both racers passed the probe and both spawned.
 *   B2 - Elysia's Bun adapter defaults `reusePort: true` (SO_REUSEPORT), so
 *        the second daemon's bind SUCCEEDED silently instead of throwing
 *        EADDRINUSE; on macOS the newest binder takes the traffic, exactly
 *        matching the incident (the SECOND pid held :7777, both alive).
 *
 * These tests spawn REAL daemon processes on ephemeral ports inside a
 * throwaway $HAYVEN_HOME. NEVER port 7777 - a real daemon serves 10 projects
 * there on this machine.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryFile } from "../src/daemon/registry.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("could not obtain a free port from the OS");
  return port;
}

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
 * Every live pid whose command line marks it as a foreground daemon bound to
 * `port`. The `--port <port>` argument is forwarded verbatim to the detached
 * child, so it uniquely fingerprints THIS test's daemons - an ephemeral port
 * appears in no other process on the machine.
 */
function daemonPidsFor(port: number): number[] {
  const r = Bun.spawnSync({ cmd: ["ps", "ax", "-o", "pid=,command="], stdout: "pipe", stderr: "ignore" });
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes("daemon start --foreground") && l.includes(`--port ${port}`))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** SIGKILL every daemon this test's port fingerprints, and wait them out. */
async function sweepDaemons(port: number): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const pids = daemonPidsFor(port);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

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

describe("HAYV-7 TASK B: concurrent `daemon start` yields exactly one daemon", () => {
  let home: string;
  let workspace: string;
  let priorHome: string | undefined;
  let port = 0;

  beforeEach(() => {
    priorHome = process.env["HAYVEN_HOME"];
    home = mkdtempSync(join(tmpdir(), "hayven-race-home-"));
    mkdirSync(join(home, ".hayven"), { recursive: true });
    process.env["HAYVEN_HOME"] = home;
    if (!registryFile().startsWith(home)) {
      throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
    }
    workspace = mkdtempSync(join(tmpdir(), "hayven-race-ws-"));
  });

  afterEach(async () => {
    // Kill every daemon we may have spawned - detached daemons are NOT our
    // children, so the ps fingerprint sweep is the only reliable reaper, and
    // it must run even when the test body failed early.
    if (port !== 0) await sweepDaemons(port);
    port = 0;
    if (priorHome === undefined) delete process.env["HAYVEN_HOME"];
    else process.env["HAYVEN_HOME"] = priorHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("two SIMULTANEOUS starts: both exit 0, exactly ONE daemon process results", async () => {
    port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "raced-repo", port);
    const env = childEnv(home, port);

    // The incident's shape: two `daemon start` invocations in flight at once
    // (the hooks were one second apart; same-instant is strictly harsher).
    const args = ["bun", CLI, "daemon", "start", "--port", String(port)];
    const [a, b] = await Promise.all([runCli(args, repo, env), runCli(args, repo, env)]);

    // Both callers succeed: the winner starts the daemon, the loser finds it
    // healthy via the already-running path. Neither errors, neither hangs.
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);

    // THE property: exactly one daemon process holds the address. Pre-fix,
    // both racers spawned and (thanks to SO_REUSEPORT) both children BOUND -
    // this counted 2.
    const pids = daemonPidsFor(port);
    expect(pids.length).toBe(1);

    // And the one that answers is that same process (Task C's pid field).
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = (await res.json()) as { pid?: number };
    expect(health.pid).toBe(pids[0]);
  }, 90_000);

  it("B2: a second FOREGROUND daemon on a taken port dies loudly on EADDRINUSE", async () => {
    port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "bind-repo", port);
    const env = childEnv(home, port);

    const first = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: repo,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // Wait until the first daemon genuinely serves.
      let up = false;
      for (let i = 0; i < 200 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).ok;
        } catch {
          /* not up yet */
        }
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up).toBe(true);

      // A second foreground daemon on the SAME port must fail its bind and
      // exit non-zero, quickly and loudly. Pre-fix (Elysia's reusePort:true
      // default) this bind SUCCEEDED, the process stayed alive serving the
      // port, and this race below timed out. Launched from a SECOND repo so
      // the first repo's pidfile guard cannot short-circuit before the bind -
      // the property under test is the socket, not the pidfile.
      const repo2 = makeProject(workspace, "bind-repo-2", port);
      const second = Bun.spawn({
        cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
        cwd: repo2,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exited = await Promise.race([
        second.exited,
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 20_000)),
      ]);
      if (exited === "timeout") {
        second.kill("SIGKILL");
        await second.exited;
        throw new Error("second daemon did not exit - it silently double-bound the port (SO_REUSEPORT regression)");
      }
      expect(exited).not.toBe(0);
      const err = await new Response(second.stderr as ReadableStream).text();
      expect(err).toMatch(/in use/i);

      // The first daemon is unharmed and still answering.
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      expect(res.ok).toBe(true);
      const health = (await res.json()) as { pid?: number };
      expect(health.pid).toBe(first.pid);
    } finally {
      try {
        first.kill("SIGKILL");
        await first.exited;
      } catch {
        /* already gone */
      }
    }
  }, 90_000);
});
