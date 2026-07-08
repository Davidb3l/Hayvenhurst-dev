// Multi-project routing for the live-sync WebSocket (`/ws/sync`) on a SHARED
// daemon (ARCHITECTURE.md §15.3 + the multi-project facade in server.ts).
//
// The HTTP surface selects a project per request via AsyncLocalStorage in
// `onRequest`, but that context does NOT reach Bun's ws open/message
// callbacks — so without connection-time pinning, a peer that connected with
// a perfectly valid `?project=<alias>` would stream its CRDT ops into the
// PRIMARY project's op-log. These tests pin:
//   1. `?project=<non-primary>` → hello identifies THAT project, and inbound
//      ops land in THAT project's op-log (and nowhere else),
//   2. un-addressed connections keep the legacy primary routing,
//   3. an unknown selector is refused — the socket never reaches op exchange.
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
import { gsetToWire, openWireBridge } from "../src/crdt/wire.ts";
import { writerIdToHex, type Hlc } from "../src/crdt/hlc.ts";
import { Db } from "../src/db/queries.ts";
import { buildMultiProjectApp, type ServerDependencies } from "../src/daemon/server.ts";
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
const H = (wallMs: number, counter = 0): Hlc => ({ wallMs, counter });
const T_GSET = 0x20; // §15.3 binary-frame type byte — must match ws.ts.

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

interface Project {
  deps: ServerDependencies;
  crdt: CrdtState;
}

