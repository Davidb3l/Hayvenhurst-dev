/**
 * HAYV-7 TASK C - `GET /api/health` names its serving process.
 *
 * The orphan incident's diagnosis needed `lsof` because nothing in the health
 * payload said WHICH process was answering. `pid` (additive; older clients
 * ignore it) is what lets `daemon stop`/`status` name - and confidently signal
 * - an orphan, and lets `sirius doctor` detect one without lsof.
 *
 * A REAL daemon child is spawned so the assertion pins the actual serving
 * process's pid, not a mock's. Ephemeral port, throwaway $HAYVEN_HOME.
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

async function assertPortUnanswered(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new Error(`test precondition failed: something is already answering on port ${port}`);
}

describe("HAYV-7 TASK C: /api/health carries the serving pid", () => {
  let home: string;
  let workspace: string;
  let priorHome: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | null = null;

  beforeEach(() => {
    priorHome = process.env["HAYVEN_HOME"];
    home = mkdtempSync(join(tmpdir(), "hayven-hpid-home-"));
    mkdirSync(join(home, ".hayven"), { recursive: true });
    process.env["HAYVEN_HOME"] = home;
    if (!registryFile().startsWith(home)) {
      throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
    }
    workspace = mkdtempSync(join(tmpdir(), "hayven-hpid-ws-"));
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
    if (priorHome === undefined) delete process.env["HAYVEN_HOME"];
    else process.env["HAYVEN_HOME"] = priorHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reports the daemon process's own pid", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const repo = join(workspace, "repo");
    mkdirSync(join(repo, ".hayven"), { recursive: true });
    writeFileSync(
      join(repo, ".hayven", "config.json"),
      JSON.stringify({ daemon_host: "127.0.0.1", daemon_port: port }),
      "utf8",
    );

    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
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

    let health: { ok?: boolean; pid?: number } | null = null;
    for (let i = 0; i < 200; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          health = (await res.json()) as { ok?: boolean; pid?: number };
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(health?.ok).toBe(true);
    // THE property: the payload names the exact process that produced it -
    // the foreground child we spawned. Pre-fix, `pid` was absent entirely.
    expect(health?.pid).toBe(child.pid);
  }, 45_000);
});
