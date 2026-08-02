/**
 * A4 — `hayven proxy` must bind LOOPBACK, and must print where it really bound.
 *
 * `Bun.serve({ port, fetch })` with no `hostname` binds the wildcard address
 * (verified on Bun 1.3.14: `lsof` shows `TCP *:PORT (LISTEN)`) while
 * `server.hostname` still reports "localhost" — so the proxy printed
 * "http://localhost:7788" and was in fact an OPEN LLM-API relay for anyone on
 * the LAN. It attaches no credentials of its own but faithfully forwards
 * whatever a caller sends, so a stranger on the network could spend the user's
 * upstream quota.
 *
 * This test binds a REAL socket in a REAL subprocess and probes it from the
 * machine's own non-loopback address. That is the only assertion that fails when
 * the `hostname:` argument is removed — a pure unit test over the flag parsing
 * would pass with the bug fully restored, which is exactly the vacuous-test trap.
 *
 * Sandboxing: a throwaway project under the OS temp dir with `$HAYVEN_HOME`
 * pointed at a throwaway dir, so nothing touches the developer's `~/.hayven`.
 * The subprocess imports `cli/proxy.ts` directly rather than the `hayven` binary
 * or `cli.ts`, so the test does not depend on an installed build.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { Db } from "../src/db/queries.ts";

const PROXY_MODULE = join(import.meta.dir, "..", "src", "cli", "proxy.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** This machine's first non-loopback IPv4 address, or null when offline. */
function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** A sandbox: `$HAYVEN_HOME`, a project with a migrated index, and a runner. */
function makeSandbox(): { home: string; proj: string; runner: string } {
  const sandbox = mkdtempSync(join(tmpdir(), "hayven-fixa-proxy-"));
  dirs.push(sandbox);
  const home = join(sandbox, "home");
  const proj = join(sandbox, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, ".hayven"), { recursive: true });
  writeFileSync(join(proj, "a.ts"), "export function fa(): number { return 1; }\n");
  const db = new Db(join(proj, ".hayven", "index.sqlite"));
  db.migrate();
  db.close();

  const runner = join(sandbox, "run-proxy.ts");
  writeFileSync(
    runner,
    `import { runProxy } from ${JSON.stringify(PROXY_MODULE)};\n` +
      "const flags: Record<string, string | boolean> = { port: process.argv[2]! };\n" +
      'if (process.argv[3]) flags["host"] = process.argv[3];\n' +
      'if (process.argv[4] === "allow") flags["allow-remote-access"] = true;\n' +
      'const code = await runProxy({ command: "proxy", positionals: [], flags } as never);\n' +
      "process.exit(code);\n",
  );
  return { home, proj, runner };
}

/** A port in the ephemeral-ish range. NEVER assume a fixed port is free — the
 *  developer machine runs a real daemon on 7777 and may run a real proxy on
 *  7788. We assert the port was actually claimed by OUR child below. */
function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 8000);
}

interface Running {
  port: number;
  banner: string;
  stop: () => void;
}

