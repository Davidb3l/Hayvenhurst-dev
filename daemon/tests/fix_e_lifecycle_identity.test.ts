/**
 * E5 — a pidfile carrying no process identity, and E8 — a shutdown that could
 * not be escalated.
 *
 * E5, verified live on the developer's machine at the time of the review: one
 * served repo's `.hayven/daemon.pid` held 29264, a DEAD pid, while the real
 * daemon was 72718. `isAlive` was a bare `process.kill(pid, 0)`, so had the OS
 * recycled 29264, `hayven daemon stop` from that repo would have SIGTERM'd an
 * unrelated process. In the other direction `daemon start` refused FOREVER on a
 * live-but-unrelated pid, with no self-heal — the "pidfile reports a live daemon
 * (pid 1800)" wedge in the user's autostart log.
 *
 * E8: `installShutdownHandlers` latched `shuttingDown` and never escalated, so a
 * second SIGTERM during a wedged drain was swallowed and `kill -9` was the only
 * way out.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  daemonStatus,
  identityFileFor,
  installShutdownHandlers,
  parseEtime,
  readIdentityFile,
  readPidFile,
  removePidFile,
  verifyDaemonIdentity,
  writePidFile,
} from "../src/daemon/lifecycle.ts";

function tmpPidFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "hayven-fixe-pid-"));
  return { dir, file: join(dir, "daemon.pid") };
}

describe("E5: pidfile identity", () => {
  it("keeps the pidfile itself a bare integer (old readers still work)", () => {
    const { dir, file } = tmpPidFile();
    writePidFile(file);
    // A pre-upgrade `readPidFile` does `Number(readFileSync(...).trim())`. If we
    // had put JSON in here, every older client would read NaN → "not running".
    expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid));
    expect(readPidFile(file)).toBe(process.pid);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a SIDECAR identity describing this process", () => {
    const { dir, file } = tmpPidFile();
    writePidFile(file);
    const id = readIdentityFile(file);
    expect(id).not.toBeNull();
    expect(id!.pid).toBe(process.pid);
    expect(id!.host).toBe(hostname());
    // Start time is recorded, and is in the past but not absurdly so.
    expect(id!.startedAtMs).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - id!.startedAtMs).toBeLessThan(24 * 60 * 60 * 1000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies OUR OWN live process as `ours`", () => {
    const { dir, file } = tmpPidFile();
    writePidFile(file);
    expect(verifyDaemonIdentity(file, process.pid)).toBe("ours");
    expect(daemonStatus(file).state).toBe("running");
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects a RECYCLED pid: alive, but not the process we recorded", () => {
    const { dir, file } = tmpPidFile();
    // pid 1 (launchd/init) is always alive and is definitely not our daemon.
    // Claim it with an identity whose start time and command are ours.
    writePidFile(file);
    const mine = readIdentityFile(file)!;
    writeFileSync(file, "1\n", "utf8");
    writeFileSync(identityFileFor(file), JSON.stringify({ ...mine, pid: 1 }), "utf8");

    // THE property: a live pid is not proof of identity.
    expect(verifyDaemonIdentity(file, 1)).toBe("foreign");
    // …and `daemonStatus` downgrades it so every caller's existing stale-handling
    // (remove the file and proceed) self-heals instead of wedging forever.
    expect(daemonStatus(file).state).toBe("stale");
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats a pidfile from ANOTHER HOST as foreign", () => {
    const { dir, file } = tmpPidFile();
    writePidFile(file);
    const mine = readIdentityFile(file)!;
    writeFileSync(identityFileFor(file), JSON.stringify({ ...mine, host: "some-other-box" }), "utf8");
    expect(verifyDaemonIdentity(file, process.pid)).toBe("foreign");
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers `unknown` (never a guess) when there is no sidecar", () => {
    const { dir, file } = tmpPidFile();
    // A pidfile written by a pre-upgrade daemon: integer only, no sidecar.
    writeFileSync(file, `${process.pid}\n`, "utf8");
    expect(verifyDaemonIdentity(file, process.pid)).toBe("unknown");
    // Unverifiable must keep the OLD behavior, not break existing installs.
    expect(daemonStatus(file).state).toBe("running");
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the sidecar with the pidfile, leaving nothing to mis-verify", () => {
    const { dir, file } = tmpPidFile();
    writePidFile(file);
    expect(readIdentityFile(file)).not.toBeNull();
    removePidFile(file);
    expect(readPidFile(file)).toBeNull();
    expect(readIdentityFile(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not leave a STALE sidecar when recording someone else's pid", () => {
    const { dir, file } = tmpPidFile();
    writePidFile(file); // ours, with a sidecar
    writePidFile(file, 4242); // now recording a different process
    // A leftover sidecar describing US would mis-verify pid 4242 as foreign or
    // ours depending on timing — neither is a claim we are entitled to make.
    expect(readIdentityFile(file)).toBeNull();
    expect(verifyDaemonIdentity(file, 4242)).toBe("unknown");
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses every `ps -o etime=` shape", () => {
    expect(parseEtime("00:12")).toBe(12_000);
    expect(parseEtime("01:30")).toBe(90_000);
    expect(parseEtime("02:03:04")).toBe((2 * 3600 + 3 * 60 + 4) * 1000);
    expect(parseEtime("3-04:05:06")).toBe((3 * 24 * 3600 + 4 * 3600 + 5 * 60 + 6) * 1000);
    expect(parseEtime("garbage")).toBeNull();
  });
});

describe("E8: shutdown escalation", () => {
  /** Drive the installed handler by emitting the signal, without exiting. */
  async function withHandlers(
    opts: Parameters<typeof installShutdownHandlers>[2],
    onShutdown: (() => Promise<void>) | undefined,
    body: (emit: (sig: NodeJS.Signals) => void) => Promise<void>,
  ): Promise<void> {
    const { dir, file } = tmpPidFile();
    writePidFile(file);
    const uninstall = installShutdownHandlers(file, onShutdown, opts);
    try {
      await body((sig) => {
        process.emit(sig as never);
      });
    } finally {
      uninstall();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("a SECOND signal during a wedged drain forces an exit", async () => {
    const exits: number[] = [];
    const written: string[] = [];
    await withHandlers(
      {
        exit: ((code: number) => {
          exits.push(code);
          return undefined as never;
        }) as (code: number) => never,
        write: (m: string) => written.push(m),
        forceExitAfterMs: 60_000, // isolate the SIGNAL path from the watchdog
      },
      // A drain that never settles — exactly the wedge that used to need kill -9.
      () => new Promise<void>(() => {}),
      async (emit) => {
        emit("SIGTERM");
        await new Promise((r) => setTimeout(r, 20));
        expect(exits).toEqual([]); // still draining, correctly
        emit("SIGTERM"); // the user is now pressing harder
        await new Promise((r) => setTimeout(r, 20));

        // THE property: the second signal is ACTED ON. It used to be swallowed
        // by the `shuttingDown` latch and return silently.
        expect(exits).toEqual([1]);
        expect(written.join("")).toContain("forcing exit");
      },
    );
  });

  it("a watchdog force-exits a hung drain even with no second signal", async () => {
    const exits: number[] = [];
    const written: string[] = [];
    await withHandlers(
      {
        exit: ((code: number) => {
          exits.push(code);
          return undefined as never;
        }) as (code: number) => never,
        write: (m: string) => written.push(m),
        forceExitAfterMs: 60,
      },
      () => new Promise<void>(() => {}),
      async (emit) => {
        emit("SIGTERM");
        await new Promise((r) => setTimeout(r, 200));
        expect(exits).toEqual([1]);
        expect(written.join("")).toContain("forcing exit");
      },
    );
  });

  it("a normal shutdown still exits cleanly and removes EVERY owned pidfile", async () => {
    const exits: number[] = [];
    const extraDir = mkdtempSync(join(tmpdir(), "hayven-fixe-extra-"));
    const extra = join(extraDir, "daemon.pid");
    writePidFile(extra);

    await withHandlers(
      {
        exit: ((code: number) => {
          exits.push(code);
          return undefined as never;
        }) as (code: number) => never,
        write: () => {},
        forceExitAfterMs: 60_000,
        // E4: the daemon owns one pidfile PER SERVED PROJECT, not just the
        // primary's — all of them must be cleaned up on the way out.
        extraPidFiles: () => [extra],
      },
      async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
      async (emit) => {
        emit("SIGTERM");
        await new Promise((r) => setTimeout(r, 80));
        expect(exits).toEqual([0]);
        expect(readPidFile(extra)).toBeNull();
      },
    );
    rmSync(extraDir, { recursive: true, force: true });
  });
});
