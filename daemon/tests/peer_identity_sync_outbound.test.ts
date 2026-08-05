/**
 * RFC-001 §4 Stage 1 — the OUTBOUND half, end to end through the real CLI.
 *
 * `hayven sync <peer_url>` must record the peer it reached. This is the half a
 * unit test cannot honestly stand in for: the handshake is read out of a live
 * `GET /api/sync/merkle` response, and the record lands under the INITIATOR's
 * `.hayven/peers/`, not the peer's.
 *
 * Both op-logs are empty, so the roots match and `runSyncWith` returns on the
 * first round-trip. That is deliberate: it needs no native binary, and it pins
 * the semantics that matter. The peer's identity comes from the HANDSHAKE, but
 * it is recorded only when the sync COMPLETES successfully, mirroring the
 * server side, which records only after an exchange lands. Roots already
 * matching IS a successful sync (state verified identical), so an
 * already-up-to-date run (the overwhelmingly common case) still learns who it
 * talked to. Recording only on segment transfer would leave a healthy fleet
 * permanently invisible to `hayven crdt peers`; recording before the outcome
 * is known would advance `last_synced` for syncs that then failed.
 *
 * Also pinned: the initiator must NOT record its own local daemon. `hayven
 * sync` pushes pulled segments into that daemon over the same `/api/sync/push`
 * route it uses for the remote, so a missing self-check would enrol the daemon
 * as its own peer on the first sync.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { bucketize, type GsetOp } from "../src/crdt/gset.ts";
import { writerIdToHex, type Hlc } from "../src/crdt/hlc.ts";
import { readKnownPeers, SYNC_PROTOCOL_VERSION } from "../src/crdt/peers.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

interface Node {
  root: string;
  writerId: string;
  crdt: CrdtState;
  server: ReturnType<typeof Bun.serve>;
  url: string;
  peersDir: string;
}

/** The native binary is required to ENCODE ops (the segment-transfer test). */
function findNativeBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env !== undefined && env.length > 0 && existsSync(env)) return env;
  for (const c of [
    join(import.meta.dir, "../../native/target/release/hayven-native"),
    join(import.meta.dir, "../../native/target/debug/hayven-native"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A project directory plus a real HTTP daemon serving it on an ephemeral port. */
function startNode(prefix: string): Node {
  // realpath so the daemon's reported `root` and the CLI's `canonicalRoot`
  // agree; macOS's /var/folders tmpdir is a symlink and they would not.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".hayven"), { recursive: true });

  const paths = hayvenPathsFor(root);
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
  const server = Bun.serve({ port: 0, fetch: (req) => app.handle(req) });
  cleanups.push(() => void server.stop(true));

  return {
    root,
    writerId: writerIdToHex(crdt.writer),
    crdt,
    server,
    url: `http://127.0.0.1:${server.port}`,
    peersDir: paths.peersDir,
  };
}

/** Point a project's config at its own daemon's ephemeral port. */
function pinConfigToDaemon(node: Node): void {
  const cfgPath = join(node.root, ".hayven", "config.json");
  // Merge, never overwrite: `loadOrCreateWriterId` already wrote `writer_id`
  // here, and clobbering it would change the daemon's identity mid-test.
  const existing = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    cfgPath,
    JSON.stringify(
      { ...existing, daemon_host: "127.0.0.1", daemon_port: node.server.port },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function runSyncCli(
  cwd: string,
  peerUrl: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cliPath = join(import.meta.dir, "../src/cli.ts");
  const proc = Bun.spawn(["bun", cliPath, "sync", peerUrl], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("hayven sync — outbound peer recording", () => {
  test("records the peer it reached, keyed by the peer's writer_id", async () => {
    const local = startNode("hayven-sync-local-");
    const peer = startNode("hayven-sync-peer-");
    pinConfigToDaemon(local);

    const res = await runSyncCli(local.root, peer.url);
    expect(res.stderr).not.toContain("error:");
    expect(res.code).toBe(0);
    // Both logs are empty, so this is the already-up-to-date path...
    expect(res.stdout).toContain("Already up to date");

    // ...and it STILL learned who it talked to.
    const known = readKnownPeers(local.peersDir);
    expect(known).toHaveLength(1);
    expect(known[0]?.writer_id).toBe(peer.writerId);
    expect(known[0]?.last_url).toBe(peer.url);
    expect(known[0]?.protocol).toBe(SYNC_PROTOCOL_VERSION);
  }, 60_000);

  test("does not enrol its OWN local daemon as a peer", async () => {
    const local = startNode("hayven-sync-self-local-");
    const peer = startNode("hayven-sync-self-peer-");
    pinConfigToDaemon(local);

    await runSyncCli(local.root, peer.url);
    const known = readKnownPeers(local.peersDir);
    expect(known.map((p) => p.writer_id)).not.toContain(local.writerId);
  }, 60_000);

  test("a repeat sync updates the same record instead of creating a second one", async () => {
    const local = startNode("hayven-sync-repeat-local-");
    const peer = startNode("hayven-sync-repeat-peer-");
    pinConfigToDaemon(local);

    await runSyncCli(local.root, peer.url);
    const first = readKnownPeers(local.peersDir)[0];
    expect(first).toBeDefined();

    await runSyncCli(local.root, peer.url);
    const after = readKnownPeers(local.peersDir);
    // Keyed by writer_id, not by call: one peer, one record.
    expect(after).toHaveLength(1);
    expect(after[0]?.first_seen).toBe(first!.first_seen);
    expect(Date.parse(after[0]!.last_synced)).toBeGreaterThanOrEqual(
      Date.parse(first!.last_synced),
    );
  }, 60_000);

  test("`hayven crdt peers` then answers 'who am I synced with?'", async () => {
    const local = startNode("hayven-sync-cli-local-");
    const peer = startNode("hayven-sync-cli-peer-");
    pinConfigToDaemon(local);
    await runSyncCli(local.root, peer.url);

    const cliPath = join(import.meta.dir, "../src/cli.ts");
    const proc = Bun.spawn(["bun", cliPath, "crdt", "peers", "--json"], {
      cwd: local.root,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const parsed = JSON.parse(out) as { count: number; peers: Array<{ writer_id: string }> };
    expect(parsed.count).toBe(1);
    expect(parsed.peers[0]?.writer_id).toBe(peer.writerId);
  }, 60_000);
});

/**
 * THE INBOUND HALF, end to end — the piece that did not exist before this
 * stage. A real segment transfer between two real daemons, driven by the real
 * CLI, with the assertion made on the SERVING side: after being pushed to, the
 * peer must be able to name who pushed.
 *
 * Needs the native binary, because appending an op ENCODES it.
 */
const nativeBin = findNativeBinary();
const maybeDescribe = nativeBin === null ? describe.skip : describe;

maybeDescribe("hayven sync — inbound peer recording (real segment transfer)", () => {
  /** An op stamped NOW, so its segment day is inside the acceptance window. */
  function gsetOp(src: string, dst: string, writer: Uint8Array): GsetOp {
    const hlc: Hlc = { wallMs: Date.now(), counter: 0 };
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

  test("the peer we push to records US, keyed by our writer_id", async () => {
    const local = startNode("hayven-inbound-local-");
    const peer = startNode("hayven-inbound-peer-");
    pinConfigToDaemon(local);

    // Only the initiator has ops, so the diff is pure PUSH: the CLI sends our
    // segments to the peer's /api/sync/push.
    local.crdt.observe(gsetOp("auth/login", "auth/check", local.crdt.writer));
    local.crdt.observe(gsetOp("auth/login", "auth/log", local.crdt.writer));

    const res = await runSyncCli(local.root, peer.url);
    expect(res.stderr).not.toContain("error:");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Pushed: 1 segments");

    // Before this stage the serving daemon stayed anonymous about every peer
    // that only ever called IT. It no longer does.
    const knownByPeer = readKnownPeers(peer.peersDir);
    expect(knownByPeer).toHaveLength(1);
    expect(knownByPeer[0]?.writer_id).toBe(local.writerId);
    expect(knownByPeer[0]?.protocol).toBe(SYNC_PROTOCOL_VERSION);

    // And the initiator recorded the peer from the handshake — BOTH directions
    // populated from one `hayven sync`.
    expect(readKnownPeers(local.peersDir).map((p) => p.writer_id)).toEqual([peer.writerId]);
  }, 90_000);

  test("the peer we PULL from records us too", async () => {
    const local = startNode("hayven-inbound-pull-local-");
    const peer = startNode("hayven-inbound-pull-peer-");
    pinConfigToDaemon(local);

    // Only the PEER has ops, so the diff is pure PULL: the CLI reads segments
    // off the peer's /api/sync/batch and pushes them into its own daemon.
    peer.crdt.observe(gsetOp("api/handler", "api/db", peer.crdt.writer));

    const res = await runSyncCli(local.root, peer.url);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Pulled: 1 segments");

    expect(readKnownPeers(peer.peersDir).map((p) => p.writer_id)).toEqual([local.writerId]);
    // Critically, the LOCAL daemon — which the CLI pushed the pulled segments
    // into over the very same route — did NOT record itself.
    const localKnown = readKnownPeers(local.peersDir).map((p) => p.writer_id);
    expect(localKnown).toEqual([peer.writerId]);
    expect(localKnown).not.toContain(local.writerId);
  }, 90_000);
});
