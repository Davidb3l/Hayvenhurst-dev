// HD-4: a failed spawn of hayven-native used to surface as
// "serialize encode failed (null): <no stderr>", hiding the real cause
// (ENOENT / EACCES / blocked exe). The message now carries `res.error`.
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describeSpawnFailure, openWireBridge } from "../src/crdt/wire.ts";

describe("describeSpawnFailure", () => {
  it("includes the spawn error when the process never ran", () => {
    const msg = describeSpawnFailure({
      status: null,
      error: new Error("spawnSync x ENOENT"),
      stderr: null,
    });
    expect(msg).toContain("spawn error: spawnSync x ENOENT");
    expect(msg).toContain("did not exit normally");
    expect(msg).not.toContain("(null)");
  });

  it("reports exit status and stderr for a normal failure", () => {
    const msg = describeSpawnFailure({ status: 3, stderr: Buffer.from("boom\n") });
    expect(msg).toBe("(exit 3): boom");
  });

  it("names the signal when killed", () => {
    expect(describeSpawnFailure({ status: null, signal: "SIGTERM", stderr: null })).toContain("killed by SIGTERM");
  });
});

describe("subprocess wire bridge with an unrunnable binary", () => {
  it("throws a message containing the spawn error, not '(null): <no stderr>'", () => {
    const bridge = openWireBridge({ binaryPath: join(tmpdir(), "definitely-not-a-real-hayven-native") });
    // Only meaningful when the FFI cdylib is absent and the subprocess transport is used.
    if (bridge.transport !== "subprocess") return;
    let message = "";
    try {
      bridge.encode([]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("serialize encode failed");
    expect(message).toContain("spawn error");
    expect(message).not.toContain("(null)");
  });
});
