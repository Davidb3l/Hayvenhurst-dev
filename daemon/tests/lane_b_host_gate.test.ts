/**
 * Host-header allowlist (DNS-rebinding gate) + hoisted security gates.
 *
 * Threat model: `evil.com` re-resolves to 127.0.0.1 (DNS rebinding), so a
 * malicious page's requests become SAME-origin — no Origin header on GETs —
 * and the browser hands the page every response body: the whole graph, file
 * contents via /api/context/* and /api/nodes/*, fleet memory, claims, traces.
 * The loopback bind does not help because the victim's browser IS local. The
 * rebound request's one immutable tell is its `Host: evil.com` header, so the
 * daemon now refuses (403) ANY request — reads included — whose Host is not
 * loopback (or the explicitly opted-into non-loopback bind host).
 *
 * What is pinned here:
 *   1. GET with `Host: evil.com` → 403, and the body does NOT echo the
 *      attacker-controlled value back.
 *   2. GET with `Host: localhost:PORT` / `127.0.0.1:PORT` → 200, both via
 *      real `fetch` (Bun sets Host itself) and via a raw socket.
 *   3. The pre-existing cross-origin MUTATION refusal still holds: POST with
 *      `Origin: http://evil.com` → 403.
 *   4. All of the above hold against a DIRECT `buildApp` listener too — the
 *      gates were hoisted into buildApp so every server built from server.ts
 *      is protected by construction, not just the multi-project facade.
 *   5. The explicit non-loopback opt-in still works: a server bound 0.0.0.0
 *      is NOT Host-gated (the operator signed off on network exposure, and a
 *      wildcard bind matches no Host a browser would send).
 *   6. `app.handle(new Request("http://localhost/…"))` — how the entire
 *      existing test suite drives routes, with NO Host header — keeps working
 *      via the URL-host fallback.
 *
 * Hostile headers travel over a RAW TCP socket, not `fetch`: Host and Origin
 * are forbidden request headers that a fetch implementation may silently
 * drop, which would turn an expected-403 into a false-green 200.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import {
  buildApp,
  buildMultiProjectApp,
  hostHeaderName,
  isAllowedRequestHost,
  isLoopbackHostName,
  type ServerDependencies,
} from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function depsFor(): ServerDependencies {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-hostgate-"));
  const db = new Db(":memory:");
  db.migrate();
  return {
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  };
}

/**
 * Send ONE raw HTTP request and return the parsed status + body. This is the
 * only honest way to put `Host: evil.com` or a hostile Origin on the wire —
 * fetch may silently refuse to send forbidden headers.
 */
