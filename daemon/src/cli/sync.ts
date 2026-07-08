// `hayven sync <peer_url>` — initiator-driven Merkle anti-entropy pull.
// ARCHITECTURE.md §15.5.
//
// Compares our Merkle snapshot against the peer's, pulls segments we're
// missing or that differ, and pushes any segments the peer is missing. One
// round-trip per divergent segment plus the initial root + leaves exchange.
import { computeMerkle, diffSnapshots, type MerkleSnapshot } from "../crdt/merkle.ts";
import { OpLog, splitSegmentBatches, type CrdtType } from "../crdt/oplog.ts";
import { assertDaemonServesProject, projectHeader, reportIdentity, requireProject } from "./_shared.ts";
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
      "usage: hayven sync <peer_url> [--peer-project <alias>]\n" +
        "  peer_url        e.g. http://teammate.local:7777\n" +
        "  --peer-project  which project on the peer daemon to sync with; required\n" +
        "                  when the peer serves more than one project\n",
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
  const requestedPeerAlias =
    typeof args.flags["peer-project"] === "string" && args.flags["peer-project"].length > 0
      ? args.flags["peer-project"]
      : undefined;

  // We push pulled segments into our LOCAL daemon's op-log. Verify that daemon
  // serves THIS project before mutating it — every project defaults to port
  // 7777, so a foreign daemon there would otherwise ingest a peer's ops into
  // the wrong repo.
  const localUrl = `http://${ctx.config.daemon_host}:${ctx.config.daemon_port}`;
  const identity = await assertDaemonServesProject(localUrl, ctx);
  if (!reportIdentity(identity)) return 1;
  // Address local pushes to OUR project on a shared multi-project daemon.
  const localHeaders = projectHeader(identity);

  // The PEER needs the same care: a shared multi-project peer daemon serves
  // its PRIMARY project's op-log to any un-addressed request, so syncing repo
  // X against a peer whose primary is repo Y would diff X's Merkle tree
  // against Y's and cross-contaminate both CRDT op-logs. Resolve which of the
  // peer's projects we are talking to BEFORE any exchange, and address every
  // peer request with it. Peers live on other machines, so roots can't match
  // ours — identity is the peer's ALIAS, picked automatically when the peer
  // serves exactly one project and required (`--peer-project`) otherwise.
  const peerIdentity = await resolvePeerProject(peerUrl, requestedPeerAlias, ctx);
  if (!peerIdentity.ok) {
    process.stderr.write(`error: ${peerIdentity.message}\n`);
    return 1;
  }
  if (peerIdentity.warning) process.stderr.write(`note: ${peerIdentity.warning}\n`);
  const peerHeaders: Record<string, string> =
    peerIdentity.alias !== undefined ? { "x-hayven-project": peerIdentity.alias } : {};
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
    return await runSyncWith(oplog, ctx, peerUrl, summary, localHeaders, peerHeaders);
  } catch (err) {
    // A bare `fetch` rejection (connection refused / DNS / reset) means a daemon
    // — local or peer — was unreachable. Surface it the same way the other
    // mutating commands do instead of letting it bubble as an unhandled
    // rejection. HTTP-status errors carry their own message and re-throw.
    if (err instanceof UnreachableDaemonError) {
      process.stderr.write(
        `error: could not reach daemon at ${err.base} (${err.reason.message}).\n` +
          "Start it with `hayven daemon start`.\n",
      );
      return 1;
    }
    throw err;
  } finally {
    oplog.close();
  }
}

/** Result of resolving WHICH project on the peer daemon we are syncing with. */
export type PeerProjectResult =
  | {
      ok: true;
      /** Peer-side alias to address every peer request with; absent only for a
       *  legacy single-project peer that predates project addressing. */
      alias?: string;
      warning?: string;
    }
  | { ok: false; message: string };

