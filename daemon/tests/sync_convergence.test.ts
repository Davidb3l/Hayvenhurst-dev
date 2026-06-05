// End-to-end sync convergence between two in-process daemons. This is the
// regression guard for the review's CRITICAL sync findings:
//   - push wrote to today's segment instead of the pulled day (never
//     converged across days),
//   - whole-segment pushes were double-framed (corrupt → truncated to 0 ops),
//   - Merkle leaves hashed raw bytes, so different append orders never matched.
// Every test here would FAIL on the pre-hardening code. Skipped without the
// native binary.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { bucketize, type GsetOp } from "../src/crdt/gset.ts";
import { computeMerkle, diffSnapshots } from "../src/crdt/merkle.ts";
import { splitSegmentBatches } from "../src/crdt/oplog.ts";
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

const DAY1 = Date.UTC(2026, 2, 1, 9, 0, 0);
const DAY2 = Date.UTC(2026, 2, 2, 9, 0, 0);
const DAY3 = Date.UTC(2026, 2, 3, 9, 0, 0);
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

interface Replica {
  app: ReturnType<typeof buildApp>;
  crdt: CrdtState;
  dir: string;
}

function gsetOp(src: string, dst: string, hlc: Hlc, writer: Uint8Array): GsetOp {
  return {
    kind: "observe",
    src,
    dst,
    tsBucket: bucketize(Math.floor(hlc.wallMs / 1000)),
    observed: 1,
    weight: 100,
    hlc,
    writer,
  };
}

maybeDescribe("sync convergence (cross-day, bidirectional)", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function makeReplica(): Replica {
    const dir = mkdtempSync(join(tmpdir(), "hayven-conv-"));
    cleanups.push(dir);
    const paths = hayvenPathsFor(dir);
    const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile, skipHydrate: true });
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
    return { app, crdt, dir };
  }

  /** One-directional sync pass: pull `to`'s divergent days into `from`. */
  async function pullInto(from: Replica, to: Replica): Promise<void> {
    const fromSnap = computeMerkle(from.crdt.oplog);
    const toRoots = (await (await to.app.handle(new Request("http://localhost/api/sync/merkle"))).json()) as Record<"lww" | "gset" | "orset", string>;
    const toLeaves: Record<"lww" | "gset" | "orset", { path: string; hash: string }[]> = { lww: [], gset: [], orset: [] };
    for (const type of ["lww", "gset", "orset"] as const) {
      if (fromSnap.roots[type] === toRoots[type]) {
        toLeaves[type] = [...fromSnap.leaves[type]];
        continue;
      }
      const res = (await (await to.app.handle(new Request("http://localhost/api/sync/leaves", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }),
      }))).json()) as { leaves: { path: string; hash: string }[] };
      toLeaves[type] = res.leaves;
    }
    const diff = diffSnapshots(fromSnap, { roots: { ...toRoots }, leaves: toLeaves });
    for (const t of diff.pull) {
      const r = await to.app.handle(new Request("http://localhost/api/sync/batch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: t.type, path: t.path, offset: 0 }),
      }));
      const bytes = new Uint8Array(await r.arrayBuffer());
      for (const batch of splitSegmentBatches(bytes)) {
        await from.app.handle(new Request("http://localhost/api/sync/push", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: t.type, path: t.path, batch: Buffer.from(batch).toString("base64") }),
        }));
      }
    }
  }

  async function syncBoth(a: Replica, b: Replica): Promise<void> {
    await pullInto(a, b);
    await pullInto(b, a);
  }

  test("two replicas with ops on DIFFERENT days converge to identical roots", async () => {
    const a = makeReplica();
    const b = makeReplica();

    // A observes on day 1 + day 2; B observes on day 2 + day 3. Distinct
    // writers, overlapping middle day.
    a.crdt.observe(gsetOp("auth/login", "auth/check", H(DAY1), a.crdt.writer));
    a.crdt.observe(gsetOp("auth/login", "auth/log", H(DAY2), a.crdt.writer));
    b.crdt.observe(gsetOp("api/handler", "api/db", H(DAY2 + 1), b.crdt.writer));
    b.crdt.observe(gsetOp("api/handler", "api/cache", H(DAY3), b.crdt.writer));

    expect(a.crdt.gset.size).toBe(2);
    expect(b.crdt.gset.size).toBe(2);

    await syncBoth(a, b);

    // Both now hold all 4 distinct observations.
    expect(a.crdt.gset.size).toBe(4);
    expect(b.crdt.gset.size).toBe(4);

    // And the Merkle roots match across every type.
    const ra = computeMerkle(a.crdt.oplog).roots;
    const rb = computeMerkle(b.crdt.oplog).roots;
    expect(ra.gset).toBe(rb.gset);
    expect(ra).toEqual(rb);
  });

  test("a second sync after convergence is a no-op (roots already equal)", async () => {
    const a = makeReplica();
    const b = makeReplica();
    a.crdt.observe(gsetOp("x", "y", H(DAY1), a.crdt.writer));
    b.crdt.observe(gsetOp("p", "q", H(DAY3), b.crdt.writer));
    await syncBoth(a, b);
    const beforeA = computeMerkle(a.crdt.oplog).roots.gset;

    await syncBoth(a, b); // second pass
    const afterA = computeMerkle(a.crdt.oplog).roots.gset;
    expect(afterA).toBe(beforeA);
    expect(a.crdt.gset.size).toBe(2);
    expect(b.crdt.gset.size).toBe(2);
  });

  test("claims (OR-Set) converge across peers too", async () => {
    const a = makeReplica();
    const b = makeReplica();
    a.crdt.applyOr({
      kind: "add", claimId: "c-a", agent: "agent-a",
      payload: { intent: "x", scope: ["mod/a"], fingerprint: "fa", createdMs: DAY1, ttlMs: DAY1 + 600_000 },
      hlc: H(DAY1), writer: a.crdt.writer,
    });
    b.crdt.applyOr({
      kind: "add", claimId: "c-b", agent: "agent-b",
      payload: { intent: "y", scope: ["mod/b"], fingerprint: "fb", createdMs: DAY3, ttlMs: DAY3 + 600_000 },
      hlc: H(DAY3), writer: b.crdt.writer,
    });
    await syncBoth(a, b);
    const aClaims = a.crdt.orset.active().map((o) => o.claimId).sort();
    const bClaims = b.crdt.orset.active().map((o) => o.claimId).sort();
    expect(aClaims).toEqual(["c-a", "c-b"]);
    expect(bClaims).toEqual(["c-a", "c-b"]);
    expect(computeMerkle(a.crdt.oplog).roots.orset).toBe(computeMerkle(b.crdt.oplog).roots.orset);
  });
});
