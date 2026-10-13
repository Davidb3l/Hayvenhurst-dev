/**
 * `hayven claim` outcome mapping (audit finding 4.2).
 *
 * The daemon returns 200 for an idempotent re-claim (same agent + same claim
 * id). The CLI only knew 201/202/409, so a harmless retry printed
 * `error: daemon returned 200:` and exited 1 - which a foreman reads as "claim
 * failed". 200 is now success ("already held", exit 0).
 *
 * `--json` keeps EVERY key it always had (including the payload's own
 * `status:"active"` overwriting the HTTP `status` key - a long-standing wart
 * existing consumers may parse around) and ADDS `httpStatus` + `outcome`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { claimOutcome, runClaim } from "../src/cli/claim.ts";

const cwd = process.cwd();
const dirs: string[] = [];
afterEach(() => {
  process.chdir(cwd);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeProject(): string {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "hayven-claimout-")));
  dirs.push(repoRoot);
  mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".hayven", "config.json"),
    JSON.stringify({ ...DEFAULT_CONFIG, daemon_host: "127.0.0.1", daemon_port: 7777 }),
  );
  return repoRoot;
}

function stubFetch(repoRoot: string, status: number, body: unknown): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/health")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, version: "test", root: repoRoot }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  }) as unknown as typeof fetch;
}

async function run(
  status: number,
  body: unknown,
  flags: Record<string, string | boolean>,
): Promise<{ code: number; out: string; err: string }> {
  const repoRoot = makeProject();
  process.chdir(repoRoot);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(repoRoot, status, body);
  (process.stdout as { write: unknown }).write = (s: string) => (out.push(String(s)), true);
  (process.stderr as { write: unknown }).write = (s: string) => (err.push(String(s)), true);
  try {
    const code = await runClaim({ positionals: ["mod/a"], flags: { intent: "test", ...flags } });
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    globalThis.fetch = origFetch;
  }
}

const HELD = {
  id: "claim_abc",
  agent: "cli",
  status: "active",
  intent: "test",
  scope: ["mod/a"],
};

describe("claimOutcome", () => {
  it("maps HTTP statuses to stable outcome words", () => {
    expect(claimOutcome(201)).toBe("granted");
    expect(claimOutcome(200)).toBe("held");
    expect(claimOutcome(409)).toBe("conflict");
    // 202 = adjacent-claim verdict, claim NOT registered: must never read as granted.
    expect(claimOutcome(202)).toBe("potential-conflict");
    expect(claimOutcome(500)).toBe("error");
    expect(claimOutcome(400)).toBe("error");
  });
});

describe("hayven claim: idempotent re-claim (200)", () => {
  it("human output: exit 0 and says the claim is already held", async () => {
    const r = await run(200, HELD, {});
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("already held");
    expect(r.out).toContain("claim_abc");
  });

  it("--json: exit 0, original keys untouched, httpStatus + outcome added", async () => {
    const r = await run(200, HELD, { json: true });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    // Backward compat: the payload's `status:"active"` still wins the `status` key.
    expect(j["status"]).toBe("active");
    expect(j["id"]).toBe("claim_abc");
    expect(j["agent"]).toBe("cli");
    expect(j["scope"]).toEqual(["mod/a"]);
    expect(j["httpStatus"]).toBe(200);
    expect(j["outcome"]).toBe("held");
  });
});

describe("hayven claim: other statuses keep their exit codes and gain outcome fields", () => {
  it("201 -> 0, granted", async () => {
    const r = await run(201, { ...HELD }, { json: true });
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j["httpStatus"]).toBe(201);
    expect(j["outcome"]).toBe("granted");
  });

  it("201 human output unchanged", async () => {
    const r = await run(201, { ...HELD }, {});
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Claim registered");
  });

  it("202 -> 3, potential-conflict, and --json still carries the payload status", async () => {
    const body = { status: "potential-conflict", message: "m", verdicts: [] };
    const r = await run(202, body, { json: true });
    expect(r.code).toBe(3);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j["status"]).toBe("potential-conflict");
    expect(j["httpStatus"]).toBe(202);
    expect(j["outcome"]).toBe("potential-conflict");
  });

  it("409 -> 1, conflict", async () => {
    const body = { error: "scope overlaps an active claim", conflictingClaimId: "other" };
    const r = await run(409, body, { json: true });
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as Record<string, unknown>;
    expect(j["httpStatus"]).toBe(409);
    expect(j["outcome"]).toBe("conflict");
    expect(j["conflictingClaimId"]).toBe("other");
    // `status` is the HTTP code here (the payload has none) - exactly as before.
    expect(j["status"]).toBe(409);
  });

  it("500 -> 1, error, and human mode still reports the daemon status", async () => {
    const j = await run(500, { error: "boom" }, { json: true });
    expect(j.code).toBe(1);
    expect((JSON.parse(j.out) as Record<string, unknown>)["outcome"]).toBe("error");
    const h = await run(500, { error: "boom" }, {});
    expect(h.code).toBe(1);
    expect(h.err).toContain("daemon returned 500");
  });
});
