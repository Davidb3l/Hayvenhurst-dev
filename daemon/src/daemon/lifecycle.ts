/**
 * Daemon lifecycle: start/stop/status using a PID file in `.hayven/`.
 *
 * We do not yet daemonize via `fork()` — `hayven daemon start` runs in the
 * foreground for v1. The PID file lets `hayven daemon status` and external
 * supervisors check liveness.
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

/** Install signal handlers that remove the PID file on shutdown. */
export function installShutdownHandlers(pidFile: string, onShutdown?: () => void | Promise<void>): void {
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
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  process.on("beforeExit", () => removePidFile(pidFile));
}
