/**
 * RFC-001 §4 Stage 1 — the durable peer registry (`crdt/peers.ts`).
 *
 * Before this there was no substrate at all: `hayven sync` was outbound-only,
 * the responding daemon never learned who called, and `config.sync_peers` was
 * read by nothing — so "who am I synced with?" was unanswerable.
 *
 * The pins that matter most here are the ones guarding failures this codebase
 * has ALREADY suffered:
 *
 *   - CONCURRENT WRITES LOSING RECORDS. The project registry lost 8-10 of 24
 *     concurrent registrations to an unlocked read → modify → write of one
 *     shared JSON file. `peers.ts` removes the read-modify-write instead of
 *     locking it (one file per peer, tmp + atomic rename), so the N-process
 *     test below is the direct regression guard for that class of bug.
 *   - SELF-ENROLMENT. `hayven sync` pushes pulled segments into its OWN local
 *     daemon over the same route it uses for a remote, so without a self-check
 *     the first sync would record the daemon as its own peer.
 *   - UNTRUSTED IDs BECOMING FILENAMES. `writer_id` arrives from an
 *     unauthenticated peer and is used as a path component.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isWriterIdHex,
  knownPeersDir,
  parsePeerHandshake,
  readKnownPeer,
  readKnownPeers,
  recordPeer,
  SYNC_PROTOCOL_VERSION,
} from "../src/crdt/peers.ts";

const SELF = "00000000000000000000000000000000";
const PEER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEER_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PEER_C = "cccccccccccccccccccccccccccccccc";

const dirs: string[] = [];
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "hayven-peers-"));
  dirs.push(d);
  return join(d, ".hayven", "peers");
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("peer registry — recording", () => {
  test("records a peer and reads it back", () => {
    const peersDir = sandbox();
    const rec = recordPeer(peersDir, {
      writerId: PEER_A,
      url: "http://teammate.local:7777",
      protocol: SYNC_PROTOCOL_VERSION,
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 7, 1, 12, 0, 0),
    });
    expect(rec).not.toBeNull();
    expect(rec?.writer_id).toBe(PEER_A);
    expect(rec?.last_url).toBe("http://teammate.local:7777");
    expect(rec?.protocol).toBe(SYNC_PROTOCOL_VERSION);
    expect(rec?.first_seen).toBe("2026-08-01T12:00:00.000Z");
    expect(rec?.last_synced).toBe("2026-08-01T12:00:00.000Z");

    const all = readKnownPeers(peersDir);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(rec!);
  });

  test("a second exchange advances last_synced but PRESERVES first_seen", () => {
    const peersDir = sandbox();
    recordPeer(peersDir, {
      writerId: PEER_A,
      url: "http://a.local:7777",
      protocol: 1,
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 0, 1),
    });
    const second = recordPeer(peersDir, {
      writerId: PEER_A,
      url: "http://a-moved.local:7777",
      protocol: 1,
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 5, 1),
    });
    // first_seen answers "how long has this peer been in the fleet?"; pinning
    // it to the latest sync would silently destroy that.
    expect(second?.first_seen).toBe("2026-01-01T00:00:00.000Z");
    expect(second?.last_synced).toBe("2026-06-01T00:00:00.000Z");
    // Keyed by writer_id, NOT url — a peer that changes host stays ONE peer.
    expect(second?.last_url).toBe("http://a-moved.local:7777");
    expect(readKnownPeers(peersDir)).toHaveLength(1);
  });

  test("an INBOUND exchange (no url, no protocol) does not erase what we knew", () => {
    const peersDir = sandbox();
    recordPeer(peersDir, {
      writerId: PEER_A,
      url: "http://a.local:7777",
      protocol: 4,
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 0, 1),
    });
    // Inbound: the peer called US. There is no dial-back URL and a push body
    // carries no handshake, so both fields are absent — and must not clobber.
    const inbound = recordPeer(peersDir, {
      writerId: PEER_A,
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 0, 2),
    });
    expect(inbound?.last_url).toBe("http://a.local:7777");
    expect(inbound?.protocol).toBe(4);
    expect(inbound?.last_synced).toBe("2026-01-02T00:00:00.000Z");
  });

  test("a peer we only ever learned of INBOUND has a null url, not a fake one", () => {
    const peersDir = sandbox();
    const rec = recordPeer(peersDir, { writerId: PEER_B, selfWriterId: SELF });
    expect(rec?.last_url).toBeNull();
    expect(rec?.protocol).toBeNull();
  });

  test("refuses to enrol SELF as a peer", () => {
    const peersDir = sandbox();
    expect(
      recordPeer(peersDir, { writerId: SELF, url: "http://localhost:7777", selfWriterId: SELF }),
    ).toBeNull();
    expect(readKnownPeers(peersDir)).toHaveLength(0);
  });

  test("refuses malformed and path-traversing writer IDs", () => {
    const peersDir = sandbox();
    for (const bad of [
      "../../../etc/passwd",
      "..",
      "a/b",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // uppercase: two records for one peer
      "aaaa", // too short
      `${PEER_A}a`, // too long
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", // not hex
      "",
      null,
      undefined,
      42,
      { writer_id: PEER_A },
    ]) {
      expect(recordPeer(peersDir, { writerId: bad, selfWriterId: SELF })).toBeNull();
    }
    expect(readKnownPeers(peersDir)).toHaveLength(0);
    // Nothing escaped the peers directory either.
    expect(existsSync(join(peersDir, "..", "..", "etc"))).toBe(false);
  });

  test("isWriterIdHex accepts only 32 lowercase hex chars", () => {
    expect(isWriterIdHex(PEER_A)).toBe(true);
    expect(isWriterIdHex(PEER_A.toUpperCase())).toBe(false);
    expect(isWriterIdHex(`${PEER_A} `)).toBe(false);
    expect(isWriterIdHex(`\n${PEER_A}`)).toBe(false);
  });
});

describe("peer registry — reading", () => {
  test("an unsynced project reads as empty, never as an error", () => {
    expect(readKnownPeers(sandbox())).toEqual([]);
    expect(readKnownPeer(sandbox(), PEER_A)).toBeNull();
  });

  test("corrupt, foreign-named and mismatched records are skipped, not fatal", () => {
    const peersDir = sandbox();
    recordPeer(peersDir, { writerId: PEER_A, selfWriterId: SELF });
    const dir = knownPeersDir(peersDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${PEER_B}.json`), "{ not json", "utf8");
    writeFileSync(join(dir, "notapeer.json"), JSON.stringify({ writer_id: PEER_B }), "utf8");
    writeFileSync(join(dir, "README"), "hello", "utf8");
    // A body whose writer_id disagrees with its filename must not smuggle a
    // second identity into a listing that is supposed to be keyed by file.
    writeFileSync(
      join(dir, `cccccccccccccccccccccccccccccccc.json`),
      JSON.stringify({
        writer_id: PEER_B,
        last_url: null,
        first_seen: "x",
        last_synced: "x",
        protocol: 1,
      }),
      "utf8",
    );
    const all = readKnownPeers(peersDir);
    expect(all.map((p) => p.writer_id)).toEqual([PEER_A]);
  });

  test("listing is sorted by writer_id, not left in directory order", () => {
    // EIGHT scattered IDs, deliberately. With two or three, `readdirSync` on
    // APFS happens to return them in reverse-sorted order regardless of
    // creation order — so both "no sort at all" and "reverse the directory
    // listing" satisfy an ascending assertion, and the test pins nothing. At
    // eight the directory order is neither sorted nor reverse-sorted, so only
    // a real sort passes.
    const peersDir = sandbox();
    const ids = ["1f", "3a", "5c", "7e", "9b", "b2", "d4", "f6"].map((p) => p.repeat(16));
    // Insert in a shuffled order too, so creation order is not the answer.
    for (const id of [ids[3], ids[0], ids[7], ids[5], ids[1], ids[6], ids[2], ids[4]]) {
      recordPeer(peersDir, { writerId: id as string, selfWriterId: SELF });
    }
    const listed = readKnownPeers(peersDir).map((p) => p.writer_id);
    expect(listed).toEqual([...ids].sort());
    // And the raw directory order really is different, or the assertion above
    // would be vacuous on this filesystem.
    const rawOrder = readdirSync(knownPeersDir(peersDir)).map((n) => n.slice(0, -".json".length));
    expect(rawOrder).not.toEqual(listed);
    expect([...rawOrder].reverse()).not.toEqual(listed);
  });

  test("publish leaves no scratch files behind", () => {
    const peersDir = sandbox();
    recordPeer(peersDir, { writerId: PEER_A, selfWriterId: SELF });
    recordPeer(peersDir, { writerId: PEER_A, selfWriterId: SELF });
    expect(readdirSync(knownPeersDir(peersDir))).toEqual([`${PEER_A}.json`]);
  });
});

describe("peer handshake parsing — additive means absence is NOT an error", () => {
  test("a missing or malformed peer block reads as 'unknown, assume nothing'", () => {
    // An OLDER peer omits the block entirely. Erroring here would break sync
    // against every daemon released before this feature.
    for (const bad of [
      undefined,
      null,
      {},
      "peer",
      42,
      { writer_id: PEER_A }, // no protocol
      { protocol: 1 }, // no writer_id
      { writer_id: "nope", protocol: 1 },
      { writer_id: PEER_A, protocol: "1" },
      { writer_id: PEER_A, protocol: 1.5 },
      { writer_id: PEER_A, protocol: -1 },
    ]) {
      expect(parsePeerHandshake(bad)).toBeNull();
    }
  });

  test("a well-formed block parses", () => {
    expect(parsePeerHandshake({ writer_id: PEER_A, protocol: 3 })).toEqual({
      writer_id: PEER_A,
      protocol: 3,
    });
  });
});

describe("peer registry — concurrency", () => {
  /**
   * THE regression guard. 24 processes each recording a DISTINCT peer against
   * the same project must leave 24 records. The project registry, whose shared
   * `projects.json` read → modify → write was unlocked, lost 8-10 of exactly
   * this workload — every process exiting 0 with nothing on stderr.
   */
  test("24 concurrent processes recording distinct peers lose none", async () => {
    const peersDir = sandbox();
    const N = 24;
    const script = join(dirs[dirs.length - 1] as string, "record.ts");
    writeFileSync(
      script,
      `import { recordPeer } from ${JSON.stringify(join(import.meta.dir, "../src/crdt/peers.ts"))};\n` +
        `const [dir, id] = process.argv.slice(2);\n` +
        `const ok = recordPeer(dir, { writerId: id, url: "http://p" + id + ":7777", protocol: 1, selfWriterId: ${JSON.stringify(SELF)} });\n` +
        `process.exit(ok === null ? 1 : 0);\n`,
      "utf8",
    );

    const ids = Array.from({ length: N }, (_, i) => i.toString(16).padStart(32, "d"));
    const procs = ids.map((id) =>
      Bun.spawn(["bun", script, peersDir, id], { stdout: "pipe", stderr: "pipe" }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes.every((c) => c === 0)).toBe(true);

    const got = readKnownPeers(peersDir).map((p) => p.writer_id).sort();
    expect(got).toEqual([...ids].sort());
  }, 60_000);

  /**
   * The narrower race the per-file design deliberately ACCEPTS: two processes
   * recording the SAME peer contend on one file. The publish is tmp + rename,
   * so the outcome must always be a complete, valid record — never a truncated
   * one that `readKnownPeers` silently skips (which would read as "that peer
   * vanished").
   */
  test("8 concurrent processes recording the SAME peer leave one intact record", async () => {
    const peersDir = sandbox();
    const script = join(dirs[dirs.length - 1] as string, "record_same.ts");
    writeFileSync(
      script,
      `import { recordPeer } from ${JSON.stringify(join(import.meta.dir, "../src/crdt/peers.ts"))};\n` +
        `const [dir] = process.argv.slice(2);\n` +
        `recordPeer(dir, { writerId: ${JSON.stringify(PEER_A)}, url: "http://a:7777", protocol: 1, selfWriterId: ${JSON.stringify(SELF)} });\n`,
      "utf8",
    );
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", script, peersDir], { stdout: "pipe", stderr: "pipe" }),
    );
    await Promise.all(procs.map((p) => p.exited));

    const all = readKnownPeers(peersDir);
    expect(all).toHaveLength(1);
    expect(all[0]?.writer_id).toBe(PEER_A);
    expect(all[0]?.last_url).toBe("http://a:7777");
    // And no scratch file survived the pile-up.
    expect(readdirSync(knownPeersDir(peersDir))).toEqual([`${PEER_A}.json`]);
  }, 60_000);

  /**
   * The publish must be tmp + ATOMIC RENAME, not a direct `writeFileSync`.
   *
   * `writeFileSync` to the destination opens it `O_TRUNC`: for a window it is a
   * zero-length or half-written file, and a concurrent reader — `hayven crdt
   * peers`, or the next `recordPeer`'s merge read — sees a record that fails to
   * parse. `readKnownPeers` skips unparseable records by design, so the
   * user-visible symptom is a peer that intermittently VANISHES from the
   * listing and, worse, comes back with its `first_seen` reset because the
   * merge read found nothing.
   *
   * `renameSync` has no such window: the destination is either the old complete
   * record or the new complete one, never a partial.
   *
   * Observed by hammering: writers republish in a tight loop while this process
   * reads the same path continuously. Under a correct publish, EVERY read that
   * finds the file must parse.
   */
  test("publishing is atomic — a concurrent reader never sees a partial record", async () => {
    const peersDir = sandbox();
    const dir = knownPeersDir(peersDir);
    const target = join(dir, `${PEER_A}.json`);
    const script = join(dirs[dirs.length - 1] as string, "hammer.ts");
    writeFileSync(
      script,
      `import { recordPeer } from ${JSON.stringify(join(import.meta.dir, "../src/crdt/peers.ts"))};\n` +
        `const [d] = process.argv.slice(2);\n` +
        `for (let i = 0; i < 400; i++) {\n` +
        `  recordPeer(d, { writerId: ${JSON.stringify(PEER_A)}, url: "http://a:7777/" + "x".repeat(i % 64), protocol: 1, selfWriterId: ${JSON.stringify(SELF)} });\n` +
        `}\n`,
      "utf8",
    );
    // Seed so the destination exists before the hammering starts.
    recordPeer(peersDir, { writerId: PEER_A, url: "http://a:7777", protocol: 1, selfWriterId: SELF });

    const procs = Array.from({ length: 6 }, () =>
      Bun.spawn(["bun", script, peersDir], { stdout: "pipe", stderr: "pipe" }),
    );
    const done = Promise.all(procs.map((p) => p.exited));

    let reads = 0;
    let torn = 0;
    let running = true;
    void done.then(() => {
      running = false;
    });
    while (running) {
      let text: string;
      try {
        text = readFileSync(target, "utf8");
      } catch {
        // The file must never DISAPPEAR either — rename replaces in place.
        torn += 1;
        continue;
      }
      reads += 1;
      try {
        const parsed = JSON.parse(text) as { writer_id?: string };
        if (parsed.writer_id !== PEER_A) torn += 1;
      } catch {
        torn += 1;
      }
      await Bun.sleep(0);
    }
    await done;

    expect(reads).toBeGreaterThan(100); // the hammer actually ran
    expect(torn).toBe(0);
  }, 120_000);
});
