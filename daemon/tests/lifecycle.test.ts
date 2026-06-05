import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { daemonStatus, readPidFile, removePidFile, writePidFile } from "../src/daemon/lifecycle.ts";

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
});