/**
 * Resolve the peer-side project identity for `hayven sync` BEFORE any segment
 * exchange. Cross-machine roots never match (different filesystems), so the
 * unit of identity is the peer's project ALIAS as reported by its
 * `GET /api/health` `projects` list:
 *
 *   - peer serves ONE project → that alias is unambiguous; use it (and verify
 *     a `--peer-project` override against it).
 *   - peer serves SEVERAL → `--peer-project <alias>` is REQUIRED. Guessing
 *     (or falling back to the peer's primary) is how repo X's op-log gets
 *     diffed against repo Y's and both ends get cross-contaminated.
 *   - requested alias not in the list → hard refusal, listing what IS served.
 *   - legacy peer (health has no `projects`) → single-project by construction;
 *     proceed un-addressed with a note, unless the caller demanded a specific
 *     alias the peer cannot honor.
 *
 * Transport-level failures are tolerated (ok, no alias): the first real sync
 * request hits the same daemon and reports "could not reach" with the
 * consistent message, mirroring `assertDaemonServesProject`'s tolerance.
 *
 * As a nudge against picking the wrong alias on a multi-project peer, a
 * basename mismatch between the chosen peer project's root and ours is
 * surfaced as a warning (cross-machine clones usually share the repo name) —
 * a warning only, because clone directory names legitimately differ.
 */
export async function resolvePeerProject(
  peerUrl: string,
  requestedAlias: string | undefined,
  ctx: { paths: { repoRoot: string } },
): Promise<PeerProjectResult> {
  // Tolerated probe failures still carry a warning: without it, a transient
  // health hiccup against a multi-project peer would run the whole sync
  // un-addressed (the exact silent wrong-project exchange this guard exists
  // to prevent) with no trace of the guard having been skipped.
  const probeFailed = (why: string): PeerProjectResult =>
    requestedAlias !== undefined
      ? {
          ok: true,
          alias: requestedAlias,
          warning:
            `could not verify --peer-project '${requestedAlias}' against the peer (${why}) — ` +
            "sending it anyway; the peer will refuse it if unknown.",
        }
      : {
          ok: true,
          warning:
            `could not verify which project the peer serves (${why}) — syncing un-addressed. ` +
            "Pass --peer-project to pin the peer-side project.",
        };

  let health: { root?: unknown; projects?: unknown };
  try {
    const res = await fetch(`${peerUrl}/api/health`);
    if (!res.ok) {
      // Reachable but unhealthy — let the real requests surface the failure.
      return probeFailed(`health returned ${res.status}`);
    }
    health = (await res.json()) as { root?: unknown; projects?: unknown };
  } catch {
    // Unreachable — the merkle fetch will report this clearly itself. Still
    // honor an explicit alias so a flaky probe can't drop the selector.
    return probeFailed("health probe failed");
  }

  const projects = Array.isArray(health.projects)
    ? (health.projects as Array<{ alias?: unknown; root?: unknown }>).filter(
        (p): p is { alias: string; root?: unknown } =>
          typeof p.alias === "string" && p.alias.length > 0,
      )
    : undefined;

  // Legacy peer: no projects list — single-project by construction.
  if (projects === undefined || projects.length === 0) {
    if (requestedAlias !== undefined) {
      return {
        ok: false,
        message:
          `--peer-project '${requestedAlias}' was given, but the peer at ${peerUrl} does not ` +
          "support project addressing (old daemon without a `projects` list in /api/health).\n" +
          "Upgrade the peer daemon, or drop --peer-project if it really serves only that project.",
      };
    }
    // Legacy daemons DO report their (single) project root — use it for the
    // same basename nudge the multi-project path gets, since a legacy peer
    // serving a different repo is exactly the silent cross-contamination case.
    const legacyRootName =
      typeof health.root === "string" ? basenameOf(health.root) : undefined;
    const ourRootName = basenameOf(ctx.paths.repoRoot);
    if (legacyRootName !== undefined && legacyRootName !== ourRootName) {
      return {
        ok: true,
        warning:
          `peer at ${peerUrl} is an old single-project daemon whose project root is named ` +
          `'${legacyRootName}', but this repo is '${ourRootName}' — if that is NOT the same project, ` +
          "STOP: syncing would cross-contaminate both op-logs. Upgrade the peer daemon to enable strict checking.",
      };
    }
    return {
      ok: true,
      warning:
        `peer at ${peerUrl} did not report its served projects (old version?) — ` +
        "syncing un-addressed against its primary project. Upgrade the peer to enable the project-identity check.",
    };
  }

  const aliases = projects.map((p) => p.alias);
  let chosen: { alias: string; root?: unknown } | undefined;
  if (requestedAlias !== undefined) {
    chosen = projects.find((p) => p.alias === requestedAlias);
    if (!chosen) {
      return {
        ok: false,
        message:
          `peer at ${peerUrl} does not serve a project with alias '${requestedAlias}'.\n` +
          `  peer serves: ${aliases.join(", ")}\n` +
          "Pass one of those with --peer-project (or register the project on the peer).",
      };
    }
  } else if (projects.length === 1 && projects[0] !== undefined) {
    chosen = projects[0];
  } else {
    return {
      ok: false,
      message:
        `peer at ${peerUrl} serves ${projects.length} projects — refusing to guess which one to sync with.\n` +
        `  peer serves: ${aliases.join(", ")}\n` +
        "Re-run with --peer-project <alias> naming the peer-side project for THIS repo.",
    };
  }

  const ourName = basenameOf(ctx.paths.repoRoot);
  const theirName = typeof chosen.root === "string" ? basenameOf(chosen.root) : undefined;
  const warning =
    theirName !== undefined && theirName !== ourName
      ? `peer project '${chosen.alias}' has root name '${theirName}' but this repo is '${ourName}' — ` +
        "make sure that alias really is this project's clone on the peer."
      : undefined;
  return warning !== undefined
    ? { ok: true, alias: chosen.alias, warning }
    : { ok: true, alias: chosen.alias };
}