function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  httpVersion = "1.1",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        `${method} ${path} HTTP/${httpVersion}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "Connection: close",
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const statusLine = data.split("\r\n", 1)[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? "0");
      const bodyStart = data.indexOf("\r\n\r\n");
      resolve({ status, body: bodyStart === -1 ? "" : data.slice(bodyStart + 4) });
    });
  });
}

// ---- the two server shapes under test -------------------------------------
// Multi-project facade (production shape) bound loopback.
const multiApp = buildMultiProjectApp({
  primary: "alpha",
  projects: new Map<string, ServerDependencies>([["alpha", depsFor()]]),
  logger: createLogger({ toFile: false, toStderr: false }),
  daemonVersion: "test",
});
multiApp.listen({ hostname: "127.0.0.1", port: 0 });
// Bun types `port` as optional; it is always set on a listening server.
const multiPort = multiApp.server!.port as number;

// Direct buildApp listener (the Task 2 shape that used to be unprotected).
const directApp = buildApp(depsFor());
directApp.listen({ hostname: "127.0.0.1", port: 0 });
const directPort = directApp.server!.port as number;

afterAll(() => {
  multiApp.stop();
  directApp.stop();
});

/** The gate contract, asserted identically against both server shapes. */
function gateSuite(label: string, port: () => number) {
  describe(label, () => {
    it("REFUSES (403) a GET whose Host is a rebound public name", async () => {
      const res = await rawRequest(port(), "GET", "/api/claims", { Host: "evil.com" });
      expect(res.status).toBe(403);
      // Terse body, and it must NOT echo the attacker-controlled Host value.
      expect(res.body).not.toContain("evil.com");
    });

    it("REFUSES (403) a rebound Host even with a port attached", async () => {
      const res = await rawRequest(port(), "GET", "/api/claims", {
        Host: `evil.com:${port()}`,
      });
      expect(res.status).toBe(403);
    });

    it("REFUSES (403) a Host that smuggles localhost past a URL parser", async () => {
      const res = await rawRequest(port(), "GET", "/api/claims", {
        Host: "evil.com@localhost",
      });
      expect(res.status).toBe(403);
    });

    it("ALLOWS (200) Host: localhost:PORT over a raw socket", async () => {
      const res = await rawRequest(port(), "GET", "/api/claims", {
        Host: `localhost:${port()}`,
      });
      expect(res.status).toBe(200);
    });

    it("ALLOWS (200) Host: 127.0.0.1:PORT over a raw socket", async () => {
      const res = await rawRequest(port(), "GET", "/api/claims", {
        Host: `127.0.0.1:${port()}`,
      });
      expect(res.status).toBe(200);
    });

    it("ALLOWS (200) plain fetch, which sets a loopback Host itself", async () => {
      const res = await fetch(`http://127.0.0.1:${port()}/api/claims`);
      expect(res.status).toBe(200);
      const viaName = await fetch(`http://localhost:${port()}/api/claims`);
      expect(viaName.status).toBe(200);
    });

    it("still REFUSES (403) a cross-origin MUTATION with a loopback Host", async () => {
      const res = await rawRequest(port(), "POST", "/api/claims", {
        Host: `127.0.0.1:${port()}`,
        Origin: "http://evil.com",
        "Content-Type": "application/json",
        "Content-Length": "0",
      });
      expect(res.status).toBe(403);
      expect(res.body).toContain("cross-origin");
    });

    it("REFUSES a cross-origin WebSocket upgrade (GET, but write-capable)", async () => {
      // Browsers do NOT apply the same-origin policy to WebSocket connects:
      // any page can open ws://127.0.0.1:PORT/ws/sync and both push CRDT ops
      // and READ frames — no DNS rebinding required. The upgrade is a GET, so
      // the method check alone would wave it through; the gate must treat an
      // Upgrade: websocket request like a mutation.
      const ws = new WebSocket(`ws://127.0.0.1:${port()}/ws/sync`, {
        headers: { origin: "http://evil.com" },
      } as never);
      const outcome = await new Promise<string>((res) => {
        ws.onopen = () => res("open");
        ws.onerror = () => res("refused");
        ws.onclose = () => res("refused");
      });
      expect(outcome).toBe("refused");
    });

    it("ALLOWS a WebSocket connect with no Origin (CLI / daemon sync peers)", async () => {
      // Bun's WebSocket client (what the CLI and daemon-to-daemon sync use)
      // sends no Origin header, so only browser pages are refused.
      const ws = new WebSocket(`ws://127.0.0.1:${port()}/ws/sync`);
      const outcome = await new Promise<string>((res) => {
        ws.onopen = () => res("open");
        ws.onerror = () => res("refused");
        ws.onclose = () => res("refused");
      });
      expect(outcome).toBe("open");
      ws.close();
    });

    it("refuses a Host-less HTTP/1.0 request rather than serving it", async () => {
      // Bun's serve loop needs a Host to build `request.url`, and HTTP/1.1
      // makes the header mandatory — but HTTP/1.0 does not, so probe what Bun
      // actually delivers. Contract: whatever layer answers (Bun's parser or
      // the gate's reject-when-underivable branch), the graph is NOT served.
      const res = await rawRequest(port(), "GET", "/api/claims", {}, "1.0");
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
}

gateSuite("host gate: multi-project facade (production shape)", () => multiPort);
gateSuite("host gate: DIRECT buildApp listener (Task 2 hoist)", () => directPort);

describe("host gate: explicit non-loopback opt-in", () => {
  it("stands down when the operator bound non-loopback (wildcard)", async () => {
    // Mirrors `--host 0.0.0.0 --allow-remote-access`: the operator explicitly
    // published an unauthenticated daemon, remote callers legitimately send
    // arbitrary Host values (LAN IPs, DNS names we cannot enumerate), and a
    // rebinding gate protects nothing that direct network access does not
    // already expose. The gate must NOT break the access that was opted into.
    const app = buildApp(depsFor());
    app.listen({ hostname: "0.0.0.0", port: 0 });
    try {
      // Bun types `port` as optional; it is always set on a listening server.
      const p = app.server!.port as number;
      const res = await rawRequest(p, "GET", "/api/claims", { Host: "some.lan.name:7777" });
      expect(res.status).toBe(200);
    } finally {
      app.stop();
    }
  });
});

describe("host gate: app.handle compatibility (existing suite contract)", () => {
  it("serves a Host-less handle() Request via the URL-host fallback", async () => {
    // The whole existing test suite drives routes exactly like this: no real
    // server semantics on the Request, no Host header, `http://localhost/…`.
    const app = buildApp(depsFor());
    const res = await app.handle(new Request("http://localhost/api/claims"));
    expect(res.status).toBe(200);
  });

  it("still refuses a handle() Request that carries a hostile Host header", async () => {
    const app = buildApp(depsFor());
    const res = await app.handle(
      new Request("http://localhost/api/claims", { headers: { host: "evil.com" } }),
    );
    expect(res.status).toBe(403);
  });
});

describe("host allowlist helpers (unit)", () => {
  it("parses host:port, bracketed IPv6, and bare names", () => {
    expect(hostHeaderName("localhost:7777")).toBe("localhost");
    expect(hostHeaderName("127.0.0.1")).toBe("127.0.0.1");
    expect(hostHeaderName("[::1]:7777")).toBe("::1");
    expect(hostHeaderName("[::1]")).toBe("::1");
    expect(hostHeaderName("LOCALHOST:80")).toBe("localhost");
  });

  it("returns null (a rejection) for smuggling shapes and junk", () => {
    expect(hostHeaderName("evil.com@localhost")).toBeNull();
    expect(hostHeaderName("localhost/evil")).toBeNull();
    expect(hostHeaderName("localhost?x=1")).toBeNull();
    expect(hostHeaderName("localhost #")).toBeNull();
    expect(hostHeaderName("")).toBeNull();
    expect(hostHeaderName("localhost:notaport")).toBeNull();
    expect(hostHeaderName("a".repeat(300))).toBeNull();
  });

  it("allowlists exactly loopback, on any port", () => {
    expect(isAllowedRequestHost("localhost:1234")).toBe(true);
    expect(isAllowedRequestHost("127.0.0.1:7777")).toBe(true);
    expect(isAllowedRequestHost("127.255.0.9")).toBe(true);
    expect(isAllowedRequestHost("[::1]:7777")).toBe(true);
    // The IPv4-mapped loopback: WHATWG URL canonicalizes `[::ffff:127.0.0.1]`
    // to the hex form `::ffff:7f00:1`, so the allowlist must know BOTH.
    expect(isAllowedRequestHost("[::ffff:127.0.0.1]:7777")).toBe(true);
    expect(isAllowedRequestHost("evil.com")).toBe(false);
    expect(isAllowedRequestHost("evil.com:7777")).toBe(false);
    // `.localhost` subdomains are deliberately NOT admitted: keep the set to
    // names an attacker can provably never point at this machine.
    expect(isAllowedRequestHost("sub.localhost:7777")).toBe(false);
    // A public IP is not loopback no matter how it is dressed.
    expect(isAllowedRequestHost("8.8.8.8:7777")).toBe(false);
  });

  it("additionally admits the explicitly-bound host, and only it", () => {
    expect(isAllowedRequestHost("192.168.1.5:7777", "192.168.1.5")).toBe(true);
    expect(isAllowedRequestHost("evil.com:7777", "192.168.1.5")).toBe(false);
    expect(isAllowedRequestHost("[fe80::1]:7777", "fe80::1")).toBe(true);
    expect(isAllowedRequestHost("[fe80::1]:7777", "[fe80::1]")).toBe(true);
  });

  it("isLoopbackHostName matches the bind-side notion of loopback", () => {
    expect(isLoopbackHostName("127.0.0.1")).toBe(true);
    expect(isLoopbackHostName("localhost")).toBe(true);
    expect(isLoopbackHostName("::1")).toBe(true);
    expect(isLoopbackHostName("[::1]")).toBe(true);
    expect(isLoopbackHostName("0.0.0.0")).toBe(false);
    expect(isLoopbackHostName("::")).toBe(false);
    expect(isLoopbackHostName("192.168.1.5")).toBe(false);
  });
});
