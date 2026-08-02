/**
 * P4 — the two daemon-facing fetches in `cli/_shared.ts` had no `AbortSignal`.
 *
 * This is the class of bug that made the original incident invisible: a socket
 * that ACCEPTS and then never answers — a live daemon with a pegged event loop,
 * exactly what a runaway ingest produces — inherits Bun's 5-minute idle default.
 * Lane C measured a single unbounded `probeDaemon` against an accept-and-hang
 * server at 300,020 ms while the CLI printed a message promising ten seconds.
 * `hotAddToRunningDaemon` and `assertDaemonServesProject` had the same shape.
 *
 * These tests run against a REAL server that accepts and then holds the request
 * open forever, because that is the only fixture that distinguishes "bounded"
 * from "unbounded" — a closed port fails instantly either way.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DETACH_HEALTH_TIMEOUT_MS, DETACH_PROBE_TIMEOUT_MS } from "../src/daemon/detach.ts";
import { assertDaemonServesProject, hotAddToRunningDaemon } from "../src/cli/_shared.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";

/** A server that completes the TCP handshake and then never answers. */
let hang: ReturnType<typeof Bun.serve>;
let base: string;
let sandbox: string;

beforeAll(() => {
  hang = Bun.serve({
    port: 0,
    // Never resolves: headers are never sent, so the client is left waiting on
    // a live, accepted connection. This is a wedged daemon, not a dead one.
    fetch: () => new Promise<Response>(() => {}),
  });
  base = `http://127.0.0.1:${hang.port}`;
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapp-fetch-")));
});

afterAll(() => {
  hang.stop(true);
  rmSync(sandbox, { recursive: true, force: true });
});

/** A project-shaped root that passes the `isRegistrableRoot` client guard. */
function project(name: string): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  return root;
}

describe("hotAddToRunningDaemon is bounded", () => {
  it("gives up on a wedged daemon instead of parking for Bun's 5-minute default", async () => {
    const started = Date.now();
    const res = await hotAddToRunningDaemon(project("hot"), base);
    const elapsed = Date.now() - started;

    // Generous upper bound: what matters is that it is nowhere near 300_000.
    expect(elapsed).toBeLessThan(DETACH_HEALTH_TIMEOUT_MS + 5_000);
    // ...and it actually waited, i.e. the request was really attempted against
    // the hanging server rather than short-circuited by the registrable-root
    // guard or a connection refusal.
    expect(elapsed).toBeGreaterThan(DETACH_HEALTH_TIMEOUT_MS / 2);
    // A hang is NOT "no daemon". Reporting it as absent makes the caller say
    // "this daemon does not support live project registration", sending the
    // user after a version problem that does not exist.
    expect(res.kind).toBe("error");
    expect((res as { message: string }).message).toMatch(/did not answer POST \/api\/projects/);
    expect((res as { message: string }).message).toMatch(/wedged/);
  }, 60_000);

  it("positive control: a closed port is still reported as no-daemon, immediately", async () => {
    // Distinguishes the timeout branch from the unreachable branch. A refusal
    // must stay silent and instant — the common "no daemon running" case.
    const dead = "http://127.0.0.1:7916";
    const started = Date.now();
    const res = await hotAddToRunningDaemon(project("cold"), dead);
    expect(res.kind).toBe("no-daemon");
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);
});

describe("assertDaemonServesProject is bounded", () => {
  const ctx = (root: string) => ({
    paths: hayvenPathsFor(root),
    config: DEFAULT_CONFIG,
    configSources: [],
  });

  it("gives up on a wedged /api/health and SAYS the identity check was skipped", async () => {
    const started = Date.now();
    const res = await assertDaemonServesProject(base, ctx(project("ident")));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(DETACH_PROBE_TIMEOUT_MS + 5_000);
    expect(elapsed).toBeGreaterThan(DETACH_PROBE_TIMEOUT_MS / 2);
    // Still `ok` — the contract is "proceed and let the real request report the
    // failure" — but no longer SILENT, because the identity check really was
    // skipped and the next request is about to hang the same way.
    expect(res.ok).toBe(true);
    expect((res as { warning?: string }).warning).toMatch(/did not answer \/api\/health/);
  }, 60_000);

  it("positive control: a closed port passes silently, with no warning", async () => {
    // The overwhelmingly common case — nothing is listening. A note here would
    // be pure noise on every `claim`/`release`/`sync` run without a daemon.
    const res = await assertDaemonServesProject("http://127.0.0.1:7916", ctx(project("ident2")));
    expect(res.ok).toBe(true);
    expect((res as { warning?: string }).warning).toBeUndefined();
  }, 30_000);
});
