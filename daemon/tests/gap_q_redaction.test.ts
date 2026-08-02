/**
 * GAP Q2 — `redactHomePaths` used a THIRD notion of "home".
 *
 * `server.ts` read `process.env.HOME` while everything else in the codebase uses
 * `homedir()` / `hayvenHomeDir()`. `plugin/scripts/ensure-daemon.sh` documents
 * HOME being unset or EMPTY under launchd, systemd, several CI runners and slim
 * containers — and starts the daemon anyway. In exactly those environments the
 * redaction silently no-opped, and `onError` returns the raw `error.message`,
 * which routinely embeds absolute paths — leaking the account name and the
 * on-disk layout to anything that could reach the port.
 *
 * These tests take the roots as an argument rather than mutating the process
 * environment: Bun resolves `os.homedir()` once per process, so a test that set
 * `HOME` would prove nothing about the launchd case anyway.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";

import { homeRedactionRoots, redactHomePaths } from "../src/daemon/server.ts";

describe("Q2 — home redaction does not depend on $HOME being set", () => {
  test("still redacts when $HOME is absent (launchd / systemd / slim container)", () => {
    const roots = homeRedactionRoots({}); // no HOME at all
    expect(roots.length).toBeGreaterThan(0);
    // `os.homedir()` resolves via getpwuid when $HOME is missing — that is the
    // whole reason it must be in the set.
    expect(roots).toContain(homedir());

    const leak = `ENOENT: no such file or directory, open '${homedir()}/code/secret-repo/.hayven/index.sqlite'`;
    const out = redactHomePaths(leak, roots);
    expect(out).not.toContain(homedir());
    expect(out).toContain("~/code/secret-repo/.hayven/index.sqlite");
  });

  test("still redacts when $HOME is set to the empty string", () => {
    const roots = homeRedactionRoots({ HOME: "" });
    expect(roots).toContain(homedir());
    expect(redactHomePaths(`${homedir()}/x`, roots)).toBe("~/x");
  });

  test("redacts the $HAYVEN_HOME override as well as the OS home", () => {
    const roots = homeRedactionRoots({ HOME: "/home/alice", HAYVEN_HOME: "/srv/hayven-state" });
    // hayvenHomeDir() reads the live process env, so drive it explicitly.
    const prior = process.env["HAYVEN_HOME"];
    process.env["HAYVEN_HOME"] = "/srv/hayven-state";
    try {
      const live = homeRedactionRoots({ HOME: "/home/alice" });
      expect(live).toContain("/srv/hayven-state");
      expect(live).toContain("/home/alice");
      expect(redactHomePaths("open /srv/hayven-state/logs/daemon.log failed", live)).toBe(
        "open ~/logs/daemon.log failed",
      );
    } finally {
      if (prior === undefined) delete process.env["HAYVEN_HOME"];
      else process.env["HAYVEN_HOME"] = prior;
    }
    void roots;
  });

  test("a nested root is replaced before its parent (longest match first)", () => {
    const roots = homeRedactionRoots({ HOME: "/home/alice" });
    // Simulate HAYVEN_HOME living underneath HOME by passing both explicitly.
    const both = ["/home/alice", "/home/alice/.state"].sort((a, b) => b.length - a.length);
    expect(redactHomePaths("/home/alice/.state/db", both)).toBe("~/db");
    void roots;
  });

  test("never redacts '/' or '' — that would shred the message", () => {
    const roots = homeRedactionRoots({ HOME: "/" });
    expect(roots).not.toContain("/");
    expect(roots).not.toContain("");
    expect(redactHomePaths("/a/b/c", ["/", ""].filter((r) => r.length >= 2))).toBe("/a/b/c");
  });
});
