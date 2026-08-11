/**
 * `daemon status` must not tell the user a live process is dead.
 *
 * FIELD REPORT (2026-08-05). `hayven daemon status` run from one repo printed
 *
 *     stale pidfile (pid 61445 is not alive)
 *
 * while pid 61445 was alive, listening on 127.0.0.1:7777, and answering
 * /api/health. The same command in a sibling repo correctly printed
 * `running (pid 61445)`. Both repos' `.hayven/daemon.pid` contained 61445.
 *
 * The identity check was RIGHT: the second repo held a leftover pidfile from an
 * earlier daemon whose pid the OS had since handed to the current one, so its
 * sidecar recorded a different boot-relative start offset (161.94h vs the
 * observed 96.02h) and `verifyDaemonIdentity` correctly answered "foreign".
 *
 * The REPORTING was wrong. `daemonStatus` collapses "no such process" and
 * "alive, but not our daemon" into one `stale` state so that callers self-heal
 * identically (remove the file, proceed) — correct for callers, but the status
 * command then printed the wrong one of the two facts. On a machine running one
 * shared daemon, the recycled pid usually IS that daemon, so the message denied
 * the existence of a process the user could see running, and `sirius doctor`
 * read the shared daemon as down.
 *
 * These tests pin the distinction, not the prose: `state` stays `stale` for both
 * (so no caller's self-healing changes), while `reason` separates them.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  daemonStatus,
  identityFileFor,
  systemUptimeMs,
  writePidFile,
} from "../src/daemon/lifecycle.ts";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "hayven-status-reason-"));
}

/** A pid that cannot be alive: the kernel never hands out 2^22. */
const DEAD_PID = 4_194_304;

describe("daemonStatus distinguishes a dead pid from a recycled one", () => {
  it("reports reason 'dead' when no process holds the pid", () => {
    const dir = sandbox();
    try {
      const file = join(dir, "daemon.pid");
      writeFileSync(file, `${DEAD_PID}\n`, "utf8");
      const status = daemonStatus(file);
      expect(status.state).toBe("stale");
      // The narrow claim: nothing is running under that number.
      expect(status.state === "stale" && status.reason).toBe("dead");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports reason 'foreign' for a LIVE pid the sidecar disowns", () => {
    const dir = sandbox();
    try {
      const file = join(dir, "daemon.pid");
      // Point the pidfile at THIS process, which is definitionally alive, then
      // write a sidecar describing a different process that held the same pid:
      // same pid, same host, same comm, but a start offset far outside the
      // 10s tolerance. That is exactly the shape of the field report.
      writeFileSync(file, `${process.pid}\n`, "utf8");
      const uptimeMs = systemUptimeMs();
      if (uptimeMs === null) return; // no ps/etime on this platform; nothing to assert
      writeFileSync(
        identityFileFor(file),
        `${JSON.stringify({
          pid: process.pid,
          startedAtMs: Date.now() - 3_600_000,
          // Half the machine's uptime ago: a real offset for a real process,
          // just not for THIS one. Never negative, never above uptime, so it is
          // indistinguishable from a legitimate record except by comparison.
          startOffsetFromBootMs: Math.round(uptimeMs / 2),
          comm: null, // skip the comm check so the offset is what decides
          host: hostname(),
        })}\n`,
        "utf8",
      );

      const status = daemonStatus(file);
      expect(status.state).toBe("stale");
      expect(status.state === "stale" && status.reason).toBe("foreign");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still reports running for a pidfile+sidecar this process wrote", () => {
    // The control. If this ever fails, the identity check has become too strict
    // and every healthy daemon is about to be declared stale, which is the
    // failure mode that costs a pidfile and spawns a duplicate daemon.
    const dir = sandbox();
    try {
      const file = join(dir, "daemon.pid");
      writePidFile(file); // writes the pidfile AND a truthful sidecar
      expect(daemonStatus(file).state).toBe("running");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