/** Final path component, tolerant of both separators (peers may be Windows). */
function basenameOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Thrown when a `fetch` to a daemon (local or peer) fails at the transport
 *  layer — connection refused, DNS, reset — as opposed to an HTTP error status. */
class UnreachableDaemonError extends Error {
  constructor(readonly base: string, readonly reason: Error) {
    super(`could not reach daemon at ${base}: ${reason.message}`);
    this.name = "UnreachableDaemonError";
  }
}

/** Run a `fetch`, re-tagging a transport-layer failure with the base URL so the
 *  top-level handler can print the consistent unreachable-daemon message. */
async function reachableFetch(url: string, init?: RequestInit): Promise<Response> {
  const base = new URL(url).origin;
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new UnreachableDaemonError(base, err as Error);
  }
}

async function runSyncWith(
  oplog: OpLog,
  ctx: ReturnType<typeof requireProject>,
  peerUrl: string,
  summary: SyncSummary,
  /** Project-selector headers for the LOCAL daemon (shared multi-project daemon). */
  localHeaders: Record<string, string> = {},
  /** Project-selector headers for the PEER daemon — EVERY peer request must
   *  carry them, or a shared peer answers for its primary project. */
  peerHeaders: Record<string, string> = {},
): Promise<number> {
  // Round-trip 1: roots.
  const ourRoots = computeMerkle(oplog);
  const theirRoots = await fetchJson<Record<CrdtType, string>>(
    `${peerUrl}/api/sync/merkle`,
    peerHeaders,
  );
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
      peerHeaders,
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
    const bytes = await pullSegment(peerUrl, target.type, target.path, peerHeaders);
    summary.pulledSegments += 1;
    summary.pulledBytes += bytes.length;
    summary.roundTrips += 1;
    for (const batch of splitSegmentBatches(bytes)) {
      await postJson(
        `${localUrl}/api/sync/push`,
        {
          type: target.type,
          path: target.path,
          batch: bufferToBase64(batch),
        },
        localHeaders,
      );
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
      await postJson(
        `${peerUrl}/api/sync/push`,
        {
          type: target.type,
          path: target.path,
          batch: bufferToBase64(batch),
        },
        peerHeaders,
      );
    }
  }

  summary.finishedAtMs = Date.now();
  process.stdout.write(renderSummary(summary, /* upToDate */ false));
  return 0;
}

function rootsMatch(a: Record<CrdtType, string>, b: Record<CrdtType, string>): boolean {
  return a.lww === b.lww && a.gset === b.gset && a.orset === b.orset;
}

async function fetchJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await reachableFetch(url, { headers });
  if (!res.ok) {
    // Keep the body: on a strict-404 (e.g. the peer stopped serving our
    // alias mid-sync) it carries the actionable "register it / restart"
    // message the daemon wrote.
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await reachableFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function pullSegment(
  peerUrl: string,
  type: CrdtType,
  path: string,
  peerHeaders: Record<string, string> = {},
): Promise<Uint8Array> {
  // Walk offsets until x-segment-eof is "1".
  const chunks: Uint8Array[] = [];
  let offset = 0;
  // Hard cap on iterations to avoid an infinite loop against a buggy peer.
  for (let i = 0; i < 1024; i++) {
    const res = await reachableFetch(`${peerUrl}/api/sync/batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...peerHeaders },
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
