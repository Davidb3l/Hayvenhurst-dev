// HD-4/HD-10: handshake floor + truthful "added live ... (no restart needed)".
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hotAddToRunningDaemon, staleDaemonNote } from "../src/cli/_shared.ts";
import { MIN_COMPATIBLE_DAEMON_VERSION, checkDaemonVersion } from "../src/daemon/detach.ts";
import { VERSION } from "../src/version.ts";

describe("MIN_COMPATIBLE_DAEMON_VERSION", () => {
  it("is 0.0.8: a 0.0.7 resident daemon lacks 0.0.8's pid/global_home/Host-gate and is refused", () => {
    expect(MIN_COMPATIBLE_DAEMON_VERSION).toBe("0.0.8");
    const old = checkDaemonVersion("0.0.7", VERSION);
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.reason).toContain("0.0.7");
    expect(checkDaemonVersion("0.0.8", VERSION)).toEqual({ ok: true });
    expect(checkDaemonVersion("0.0.9", VERSION)).toEqual({ ok: true });
  });
});

describe("staleDaemonNote", () => {
  it("is null when the daemon is this build, or its version is unknown", () => {
    expect(staleDaemonNote(VERSION)).toBeNull();
    expect(staleDaemonNote(undefined)).toBeNull();
  });
  it("names both versions and the restart command when they differ", () => {
    const note = staleDaemonNote("0.0.7", "0.0.8");
    expect(note).toContain("v0.0.7");
    expect(note).toContain("v0.0.8");
    expect(note).toContain("hayven daemon restart");
  });
});

describe("hotAddToRunningDaemon surfaces the daemon's version", () => {
  const dirs: string[] = [];
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function stub(version: string): void {
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/health")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, version, root: "/x" }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ added: true, alias: "proj" }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
  }

  it("a stale daemon: added + daemonVersion that staleDaemonNote flags", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hayven-hd10-")));
    dirs.push(root);
    stub("0.0.7");
    const hot = await hotAddToRunningDaemon(root, "http://127.0.0.1:1");
    expect(hot.kind).toBe("added");
    if (hot.kind === "added") {
      expect(hot.daemonVersion).toBe("0.0.7");
      expect(staleDaemonNote(hot.daemonVersion)).not.toBeNull();
    }
  });

  it("a same-build daemon: added, no stale note", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hayven-hd10-")));
    dirs.push(root);
    stub(VERSION);
    const hot = await hotAddToRunningDaemon(root, "http://127.0.0.1:1");
    expect(hot.kind).toBe("added");
    if (hot.kind === "added") expect(staleDaemonNote(hot.daemonVersion)).toBeNull();
  });
});
