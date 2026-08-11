/**
 * THE LOSER PATH IS REACHABLE - the differential test the first cut lacked.
 *
 * The review of the HAYV-7 work found the start lock INERT at its call site:
 * `tryAcquireStartLock` returns the three-way string
 * `"acquired" | "held" | "unavailable"`, and the caller tested it with
 * `!result` - always false for a non-empty string - so the loser branch was
 * dead code and every racer proceeded as the winner. The suite stayed green
 * anyway, because `reusePort: false` independently makes a losing CHILD die
 * on EADDRINUSE and the parent converges via the daemon-already-answering
 * path. Outcome-shaped tests (both exit 0, one listener) therefore cannot
 * tell a working lock from a dead one.
 *
 * This test can. It pre-holds the start lock with THIS process's pid (alive,
 * so never breakable as stale) while making sure NO daemon answers the
 * address. A working lock sends `daemon start` down the loser path, where it
 * must WAIT and, with no winner daemon ever appearing, give up naming the
 * lock and its holder. The inert call site never waits: it starts a daemon
 * and exits 0 in a few seconds - which is exactly how this test fails
 * against the pre-fix code (verified by stashing the fix).
 *
 * Real process, ephemeral port, throwaway $HAYVEN_HOME. NEVER port 7777.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonStartLockFile } from "../src/daemon/lifecycle.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("could not obtain a free port from the OS");
  return port;
}

describe("daemon start honors a held start lock (the loser path exists)", () => {
  let home: string | null = null;
  const children: ReturnType<typeof Bun.spawn>[] = [];

  afterEach(async () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
        await c.exited;
      } catch {
        // already gone
      }
    }
    children.length = 0;
    if (home !== null) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it(
    "waits on a live holder's lock instead of starting, and says whose lock it is",
    async () => {
      home = mkdtempSync(join(tmpdir(), "hayven-lock-loser-"));
      const port = await freePort();
      const repo = join(home, "repo");
      mkdirSync(join(repo, ".hayven"), { recursive: true });
      writeFileSync(
        join(repo, ".hayven", "config.json"),
        JSON.stringify({ daemon_host: "127.0.0.1", daemon_port: port }),
        "utf8",
      );

      // Hold the lock as THIS process: alive, so never breakable as stale.
      // The daemon start below must treat it as HELD for its whole wait.
      const globalDir = join(home, ".hayven");
      mkdirSync(globalDir, { recursive: true });
      const lockPath = daemonStartLockFile(globalDir, "127.0.0.1", port);
      writeFileSync(lockPath, String(process.pid) + "\n", { flag: "wx" });

      const child = Bun.spawn({
        cmd: [process.execPath, CLI, "daemon", "start"],
        cwd: repo,
        env: {
          ...(process.env as Record<string, string>),
          HAYVEN_HOME: home,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);

      // A WORKING loser path polls for the full START_LOCK_WAIT_MS (20s)
      // because no winner daemon will ever appear on this port. The INERT
      // call site ignores the lock, spawns a daemon, and exits 0 well inside
      // 15s. So: still-running at 15s distinguishes the two implementations
      // before we even read the exit.
      const WINDOW_MS = 15_000;
      const finishedEarly = await Promise.race([
        child.exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), WINDOW_MS)),
      ]);
      expect(finishedEarly).toBe(false);

      // Let it reach its own deadline and verify it FAILED, naming the lock
      // and the live holder, and that no daemon was started on the port.
      const code = await child.exited;
      const err = await new Response(child.stderr).text();
      expect(code).toBe(1);
      expect(err).toContain("start lock");
      expect(err).toContain(String(process.pid));
      let answered = true;
      try {
        await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(700),
        });
      } catch {
        answered = false;
      }
      expect(answered).toBe(false);
    },
    45_000,
  );
});
