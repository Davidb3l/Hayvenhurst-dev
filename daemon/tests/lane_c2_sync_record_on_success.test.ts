/**
 * Outbound peer recording happens on SUCCESS, not on handshake.
 *
 * `hayven sync` used to call `recordPeer` the moment the merkle handshake
 * arrived, before the roots comparison and before any transfer, so
 * `last_synced` advanced even when the sync then blew up. The server side has
 * always recorded only after an exchange lands, so the two halves disagreed on
 * what "synced" means and the registry could report a peer as freshly synced
 * that has never completed a sync at all.
 *
 * The happy paths (up-to-date sync records; completed transfer records) are
 * already pinned end to end by peer_identity_sync_outbound.test.ts. What THIS
 * file pins is the failure half of the new contract: a peer that presents a
 * perfectly valid handshake and then fails the sync must NOT be recorded.
 *
 * The peer here is a hand-rolled HTTP server, not a real daemon, precisely so
 * it can hand over a well-formed handshake with divergent roots and then 500
 * the very next request.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { readKnownPeers } from "../src/crdt/peers.ts";
import { CrdtState } from "../src/crdt/state.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { createLogger } from "../src/util/log.ts";

const FAKE_PEER_ID = "feedfacefeedfacefeedfacefeedface";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A real local project + daemon, same shape as peer_identity_sync_outbound. */
function startLocalNode(): { root: string; peersDir: string } {
  // realpath so the daemon's reported `root` and the CLI's canonical root
  // agree; macOS's /var/folders tmpdir is a symlink and they would not.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hayven-recfail-local-")));
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

  // Point the project's config at its own daemon's ephemeral port, merging so
  // the writer_id `loadOrCreateWriterId` already wrote is preserved.
  const cfgPath = join(root, ".hayven", "config.json");
  const existing = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    cfgPath,
    JSON.stringify(
      { ...existing, daemon_host: "127.0.0.1", daemon_port: server.port },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { root, peersDir: paths.peersDir };
}

describe("hayven sync — no record for a peer whose sync FAILED", () => {
  test("valid handshake + divergent roots + 500 on leaves leaves no record", async () => {
    const local = startLocalNode();

    // The saboteur peer: healthy-looking handshake, then nothing works. Roots
    // are non-hashes that cannot match the local (empty) snapshot, forcing the
    // sync past the up-to-date early return and into the leaves request.
    const peer = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/sync/merkle") {
          return Response.json({
            lww: "divergent-a",
            gset: "divergent-b",
            orset: "divergent-c",
            peer: { writer_id: FAKE_PEER_ID, protocol: 1 },
          });
        }
        // /api/health and everything else, /api/sync/leaves included: the
        // health probe failure is tolerated by design, the leaves failure is
        // the mid-sync death this test exists to inject.
        return new Response("boom", { status: 500 });
      },
    });
    cleanups.push(() => void peer.stop(true));

    const cliPath = join(import.meta.dir, "../src/cli.ts");
    const proc = Bun.spawn(
      ["bun", cliPath, "sync", `http://127.0.0.1:${peer.port}`],
      { cwd: local.root, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    // The sync failed (the leaves 500 is not a survivable per-segment
    // refusal), so it must not have reported success...
    expect(code).not.toBe(0);
    expect(stdout).not.toContain("Already up to date");

    // ...and the handshake alone must not have enrolled the peer. Under the
    // old record-on-handshake timing this listing contained FAKE_PEER_ID with
    // a fresh last_synced, for a peer we have never successfully synced with.
    expect(readKnownPeers(local.peersDir).map((p) => p.writer_id)).not.toContain(
      FAKE_PEER_ID,
    );
    expect(readKnownPeers(local.peersDir)).toHaveLength(0);
  }, 60_000);
});
