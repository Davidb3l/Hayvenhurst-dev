/**
 * Daemon lifecycle: start/stop/status using a PID file in `.hayven/`.
 *
 * `hayven daemon start` detaches by default (see `daemon/detach.ts`): the CLI
 * re-execs itself with `--foreground`, redirects stdio to the daemon log, and
 * unrefs the child so it survives the launching shell/session. `--foreground`
 * keeps the v1 behavior for CI, tests, and external supervisors. The PID file
 * lets `hayven daemon status` and supervisors check liveness.
 *
 * A bare pid is NOT an identity. `process.kill(pid, 0)` only proves SOMETHING
 * with that number is alive, and pids recycle — a stale pidfile pointing at a
 * recycled number made `hayven daemon stop` willing to SIGTERM an unrelated
 * process, and made `daemon start` refuse forever ("pidfile reports a live
 * daemon (pid 1800)") with no way to self-heal. So every pidfile now gets a
 * SIDECAR identity file (`daemon.pid.json`) recording the pid, its BOOT-RELATIVE
 * start offset and its `ps` command, and {@link verifyDaemonIdentity} checks the
 * live process against it. The pidfile itself keeps its plain-integer format so
 * older readers are unaffected; a missing sidecar degrades to the old behavior.
 *
 * The start signal is deliberately boot-relative rather than wall-clock: see
 * {@link verifyDaemonIdentity} for why comparing two absolute clock readings
 * turned an NTP step into a duplicate daemon.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

export type DaemonStatus =
  | { state: "running"; pid: number }
  | { state: "stopped" }
  | { state: "stale"; pid: number };

/**
 * What we record about OURSELVES next to a pidfile so a later `stop`/`status`
 * can tell our daemon from an unrelated process that recycled the pid.
 */
export interface DaemonIdentity {
  pid: number;
  /**
   * Epoch ms this process started (`now - uptime`), in WALL-CLOCK terms.
   *
   * RETAINED FOR OLD READERS ONLY — {@link verifyDaemonIdentity} no longer
   * declares anything `foreign` on the strength of this field. It compares two
   * absolute wall-clock readings taken at different times, so an NTP step or a
   * VM resume between write and check moves a perfectly healthy daemon outside
   * the tolerance: it was then reported `foreign`, which made `daemon stop` say
   * "not running" and DELETE the pidfile, and the next `daemon start` bring up a
   * duplicate. Use {@link DaemonIdentity.startOffsetFromBootMs}.
   */
  startedAtMs: number;
  /**
   * How long after BOOT this process started, in ms — the clock-agreement-free
   * identity signal.
   *
   * Derived as `etime(pid 1) - process.uptime()`. Both terms are computed by the
   * kernel from the same reference, so a wall-clock step shifts them by the SAME
   * amount and cancels out of the difference; at verify time the same quantity
   * is recomputed as `etime(pid 1) - etime(pid)`. A recycled pid started later
   * in the machine's life and cannot match. `null` when `ps -p 1` was
   * unavailable (a restricted sandbox), in which case the check degrades to
   * `unknown` rather than guessing.
   */
  startOffsetFromBootMs: number | null;
  /** `ps -o comm=` at write time, or null when `ps` was unavailable. */
  comm: string | null;
  /** Guards a pidfile that reached another machine (synced dotfiles, NFS home). */
  host: string;
}

/**
 * - `ours`    — the live pid verifiably IS the daemon that wrote this pidfile.
 * - `foreign` — the live pid is verifiably NOT it (recycled number, other host).
 * - `unknown` — no sidecar / `ps` unavailable. Callers must fall back to the
 *   pre-identity behavior (treat a live pid as the daemon) rather than guess.
 */
export type IdentityVerdict = "ours" | "foreign" | "unknown";

/**
 * `ps` reports elapsed time truncated to whole seconds and our own start-time
 * estimate has sub-second error, so compare with slack. A recycled pid would
 * have to have started within this window of the original daemon AND run the
 * same command to slip through.
 */
export const IDENTITY_START_TOLERANCE_MS = 10_000;

/**
 * Milliseconds since boot, read as pid 1's elapsed time.
 *
 * pid 1 exists on every POSIX system this ships to (launchd on macOS, init /
 * systemd on Linux, the container's entrypoint inside a container) and is by
 * definition the first process, so its `etime` IS the machine's (or the
 * namespace's) uptime. We only ever use it as a shared reference point that both
 * the write and the verify subtract from, so it does not matter that a
 * container's pid 1 is younger than the host — it just has to be the same
 * reference on both sides, and it is.
 *
 * `null` when `ps` is unavailable or unparseable.
 */
export function systemUptimeMs(): number | null {
  const raw = psFields(1, "etime=");
  if (raw === null) return null;
  return parseEtime(raw);
}