/** Start the proxy in a subprocess and wait for its startup banner. */
async function startProxy(host?: string, allowRemote = false): Promise<Running> {
  const { home, proj, runner } = makeSandbox();
  const port = randomPort();
  const args = ["bun", runner, String(port)];
  if (host) args.push(host);
  if (allowRemote) args.push("allow");
  const child = Bun.spawn(args, {
    cwd: proj,
    env: { ...process.env, HAYVEN_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stop = (): void => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  // Read stderr until the banner arrives (the proxy blocks forever after it).
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let banner = "";
  const deadline = Date.now() + 20_000;
  while (!banner.includes("point your client's base URL") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    banner += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  if (!banner.includes("point your client's base URL")) {
    stop();
    throw new Error(`proxy did not start; stderr was:\n${banner}`);
  }
  return { port, banner, stop };
}

/** `true` if `http://host:port/` answers ANYTHING (any status = it is bound and
 *  reachable); `false` on a connection failure. */
async function reachable(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/__hayven_probe`, {
      signal: AbortSignal.timeout(4000),
    });
    return true;
  } catch {
    return false;
  }
}

describe("A4 — hayven proxy binds loopback only", () => {
  it("is reachable on 127.0.0.1 but NOT on the machine's LAN address", async () => {
    const lan = lanAddress();
    // Explicit precondition: with no non-loopback interface there is nothing to
    // prove, and a silent pass would be a vacuous test.
    if (lan === null) {
      console.warn("SKIP: no non-loopback IPv4 interface on this machine");
      return;
    }
    const proxy = await startProxy();
    try {
      // Positive control FIRST — if this fails the negative below proves nothing.
      expect(await reachable("127.0.0.1", proxy.port)).toBe(true);
      // The actual finding: unfixed, this is `true`.
      expect(await reachable(lan, proxy.port)).toBe(false);
    } finally {
      proxy.stop();
    }
  }, 40_000);

  it("prints the ACTUAL bind address, never a hardcoded localhost", async () => {
    const proxy = await startProxy();
    try {
      expect(proxy.banner).toContain(`http://127.0.0.1:${proxy.port}`);
      expect(proxy.banner).not.toContain("http://localhost:");
      // No warning when we are safely on loopback.
      expect(proxy.banner).not.toMatch(/WARNING/);
    } finally {
      proxy.stop();
    }
  }, 40_000);

  it("an explicit non-loopback --host is honoured AND warned about (with the opt-in)", async () => {
    const lan = lanAddress();
    if (lan === null) {
      console.warn("SKIP: no non-loopback IPv4 interface on this machine");
      return;
    }
    // `--host 0.0.0.0` ALONE is now refused (asserted below); the opt-in is what
    // makes this reachable, which is what gives the refusal its meaning.
    const proxy = await startProxy("0.0.0.0", true);
    try {
      expect(proxy.banner).toMatch(/WARNING: bound to 0\.0\.0\.0/);
      expect(proxy.banner).toMatch(/reachable from the NETWORK/);
      // Opt-in really does open it up — which is what makes the DEFAULT's
      // closure meaningful rather than an accident of the environment
      // (a firewall silently eating the LAN probe above would show up here).
      expect(await reachable(lan, proxy.port)).toBe(true);
    } finally {
      proxy.stop();
    }
  }, 40_000);
});

describe("S5 — a non-loopback proxy bind is REFUSED without --allow-remote-access", () => {
  /** Run the proxy to COMPLETION (it exits instead of serving when refused). */
  async function runRefused(host: string): Promise<{ code: number; stderr: string; port: number }> {
    const { home, proj, runner } = makeSandbox();
    const port = randomPort();
    const child = Bun.spawn(["bun", runner, String(port), host], {
      cwd: proj,
      env: { ...process.env, HAYVEN_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    return { code, stderr, port };
  }

  it("exits non-zero with an actionable error, and binds NOTHING", async () => {
    // The end-to-end pin, through the real CLI entry point in a real subprocess:
    // a unit test over `decideProxyBind` alone would pass even if `runProxy`
    // ignored its verdict and served anyway.
    const { code, stderr, port } = await runRefused("0.0.0.0");
    expect(code).not.toBe(0);
    expect(stderr).toContain("refusing to bind 0.0.0.0");
    expect(stderr).toContain("--allow-remote-access");
    // It must not have printed the ready banner…
    expect(stderr).not.toContain("point your client's base URL");
    // …and nothing may be listening on the port it would have used. Probed on
    // loopback: if it had served at all, the wildcard bind would answer here.
    expect(await reachable("127.0.0.1", port)).toBe(false);
  }, 40_000);

  it("refuses a LAN interface address too, not just the wildcard", async () => {
    const lan = lanAddress();
    if (lan === null) {
      console.warn("SKIP: no non-loopback IPv4 interface on this machine");
      return;
    }
    const { code, stderr } = await runRefused(lan);
    expect(code).not.toBe(0);
    expect(stderr).toContain(`refusing to bind ${lan}`);
  }, 40_000);

  it("still starts normally on the loopback default", async () => {
    // The negative control: the gate must not have broken the ordinary path.
    const proxy = await startProxy();
    try {
      expect(proxy.banner).toContain("point your client's base URL");
      expect(proxy.banner).not.toContain("refusing to bind");
      expect(await reachable("127.0.0.1", proxy.port)).toBe(true);
    } finally {
      proxy.stop();
    }
  }, 40_000);
});
