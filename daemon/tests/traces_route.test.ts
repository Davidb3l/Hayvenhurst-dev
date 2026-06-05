/**
 * `POST /api/traces/observations` — daemon-side defense-in-depth for the
 * additive per-test `test_coverage` array (schema v6).
 *
 * The Python collector now POSTs runtime traces in BOUNDED batches (a single
 * giant POST was timing out and silently dropping ~half a large suite's
 * coverage). These tests pin the daemon-side complement so a large/edge-case
 * coverage chunk is never silently dropped:
 *   - a coverage-ONLY chunk (`observations: []` + non-empty `test_coverage`)
 *     still inserts its coverage (coverage is NOT gated on observations);
 *   - one malformed coverage row is SKIPPED and reported, never a 400/throw;
 *   - a normal both-arrays payload still works (regression);
 *   - a large coverage batch (3000 rows) is accepted and all land.
 *
 * App build mirrors `neighbors_trace.test.ts`'s `mkApp`/`buildApp` pattern.
 * REMEMBER: Elysia `app.handle` is hostname-sensitive — use `http://localhost`.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

/** Build an in-memory app + db, mirroring the neighbors-trace test harness. */
function mkApp(): { app: ReturnType<typeof buildApp>; db: Db } {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-traces-route-"));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(":memory:");
  db.migrate();
  const app = buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used in this test");
      },
    },
  });
  return { app, db };
}

/** POST a JSON body to the observations route. */
async function post(
  app: ReturnType<typeof buildApp>,
  body: unknown,
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/api/traces/observations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface OkBody {
  ok: boolean;
  accepted: number;
  coverage_accepted: number;
  coverage_skipped: number;
  coverage_error?: string;
}

describe("POST /api/traces/observations — coverage defense-in-depth", () => {
  it("inserts coverage from a coverage-ONLY chunk (empty observations: [])", async () => {
    const { app, db } = mkApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [], // surplus coverage batch — no observations this chunk
      test_coverage: [
        { test: "test_login", entity: "auth/login", weight: 3 },
        { test: "test_login", entity: "auth/validate", weight: 1 },
        { test: "test_logout", entity: "auth/logout", weight: 2 },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.ok).toBe(true);
    // Observations empty, but coverage MUST land independently.
    expect(body.accepted).toBe(0);
    expect(body.coverage_accepted).toBe(3);
    expect(body.coverage_skipped).toBe(0);
    expect(db.observationsCount()).toBe(0);
    expect(db.testCoverageCount()).toBe(3);
  });

  it("skips a malformed coverage row and accepts the rest (no 400, no throw)", async () => {
    const { app, db } = mkApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [],
      test_coverage: [
        { test: "test_a", entity: "mod/a", weight: 1 }, // good
        { test: "", entity: "mod/b", weight: 1 }, // blank test → skip
        { test: "test_c", entity: "   ", weight: 1 }, // blank entity → skip
        { test: "test_d", entity: "mod/d", weight: -1 }, // bad weight → skip
        { test: "test_e", entity: "mod/e" }, // weight defaults to 1 → good
        { test: "test_f", entity: "mod/f", weight: 2 }, // good
      ],
    });
    // A bad row never rejects the batch.
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.ok).toBe(true);
    expect(body.coverage_accepted).toBe(3); // a, e, f
    expect(body.coverage_skipped).toBe(3); // blank-test, blank-entity, bad-weight
    expect(db.testCoverageCount()).toBe(3);
    // Confirm precisely the good rows landed.
    const tests = db
      .allTestCoverage()
      .map((r) => r.test)
      .sort();
    expect(tests).toEqual(["test_a", "test_e", "test_f"]);
  });

  it("accepts a normal payload with BOTH observations and coverage (regression)", async () => {
    const { app, db } = mkApp();
    const ts = 1_715_789_520;
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [
        { src: "auth/login", dst: "auth/validate", ts, observed: 5, weight: 500 },
        { src: "auth/login", dst: "auth/issue", ts, observed: 3, weight: 300 },
      ],
      test_coverage: [
        { test: "test_login", entity: "auth/login", weight: 1 },
        { test: "test_login", entity: "auth/validate", weight: 1 },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.accepted).toBe(2);
    expect(body.coverage_accepted).toBe(2);
    expect(body.coverage_skipped).toBe(0);
    expect(db.observationsCount()).toBe(2);
    expect(db.testCoverageCount()).toBe(2);
  });

  it("accepts a large coverage batch (3000 rows) and all land", async () => {
    const { app, db } = mkApp();
    const N = 3000;
    const test_coverage = Array.from({ length: N }, (_, i) => ({
      test: `test_${i}`,
      entity: `mod/entity_${i % 50}`,
      weight: 1,
    }));
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [],
      test_coverage,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.coverage_accepted).toBe(N);
    expect(body.coverage_skipped).toBe(0);
    expect(db.testCoverageCount()).toBe(N);
  });

  it("treats a payload with NEITHER observations NOR coverage as an empty-accepted no-op (not 400)", async () => {
    const { app, db } = mkApp();
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [],
      // no test_coverage at all
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.ok).toBe(true);
    expect(body.accepted).toBe(0);
    expect(body.coverage_accepted).toBe(0);
    expect(body.coverage_skipped).toBe(0);
    expect(db.observationsCount()).toBe(0);
    expect(db.testCoverageCount()).toBe(0);
  });

  it("does NOT 500 when the coverage insert throws — reports coverage_error after observations commit", async () => {
    const { app, db } = mkApp();
    const ts = 1_715_789_520;
    // Force a DB-layer failure on the coverage insert ONLY, AFTER observations
    // have already committed. The handler must catch it, keep the 200, and
    // report `coverage_error` rather than crashing the whole request (task 4).
    db.insertTestCoverage = () => {
      throw new Error("simulated coverage DB failure");
    };
    const res = await post(app, {
      source: "python",
      sample_rate: 100,
      observations: [
        { src: "auth/login", dst: "auth/validate", ts, observed: 5, weight: 500 },
      ],
      test_coverage: [{ test: "test_login", entity: "auth/login", weight: 1 }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkBody;
    expect(body.ok).toBe(true);
    // Observations committed despite the coverage failure.
    expect(body.accepted).toBe(1);
    expect(db.observationsCount()).toBe(1);
    expect(body.coverage_accepted).toBe(0);
    expect(body.coverage_error).toContain("simulated coverage DB failure");
  });
});
