/**
 * Peer registry flood defense (`MAX_KNOWN_PEERS` in `crdt/peers.ts`).
 *
 * The sync endpoints are unauthenticated and `peer_writer_id` is self-asserted,
 * so before the cap a loop presenting random 32-hex ids minted one file under
 * `.hayven/peers/known/` per id: unbounded inodes, and a `hayven crdt peers`
 * listing buried in noise exactly when someone is spoofing. What is pinned:
 *
 *   - exactly MAX_KNOWN_PEERS distinct ids enroll; the next NEW id is refused
 *     (null return, no file);
 *   - a KNOWN id still updates `last_synced` at the cap, so a full registry
 *     never stops the real fleet from refreshing;
 *   - the on-disk file count never exceeds the cap no matter how many ids are
 *     thrown at it;
 *   - the refusal warns ONCE per process, not once per refusal, so a flood
 *     cannot turn the log itself into the amplification vector.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  knownPeersDir,
  MAX_KNOWN_PEERS,
  readKnownPeer,
  readKnownPeers,
  recordPeer,
} from "../src/crdt/peers.ts";

const SELF = "00000000000000000000000000000000";

/**
 * Deterministic distinct 32-hex ids: a fixed "e" prefix plus the 8-hex-digit
 * counter. The fixed-width counter (not padStart over the whole id) is what
 * guarantees uniqueness for every i below 16^8; padding the raw hex of i to 32
 * chars would silently collide for values whose hex is all pad chars.
 */
function idFor(i: number): string {
  return "e".repeat(24) + i.toString(16).padStart(8, "0");
}

const dirs: string[] = [];
function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "hayven-peercap-"));
  dirs.push(d);
  return join(d, ".hayven", "peers");
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** Enroll exactly MAX_KNOWN_PEERS distinct peers into a fresh registry. */
function fillToCap(peersDir: string): void {
  for (let i = 0; i < MAX_KNOWN_PEERS; i++) {
    const rec = recordPeer(peersDir, {
      writerId: idFor(i),
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 0, 1),
    });
    expect(rec).not.toBeNull();
  }
}

describe("peer registry — MAX_KNOWN_PEERS cap", () => {
  test("the cap is the documented 64", () => {
    // The RFC's deviations note and the warning text both name 64; a silent
    // change here should have to change this line too, on purpose.
    expect(MAX_KNOWN_PEERS).toBe(64);
  });

  test("64 distinct peers enroll; the 65th is refused with no file created", () => {
    const peersDir = sandbox();
    fillToCap(peersDir);
    expect(readKnownPeers(peersDir)).toHaveLength(MAX_KNOWN_PEERS);

    const overflow = recordPeer(peersDir, {
      writerId: idFor(MAX_KNOWN_PEERS),
      selfWriterId: SELF,
    });
    expect(overflow).toBeNull();
    // Refused means REFUSED: no record readable, no file on disk.
    expect(readKnownPeer(peersDir, idFor(MAX_KNOWN_PEERS))).toBeNull();
    expect(readKnownPeers(peersDir)).toHaveLength(MAX_KNOWN_PEERS);
    expect(readdirSync(knownPeersDir(peersDir))).not.toContain(
      `${idFor(MAX_KNOWN_PEERS)}.json`,
    );
  });

  test("a KNOWN peer still updates last_synced at the cap", () => {
    const peersDir = sandbox();
    fillToCap(peersDir);

    // The whole point of allowing updates through: a full registry must not
    // freeze the real fleet's freshness data.
    const updated = recordPeer(peersDir, {
      writerId: idFor(3),
      url: "http://moved.local:7777",
      selfWriterId: SELF,
      now: () => Date.UTC(2026, 6, 1),
    });
    expect(updated).not.toBeNull();
    expect(updated?.last_synced).toBe("2026-07-01T00:00:00.000Z");
    // An update, not an enrollment: first_seen preserved, count unchanged.
    expect(updated?.first_seen).toBe("2026-01-01T00:00:00.000Z");
    expect(updated?.last_url).toBe("http://moved.local:7777");
    expect(readKnownPeers(peersDir)).toHaveLength(MAX_KNOWN_PEERS);
  });

  test("a flood of ids never pushes the directory past the cap", () => {
    const peersDir = sandbox();
    const FLOOD = MAX_KNOWN_PEERS * 3;
    for (let i = 0; i < FLOOD; i++) {
      recordPeer(peersDir, { writerId: idFor(i), selfWriterId: SELF });
      // Invariant holds at EVERY step, not just at the end: the cap is a
      // ceiling, not an eventually-pruned high-water mark.
      const files = readdirSync(knownPeersDir(peersDir)).filter((n) => n.endsWith(".json"));
      expect(files.length).toBeLessThanOrEqual(MAX_KNOWN_PEERS);
    }
    // And exactly the first 64 ids made it in, in enrollment order by id.
    const got = readKnownPeers(peersDir).map((p) => p.writer_id).sort();
    const want = Array.from({ length: MAX_KNOWN_PEERS }, (_, i) => idFor(i)).sort();
    expect(got).toEqual(want);
  });

  test("the cap refusal warns once per process, not once per refusal", async () => {
    const peersDir = sandbox();
    fillToCap(peersDir);

    // The one-time latch is module state, so it must be observed in a FRESH
    // process (this test process may already have tripped it above). The
    // child hammers many over-cap ids and its stderr must carry exactly one
    // warning naming the cap.
    const script = join(dirs[dirs.length - 1] as string, "flood.ts");
    writeFileSync(
      script,
      `import { recordPeer, MAX_KNOWN_PEERS } from ${JSON.stringify(join(import.meta.dir, "../src/crdt/peers.ts"))};\n` +
        `const [dir] = process.argv.slice(2);\n` +
        `let refused = 0;\n` +
        `for (let i = 0; i < 50; i++) {\n` +
        `  const id = "e".repeat(24) + (MAX_KNOWN_PEERS + i).toString(16).padStart(8, "0");\n` +
        `  if (recordPeer(dir, { writerId: id, selfWriterId: ${JSON.stringify(SELF)} }) === null) refused += 1;\n` +
        `}\n` +
        `process.exit(refused === 50 ? 0 : 1);\n`,
      "utf8",
    );
    const proc = Bun.spawn(["bun", script, peersDir], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0); // all 50 over-cap ids were refused
    const warnings = stderr
      .split("\n")
      .filter((l) => l.includes("peer registry is at its cap"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(String(MAX_KNOWN_PEERS));
    // And none of the 50 landed on disk.
    expect(readKnownPeers(peersDir)).toHaveLength(MAX_KNOWN_PEERS);
  }, 30_000);
});
