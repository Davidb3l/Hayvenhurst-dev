import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  daemonStatus,
  installShutdownHandlers,
  readPidFile,
  removePidFile,
  SHUTDOWN_SIGNALS,
  writePidFile,
} from "../src/daemon/lifecycle.ts";

describe("lifecycle", () => {
  it("writes and reads pid files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-pid-"));
    const file = join(dir, "daemon.pid");
    writePidFile(file, 42);
    expect(readPidFile(file)).toBe(42);
    removePidFile(file);
    expect(readPidFile(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports `stopped` when no pidfile exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-pid-"));
    expect(daemonStatus(join(dir, "missing.pid")).state).toBe("stopped");
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports `running` for self pid", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-pid-"));
    const file = join(dir, "daemon.pid");
    writePidFile(file, process.pid);
    expect(daemonStatus(file).state).toBe("running");
    removePidFile(file);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports `stale` for a dead pid (start can then clean it and proceed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-pid-"));
    const file = join(dir, "daemon.pid");
    // Spawn a short-lived process and wait for it to exit — its pid is dead.
    const child = Bun.spawn(["true"]);
    await child.exited;
    writePidFile(file, child.pid);
    const status = daemonStatus(file);
    expect(status.state).toBe("stale");
    if (status.state === "stale") expect(status.pid).toBe(child.pid);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("installShutdownHandlers signal set", () => {
  it("covers SIGHUP alongside SIGINT/SIGTERM (terminal close cleans the pidfile)", () => {
    expect(SHUTDOWN_SIGNALS).toContain("SIGHUP");
    expect(SHUTDOWN_SIGNALS).toContain("SIGINT");
    expect(SHUTDOWN_SIGNALS).toContain("SIGTERM");

    const dir = mkdtempSync(join(tmpdir(), "hayven-sig-"));
    const file = join(dir, "daemon.pid");
    const before = Object.fromEntries(
      SHUTDOWN_SIGNALS.map((s) => [s, process.listenerCount(s)]),
    );
    const uninstall = installShutdownHandlers(file);
    try {
      // ONE handler registered per shutdown signal — SIGHUP included, so an
      // abrupt session close runs the same cleanup as Ctrl-C / SIGTERM.
      for (const sig of SHUTDOWN_SIGNALS) {
        expect(process.listenerCount(sig)).toBe((before[sig] ?? 0) + 1);
      }
    } finally {
      uninstall();
      rmSync(dir, { recursive: true, force: true });
    }
    // Uninstall restored the listener counts (no leak into other tests).
    for (const sig of SHUTDOWN_SIGNALS) {
      expect(process.listenerCount(sig)).toBe(before[sig] ?? 0);
    }
  });
});
