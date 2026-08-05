/**
 * RFC-001 §4 Stage 1 — `hayven crdt peers [--json]`, the user-visible payoff.
 *
 * Before this, nothing on the machine could answer "who am I synced with?":
 * `hayven sync` was outbound-only, the responding daemon never learned who
 * called, and `config.sync_peers` was read by nothing.
 *
 * What is pinned:
 *   - the EMPTY case renders as a normal state and exits 0. A project that has
 *     never synced is not a failure, and a non-zero exit would break any script
 *     that polls this;
 *   - the JSON envelope's field names, since an agent reading this cannot
 *     re-derive them;
 *   - that "protocol unknown" is spelled out rather than printed as a number,
 *     so nobody compares against a value that was never advertised;
 *   - that the listing is not mistaken for an access-control list. Sync is
 *     unauthenticated; being listed here grants nothing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderPeers } from "../src/cli/crdt.ts";
import { recordPeer, type PeerRecord } from "../src/crdt/peers.ts";

const SELF = "00000000000000000000000000000000";
const PEER_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PEER_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("hayven crdt peers — rendering", () => {
  test("an unsynced project reads as a normal empty state, not an error", () => {
    const out = renderPeers([]);
    expect(out).toContain("Known sync peers");
    expect(out).toContain("has not exchanged CRDT segments with any peer");
    // No error/failure vocabulary — this is the expected state on day one.
    expect(out.toLowerCase()).not.toContain("error");
    // And it says how peers get recorded, including the inbound direction that
    // is the whole point of this stage.
    expect(out).toContain("BOTH");
  });

  test("a known peer shows its id, url, both timestamps and protocol", () => {
    const rec: PeerRecord = {
      writer_id: PEER_A,
      last_url: "http://teammate.local:7777",
      first_seen: "2026-01-01T00:00:00.000Z",
      last_synced: "2026-08-01T00:00:00.000Z",
      protocol: 1,
    };
    const out = renderPeers([rec]);
    expect(out).toContain(PEER_A);
    expect(out).toContain("http://teammate.local:7777");
    expect(out).toContain("2026-01-01T00:00:00.000Z");
    expect(out).toContain("2026-08-01T00:00:00.000Z");
    expect(out).toContain("protocol: 1");
  });

  test("an unknown protocol is spelled out, never rendered as a number", () => {
    const out = renderPeers([
      {
        writer_id: PEER_B,
        last_url: null,
        first_seen: "2026-01-01T00:00:00.000Z",
        last_synced: "2026-01-01T00:00:00.000Z",
        protocol: null,
      },
    ]);
    expect(out).toContain("unknown (peer sent no handshake)");
    // "protocol: 0" / "protocol: null" would invite a version comparison
    // against a value the peer never advertised.
    expect(out).not.toContain("protocol: 0");
    expect(out).not.toContain("protocol: null");
    // An inbound-only peer has no dial-back address, and says so.
    expect(out).toContain("inbound only");
  });

  test("says out loud that this is not a permission list", () => {
    const out = renderPeers([
      {
        writer_id: PEER_A,
        last_url: "http://a:7777",
        first_seen: "x",
        last_synced: "x",
        protocol: 1,
      },
    ]);
    expect(out).toContain("not a permission list");
  });
});

describe("hayven crdt peers — end to end through the CLI", () => {
  /** Run the real `hayven crdt <sub>` dispatcher in a child process. */
  async function runCli(
    repoRoot: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const cliPath = join(import.meta.dir, "../src/cli.ts");
    const proc = Bun.spawn(["bun", cliPath, "crdt", ...args], {
      cwd: repoRoot,
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

  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "hayven-peercli-"));
    // `requireProject` needs a `.hayven/` dir to exist; nothing else.
    require("node:fs").mkdirSync(join(dir, ".hayven"), { recursive: true });
    return dir;
  }

  test("empty registry exits 0 in both text and --json", async () => {
    const root = project();
    try {
      const text = await runCli(root, ["peers"]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain("has not exchanged CRDT segments");

      const json = await runCli(root, ["peers", "--json"]);
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout) as { ok: boolean; count: number; peers: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBe(0);
      expect(parsed.peers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("recorded peers are listed, and --json carries the documented fields", async () => {
    const root = project();
    try {
      const peersDir = join(root, ".hayven", "peers");
      recordPeer(peersDir, {
        writerId: PEER_A,
        url: "http://teammate.local:7777",
        protocol: 1,
        selfWriterId: SELF,
        now: () => Date.UTC(2026, 0, 1),
      });
      recordPeer(peersDir, { writerId: PEER_B, selfWriterId: SELF, now: () => Date.UTC(2026, 1, 1) });

      const text = await runCli(root, ["peers"]);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(PEER_A);
      expect(text.stdout).toContain(PEER_B);
      expect(text.stdout).toContain("http://teammate.local:7777");

      const json = await runCli(root, ["peers", "--json"]);
      const parsed = JSON.parse(json.stdout) as {
        count: number;
        protocol: number;
        peers: PeerRecord[];
      };
      expect(parsed.count).toBe(2);
      expect(parsed.protocol).toBe(1);
      expect(Object.keys(parsed.peers[0] as object).sort()).toEqual([
        "first_seen",
        "last_synced",
        "last_url",
        "protocol",
        "writer_id",
      ]);
      expect(parsed.peers[0]?.writer_id).toBe(PEER_A);
      expect(parsed.peers[0]?.first_seen).toBe("2026-01-01T00:00:00.000Z");
      expect(parsed.peers[1]?.last_url).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unknown subcommand still fails with usage naming BOTH subcommands", async () => {
    const root = project();
    try {
      const res = await runCli(root, ["nonsense"]);
      expect(res.code).toBe(2);
      expect(res.stderr).toContain("retention|peers");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
