// BL-12: CRDT-aware node-body write path.
//
// Two suites:
//   1. The `PUT /api/nodes/:id/body` route mints an LwwOp, persists it to the
//      op log, updates the markdown source-of-truth, and refreshes the SQL
//      `summary` read cache.
//   2. Two peers edit the same node body, sync over the §15 Merkle protocol,
//      and converge to the HIGHER-HLC body (the §12.1 LWW winner).
//
// Skipped when the native binary isn't built — recordLww encodes through the
// wire bridge (hayven-native), same as the claims/trace CRDT paths.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { computeMerkle, diffSnapshots } from "../src/crdt/merkle.ts";
import { splitSegmentBatches } from "../src/crdt/oplog.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { nodeFilePath } from "../src/graph/nodeWriter.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";
import type { GraphNode } from "../src/graph/types.ts";
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
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });

function seedNode(db: Db, id: string): void {
  const node: GraphNode = {
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id.split("/").pop() ?? id,
    kind: "function",
    language: "typescript",
    file: "src/auth/login.ts",
    range: [1, 10],
    ast_hash: "seed",
    last_seen: Date.now(),
    logical_clock: 0,
  };
  db.upsertNode(node);
}

maybeDescribe("PUT /api/nodes/:id/body (LWW write-through)", () => {
  const cleanups: string[] = [];
  const closables: CrdtState[] = [];
  afterEach(() => {
    for (const s of closables) s.close();
    closables.length = 0;
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function makeApp() {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-nodes-crdt-"));
    cleanups.push(repoRoot);
    const paths = hayvenPathsFor(repoRoot);
    const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile, skipHydrate: true });
    closables.push(crdt);
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
    return { app, db, crdt, paths };
  }

  async function putBody(app: ReturnType<typeof makeApp>["app"], id: string, body: unknown): Promise<Response> {
    return app.handle(
      new Request(`http://localhost/api/nodes/${encodeURIComponent(id)}/body`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }),
    );
  }

  test("mints an LwwOp, writes markdown, and updates the SQL summary cache", async () => {
    const { app, db, crdt, paths } = makeApp();
    const id = "auth/login/loginHandler";
    seedNode(db, id);

    const res = await putBody(app, id, "Handles the login flow and rate limiting.");
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; id: string; body: string; path: string };
    expect(out.ok).toBe(true);
    expect(out.body).toBe("Handles the login flow and rate limiting.");

    // (1) An LwwOp landed in the in-memory registry...
    expect(crdt.lww.get(id)?.value).toBe("Handles the login flow and rate limiting.");
    // ...and on disk in the lww op-log segment (drives Merkle sync).
    expect(crdt.oplog.listSegmentDays("lww").length).toBeGreaterThan(0);

    // (2) Markdown source-of-truth on disk reflects the new body.
    const md = readFileSync(nodeFilePath(paths.nodesDir, id), "utf8");
    expect(md).toContain("Handles the login flow and rate limiting.");

    // (3) SQL read cache `summary` is updated.
    expect(db.getNode(id)?.summary).toBe("Handles the login flow and rate limiting.");
  });

  test("a second edit overwrites the body (local clock is monotonic)", async () => {
    const { app, db, crdt } = makeApp();
    const id = "auth/login/loginHandler";
    seedNode(db, id);
    await putBody(app, id, "first");
    await putBody(app, id, "second");
    expect(crdt.lww.get(id)?.value).toBe("second");
    expect(db.getNode(id)?.summary).toBe("second");
  });

  test("404 for an unknown node id; 400 for a non-string body", async () => {
    const { app, db } = makeApp();
    const id = "auth/login/loginHandler";
    seedNode(db, id);
    expect((await putBody(app, "does/not/exist", "x")).status).toBe(404);
    expect((await putBody(app, id, 42)).status).toBe(400);
  });
});

maybeDescribe("node-body convergence across two peers", () => {
  const cleanups: string[] = [];
  const closables: CrdtState[] = [];
  afterEach(() => {
    for (const s of closables) s.close();
    closables.length = 0;
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  interface Replica {
    app: ReturnType<typeof buildApp>;
    crdt: CrdtState;
  }

  function makeReplica(): Replica {
    const dir = mkdtempSync(join(tmpdir(), "hayven-nodes-conv-"));
    cleanups.push(dir);
    const paths = hayvenPathsFor(dir);
    const crdt = new CrdtState({ crdtRoot: paths.crdtDir, configFile: paths.configFile, skipHydrate: true });
    closables.push(crdt);
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
    return { app, crdt };
  }

  /** One-directional sync pass: pull `to`'s divergent lww days into `from`. */
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

  test("two peers edit the same node body; both converge to the higher-HLC body", async () => {
    const a = makeReplica();
    const b = makeReplica();
    const id = "auth/login/loginHandler";

    // A writes an OLDER body (DAY1); B writes a NEWER body (DAY2). The §12.1
    // LWW winner is B's body (higher composite key). Use explicit HLCs so the
    // winner is deterministic, mirroring sync_convergence.test.ts.
    a.crdt.recordLww({ entityId: id, value: "A's older body", hlc: H(DAY1) });
    b.crdt.recordLww({ entityId: id, value: "B's newer body", hlc: H(DAY2) });

    expect(a.crdt.lww.get(id)?.value).toBe("A's older body");
    expect(b.crdt.lww.get(id)?.value).toBe("B's newer body");

    await syncBoth(a, b);

    // Both converge to the higher-HLC (DAY2) body.
    expect(a.crdt.lww.get(id)?.value).toBe("B's newer body");
    expect(b.crdt.lww.get(id)?.value).toBe("B's newer body");

    // And the lww Merkle roots match.
    expect(computeMerkle(a.crdt.oplog).roots.lww).toBe(computeMerkle(b.crdt.oplog).roots.lww);
  });

  test("convergence is independent of which peer wrote later in wall-clock order", async () => {
    // B writes its OLDER body AFTER A writes its NEWER one — the HLC, not the
    // order of the sync, decides the winner.
    const a = makeReplica();
    const b = makeReplica();
    const id = "auth/login/loginHandler";
    a.crdt.recordLww({ entityId: id, value: "newer-from-A", hlc: H(DAY2) });
    b.crdt.recordLww({ entityId: id, value: "older-from-B", hlc: H(DAY1) });

    await syncBoth(a, b);

    expect(a.crdt.lww.get(id)?.value).toBe("newer-from-A");
    expect(b.crdt.lww.get(id)?.value).toBe("newer-from-A");
    expect(computeMerkle(a.crdt.oplog).roots.lww).toBe(computeMerkle(b.crdt.oplog).roots.lww);
  });
});
