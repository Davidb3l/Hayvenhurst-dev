/**
 * `assertDaemonServesProject` — shared-daemon behavior:
 *   1. Multi-project daemon already serving this root → ok + that alias.
 *   2. Daemon not serving it → registers LIVE (POST /api/projects) → ok + the
 *      new alias + a surfaced note.
 *   3. Registration fails → hard ok:false (never fall through to an
 *      un-addressed mutation of a foreign primary).
 *   4. Legacy single-project daemon whose root matches → ok, NO alias (an
 *      un-addressed request already routes to us).
 * The old tolerance paths (unreachable / no-root daemon) are pinned by
 * daemon_identity.test.ts and stay unchanged.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import {
  assertDaemonServesProject,
  projectHeader,
  type ProjectContext,
} from "../src/cli/_shared.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

function ctxFor(repoRoot: string): ProjectContext {
  return { paths: hayvenPathsFor(repoRoot), config: DEFAULT_CONFIG, configSources: [] };
}

/**
 * Fetch stub: `/api/health` returns `health`; `POST /api/projects` returns
 * `register` (a body + status). Records whether registration was attempted.
 */
function withDaemon(
  health: Record<string, unknown>,
  register: { status: number; body: Record<string, unknown> },
  fn: (registerCalls: () => number) => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  let registers = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/health")) {
      return new Response(JSON.stringify(health), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/projects") && init?.method === "POST") {
      registers++;
      return new Response(JSON.stringify(register.body), {
        status: register.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
  return (async () => {
    try {
      await fn(() => registers);
    } finally {
      globalThis.fetch = orig;
    }
  })();
}

describe("assertDaemonServesProject — shared multi-project daemon", () => {
  it("returns the served alias when the daemon already serves this root", async () => {
    const ours = mkdtempSync(join(tmpdir(), "hayven-served-"));
    const other = mkdtempSync(join(tmpdir(), "hayven-other-"));
    const health = {
      ok: true,
      version: "0.0.5",
      root: other, // primary is ANOTHER repo
      primary: "other",
      projects: [
        { alias: "other", root: other, branch: null },
        { alias: "ours", root: ours, branch: null },
      ],
    };
    await withDaemon(health, { status: 200, body: {} }, async (registers) => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(ours));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.alias).toBe("ours");
        expect(r.warning).toBeUndefined();
      }
      expect(registers()).toBe(0); // no registration needed
      expect(projectHeader(r)).toEqual({ "x-hayven-project": "ours" });
    });
  });

  it("registers the project live when the daemon does not serve it yet", async () => {
    const ours = mkdtempSync(join(tmpdir(), "hayven-reg-"));
    const other = mkdtempSync(join(tmpdir(), "hayven-reg-other-"));
    const health = {
      ok: true,
      version: "0.0.5",
      root: other,
      primary: "other",
      projects: [{ alias: "other", root: other, branch: null }],
    };
    await withDaemon(
      health,
      { status: 200, body: { ok: true, alias: "fresh", root: ours, added: true } },
      async (registers) => {
        const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(ours));
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.alias).toBe("fresh");
          expect(r.warning).toContain("registered it live");
        }
        expect(registers()).toBe(1);
        expect(projectHeader(r)).toEqual({ "x-hayven-project": "fresh" });
      },
    );
  });

  it("hard-refuses when live registration fails (never mutate a foreign primary)", async () => {
    const ours = mkdtempSync(join(tmpdir(), "hayven-refuse-"));
    const other = mkdtempSync(join(tmpdir(), "hayven-refuse-other-"));
    const health = {
      ok: true,
      version: "0.0.5",
      root: other,
      primary: "other",
      projects: [{ alias: "other", root: other, branch: null }],
    };
    await withDaemon(
      health,
      { status: 400, body: { error: "no .hayven/ directory" } },
      async () => {
        const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(ours));
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.message).toContain("refusing to mutate");
          expect(r.message).toContain("no .hayven/ directory");
        }
        expect(projectHeader(r)).toEqual({});
      },
    );
  });

  it("hard-refuses against a daemon without the registration route (404)", async () => {
    const ours = mkdtempSync(join(tmpdir(), "hayven-noroute-"));
    const other = mkdtempSync(join(tmpdir(), "hayven-noroute-other-"));
    const health = { ok: true, version: "0.0.5", root: other }; // no projects list
    await withDaemon(health, { status: 404, body: { error: "not found" } }, async () => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(ours));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain("does not support live project registration");
    });
  });

  it("matching single-project root passes with NO alias (primary routing is correct)", async () => {
    const ours = mkdtempSync(join(tmpdir(), "hayven-single-"));
    const health = { ok: true, version: "0.0.5", root: ours };
    await withDaemon(health, { status: 200, body: {} }, async (registers) => {
      const r = await assertDaemonServesProject("http://localhost:7777", ctxFor(ours));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.alias).toBeUndefined();
      expect(registers()).toBe(0);
      expect(projectHeader(r)).toEqual({});
    });
  });
});
