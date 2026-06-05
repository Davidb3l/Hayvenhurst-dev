// Bandwidth measurement for sync round-trips. PRD §16(5) target: a routine
// daily sync between two machines transfers <30 KB.
//
// We don't run a real network — we exercise the §15.2 endpoints on two
// in-process apps and tally the bytes that would have gone on the wire.
//
// BL-9: the original ledger counted request+response BODIES only and reported
// that as "the" sync cost — which undersold real traffic, because every one of
// the ~16 round-trips also carries HTTP request + response headers (request
// line, Host, Content-Type, Content-Length, Date, Connection, etc.). We now
// report TWO honest figures:
//   - `payloadBytes` — request+response bodies (what the old headline measured)
//   - `realisticBytes` — payloadBytes + a fixed per-round-trip header estimate
// The PRD §16(5) `< 30 KB` contract is asserted against the realisticBytes
// figure (it still holds comfortably), so the test guards the number a real
// peer actually sees, not the optimistic body-only floor.
//
// Skipped when the native binary isn't built (the wire encoder needs it).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { bucketize, type GsetOp } from "../src/crdt/gset.ts";
import { computeMerkle, diffSnapshots } from "../src/crdt/merkle.ts";
import { splitSegmentBatches } from "../src/crdt/oplog.ts";
import { gsetToWire } from "../src/crdt/wire.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import type { Hlc } from "../src/crdt/hlc.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  for (const c of [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ]) if (existsSync(c)) return c;
  return null;
}

const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

function obs(opts: Partial<GsetOp> & { hlc: Hlc; writer: Uint8Array }): GsetOp {
  return {
    kind: "observe",
    src: opts.src ?? "auth/login",
    dst: opts.dst ?? "auth/session",
    tsBucket: opts.tsBucket ?? bucketize(1_700_000_000),
    observed: opts.observed ?? 1,
    weight: opts.weight ?? 100,
    hlc: opts.hlc,
    writer: opts.writer,
  };
}

interface Replica {
  app: ReturnType<typeof buildApp>;
  crdt: CrdtState;
  paths: ReturnType<typeof hayvenPathsFor>;
  dir: string;
}

function makeReplica(now: () => number): Replica {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-bw-"));
  const paths = hayvenPathsFor(repoRoot);
  // CrdtState writes to paths.crdtDir; the sync routes read computeMerkle
  // from the same dir, so the request-path view stays consistent with what
  // the in-memory CRDT does.
  const crdt = new CrdtState({
    crdtRoot: paths.crdtDir,
    configFile: paths.configFile,
    skipHydrate: true,
    now,
  });
  const db = new Db(":memory:");
  db.migrate();
  const app = buildApp({
    db,
    config: DEFAULT_CONFIG,
    paths,
    logger: createLogger({ toFile: false, toStderr: false }),
    crdt,
    daemonVersion: "test",
    ingest: { current: () => null, start: async () => { throw new Error("not used"); } },
  });
  return { app, crdt, paths, dir: repoRoot };
}

interface BandwidthLedger {
  requestBytes: number;
  responseBytes: number;
  roundTrips: number;
}

// BL-9: a conservative-but-realistic estimate of the HTTP header bytes a real
// peer adds per round-trip, summed across the request and response. A minimal
// keep-alive exchange (request line + Host + Content-Type + Content-Length +
// Accept; response status line + Content-Type + Content-Length + Date +
// Connection) lands around here. Deliberately on the modest side so the
// reported number stays honest without being alarmist.
const HEADER_OVERHEAD_PER_ROUND_TRIP = 350;

function payloadBytes(l: BandwidthLedger): number {
  return l.requestBytes + l.responseBytes;
}

function realisticBytes(l: BandwidthLedger): number {
  return payloadBytes(l) + l.roundTrips * HEADER_OVERHEAD_PER_ROUND_TRIP;
}

