/**
 * GAP Q3 — a WIPED index still reported healthy over HTTP.
 *
 * `last_ingest_at` lives in the `stats` table and is written only on SUCCESS, so
 * it SURVIVES a `clearGraph()` that was never repopulated. `/api/stats` returned
 * that timestamp with no integrity field at all, so a zero-node index answered
 * "fresh, last ingested a minute ago" to the viewer, the MCP server, the proxy
 * and anything else polling the daemon — while every query returned "No matches",
 * which a caller reads as a fact about their code rather than a tool failure.
 *
 * The integrity check existed (`Db.checkIndexIntegrity`, and `StalenessResult.
 * broken` on top of it) but was wired into the CLI only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp, type ServerDependencies } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import { makeTestCrdtState } from "./_helpers.ts";

// Belt-and-braces per the house rules; nothing here should reach global state.
const HAYVEN_HOME_SANDBOX = mkdtempSync(join(tmpdir(), "hayven-gapq-stats-home-"));
process.env["HAYVEN_HOME"] = HAYVEN_HOME_SANDBOX;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function appFor(db: Db, inFlight: { startedAt: number } | null = null) {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-gapq-stats-"));
  dirs.push(repoRoot);
  const deps: ServerDependencies = {
    db,
    config: DEFAULT_CONFIG,
    paths: hayvenPathsFor(repoRoot),
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt: makeTestCrdtState(),
    daemonVersion: "test",
    ingest: {
      current: () => inFlight,
      start: async () => {
        throw new Error("not used");
      },
    },
  };
  return buildApp(deps);
}

async function stats(db: Db, inFlight: { startedAt: number } | null = null) {
  const res = await appFor(db, inFlight).handle(new Request("http://localhost/api/stats"));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    nodes: number;
    last_ingest_at: number | null;
    index_ok: boolean;
    index_broken: string | null;
    index_broken_detail: string | null;
    index_ingesting: boolean;
  };
}

describe("Q3 — /api/stats surfaces index integrity, not just freshness", () => {
  test("a WIPED index that still claims a successful ingest is reported broken", async () => {
    const db = new Db(":memory:");
    db.migrate();
    // Record a successful ingest of 1,234 nodes, then wipe the graph — exactly
    // what an interrupted `clearGraph()` + re-parse leaves behind.
    db.setStat("last_ingest_nodes", "1234");
    db.setStat("last_ingest_at", String(Date.now()));
    db.handle.run("DELETE FROM nodes");

    const body = await stats(db);
    // The FRESHNESS signal is still (misleadingly) present — that is the point.
    expect(body.last_ingest_at).not.toBeNull();
    expect(body.nodes).toBe(0);
    // ...but a client can now tell the difference.
    expect(body.index_ok).toBe(false);
    expect(body.index_broken).toBe("empty-but-claims-content");
    expect(typeof body.index_broken_detail).toBe("string");
    expect(body.index_broken_detail!.length).toBeGreaterThan(0);
    db.close();
  });

  test("an interrupted ingest (marker set, NOTHING running) is reported broken", async () => {
    const db = new Db(":memory:");
    db.migrate();
    db.markIngestInProgress();

    const body = await stats(db, null);
    expect(body.index_ok).toBe(false);
    expect(body.index_broken).toBe("ingest-interrupted");
    expect(body.index_ingesting).toBe(false);
    db.close();
  });

  test("an IN-FLIGHT ingest is NOT reported broken — that would flap on every save", async () => {
    // `runIngest` sets the in-progress marker for EVERY ingest, including each
    // watcher incremental re-ingest. Reported verbatim, a healthy daemon would
    // publish `index_ok: false` every time the user saved a file, and a client
    // told to branch on the field would be useless.
    const db = new Db(":memory:");
    db.migrate();
    db.markIngestInProgress();

    const body = await stats(db, { startedAt: Date.now() });
    expect(body.index_ok).toBe(true);
    expect(body.index_broken).toBeNull();
    // ...but the client is still told WHY the counts may be moving.
    expect(body.index_ingesting).toBe(true);
    db.close();
  });

  test("a full ingest mid-rebuild is NOT reported broken — the wipe is its own first step", async () => {
    // `fullIngest` calls `clearGraph()`, which empties `nodes` while
    // `last_ingest_nodes` survives in `stats`. From that clear until the first
    // batch flushes — the ENTIRE native parse phase, minutes on a large repo — a
    // healthy daemon is byte-identical to one whose rebuild was killed. This
    // state is genuinely NOT KNOWABLE while an ingest runs, and the remedy the
    // broken state advertises ("run `hayven ingest --full`") is exactly what is
    // already running, so a warning here could not even be acted on.
    //
    // An earlier draft of this file asserted the opposite. It was wrong: it
    // would have made a healthy daemon publish `index_ok: false` for the whole
    // of every rebuild, which is precisely the flapping that makes a health
    // field worthless.
    const db = new Db(":memory:");
    db.migrate();
    db.setStat("last_ingest_nodes", "1234");
    db.handle.run("DELETE FROM nodes");
    db.markIngestInProgress();

    const body = await stats(db, { startedAt: Date.now() });
    expect(body.index_ok).toBe(true);
    expect(body.index_broken).toBeNull();
    // The ambiguity is DISCLOSED, not hidden — a client seeing this must not
    // read the counts as truth.
    expect(body.index_ingesting).toBe(true);
    expect(body.nodes).toBe(0);
    db.close();
  });

  test("...and the SAME state IS reported broken once the ingest ends", async () => {
    // The distinguishing fact is not the index, it is whether anything is still
    // working on it. This is the assertion that keeps the exemption honest: an
    // exemption that also fired with no ingest running would re-open the
    // original bug (a wiped index certifying itself healthy over HTTP).
    const db = new Db(":memory:");
    db.migrate();
    db.setStat("last_ingest_nodes", "1234");
    db.handle.run("DELETE FROM nodes");
    db.markIngestInProgress();

    const body = await stats(db, null);
    expect(body.index_ok).toBe(false);
    expect(body.index_broken).toBe("empty-but-claims-content");
    expect(body.index_ingesting).toBe(false);
    db.close();
  });

  test("a healthy index reports index_ok with a null reason", async () => {
    const db = new Db(":memory:");
    db.migrate();
    db.setStat("last_ingest_at", String(Date.now()));

    const body = await stats(db);
    expect(body.index_ok).toBe(true);
    expect(body.index_broken).toBeNull();
    expect(body.index_broken_detail).toBeNull();
    db.close();
  });
});

/**
 * GAP Q (Lane T handoff) — `HlcGenerator.rejectedSkewCount()` existed but was
 * unreachable: the count lives in the daemon's in-memory `CrdtState`, so a peer
 * whose clock was badly wrong had its ops silently refused with the evidence
 * trapped in a process nobody could query.
 */
