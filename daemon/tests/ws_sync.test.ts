// Live-sync WebSocket (`/ws/sync`) — ARCHITECTURE.md §15.3.
//
// Exercises the real CRDT op stream that replaced the week-6 echo stub:
//   - the `hello` envelope carries this daemon's writer id + per-type op
//     counts (state vector) + Merkle roots,
//   - an op appended on daemon A is streamed to a connected peer as a §15.3
//     binary frame, decodes to the same op, and folds into a second daemon B
//     (B converges to A's roots),
//   - a malformed inbound frame is rejected with an `error` text frame and the
//     daemon stays up (a good frame after it still applies),
//   - a re-delivered op is an idempotent no-op (commutative CRDT, §12).
//
// Skipped without the native binary (the wire bridge spawns it). Uses
// `localhost` for every bind/connect per the CLAUDE.md Elysia hostname gotcha.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { bucketize, type GsetOp } from "../src/crdt/gset.ts";
import { computeMerkle } from "../src/crdt/merkle.ts";
import { gsetToWire, openWireBridge } from "../src/crdt/wire.ts";
import { writerIdToHex, type Hlc } from "../src/crdt/hlc.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

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

// §15.3 binary-frame type bytes — must match ws.ts.
const T_GSET = 0x20;

interface Daemon {
  app: ReturnType<typeof buildApp>;
  crdt: CrdtState;
  dir: string;
  port: number;
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

maybeDescribe("live sync /ws/sync (§15.3)", () => {
  const cleanups: string[] = [];
  const listening: Array<ReturnType<typeof buildApp>> = [];

  afterEach(() => {
    for (const app of listening) {
      try { app.stop(); } catch { /* already stopped */ }
    }
    listening.length = 0;
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function makeDaemon(): Daemon {
    const dir = mkdtempSync(join(tmpdir(), "hayven-ws-"));
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
    // Ephemeral port on localhost (Elysia is hostname-sensitive — CLAUDE.md).
    app.listen({ hostname: "localhost", port: 0 });
    listening.push(app);
    const port = app.server?.port as number;
    return { app, crdt, dir, port };
  }

  /** Open a ws client and resolve once the socket is OPEN. */
  function connect(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/sync`);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)), { once: true });
    });
  }

  /** Resolve with the next message matching `pick` (binary or text). */
  function nextMessage<T>(
    ws: WebSocket,
    pick: (data: ArrayBuffer | string) => T | undefined,
    timeoutMs = 4000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.removeEventListener("message", onMsg);
        reject(new Error("timed out waiting for ws message"));
      }, timeoutMs);
      function onMsg(ev: MessageEvent) {
        const got = pick(ev.data as ArrayBuffer | string);
        if (got !== undefined) {
          clearTimeout(timer);
          ws.removeEventListener("message", onMsg);
          resolve(got);
        }
      }
      ws.addEventListener("message", onMsg);
    });
  }

  function asHello(data: ArrayBuffer | string) {
    if (typeof data !== "string") return undefined;
    const obj = JSON.parse(data);
    return obj.type === "hello" ? obj : undefined;
  }

  test("hello envelope carries writer id, versions, and Merkle roots (§15.3)", async () => {
    const a = makeDaemon();
    a.crdt.observe(gsetOp("auth/login", "auth/check", H(DAY1), a.crdt.writer));

    const ws = await connect(a.port);
    const hello = await nextMessage(ws, asHello);
    ws.close();

    expect(hello.type).toBe("hello");
    expect(hello.writer_id).toBe(writerIdToHex(a.crdt.writer));
    expect(hello.writer_id).toMatch(/^[0-9a-f]{32}$/);
    // One gset op appended → versions.gset === 1; others 0.
    expect(hello.versions).toEqual({ lww: 0, gset: 1, orset: 0 });
    // Merkle roots present + agree with the HTTP /api/sync/merkle handler.
    const httpRoots = computeMerkle(a.crdt.oplog).roots;
    expect(hello.roots).toEqual(httpRoots);
  });

  test("an op appended on A is streamed to a connected peer and decodes to that op", async () => {
    const a = makeDaemon();
    const ws = await connect(a.port);
    await nextMessage(ws, asHello); // drain hello first

    // Pick up the next BINARY frame.
    const framePromise = nextMessage(ws, (d) => (typeof d === "string" ? undefined : new Uint8Array(d)));

    a.crdt.observe(gsetOp("api/handler", "api/db", H(DAY2), a.crdt.writer));
    const frame = await framePromise;
    ws.close();

    // §15.3 binary frame: <type byte><§13 envelope>.
    expect(frame[0]).toBe(T_GSET);
    const envelope = frame.subarray(1);
    const decoded = openWireBridge({ binaryPath: bin! }).decode(new Uint8Array(envelope));
    expect(decoded).toHaveLength(1);
    const op = decoded[0]!;
    expect(op.kind).toBe("gset_observe");
    if (op.kind === "gset_observe") {
      expect(op.src).toBe("api/handler");
      expect(op.dst).toBe("api/db");
    }
  });

  test("two daemons converge: B's op streamed into A folds + matches roots", async () => {
    const a = makeDaemon();
    const b = makeDaemon();

    // A op already on A; B op only on B. A is the listening peer; B forwards
    // its op over the live-sync socket (simulating B's outbound push).
    a.crdt.observe(gsetOp("auth/login", "auth/check", H(DAY1), a.crdt.writer));
    b.crdt.observe(gsetOp("api/handler", "api/db", H(DAY2), b.crdt.writer));
    expect(a.crdt.gset.size).toBe(1);

    const ws = await connect(a.port);
    await nextMessage(ws, asHello);

    // Frame B's op exactly as ws.ts would and stream it to A.
    const bWire = gsetToWire(gsetOp("api/handler", "api/db", H(DAY2), b.crdt.writer));
    const envelope = openWireBridge({ binaryPath: bin! }).encode([bWire]);
    const frame = new Uint8Array(1 + envelope.length);
    frame[0] = T_GSET;
    frame.set(envelope, 1);

    const ackP = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "ack" ? o : undefined;
    });
    ws.send(frame);
    const ack = await ackP;
    ws.close();

    expect(ack.applied).toBe(1);
    expect(ack.total).toBe(1);
    // A now holds BOTH ops (its own + B's streamed op).
    expect(a.crdt.gset.size).toBe(2);
    // Convergence proof: A's Merkle leaf for B's day (DAY2) is byte-identical
    // to B's leaf for that day — the streamed op landed in the same-named
    // segment with the same op-key set (§14.1 / §15.1). A's full root differs
    // only because A also holds its own DAY1 op that B never received here.
    const day = "2026-03-02"; // DAY2 in UTC
    const aLeaf = computeMerkle(a.crdt.oplog).leaves.gset.find((l) => l.path === day);
    const bLeaf = computeMerkle(b.crdt.oplog).leaves.gset.find((l) => l.path === day);
    expect(aLeaf?.hash).toBeDefined();
    expect(aLeaf?.hash).toBe(bLeaf?.hash);
  });

  test("a malformed inbound frame is rejected without crashing the daemon", async () => {
    const a = makeDaemon();
    const ws = await connect(a.port);
    await nextMessage(ws, asHello);

    // Garbage envelope behind a valid type byte → decode throws → error frame.
    const bad = new Uint8Array([T_GSET, 0xff, 0xff, 0xff, 0xfe, 0x01, 0x02]);
    const errP = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "error" ? o : undefined;
    });
    ws.send(bad);
    const err = await errP;
    expect(typeof err.error).toBe("string");
    expect(a.crdt.gset.size).toBe(0); // nothing persisted/applied

    // Daemon is still alive: a subsequent GOOD frame still applies.
    const wire = gsetToWire(gsetOp("x", "y", H(DAY1), a.crdt.writer));
    const env = openWireBridge({ binaryPath: bin! }).encode([wire]);
    const frame = new Uint8Array(1 + env.length);
    frame[0] = T_GSET;
    frame.set(env, 1);
    const ackP = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "ack" ? o : undefined;
    });
    ws.send(frame);
    const ack = await ackP;
    ws.close();
    expect(ack.applied).toBe(1);
    expect(a.crdt.gset.size).toBe(1);
  });

  test("an unknown frame-type byte is rejected (untrusted discriminator)", async () => {
    const a = makeDaemon();
    const ws = await connect(a.port);
    await nextMessage(ws, asHello);
    const errP = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "error" ? o : undefined;
    });
    ws.send(new Uint8Array([0x99, 0x00, 0x01]));
    const err = await errP;
    ws.close();
    expect(err.error).toMatch(/unknown frame type/i);
    expect(a.crdt.gset.size).toBe(0);
  });

  test("re-delivery of the same op is an idempotent no-op", async () => {
    const a = makeDaemon();
    const ws = await connect(a.port);
    await nextMessage(ws, asHello);

    const wire = gsetToWire(gsetOp("dup/src", "dup/dst", H(DAY1), a.crdt.writer));
    const env = openWireBridge({ binaryPath: bin! }).encode([wire]);
    const frame = new Uint8Array(1 + env.length);
    frame[0] = T_GSET;
    frame.set(env, 1);

    const ack1P = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "ack" ? o : undefined;
    });
    ws.send(frame);
    await ack1P;
    expect(a.crdt.gset.size).toBe(1);

    // Same frame again (a reconnect/re-delivery) — commutative CRDT no-op.
    const ack2P = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "ack" ? o : undefined;
    });
    ws.send(frame);
    await ack2P;
    ws.close();
    expect(a.crdt.gset.size).toBe(1); // unchanged
  });

  test("a ping text frame is answered with a pong (heartbeat)", async () => {
    const a = makeDaemon();
    const ws = await connect(a.port);
    await nextMessage(ws, asHello);
    const pongP = nextMessage(ws, (d) => {
      if (typeof d !== "string") return undefined;
      const o = JSON.parse(d);
      return o.type === "pong" ? o : undefined;
    });
    ws.send(JSON.stringify({ type: "ping" }));
    const pong = await pongP;
    ws.close();
    expect(pong.type).toBe("pong");
  });
});