async function syncWithLedger(
  from: Replica,
  to: Replica,
  ledger: BandwidthLedger,
): Promise<void> {
  // GET /api/sync/merkle on `to` — we add the URL length for the request
  // (no body), and the JSON response length.
  ledger.roundTrips += 1;
  const merkleReq = "GET /api/sync/merkle HTTP/1.1\r\n\r\n";
  ledger.requestBytes += merkleReq.length;
  const rootsRes = await to.app.handle(new Request("http://localhost/api/sync/merkle"));
  const rootsBytes = new Uint8Array(await rootsRes.clone().arrayBuffer());
  ledger.responseBytes += rootsBytes.length;
  const toRoots = (await rootsRes.json()) as Record<"lww" | "gset" | "orset", string>;

  const fromSnap = computeMerkle(from.crdt.oplog);
  if (
    fromSnap.roots.lww === toRoots.lww &&
    fromSnap.roots.gset === toRoots.gset &&
    fromSnap.roots.orset === toRoots.orset
  ) return;

  const toLeaves: Record<"lww" | "gset" | "orset", { path: string; hash: string }[]> = {
    lww: [],
    gset: [],
    orset: [],
  };
  for (const type of ["lww", "gset", "orset"] as const) {
    if (fromSnap.roots[type] === toRoots[type]) {
      toLeaves[type] = [...fromSnap.leaves[type]];
      continue;
    }
    ledger.roundTrips += 1;
    const body = JSON.stringify({ type });
    ledger.requestBytes += body.length;
    const r = await to.app.handle(new Request("http://localhost/api/sync/leaves", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    const buf = new Uint8Array(await r.clone().arrayBuffer());
    ledger.responseBytes += buf.length;
    const parsed = (await r.json()) as { type: string; leaves: { path: string; hash: string }[] };
    toLeaves[type] = parsed.leaves;
  }
  const toSnap = { roots: { ...toRoots }, leaves: toLeaves };
  const diff = diffSnapshots(fromSnap, toSnap);

  // Pull divergent days from `to`, push each constituent batch into `from`'s
  // local daemon. Uses the production splitSegmentBatches — same path the
  // real CLI takes, so the measurement reflects real traffic.
  for (const t of diff.pull) {
    ledger.roundTrips += 1;
    const body = JSON.stringify({ type: t.type, path: t.path, offset: 0 });
    ledger.requestBytes += body.length;
    const r = await to.app.handle(new Request("http://localhost/api/sync/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));
    const bytes = new Uint8Array(await r.arrayBuffer());
    ledger.responseBytes += bytes.length;
    for (const batch of splitSegmentBatches(bytes)) {
      ledger.roundTrips += 1;
      const pushBody = JSON.stringify({
        type: t.type,
        path: t.path,
        batch: Buffer.from(batch).toString("base64"),
      });
      ledger.requestBytes += pushBody.length;
      const pushRes = await from.app.handle(new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: pushBody,
      }));
      ledger.responseBytes += new Uint8Array(await pushRes.arrayBuffer()).length;
    }
  }
  for (const t of diff.push) {
    const segBytes = from.crdt.oplog.readSegmentBytes(t.type, t.path);
    if (segBytes === null) continue;
    for (const batch of splitSegmentBatches(segBytes)) {
      ledger.roundTrips += 1;
      const body = JSON.stringify({
        type: t.type,
        path: t.path,
        batch: Buffer.from(batch).toString("base64"),
      });
      ledger.requestBytes += body.length;
      const r = await to.app.handle(new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
      ledger.responseBytes += new Uint8Array(await r.arrayBuffer()).length;
    }
  }
}

maybeDescribe("PRD §16(5): routine daily sync transfers <30 KB", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  test("identical peers: a no-op sync is one round-trip + ~150 B", async () => {
    const now = () => 1_700_000_000_000;
    const a = makeReplica(now);
    const b = makeReplica(now);
    cleanups.push(a.dir, b.dir);
    const ledger: BandwidthLedger = { requestBytes: 0, responseBytes: 0, roundTrips: 0 };
    await syncWithLedger(a, b, ledger);
    expect(ledger.roundTrips).toBe(1);
    // Bodies are tiny (~150 B); with one round-trip's header overhead a real
    // no-op probe is still well under 1 KB.
    expect(payloadBytes(ledger)).toBeLessThan(300);
    expect(realisticBytes(ledger)).toBeLessThan(1_000);
  });

  test("representative day: 200 trace observations + 5 claims fits under 30 KB", async () => {
    const now = () => 1_700_000_000_000;
    const a = makeReplica(now);
    const b = makeReplica(now);
    cleanups.push(a.dir, b.dir);

    // Simulate the Python tracer's behavior: ~48 batches per day (one
    // flush every 30 seconds). We split 200 ops into chunks of ~10 to
    // model that — appendOps writes one §13 batch per call regardless of
    // op count, so this matches what the trace route does when given a
    // batch payload from the tracer.
    const chunkSize = 25;
    let opIdx = 0;
    for (let chunk = 0; chunk < 200 / chunkSize; chunk++) {
      const wireOps = [];
      for (let i = 0; i < chunkSize; i++) {
        const op = obs({
          hlc: H(1_700_000_000_000 + opIdx * 30, 0),
          writer: a.crdt.writer,
          src: `auth/handler_${opIdx % 20}`,
          dst: `auth/check_${opIdx % 13}`,
          observed: (opIdx % 5) + 1,
          weight: ((opIdx % 5) + 1) * 100,
        });
        wireOps.push(gsetToWire(op));
        a.crdt.gset.apply(op);
        opIdx += 1;
      }
      a.crdt.oplog.appendOps("gset", wireOps);
    }
    for (let i = 0; i < 5; i++) {
      a.crdt.applyOr({
        kind: "add",
        claimId: `claim_${i}`,
        agent: "agent-a",
        payload: {
          intent: `refactor module ${i}`,
          scope: [`mod_${i}/handler`],
          fingerprint: `blake3:${i.toString(16).padStart(8, "0")}`,
          createdMs: 1_700_000_000_000,
          ttlMs: 1_700_000_000_000 + 600_000,
        },
        hlc: H(1_700_000_000_000 + 10_000 + i, 0),
        writer: a.crdt.writer,
      });
    }

    const ledger: BandwidthLedger = { requestBytes: 0, responseBytes: 0, roundTrips: 0 };
    await syncWithLedger(a, b, ledger);
    const payload = payloadBytes(ledger);
    const realistic = realisticBytes(ledger);
    // eslint-disable-next-line no-console
    console.log(
      `bandwidth: payload(req+res bodies)=${payload} ` +
      `+ headers(${ledger.roundTrips} rt × ${HEADER_OVERHEAD_PER_ROUND_TRIP} B) ` +
      `= realistic=${realistic} (PRD target: <30 KB)`,
    );
    // Assert the PRD §16(5) contract against the HONEST realistic figure
    // (payload + header overhead), not the optimistic body-only number.
    expect(realistic).toBeLessThan(30_000);
    // Sanity: convergence happened too.
    expect(b.crdt.gset.size).toBe(200);
    expect(b.crdt.orset.active().length).toBe(5);
  });
});
