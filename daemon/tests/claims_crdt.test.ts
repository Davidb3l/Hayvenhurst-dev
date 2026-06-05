// Tests for the CRDT-backed claims API (POST/DELETE/GET) introduced when
// `/api/claims` was rewired through the OR-Set + on-disk op log.
// Skipped when the native binary isn't built — applyOr encodes through the
// wire bridge (hayven-native).
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  const candidates = [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

interface ClaimDto {
  id: string;
  agent: string;
  intent: string;
  scope: string[];
  fingerprint: string;
  created: number;
  ttl: number;
  status: "active" | "expired";
}

interface ClaimsResponse {
  claims: ClaimDto[];
  total: number;
  active: number;
  expired: number;
}

function makeAppWith(crdt: CrdtState) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-claims-crdt-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  const app = buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt,
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  });
  return { app, db, repoRoot };
}

async function postClaim(
  app: ReturnType<typeof makeAppWith>["app"],
  body: unknown,
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/claims", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function deleteClaim(
  app: ReturnType<typeof makeAppWith>["app"],
  id: string,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/api/claims/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  );
}

async function getClaims(
  app: ReturnType<typeof makeAppWith>["app"],
): Promise<ClaimsResponse> {
  const res = await app.handle(new Request("http://localhost/api/claims"));
  expect(res.status).toBe(200);
  return (await res.json()) as ClaimsResponse;
}

const samplePayload = () => ({
  id: "claim_abc",
  agent: "agent_3",
  intent: "Adding rate limiting to login flow",
  scope: ["auth/login_handler", "auth/validate_session"],
  fingerprint: "blake3:9c2d",
  ttlSeconds: 600,
});

