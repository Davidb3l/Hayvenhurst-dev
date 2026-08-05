/**
 * RFC-001 §4 Stage 1 — the sync HTTP surface's half of peer identity.
 *
 * Two things are pinned here.
 *
 * 1. THE ADDITIVE HANDSHAKE. `GET /api/sync/merkle` gains a `peer` block
 *    carrying the daemon's EXISTING `writer_id` (never a second identity — two
 *    notions of "who am I" is the duplicate-decision-function shape that has
 *    already caused bugs here). The three root fields must keep their exact
 *    top-level names and values, or every older peer that reads `body.lww`
 *    breaks.
 *
 * 2. THE INBOUND HALF, which did not exist. `hayven sync` is outbound-only, so
 *    a responding daemon served segments to anyone and stayed permanently
 *    anonymous — it could not answer "who am I synced with?" for any peer that
 *    had only ever called IT. `/api/sync/push` and `/api/sync/batch` now learn
 *    the caller from a request field and record it.
 *
 * No native binary needed: segments are planted with `appendRawBatchToDate`
 * (which never decodes) and the push cases assert the NON-recording paths,
 * which are all reached before any decode.
 *
 * NB: `app.handle` is hostname-sensitive — always `http://localhost/...`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { writerIdToHex } from "../src/crdt/hlc.ts";
import { readKnownPeers, SYNC_PROTOCOL_VERSION } from "../src/crdt/peers.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

const PEER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), "hayven-peerid-"));
  dirs.push(dir);
  const paths = hayvenPathsFor(dir);
  const crdt = new CrdtState({
    crdtRoot: paths.crdtDir,
    configFile: paths.configFile,
    skipHydrate: true,
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
    ingest: {
      current: () => null,
      start: async () => {
        throw new Error("not used");
      },
    },
  });
  return { app, crdt, paths };
}

/** Today's UTC segment day — inside `assertAcceptableSegmentDay`'s window. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("GET /api/sync/merkle — additive peer block", () => {
  test("advertises the daemon's EXISTING writer_id, not a fresh identity", async () => {
    const { app, crdt } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/sync/merkle"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const peer = body["peer"] as { writer_id: string; protocol: number };
    // THE point of reuse: the handshake ID is the CRDT attribution ID.
    expect(peer.writer_id).toBe(writerIdToHex(crdt.writer));
    expect(peer.protocol).toBe(SYNC_PROTOCOL_VERSION);
  });

  test("the existing root fields are byte-for-byte unchanged (older peers keep working)", async () => {
    const { app, crdt } = makeApp();
    const res = await app.handle(new Request("http://localhost/api/sync/merkle"));
    const body = (await res.json()) as Record<string, unknown>;
    // Compute the same roots the old handler returned and compare each key.
    const { computeRoots } = await import("../src/crdt/merkle.ts");
    const roots = computeRoots(crdt.oplog);
    for (const t of ["lww", "gset", "orset"] as const) {
      expect(body[t]).toBe(roots[t]);
    }
    // `peer` is the ONLY new top-level key.
    expect(Object.keys(body).sort()).toEqual(["gset", "lww", "orset", "peer"]);
  });

  test("reading the handshake does not enrol anyone — merkle is a read", async () => {
    const { app, paths } = makeApp();
    await app.handle(new Request("http://localhost/api/sync/merkle"));
    expect(readKnownPeers(paths.peersDir)).toEqual([]);
  });
});

describe("POST /api/sync/batch — inbound peer recording", () => {
  async function pull(
    app: ReturnType<typeof makeApp>["app"],
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.handle(
      new Request("http://localhost/api/sync/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("records the caller when a segment is actually served", async () => {
    const { app, crdt, paths } = makeApp();
    const day = today();
    crdt.oplog.appendRawBatchToDate("gset", day, new Uint8Array([1, 2, 3, 4]));

    const res = await pull(app, {
      type: "gset",
      path: day,
      peer_writer_id: PEER_A,
      peer_protocol: SYNC_PROTOCOL_VERSION,
    });
    expect(res.status).toBe(200);

    const peers = readKnownPeers(paths.peersDir);
    expect(peers).toHaveLength(1);
    expect(peers[0]?.writer_id).toBe(PEER_A);
    expect(peers[0]?.protocol).toBe(SYNC_PROTOCOL_VERSION);
    // Inbound: we have no dial-back address for the caller.
    expect(peers[0]?.last_url).toBeNull();
  });

  test("an OLDER caller that sends no peer_writer_id is served exactly as before", async () => {
    const { app, crdt, paths } = makeApp();
    const day = today();
    crdt.oplog.appendRawBatchToDate("gset", day, new Uint8Array([1, 2, 3, 4]));

    const res = await pull(app, { type: "gset", path: day });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer()).length).toBeGreaterThan(0);
    expect(readKnownPeers(paths.peersDir)).toEqual([]);
  });

  test("a malformed peer_writer_id is ignored, NOT an error — identity never breaks sync", async () => {
    const { app, crdt, paths } = makeApp();
    const day = today();
    crdt.oplog.appendRawBatchToDate("gset", day, new Uint8Array([1, 2, 3, 4]));

    for (const bad of ["../../etc/passwd", "", 42, null, PEER_A.toUpperCase()]) {
      const res = await pull(app, { type: "gset", path: day, peer_writer_id: bad });
      expect(res.status).toBe(200);
    }
    expect(readKnownPeers(paths.peersDir)).toEqual([]);
  });

  test("a rejected or empty-handed request enrols nobody", async () => {
    const { app, paths } = makeApp();
    // 400: bad type.
    expect((await pull(app, { type: "nope", peer_writer_id: PEER_A })).status).toBe(400);
    // 400: impossible calendar date.
    expect((await pull(app, { type: "gset", path: "9999-99-99", peer_writer_id: PEER_A })).status).toBe(400);
    // 404: valid request, segment we do not have. An attempt, not an exchange —
    // otherwise a scanner populates the registry without syncing a byte.
    expect((await pull(app, { type: "gset", path: today(), peer_writer_id: PEER_A })).status).toBe(404);
    expect(readKnownPeers(paths.peersDir)).toEqual([]);
  });
});

describe("POST /api/sync/push — inbound peer recording", () => {
  async function push(
    app: ReturnType<typeof makeApp>["app"],
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.handle(
      new Request("http://localhost/api/sync/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("a REFUSED push enrols nobody", async () => {
    const { app, paths } = makeApp();
    // 400: far-future segment day (F4's acceptance window).
    expect(
      (await push(app, { type: "gset", path: "9999-12-31", batch: "AAAA", peer_writer_id: PEER_A }))
        .status,
    ).toBe(400);
    // 400: no batch at all.
    expect((await push(app, { type: "gset", path: today(), peer_writer_id: PEER_A })).status).toBe(400);
    // 413: over the base64 cap.
    expect(
      (
        await push(app, {
          type: "gset",
          path: today(),
          batch: "A".repeat(20 * 1024 * 1024),
          peer_writer_id: PEER_A,
        })
      ).status,
    ).toBe(413);
    expect(readKnownPeers(paths.peersDir)).toEqual([]);
  });
});

describe("self is never a peer", () => {
  test("a caller presenting OUR OWN writer_id is not enrolled", async () => {
    const { app, crdt, paths } = makeApp();
    const day = today();
    crdt.oplog.appendRawBatchToDate("gset", day, new Uint8Array([1, 2, 3, 4]));
    // `hayven sync` pushes pulled segments into its OWN local daemon over these
    // same routes; a self-record would poison every later answer to
    // "who am I synced with?".
    const res = await app.handle(
      new Request("http://localhost/api/sync/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "gset",
          path: day,
          peer_writer_id: writerIdToHex(crdt.writer),
          peer_protocol: SYNC_PROTOCOL_VERSION,
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(readKnownPeers(paths.peersDir)).toEqual([]);
  });
});
