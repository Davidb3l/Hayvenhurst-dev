// `hayven sync <peer_url>` — initiator-driven Merkle anti-entropy pull.
// ARCHITECTURE.md §15.5.
//
// Compares our Merkle snapshot against the peer's, pulls segments we're
// missing or that differ, and pushes any segments the peer is missing. One
// round-trip per divergent segment plus the initial root + leaves exchange.
import { computeMerkle, diffSnapshots, type MerkleSnapshot } from "../crdt/merkle.ts";
import { OpLog, splitSegmentBatches, type CrdtType } from "../crdt/oplog.ts";
import { assertDaemonServesProject, requireProject } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

interface SyncSummary {
  peer: string;
  pulledSegments: number;
  pulledBytes: number;
  pushedSegments: number;
  pushedBytes: number;
  roundTrips: number;
  startedAtMs: number;
  finishedAtMs: number;
}

export async function runSync(args: ParsedArgs): Promise<number> {
  const peer = args.positionals[0];
  if (!peer) {
    process.stderr.write(
      "usage: hayven sync <peer_url>\n" +
        "  peer_url   e.g. http://teammate.local:7777\n",
    );
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const peerUrl = peer.replace(/\/+$/, "");

  // We push pulled segments into our LOCAL daemon's op-log. Verify that daemon
  // serves THIS project before mutating it — every project defaults to port
  // 7777, so a foreign daemon there would otherwise ingest a peer's ops into
  // the wrong repo.
  const localUrl = `http://${ctx.config.daemon_host}:${ctx.config.daemon_port}`;
  const identity = await assertDaemonServesProject(localUrl, ctx);
  if (!identity.ok) {
    process.stderr.write(`error: ${identity.message}\n`);
    return 1;
  }
  if (identity.warning) process.stderr.write(`warning: ${identity.warning}\n`);
  const summary: SyncSummary = {
    peer: peerUrl,
    pulledSegments: 0,
    pulledBytes: 0,
    pushedSegments: 0,
    pushedBytes: 0,
    roundTrips: 0,
    startedAtMs: Date.now(),
    finishedAtMs: 0,
  };

  // Read-only op-log view over our local crdt dir for the Merkle snapshot.
  const oplog = new OpLog(ctx.paths.crdtDir);
  try {
    return await runSyncWith(oplog, ctx, peerUrl, summary);
  } finally {
    oplog.close();
  }
}

async function runSyncWith(
  oplog: OpLog,
  ctx: ReturnType<typeof requireProject>,
  peerUrl: string,
  summary: SyncSummary,
): Promise<number> {
  // Round-trip 1: roots.
  const ourRoots = computeMerkle(oplog);
  const theirRoots = await fetchJson<Record<CrdtType, string>>(`${peerUrl}/api/sync/merkle`);
  summary.roundTrips += 1;

  if (rootsMatch(ourRoots.roots, theirRoots)) {
    summary.finishedAtMs = Date.now();
    process.stdout.write(renderSummary(summary, /* upToDate */ true));
    return 0;
  }

  // Round-trip 2+: per-type leaves.
  const types: CrdtType[] = ["lww", "gset", "orset"];
  const theirSnap: MerkleSnapshot = {
    roots: { ...theirRoots },
    leaves: { lww: [], gset: [], orset: [] },
  };
  for (const type of types) {
    if (ourRoots.roots[type] === theirRoots[type]) {
      theirSnap.leaves[type] = ourRoots.leaves[type];
      continue;
    }
    const res = await postJson<{ type: string; leaves: { path: string; hash: string }[] }>(
      `${peerUrl}/api/sync/leaves`,
      { type },
    );
    theirSnap.leaves[type] = res.leaves;
    summary.roundTrips += 1;
  }

  const diff = diffSnapshots(ourRoots, theirSnap);
  const localUrl = `http://${ctx.config.daemon_host}:${ctx.config.daemon_port}`;

  // Pull divergent + missing segments from the peer, then push each
  // constituent batch into our LOCAL daemon so its in-memory CRDT picks up
  // the new ops. A segment is `[len][batch]...`; /api/sync/push takes ONE
  // batch per call, so we split before pushing (a whole-segment push would
  // double-frame and corrupt).
  for (const target of diff.pull) {
    const bytes = await pullSegment(peerUrl, target.type, target.path);
    summary.pulledSegments += 1;
    summary.pulledBytes += bytes.length;
    summary.roundTrips += 1;
    for (const batch of splitSegmentBatches(bytes)) {
      await postJson(`${localUrl}/api/sync/push`, {
        type: target.type,
        path: target.path,
        batch: bufferToBase64(batch),
      });
    }
  }

  // Push segments the peer is missing — again one batch per call.
  for (const target of diff.push) {
    const bytes = oplog.readSegmentBytes(target.type, target.path);
    if (bytes === null) continue;
    summary.pushedSegments += 1;
    summary.pushedBytes += bytes.length;
    for (const batch of splitSegmentBatches(bytes)) {
      summary.roundTrips += 1;
      await postJson(`${peerUrl}/api/sync/push`, {
        type: target.type,
        path: target.path,
        batch: bufferToBase64(batch),
      });
    }
  }

  summary.finishedAtMs = Date.now();
  process.stdout.write(renderSummary(summary, /* upToDate */ false));
  return 0;
}

function rootsMatch(a: Record<CrdtType, string>, b: Record<CrdtType, string>): boolean {
  return a.lww === b.lww && a.gset === b.gset && a.orset === b.orset;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function pullSegment(peerUrl: string, type: CrdtType, path: string): Promise<Uint8Array> {
  // Walk offsets until x-segment-eof is "1".
  const chunks: Uint8Array[] = [];
  let offset = 0;
  // Hard cap on iterations to avoid an infinite loop against a buggy peer.
  for (let i = 0; i < 1024; i++) {
    const res = await fetch(`${peerUrl}/api/sync/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, path, offset }),
    });
    if (!res.ok) throw new Error(`POST /api/sync/batch → ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    chunks.push(buf);
    if (res.headers.get("x-segment-eof") === "1") break;
    offset += buf.length;
    if (buf.length === 0) break; // peer returned no progress — bail
  }
  return concatBytes(chunks);
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function bufferToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

function renderSummary(s: SyncSummary, upToDate: boolean): string {
  const dur = s.finishedAtMs - s.startedAtMs;
  if (upToDate) {
    return `# Sync with ${s.peer}\n\nAlready up to date (${s.roundTrips} round-trips, ${dur} ms).\n`;
  }
  return (
    `# Sync with ${s.peer}\n\n` +
    `- Pulled: ${s.pulledSegments} segments, ${formatBytes(s.pulledBytes)}\n` +
    `- Pushed: ${s.pushedSegments} segments, ${formatBytes(s.pushedBytes)}\n` +
    `- Round-trips: ${s.roundTrips}\n` +
    `- Duration:    ${dur} ms\n`
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
