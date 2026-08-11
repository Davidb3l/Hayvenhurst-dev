/**
 * HAYV-7 TASK B (stale-safety) - a start lock naming a DEAD pid must never
 * wedge `daemon start`.
 *
 * The single-instance start lock serializes the probe+spawn window. A winner
 * killed hard (SIGKILL, power loss) leaves its lock file behind; if that were
 * treated as held, every future `daemon start` on this address would wait out
 * its bounded budget and fail forever - the lock would have traded a
 * double-start incident for a can-never-start incident. A lock whose stamped
 * pid is dead is debris and must be broken silently.
 *
 * Ephemeral ports and a throwaway $HAYVEN_HOME throughout; the machine's real
 * daemon on :7777 is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonStartLockFile } from "../src/daemon/lifecycle.ts";
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

function daemonPidsFor(port: number): number[] {
  const r = Bun.spawnSync({ cmd: ["ps", "ax", "-o", "pid=,command="], stdout: "pipe", stderr: "ignore" });
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes("daemon start --foreground") && l.includes(`--port ${port}`))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

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

describe("HAYV-7: a stale start lock does not wedge `daemon start`", () => {
  let home: string;
  let workspace: string;
  let priorHome: string | undefined;
  let port = 0;

  beforeEach(() => {
    priorHome = process.env["HAYVEN_HOME"];
    home = mkdtempSync(join(tmpdir(), "hayven-lock-home-"));
    mkdirSync(join(home, ".hayven"), { recursive: true });
    process.env["HAYVEN_HOME"] = home;
    if (!registryFile().startsWith(home)) {
      throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
    }
    workspace = mkdtempSync(join(tmpdir(), "hayven-lock-ws-"));
  });

  afterEach(async () => {
    if (port !== 0) await sweepDaemons(port);
    port = 0;
    if (priorHome === undefined) delete process.env["HAYVEN_HOME"];
    else process.env["HAYVEN_HOME"] = priorHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("breaks a lock stamped with a DEAD pid, starts normally, and releases its own lock", async () => {
    port = await freePort();
    await assertPortUnanswered(port);
    const repo = makeProject(workspace, "stale-lock-repo", port);

    // A verifiably dead pid: a real process we already reaped.
    const dead = Bun.spawn({ cmd: ["sleep", "0"] });
    await dead.exited;

    // The exact lock file the CLI computes for this home + address - same
    // helper, same inputs, so a rename in the implementation fails HERE, not
    // silently by writing an unrelated file the daemon never looks at.
    const lockPath = daemonStartLockFile(join(home, ".hayven"), "127.0.0.1", port);
    writeFileSync(lockPath, `${dead.pid}\n`, "utf8");

    const proc = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--port", String(port)],
      cwd: repo,
      env: {
        ...(process.env as Record<string, string>),
        HAYVEN_HOME: home,
        HAYVEN_PORT: String(port),
        HAYVEN_HOST: "127.0.0.1",
        HAYVEN_LOG_LEVEL: "warn",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);

    // Pre-stale-handling, this would burn the loser budget waiting on debris
    // and exit 1; with it, the start is indistinguishable from a clean one.
    expect(stderr).not.toContain("start lock");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hayven daemon started");

    // The daemon is genuinely up…
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(res.ok).toBe(true);

    // …and the winner RELEASED its own lock: held-forever would serialize
    // nothing and stale-break on every future start, hiding real contention.
    if (existsSync(lockPath)) {
      throw new Error(`start lock not released: ${readFileSync(lockPath, "utf8").trim()} still holds ${lockPath}`);
    }
  }, 90_000);
});