maybeDescribe("/api/claims CRDT path", () => {
  const cleanups: string[] = [];
  const closables: CrdtState[] = [];
  afterEach(() => {
    for (const s of closables) s.close();
    closables.length = 0;
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function newCrdtRoot(): { crdtRoot: string; configFile: string } {
    const dir = mkdtempSync(join(tmpdir(), "hayven-crdt-claims-"));
    cleanups.push(dir);
    return { crdtRoot: join(dir, "crdt"), configFile: join(dir, "config.json") };
  }

  function freshCrdt(): CrdtState {
    const { crdtRoot, configFile } = newCrdtRoot();
    const s = new CrdtState({ crdtRoot, configFile, skipHydrate: true });
    closables.push(s);
    return s;
  }

  it("POST returns 201 and the claim is visible on the next GET", async () => {
    const { app, db } = makeAppWith(freshCrdt());
    const res = await postClaim(app, samplePayload());
    expect(res.status).toBe(201);
    const created = (await res.json()) as ClaimDto;
    expect(created.id).toBe("claim_abc");
    expect(created.status).toBe("active");
    expect(created.scope).toEqual(["auth/login_handler", "auth/validate_session"]);

    const board = await getClaims(app);
    expect(board.total).toBe(1);
    expect(board.active).toBe(1);
    expect(board.claims[0]!.id).toBe("claim_abc");

    // Denormalized SQL cache is populated too.
    const row = db.handle
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM claims")
      .get();
    expect(row?.c).toBe(1);
  });

  it("rejects malformed POST payloads with HTTP 400", async () => {
    const { app } = makeAppWith(freshCrdt());
    const cases: unknown[] = [
      { agent: "a", intent: "i", scope: ["s"], fingerprint: "f", ttlSeconds: 1 },
      { id: "x", intent: "i", scope: ["s"], fingerprint: "f", ttlSeconds: 1 },
      { id: "x", agent: "a", scope: ["s"], fingerprint: "f", ttlSeconds: 1 },
      { id: "x", agent: "a", intent: "i", scope: [], fingerprint: "f", ttlSeconds: 1 },
      { id: "x", agent: "a", intent: "i", scope: ["s"], fingerprint: "f", ttlSeconds: 0 },
      { id: "x", agent: "a", intent: "i", scope: ["s"], fingerprint: "f", ttlSeconds: "soon" },
    ];
    for (const body of cases) {
      const res = await postClaim(app, body);
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: string };
      expect(typeof err.error).toBe("string");
      expect(err.error.length).toBeGreaterThan(0);
    }
  });

  it("duplicate POST by the SAME agent is idempotent (200, returns the live claim)", async () => {
    // A retry of the same (id, agent) must NOT 409 — that made a CLI retry loop
    // spin. It returns the existing claim with 200 so the caller proceeds.
    const { app } = makeAppWith(freshCrdt());
    const first = await postClaim(app, samplePayload());
    expect(first.status).toBe(201);

    const dup = await postClaim(app, samplePayload());
    expect(dup.status).toBe(200);
    const body = (await dup.json()) as ClaimDto;
    expect(body.id).toBe("claim_abc");
    expect(body.status).toBe("active");
  });

  it("duplicate id from a DIFFERENT agent is a genuine collision (409)", async () => {
    const { app } = makeAppWith(freshCrdt());
    expect((await postClaim(app, samplePayload())).status).toBe(201);
    const other = await postClaim(app, { ...samplePayload(), agent: "agent_OTHER" });
    expect(other.status).toBe(409);
    const body = (await other.json()) as { error: string; existing: ClaimDto };
    expect(body.error).toContain("different agent");
    expect(body.existing.id).toBe("claim_abc");
  });

  it("an EXPIRED claim no longer blocks an overlapping scope (TTL-aware)", async () => {
    // The deadlock bug: a claim past its TTL kept blocking its scope forever
    // because the overlap check ignored TTL. A new claim overlapping an expired
    // one must now register (201), not 409.
    const { app } = makeAppWith(freshCrdt());
    const reg = await postClaim(app, {
      id: "claim_old",
      agent: "agent_gone",
      intent: "abandoned work",
      scope: ["auth/login_handler"],
      fingerprint: "blake3:00",
      ttlSeconds: 1,
    });
    expect(reg.status).toBe(201);
    await new Promise((r) => setTimeout(r, 1100)); // let the 1s TTL elapse
    const fresh = await postClaim(app, {
      id: "claim_new",
      agent: "agent_new",
      intent: "take over",
      scope: ["auth/login_handler"],
      fingerprint: "blake3:11",
      ttlSeconds: 600,
    });
    expect(fresh.status).toBe(201); // expired claim_old did NOT block it
  });

  it("DELETE removes the claim — GET no longer lists it", async () => {
    const { app, db } = makeAppWith(freshCrdt());
    await postClaim(app, samplePayload());

    const del = await deleteClaim(app, "claim_abc");
    expect(del.status).toBe(200);
    const ok = (await del.json()) as { ok: boolean; id: string };
    expect(ok.ok).toBe(true);
    expect(ok.id).toBe("claim_abc");

    const board = await getClaims(app);
    expect(board.total).toBe(0);
    expect(board.claims).toEqual([]);

    const row = db.handle
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM claims")
      .get();
    expect(row?.c).toBe(0);
  });

  it("DELETE on an unknown id returns 404", async () => {
    const { app } = makeAppWith(freshCrdt());
    const res = await deleteClaim(app, "does_not_exist");
    expect(res.status).toBe(404);
  });

  it("POST + DELETE survive a CrdtState restart (deleted claim stays deleted)", async () => {
    const { crdtRoot, configFile } = newCrdtRoot();

    // Round 1: add two claims, delete one.
    const first = new CrdtState({ crdtRoot, configFile, skipHydrate: true });
    const ctx1 = makeAppWith(first);
    await postClaim(ctx1.app, samplePayload());
    // Distinct, non-overlapping scope in a different module: under §17.1 an
    // intersecting OR module-adjacent scope would now be rejected (409/202),
    // and this test exercises CRDT restart/delete, not the conflict path.
    await postClaim(ctx1.app, {
      ...samplePayload(),
      id: "claim_keep",
      scope: ["billing/invoice_create"],
    });
    const delRes = await deleteClaim(ctx1.app, "claim_abc");
    expect(delRes.status).toBe(200);
    first.close();

    // Round 2: fresh CrdtState against the same disk root — hydrate replays
    // the op log and rebuilds the OR-Set.
    const second = new CrdtState({ crdtRoot, configFile });
    closables.push(second);
    const ctx2 = makeAppWith(second);

    const board = await getClaims(ctx2.app);
    expect(board.total).toBe(1);
    expect(board.claims[0]!.id).toBe("claim_keep");
    const ids = board.claims.map((c) => c.id);
    expect(ids).not.toContain("claim_abc");
  });
});
