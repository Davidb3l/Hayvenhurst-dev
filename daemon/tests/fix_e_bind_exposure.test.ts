/**
 * SECURITY — the daemon bound whatever `--host` said, with no check and no
 * warning, and refuses browser-driven mutations.
 *
 * `applyBindOverrides` took `--host` (and `HAYVEN_HOST`, and `daemon_host` in
 * config.json) verbatim into `app.listen`. There is ZERO authentication and
 * ZERO Origin gating anywhere in the daemon, and it serves the entire code
 * graph, file contents via `/api/context`, fleet memory, claims, and mutating
 * routes for EVERY registered project. A sandboxed run of the unfixed code
 * bound 0.0.0.0, answered 200 from the LAN, and printed zero warnings — while
 * the flag's own usage hint literally suggested `--host 0.0.0.0`.
 *
 * Chosen fix: a non-loopback bind requires a SECOND explicit opt-in
 * (`--allow-remote-access` / `HAYVEN_ALLOW_REMOTE_ACCESS=1`) on top of `--host`,
 * not merely a warning. A warning printed by a process that then keeps serving
 * is not a decision point, and there is no auth behind it to fall back on.
 */
import { describe, expect, it } from "bun:test";

import { isLoopbackHost } from "../src/cli/daemon.ts";
import { isLocalOrigin } from "../src/daemon/server.ts";

describe("loopback classification", () => {
  it("accepts every loopback spelling", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "127.1.2.3", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("rejects the addresses that actually publish the daemon", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.162", "10.0.0.5", "example.com", ""]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("cross-origin mutation gate", () => {
  it("treats loopback origins as local", () => {
    for (const o of [
      "http://localhost:7777",
      "http://127.0.0.1:7777",
      "https://127.0.0.1",
      "http://[::1]:7777",
    ]) {
      expect(isLocalOrigin(o)).toBe(true);
    }
  });

  it("rejects remote and opaque origins", () => {
    for (const o of [
      "https://evil.example.com",
      "http://192.168.1.50",
      "null", // a file:// page's opaque origin
      "not a url",
      "",
    ]) {
      expect(isLocalOrigin(o)).toBe(false);
    }
  });

  it("does not fall for a hostname that merely CONTAINS a loopback spelling", () => {
    expect(isLocalOrigin("http://127.0.0.1.evil.com")).toBe(false);
    expect(isLocalOrigin("http://localhost.evil.com")).toBe(false);
    expect(isLocalOrigin("http://evil.com/?x=127.0.0.1")).toBe(false);
  });
});
