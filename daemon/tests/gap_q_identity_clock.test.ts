/**
 * GAP Q9 — `verifyDaemonIdentity` depended on two clocks agreeing.
 *
 * The old check compared `ps -o etime=` (wall clock, read NOW) against
 * `Date.now() - process.uptime()*1000` (wall clock, recorded at WRITE time) with
 * a 10 s tolerance. Any NTP step or VM resume between the two exceeds that by
 * construction, and a perfectly healthy daemon was then reported `foreign`:
 * `hayven daemon stop` printed "daemon is not running", DELETED the pidfile, and
 * the next `hayven daemon start` brought up a DUPLICATE daemon on the same
 * indexes — two writers on one WAL.
 *
 * The replacement compares BOOT-RELATIVE start offsets (`etime(pid 1) -
 * etime(pid)`). A wall-clock step shifts both terms identically, so it cancels.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  daemonStatus,
  identityFileFor,
  readIdentityFile,
  systemUptimeMs,
  verifyDaemonIdentity,
  writePidFile,
  type DaemonIdentity,
} from "../src/daemon/lifecycle.ts";

const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-gapq-id-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A pidfile + sidecar describing THIS process (which is genuinely alive). */
function selfPidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "hayven-gapq-id-"));
  dirs.push(dir);
  const pidFile = join(dir, "daemon.pid");
  writePidFile(pidFile);
  return pidFile;
}

function patchSidecar(pidFile: string, patch: Partial<DaemonIdentity>): void {
  const file = identityFileFor(pidFile);
  const id = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...id, ...patch }) + "\n", "utf8");
}

function dropSidecarField(pidFile: string, field: string): void {
  const file = identityFileFor(pidFile);
  const id = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete id[field];
  writeFileSync(file, JSON.stringify(id) + "\n", "utf8");
}

describe("Q9 — identity survives a clock step", () => {
  test("the sidecar records a boot-relative start offset", () => {
    const pidFile = selfPidFile();
    const id = readIdentityFile(pidFile);
    expect(id).not.toBeNull();
    // `ps -p 1 -o etime=` is available on every platform this ships to; if it
    // ever is not, the offset is null and the verdict degrades to `unknown`.
    if (systemUptimeMs() !== null) {
      expect(typeof id!.startOffsetFromBootMs).toBe("number");
    }
  });

  test("an NTP step / VM resume does NOT turn a healthy daemon foreign", () => {
    const pidFile = selfPidFile();
    // Simulate the clock having jumped an hour since the sidecar was written:
    // `startedAtMs` (absolute wall clock) is now wildly wrong, while the
    // boot-relative offset — the signal that actually identifies us — is intact.
    patchSidecar(pidFile, { startedAtMs: Date.now() - 3_600_000 });

    const verdict = verifyDaemonIdentity(pidFile, process.pid);
    expect(verdict).not.toBe("foreign");
    // ...and the knock-on behavior: `stop`/`status` still see a live daemon
    // instead of "stale pidfile removed; daemon is not running".
    expect(daemonStatus(pidFile).state).toBe("running");
  });

  test("a genuinely different boot-relative start IS still foreign", () => {
    const pidFile = selfPidFile();
    const id = readIdentityFile(pidFile)!;
    if (id.startOffsetFromBootMs === null) return; // no `ps -p 1` here — nothing to assert
    // A recycled pid started much later in the machine's life.
    patchSidecar(pidFile, { startOffsetFromBootMs: id.startOffsetFromBootMs - 600_000 });
    expect(verifyDaemonIdentity(pidFile, process.pid)).toBe("foreign");
  });

  test("a different HOST is still foreign (clock-free evidence, unchanged)", () => {
    const pidFile = selfPidFile();
    patchSidecar(pidFile, { host: `${hostname()}-somewhere-else` });
    expect(verifyDaemonIdentity(pidFile, process.pid)).toBe("foreign");
  });

  test("a different command is still foreign (clock-free evidence, unchanged)", () => {
    const pidFile = selfPidFile();
    patchSidecar(pidFile, { comm: "definitely-not-bun" });
    expect(verifyDaemonIdentity(pidFile, process.pid)).toBe("foreign");
  });

  test("a PRE-UPGRADE sidecar degrades to `unknown`, never to a clock-based `foreign`", () => {
    const pidFile = selfPidFile();
    // Old-format sidecar: no boot offset, and a wall-clock start that a step has
    // invalidated. The old code called this `foreign` and deleted the pidfile.
    dropSidecarField(pidFile, "startOffsetFromBootMs");
    patchSidecar(pidFile, { startedAtMs: Date.now() - 3_600_000 });

    expect(verifyDaemonIdentity(pidFile, process.pid)).toBe("unknown");
    // `unknown` keeps the pre-identity behavior: the daemon still reads as running,
    // so `stop` signals it instead of claiming nothing is there.
    expect(daemonStatus(pidFile).state).toBe("running");
  });

  test("a sidecar naming a DIFFERENT pid proves nothing either way", () => {
    const pidFile = selfPidFile();
    patchSidecar(pidFile, { pid: process.pid + 1 });
    expect(verifyDaemonIdentity(pidFile, process.pid)).toBe("unknown");
  });
});
