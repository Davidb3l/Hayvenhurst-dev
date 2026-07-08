/**
 * Daemon lifecycle: start/stop/status using a PID file in `.hayven/`.
 *
 * `hayven daemon start` detaches by default (see `daemon/detach.ts`): the CLI
 * re-execs itself with `--foreground`, redirects stdio to the daemon log, and
 * unrefs the child so it survives the launching shell/session. `--foreground`
 * keeps the v1 behavior for CI, tests, and external supervisors. The PID file
 * lets `hayven daemon status` and supervisors check liveness.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export type DaemonStatus =
  | { state: "running"; pid: number }
  | { state: "stopped" }
  | { state: "stale"; pid: number };

export function writePidFile(path: string, pid: number = process.pid): void {
  writeFileSync(path, String(pid) + "\n", "utf8");
}

export function removePidFile(path: string): void {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Returns true iff a process with the given pid is alive (POSIX-style check). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM => exists but we lack permission. Treat as alive.
    return e.code === "EPERM";
  }
}

export function daemonStatus(pidFile: string): DaemonStatus {
  const pid = readPidFile(pidFile);
  if (pid === null) return { state: "stopped" };
  if (isAlive(pid)) return { state: "running", pid };
  return { state: "stale", pid };
}

/**
 * Signals that trigger a graceful shutdown (drain + pidfile cleanup).
 * SIGHUP is included so an abrupt terminal/session close (the controlling
 * terminal going away) cleans up exactly like SIGINT/SIGTERM instead of
 * killing the process with a stale pidfile left behind.
 */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Install signal handlers that remove the PID file on shutdown.
 * Returns an uninstall function (used by tests; the daemon never calls it).
 */
export function installShutdownHandlers(
  pidFile: string,
  onShutdown?: () => void | Promise<void>,
): () => void {
  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await onShutdown?.();
    } finally {
      removePidFile(pidFile);
      // Re-raise the signal to get a normal exit code.
      process.exit(signal === "SIGINT" ? 130 : 0);
    }
  };
  for (const sig of SHUTDOWN_SIGNALS) process.on(sig, handler);
  const onBeforeExit = (): void => removePidFile(pidFile);
  process.on("beforeExit", onBeforeExit);
  return () => {
    for (const sig of SHUTDOWN_SIGNALS) process.removeListener(sig, handler);
    process.removeListener("beforeExit", onBeforeExit);
  };
}