/** Absolute path of the sidecar identity file for a pidfile. */
export function identityFileFor(pidFile: string): string {
  return `${pidFile}.json`;
}

function psFields(pid: number, fields: string): string | null {
  try {
    const r = Bun.spawnSync({
      cmd: ["ps", "-p", String(pid), "-o", fields],
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    const out = new TextDecoder().decode(r.stdout).trim();
    return out.length > 0 ? out : null;
  } catch {
    // No `ps` (unusual container, restricted sandbox) — identity is unavailable,
    // never a hard failure.
    return null;
  }
}

/** Parse `ps -o etime=`'s `[[dd-]hh:]mm:ss` into milliseconds. */
export function parseEtime(raw: string): number | null {
  const m = raw.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

function currentIdentity(): DaemonIdentity {
  const uptimeMs = systemUptimeMs();
  return {
    pid: process.pid,
    startedAtMs: Math.round(Date.now() - process.uptime() * 1000),
    // Boot-relative, so it survives an NTP step or a VM resume. See the field doc.
    startOffsetFromBootMs:
      uptimeMs === null ? null : Math.round(uptimeMs - process.uptime() * 1000),
    comm: psFields(process.pid, "comm="),
    host: hostname(),
  };
}

export function readIdentityFile(pidFile: string): DaemonIdentity | null {
  const file = identityFileFor(pidFile);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DaemonIdentity>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAtMs !== "number") return null;
    return {
      pid: parsed.pid,
      startedAtMs: parsed.startedAtMs,
      // Absent in sidecars written before this field existed — `null` there is
      // what makes `verifyDaemonIdentity` degrade to `unknown` instead of
      // falling back to the wall-clock comparison it replaced.
      startOffsetFromBootMs:
        typeof parsed.startOffsetFromBootMs === "number" ? parsed.startOffsetFromBootMs : null,
      comm: typeof parsed.comm === "string" ? parsed.comm : null,
      host: typeof parsed.host === "string" ? parsed.host : "",
    };
  } catch {
    return null;
  }
}

/**
 * Is the live process `pid` actually the daemon that wrote `pidFile`?
 *
 * Answers `unknown` — never a guess — whenever the evidence is missing, so a
 * pidfile written by a pre-upgrade daemon keeps behaving exactly as before.
 *
 * NO VERDICT DEPENDS ON TWO CLOCKS AGREEING. The original check compared
 * `ps -o etime=` (wall clock, read now) against `Date.now() - uptime` (wall
 * clock, recorded at write time) with a 10 s tolerance. Any NTP step or VM
 * resume in between exceeded that by construction, and a healthy daemon was
 * then reported `foreign` — at which point `daemon stop` printed "not running"
 * and deleted the pidfile, and the next `daemon start` brought up a DUPLICATE
 * daemon on the same indexes. The replacement compares BOOT-RELATIVE start
 * offsets (`etime(pid 1) - etime(pid)`), which a clock step shifts identically
 * on both terms, so it cancels.
 */
export function verifyDaemonIdentity(pidFile: string, pid: number): IdentityVerdict {
  const id = readIdentityFile(pidFile);
  // A sidecar naming a DIFFERENT pid describes a previous daemon, not this pid;
  // it proves nothing either way.
  if (id === null || id.pid !== pid) return "unknown";
  if (id.host.length > 0 && id.host !== hostname()) return "foreign";
  const observed = psFields(pid, "etime=,comm=");
  if (observed === null) return "unknown";
  const m = observed.trim().match(/^(\S+)\s+(.*)$/);
  if (!m) return "unknown";
  const elapsedMs = parseEtime(m[1]!);
  if (elapsedMs === null) return "unknown";
  // Command mismatch is clock-free proof of a recycled pid — keep it first.
  if (id.comm !== null && m[2]!.trim() !== id.comm) return "foreign";

  // Boot-relative start offset: the same quantity the sidecar recorded, but
  // recomputed from two `ps` readings taken in the same instant.
  if (id.startOffsetFromBootMs === null) {
    // Pre-upgrade sidecar. There is no clock-free start evidence, and the
    // wall-clock field it does carry is exactly the one that mis-fires — so we
    // report `unknown` (callers fall back to pre-identity behavior: `stop` still
    // signals the pid, `status` still says running) rather than risk declaring a
    // healthy daemon foreign. The next daemon start writes a full sidecar.
    return "unknown";
  }
  const uptimeMs = systemUptimeMs();
  if (uptimeMs === null) return "unknown"; // no reference point — do not guess
  const observedOffset = uptimeMs - elapsedMs;
  if (Math.abs(observedOffset - id.startOffsetFromBootMs) > IDENTITY_START_TOLERANCE_MS) {
    return "foreign";
  }
  return "ours";
}

export function writePidFile(path: string, pid: number = process.pid): void {
  // Plain integer, unchanged: `readPidFile` in older builds does `Number(trim)`,
  // so anything richer here would make every pre-upgrade reader see "stopped".
  writeFileSync(path, String(pid) + "\n", "utf8");
  if (pid === process.pid) {
    try {
      writeFileSync(identityFileFor(path), JSON.stringify(currentIdentity()) + "\n", "utf8");
    } catch {
      // The sidecar is an optimization — a daemon must still start without it.
    }
  } else {
    // Recording someone else's pid: we cannot describe that process, and a
    // LEFTOVER sidecar from a previous daemon would mis-verify it as foreign.
    removeIdentityFile(path);
  }
}

function removeIdentityFile(path: string): void {
  const file = identityFileFor(path);
  if (!existsSync(file)) return;
  try {
    unlinkSync(file);
  } catch {
    // Already gone.
  }
}

export function removePidFile(path: string): void {
  removeIdentityFile(path);
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
  if (!isAlive(pid)) return { state: "stale", pid };
  // A live pid is not proof: report `stale` when the sidecar says this process
  // is demonstrably NOT our daemon, so every caller's existing stale-handling
  // (remove the file and proceed) self-heals a recycled pid instead of wedging.
  if (verifyDaemonIdentity(pidFile, pid) === "foreign") return { state: "stale", pid };
  return { state: "running", pid };
}

/**
 * Signals that trigger a graceful shutdown (drain + pidfile cleanup).
 * SIGHUP is included so an abrupt terminal/session close (the controlling
 * terminal going away) cleans up exactly like SIGINT/SIGTERM instead of
 * killing the process with a stale pidfile left behind.
 */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Hard ceiling on a graceful shutdown. `daemon stop` waits 10 s for the process
 * to die; a drain that outlives that leaves the user with a daemon that is
 * neither running nor stopped and no signal that will end it. After this we
 * exit regardless.
 */
export const FORCE_EXIT_AFTER_MS = 12_000;

export interface ShutdownHandlerOptions {
  /** Extra pidfiles to remove on exit (the non-primary served projects). */
  extraPidFiles?: () => string[];
  /** Override the hard force-exit ceiling. Tests only. */
  forceExitAfterMs?: number;
  /** Injected exit, for tests. */
  exit?: (code: number) => never;
  /** Injected stderr writer, for tests. */
  write?: (msg: string) => void;
}

/**
 * Install signal handlers that remove the PID file(s) on shutdown.
 * Returns an uninstall function (used by tests; the daemon never calls it).
 *
 * A SECOND signal during shutdown ESCALATES to an immediate exit. Previously it
 * was swallowed by the `shuttingDown` latch, so a wedged drain could only be
 * ended with `kill -9`. A watchdog enforces the same ceiling when no second
 * signal ever arrives.
 */
export function installShutdownHandlers(
  pidFile: string,
  onShutdown?: () => void | Promise<void>,
  opts: ShutdownHandlerOptions = {},
): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const write = opts.write ?? ((msg: string) => void process.stderr.write(msg));
  const forceExitAfterMs = opts.forceExitAfterMs ?? FORCE_EXIT_AFTER_MS;

  const cleanupPidFiles = (): void => {
    removePidFile(pidFile);
    for (const extra of opts.extraPidFiles?.() ?? []) {
      if (extra !== pidFile) removePidFile(extra);
    }
  };

  let shuttingDown = false;
  const handler = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      write(`\n${signal} received while already shutting down — forcing exit\n`);
      cleanupPidFiles();
      exit(signal === "SIGINT" ? 130 : 1);
      return;
    }
    shuttingDown = true;
    // Watchdog: unref'd so it never keeps an otherwise-finished process alive,
    // but the daemon holds its server open, so a hung drain WILL hit this.
    const watchdog = setTimeout(() => {
      write(`shutdown exceeded ${Math.round(forceExitAfterMs / 1000)}s — forcing exit\n`);
      cleanupPidFiles();
      exit(1);
    }, forceExitAfterMs);
    if (typeof watchdog.unref === "function") watchdog.unref();
    try {
      await onShutdown?.();
    } finally {
      clearTimeout(watchdog);
      cleanupPidFiles();
      // Re-raise the signal to get a normal exit code.
      exit(signal === "SIGINT" ? 130 : 0);
    }
  };
  for (const sig of SHUTDOWN_SIGNALS) process.on(sig, handler);
  const onBeforeExit = (): void => cleanupPidFiles();
  process.on("beforeExit", onBeforeExit);
  return () => {
    for (const sig of SHUTDOWN_SIGNALS) process.removeListener(sig, handler);
    process.removeListener("beforeExit", onBeforeExit);
  };
}