maybeDescribe("multi-project /ws/sync routing", () => {
  const cleanups: string[] = [];
  const listening: Array<ReturnType<typeof buildMultiProjectApp>> = [];

  afterEach(() => {
    for (const app of listening) {
      try { app.stop(); } catch { /* already stopped */ }
    }
    listening.length = 0;
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
    cleanups.length = 0;
  });

  function makeProject(): Project {
    const dir = mkdtempSync(join(tmpdir(), "hayven-wsmp-"));
    cleanups.push(dir);
    const paths = hayvenPathsFor(dir);
    const crdt = new CrdtState({
      crdtRoot: paths.crdtDir,
      configFile: paths.configFile,
      skipHydrate: true,
    });
    const db = new Db(":memory:");
    db.migrate();
    return {
      crdt,
      deps: {
        db,
        config: DEFAULT_CONFIG,
        paths,
        logger: createLogger({ toFile: false, toStderr: false }),
        crdt,
        daemonVersion: "test",
        ingest: { current: () => null, start: async () => { throw new Error("not used"); } },
      },
    };
  }

  function makeShared(): {
    port: number;
    alpha: Project;
    beta: Project;
    /** Simulate a live hot-remove of beta: drop it from the routing map and
     *  fire the project-set-changed signal, exactly the order the daemon's
     *  removeProjectLive uses (map first, notify after). */
    removeBeta: () => void;
    /** Simulate a remove + immediate re-add of "beta" as ONE change event: the
     *  alias still resolves afterwards, but to a FRESH runtime. Old pins must
     *  still be evicted (identity semantics, not existence). Returns the new
     *  project so a test can prove fresh connections pin it. */
    swapBeta: () => Project;
  } {
    const alpha = makeProject();
    const beta = makeProject();
    const projects = new Map([
      ["alpha", alpha.deps],
      ["beta", beta.deps],
    ]);
    const listeners = new Set<() => void>();
    const app = buildMultiProjectApp({
      primary: "alpha",
      projects,
      logger: createLogger({ toFile: false, toStderr: false }),
      daemonVersion: "test",
      subscribeProjects: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    app.listen({ hostname: "localhost", port: 0 });
    listening.push(app);
    const notify = () => {
      for (const l of listeners) l();
    };
    const removeBeta = () => {
      projects.delete("beta");
      notify();
    };
    const swapBeta = (): Project => {
      const fresh = makeProject();
      projects.set("beta", fresh.deps);
      notify();
      return fresh;
    };
    return { port: app.server?.port as number, alpha, beta, removeBeta, swapBeta };
  }

  /** Open a ws client; resolves on OPEN, rejects on error-before-open. */
  function connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", (e) => reject(new Error(`ws error: ${String(e)}`)), { once: true });
    });
  }

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

  function asAck(data: ArrayBuffer | string) {
    if (typeof data !== "string") return undefined;
    const obj = JSON.parse(data);
    return obj.type === "ack" ? obj : undefined;
  }

  function frameFor(project: Project): Uint8Array {
    const wire = gsetToWire(gsetOp("api/handler", "api/db", H(DAY1), project.crdt.writer));
    const envelope = openWireBridge({ binaryPath: bin! }).encode([wire]);
    const frame = new Uint8Array(1 + envelope.length);
    frame[0] = T_GSET;
    frame.set(envelope, 1);
    return frame;
  }

  test("?project=<non-primary> pins the connection: hello + inbound ops hit THAT project", async () => {
    const { port, alpha, beta } = makeShared();

    const ws = await connect(`ws://localhost:${port}/ws/sync?project=beta`);
    const hello = await nextMessage(ws, asHello);

    // The hello must identify BETA (the selected project), not the primary.
    expect(hello.writer_id).toBe(writerIdToHex(beta.crdt.writer));

    // An inbound op must land in BETA's op-log — and ONLY beta's.
    const ackP = nextMessage(ws, asAck);
    ws.send(frameFor(beta));
    const ack = await ackP;
    ws.close();

    expect(ack.applied).toBe(1);
    expect(beta.crdt.gset.size).toBe(1);
    expect(alpha.crdt.gset.size).toBe(0); // the primary must be untouched
  });

  test("an un-addressed connection keeps the legacy primary routing", async () => {
    const { port, alpha, beta } = makeShared();

    const ws = await connect(`ws://localhost:${port}/ws/sync`);
    const hello = await nextMessage(ws, asHello);
    expect(hello.writer_id).toBe(writerIdToHex(alpha.crdt.writer));

    const ackP = nextMessage(ws, asAck);
    ws.send(frameFor(alpha));
    const ack = await ackP;
    ws.close();

    expect(ack.applied).toBe(1);
    expect(alpha.crdt.gset.size).toBe(1);
    expect(beta.crdt.gset.size).toBe(0);
  });

  test("hot-removing a project cleanly evicts its pinned sockets; others stay open", async () => {
    const { port, alpha, removeBeta } = makeShared();

    // One socket pinned to beta (will be evicted), one un-addressed on the
    // primary (must survive).
    const wsBeta = await connect(`ws://localhost:${port}/ws/sync?project=beta`);
    await nextMessage(wsBeta, asHello);
    const wsAlpha = await connect(`ws://localhost:${port}/ws/sync`);
    await nextMessage(wsAlpha, asHello);

    const evicted = new Promise<{ code: number; sawError: boolean }>((resolve, reject) => {
      let sawError = false;
      const timer = setTimeout(() => reject(new Error("beta socket was not evicted")), 4000);
      wsBeta.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        const obj = JSON.parse(ev.data);
        if (obj.type === "error" && String(obj.error).includes("removed")) sawError = true;
      });
      wsBeta.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve({ code: (ev as CloseEvent).code, sawError });
      });
    });

    removeBeta();
    const result = await evicted;
    // Clean close with the eviction code, after the explanatory error frame —
    // never a lingering socket fed per-frame errors.
    expect(result.code).toBe(4004);
    expect(result.sawError).toBe(true);

    // The primary-pinned socket is untouched: it still exchanges ops.
    const ackP = nextMessage(wsAlpha, asAck);
    wsAlpha.send(frameFor(alpha));
    const ack = await ackP;
    wsAlpha.close();
    expect(ack.applied).toBe(1);
    expect(alpha.crdt.gset.size).toBe(1);
  });

  test("re-adding the same alias with a fresh runtime evicts old pins (identity, not existence)", async () => {
    const { port, alpha, swapBeta } = makeShared();

    // Pin one socket to the ORIGINAL beta and one to the primary.
    const wsOldBeta = await connect(`ws://localhost:${port}/ws/sync?project=beta`);
    await nextMessage(wsOldBeta, asHello);
    const wsAlpha = await connect(`ws://localhost:${port}/ws/sync`);
    await nextMessage(wsAlpha, asHello);

    const evicted = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("old beta socket was not evicted on re-add")),
        4000,
      );
      wsOldBeta.addEventListener("close", (ev) => {
        clearTimeout(timer);
        resolve((ev as CloseEvent).code);
      });
    });

    // One change event: "beta" STILL RESOLVES afterwards, but to a fresh
    // runtime. An existence check would leave the old pin connected to a dead
    // runtime; the identity check must evict it.
    const freshBeta = swapBeta();
    expect(await evicted).toBe(4004);

    // A NEW connection to the same alias pins the fresh runtime…
    const wsNewBeta = await connect(`ws://localhost:${port}/ws/sync?project=beta`);
    const hello = await nextMessage(wsNewBeta, asHello);
    expect(hello.writer_id).toBe(writerIdToHex(freshBeta.crdt.writer));
    wsNewBeta.close();

    // …and the primary socket rode through the whole swap untouched.
    const ackP = nextMessage(wsAlpha, asAck);
    wsAlpha.send(frameFor(alpha));
    const ack = await ackP;
    wsAlpha.close();
    expect(ack.applied).toBe(1);
  });

  test("an unknown ?project= selector is refused before any op exchange", async () => {
    const { port, alpha, beta } = makeShared();

    // Either the upgrade itself is refused (error before open) or the server
    // closes immediately after open — in BOTH cases no hello arrives and no
    // op-log is touched.
    let sawHello = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/sync?project=gone`);
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already closed */ }
        resolve();
      }, 3000);
      ws.addEventListener("message", (ev) => {
        if (asHello(ev.data as ArrayBuffer | string) !== undefined) sawHello = true;
      });
      ws.addEventListener("close", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(timer); resolve(); });
    });

    expect(sawHello).toBe(false);
    expect(alpha.crdt.gset.size).toBe(0);
    expect(beta.crdt.gset.size).toBe(0);
  });
});