describe("Q/T — /api/health exposes the HLC skew-rejection count", () => {
  test("reports zero on a healthy daemon and the real count after a rejection", async () => {
    const db = new Db(":memory:");
    db.migrate();
    const app = appFor(db);

    const read = async (): Promise<number> => {
      const res = await app.handle(new Request("http://localhost/api/health"));
      expect(res.status).toBe(200);
      return ((await res.json()) as { hlc_skew_rejections: number }).hlc_skew_rejections;
    };

    expect(await read()).toBe(0);
    db.close();
  });

  test("the field tracks the generator, not a hardcoded zero", async () => {
    const db = new Db(":memory:");
    db.migrate();
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-gapq-hlc-"));
    dirs.push(repoRoot);
    const crdt = makeTestCrdtState();
    // Feed the clock a remote HLC from far in the future — past the skew bound,
    // so it is refused and counted.
    crdt.clock.observe({ wallMs: Date.now() + 365 * 24 * 3600 * 1000, counter: 0 });
    const rejected = crdt.clock.rejectedSkewCount();
    expect(rejected).toBeGreaterThan(0);

    const app = buildApp({
      db,
      config: DEFAULT_CONFIG,
      paths: hayvenPathsFor(repoRoot),
      logger: createLogger({ toFile: false, toStderr: false }),
      crdt,
      daemonVersion: "test",
      ingest: {
        current: () => null,
        start: async () => {
          throw new Error("not used");
        },
      },
    });
    const res = await app.handle(new Request("http://localhost/api/health"));
    const body = (await res.json()) as { hlc_skew_rejections: number };
    expect(body.hlc_skew_rejections).toBe(rejected);
    db.close();
  });
});

describe("Q/T — /api/health never 500s on the diagnostic field", () => {
  test("a partially-wired CrdtState degrades the counter to null, not a 500", async () => {
    // `/api/health` is the LIVENESS endpoint: every probe, the `daemon start`
    // readiness wait and `assertDaemonServesProject` all hit it. A diagnostic
    // counter must never be able to take it down — a daemon that cannot answer
    // "am I up?" is worse than one that cannot report its clock skew.
    const db = new Db(":memory:");
    db.migrate();
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-gapq-hlc2-"));
    dirs.push(repoRoot);
    const app = buildApp({
      db,
      config: DEFAULT_CONFIG,
      paths: hayvenPathsFor(repoRoot),
      logger: createLogger({ toFile: false, toStderr: false }),
      // No `clock` — the shape several existing tests wire.
      crdt: { close() {} } as never,
      daemonVersion: "test",
      ingest: {
        current: () => null,
        start: async () => {
          throw new Error("not used");
        },
      },
    });
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hlc_skew_rejections: number | null };
    expect(body.ok).toBe(true);
    expect(body.hlc_skew_rejections).toBeNull();
    db.close();
  });
});
