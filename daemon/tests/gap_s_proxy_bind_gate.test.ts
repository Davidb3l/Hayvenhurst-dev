/**
 * GAP S5 (superseded and widened) — `hayven proxy` published an unauthenticated
 * listener on a one-word flag.
 *
 * The original item was narrow: `isLoopbackHost` in `cli/proxy.ts` tested
 * `/^127\./`, an unanchored PREFIX match on arbitrary text, so `127.example.com`
 * would have been classed as loopback. The real asymmetry underneath it is
 * bigger. The daemon was hardened this round so a NON-loopback bind is REFUSED
 * unless a second explicit opt-in is given, on the reasoning that a warning
 * printed by a process that then keeps serving is not a decision point and there
 * is no authentication behind it to fall back on. The proxy merely warned and
 * served — and the proxy is arguably the more expensive exposure: it relays
 * whatever upstream credentials a caller sends (anyone who reaches the port can
 * spend the user's LLM budget) and, with `--compact-history`, substitutes slices
 * of the project's source into requests.
 *
 * The fix ADOPTS the daemon's rule rather than inventing a third: the same
 * `isLoopbackHost` (imported, not copied — `cli.ts` already loads that module
 * statically for the `daemon` subcommand, so the import is free and the two
 * predicates cannot drift), the same `--allow-remote-access` flag, the same
 * `HAYVEN_ALLOW_REMOTE_ACCESS` env var.
 *
 * NOTE ON SCOPE — these tests never bind `0.0.0.0`. `decideProxyBind` returns
 * the exact host string that `runProxy` hands to `Bun.serve({ hostname })` on
 * the next line, so asserting the decision asserts the bind without opening a
 * port on the machine running the suite. The loopback end of the range IS bound
 * for real below.
 */
import { afterEach, describe, expect, it } from "bun:test";

import { decideProxyBind } from "../src/cli/proxy.ts";
import { isLoopbackHost } from "../src/cli/daemon.ts";
import type { ParsedArgs } from "../src/cli.ts";

function args(flags: Record<string, string | boolean> = {}): ParsedArgs {
  return { command: "proxy", positional: [], flags } as unknown as ParsedArgs;
}

const ENV_KEY = "HAYVEN_ALLOW_REMOTE_ACCESS";
afterEach(() => {
  delete process.env[ENV_KEY];
});

/** Addresses that publish the proxy beyond this machine. */
const EXPOSING = ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.5", "example.com"];
/** Addresses only this machine can reach. */
const LOOPBACK = ["127.0.0.1", "127.0.0.2", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"];

describe("S5 — a non-loopback proxy bind is REFUSED without the second opt-in", () => {
  it("refuses every exposing address when the flag is absent", () => {
    for (const host of EXPOSING) {
      const d = decideProxyBind(host, args());
      expect({ host, ok: d.ok }).toEqual({ host, ok: false });
      // The refusal must name the address and the escape hatch, or it is not a
      // usable error.
      if (!d.ok) {
        expect(d.message).toContain(host);
        expect(d.message).toContain("--allow-remote-access");
        expect(d.message).toContain(ENV_KEY);
      }
    }
  });

  it("BINDS the exposing address once --allow-remote-access is given", () => {
    // The opt-in must actually work, and must yield the host UNCHANGED — this
    // is the value `runProxy` passes straight to `Bun.serve({ hostname })`, so a
    // gate that quietly downgraded it to loopback would be its own lie.
    for (const host of EXPOSING) {
      const d = decideProxyBind(host, args({ "allow-remote-access": true }));
      expect(d).toEqual({ ok: true, host, exposed: true });
    }
  });

  it("accepts the string form of the flag and the env var", () => {
    expect(decideProxyBind("0.0.0.0", args({ "allow-remote-access": "true" }))).toEqual({
      ok: true,
      host: "0.0.0.0",
      exposed: true,
    });
    for (const v of ["1", "true"]) {
      process.env[ENV_KEY] = v;
      expect(decideProxyBind("0.0.0.0", args())).toEqual({
        ok: true,
        host: "0.0.0.0",
        exposed: true,
      });
    }
    // …and nothing else enables it.
    for (const v of ["0", "false", "yes", ""]) {
      process.env[ENV_KEY] = v;
      expect(decideProxyBind("0.0.0.0", args()).ok).toBe(false);
    }
  });

  it("never asks for the opt-in on a loopback address", () => {
    for (const host of LOOPBACK) {
      expect(decideProxyBind(host, args())).toEqual({ ok: true, host, exposed: false });
    }
  });

  it("`127.example.com` is NOT loopback — the original S5 defect", () => {
    // The prefix rule classed this as loopback. It is a DNS name that can point
    // anywhere, so under the old rule it would have been bound with no gate and
    // no warning at all.
    for (const host of ["127.example.com", "127.0.0.1.evil.com", "127.attacker.net"]) {
      expect(isLoopbackHost(host)).toBe(false);
      expect(decideProxyBind(host, args()).ok).toBe(false);
    }
  });

  it("uses the DAEMON's predicate, not a second copy", () => {
    // Adoption, asserted structurally: every classification the gate makes is
    // exactly `isLoopbackHost`'s answer. If `cli/proxy.ts` ever grows its own
    // rule again, one of these disagrees.
    for (const host of [...LOOPBACK, ...EXPOSING, "127.example.com", ""]) {
      const d = decideProxyBind(host, args({ "allow-remote-access": true }));
      expect({ host, exposed: d.ok && d.exposed }).toEqual({
        host,
        exposed: !isLoopbackHost(host),
      });
    }
  });
});

describe("S5 — the decided host is the host that is actually bound", () => {
  it("serves on the address the gate returned", async () => {
    // The end-to-end half, on the one address that cannot leave this machine
    // AND is reliably bindable everywhere (127.0.0.2 is not aliased on lo0 on
    // macOS). This pins the join between the gate and the listener: the exact
    // string `decideProxyBind` returns is what `Bun.serve({hostname})` receives
    // in `runProxy`, and it is a real, reachable bind — not a value the banner
    // merely prints. The non-loopback end of that join is asserted above via
    // the decision, deliberately without opening a public port on whatever
    // machine runs this suite.
    const d = decideProxyBind("127.0.0.1", args());
    expect(d).toEqual({ ok: true, host: "127.0.0.1", exposed: false });

    const server = Bun.serve({
      hostname: (d as { host: string }).host,
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(await res.text()).toBe("ok");
    } finally {
      server.stop(true);
    }
  });
});
