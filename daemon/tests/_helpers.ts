// Tiny helpers for daemon tests. Anything that constructs a `CrdtState` or
// `ServerDependencies` should go through here so the per-test boilerplate
// stays one line.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CrdtState } from "../src/crdt/state.ts";

/** Throwaway CRDT state rooted in a fresh tmp directory. Caller owns the dir. */
export function makeTestCrdtState(): CrdtState {
  const dir = mkdtempSync(join(tmpdir(), "hayven-crdt-test-"));
  return new CrdtState({
    crdtRoot: join(dir, "crdt"),
    configFile: join(dir, "config.json"),
    skipHydrate: true,
  });
}

/**
 * `<pid> <command line>` for every live process. On Windows the `ps` on PATH is
 * Git's MSYS `ps`, which rejects `-o` and lists no native command lines, so a
 * `ps` sweep there found nothing: every detached test daemon, and its
 * `hayven-native watch` child, outlived the run. Ask Win32_Process instead.
 */
function processLines(): string[] {
  const cmd =
    process.platform === "win32"
      ? [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + ' ' + $_.CommandLine }",
        ]
      : ["ps", "ax", "-o", "pid=,command="];
  const r = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "ignore", windowsHide: true });
  return r.stdout.toString().split(/\r?\n/);
}

/**
 * Every live pid whose command line marks it as a foreground daemon bound to
 * `port`. The `--port <port>` argument is forwarded verbatim to the detached
 * child, so it uniquely fingerprints a test's daemons - an ephemeral port
 * appears in no other process on the machine. Matched as a whole token, so
 * port 5764 does not also claim a daemon on 57649.
 */
export function daemonPidsFor(port: number): number[] {
  const portArg = new RegExp(`--port ${port}(\\s|$)`);
  return processLines()
    .filter((l) => l.includes("daemon start --foreground") && portArg.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Kill `pid` and everything it started. On Windows killing the daemon alone
 * leaves its `hayven-native watch` children running (there is no process
 * group to signal), so take the whole tree with `taskkill /T`.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync({
      cmd: ["taskkill", "/T", "/F", "/PID", String(pid)],
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Kill every daemon `port` fingerprints, and wait them out. Detached daemons
 * are NOT the test's children, so this sweep is the only reliable reaper; run
 * it from afterEach so it fires even when the test body failed early.
 */
export async function sweepDaemons(port: number): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const pids = daemonPidsFor(port);
    if (pids.length === 0) return;
    for (const pid of pids) killTree(pid);
    await new Promise((r) => setTimeout(r, 100));
  }
}
