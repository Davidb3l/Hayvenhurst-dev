/**
 * `hayven crdt [retention] [--json]` — report the CRDT op log's growth state.
 *
 * WHY THIS EXISTS (T6). The §14 op log is append-only and nothing prunes it
 * (see `crdt/retention.ts` for the T5 verdict on why pruning is a protocol
 * change and is deliberately NOT implemented). Its growth bounds were measured
 * in exactly two places, both invisible: `CrdtState.hydrate()` writes warnings
 * to the daemon's stderr at START-UP, and — as of T6 — `OpLog` re-measures
 * itself every few minutes into the same stream. Both land in the daemon log,
 * which nobody reads until something has already gone wrong.
 *
 * This is the pull surface for the same numbers: a human or an agent can ask,
 * mid-session, "how big has this got, and is it over anything?" without
 * grepping a log or restarting a daemon. That matters because the failure this
 * whole pass exists to kill is not "the log grew", it is "the log grew and
 * nothing said so".
 *
 * DAEMONLESS AND READ-ONLY. It stats the segment directories directly — it does
 * not talk to the daemon, and `inspectRetention` never reads segment CONTENTS
 * (reading them would be the very read amplification it reports on). So it is
 * safe to run against a live daemon's project, and it works when no daemon is
 * running at all.
 */
import { OpLog, type CrdtType } from "../crdt/oplog.ts";
import { readKnownPeers, SYNC_PROTOCOL_VERSION, type PeerRecord } from "../crdt/peers.ts";
import { CRDT_LIMITS, inspectRetention, type RetentionReport } from "../crdt/retention.ts";
import { isJson, requireProject } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];

export async function runCrdt(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0] ?? "retention";
  if (sub !== "retention" && sub !== "peers") {
    process.stderr.write("usage: hayven crdt [retention|peers] [--json]\n");
    return 2;
  }

  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  if (sub === "peers") return runPeers(ctx.paths.peersDir, isJson(args.flags));

  // Constructing an OpLog is cheap: the wire bridge is lazy (it spawns
  // `hayven-native` per call, and we never encode or decode here), and
  // inspectRetention is stat-only.
  const oplog = new OpLog(ctx.paths.crdtDir, { retentionCheckIntervalMs: 0 });
  let report: RetentionReport;
  try {
    report = inspectRetention(oplog, CRDT_LIMITS);
  } finally {
    oplog.close();
  }

  if (isJson(args.flags)) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: report.violations.length === 0,
          totalBytes: report.totalBytes,
          segmentCounts: report.segmentCounts,
          oldestDay: report.oldestDay,
          newestDay: report.newestDay,
          limits: CRDT_LIMITS,
          violations: report.violations,
          // Stated in the payload so an agent reading this does not have to
          // infer it: there is no prune, so these numbers only ever go up.
          pruning: "none — the op log is append-only and is never reclaimed",
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stdout.write(renderReport(report));
  return 0;
}

/**
 * `hayven crdt peers [--json]` — who this project has synced with (RFC-001 §4).
 *
 * The user-visible payoff of peer identity: before this, nothing on the machine
 * could answer "who am I synced with?", because `hayven sync` was outbound-only
 * and the responding daemon never learned who called.
 *
 * READ-ONLY and DAEMONLESS, like `crdt retention` above: it reads a handful of
 * tiny JSON files under `.hayven/peers/known/` and talks to no daemon, so it is
 * safe against a live daemon's project and works with none running.
 *
 * Exit code is always 0 for a successful read. An empty registry is a normal,
 * expected state (a project that has never synced), NOT a failure — making it
 * non-zero would break any script that polls this.
 */
function runPeers(peersDir: string, json: boolean): number {
  const peers = readKnownPeers(peersDir);
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          protocol: SYNC_PROTOCOL_VERSION,
          count: peers.length,
          peers,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stdout.write(renderPeers(peers));
  return 0;
}

/** Human-readable rendering of the peer registry. Exported for a direct test on
 *  the text, so the "never synced" wording cannot silently regress into looking
 *  like an error. */
export function renderPeers(peers: PeerRecord[]): string {
  const lines: string[] = ["# Known sync peers", ""];
  if (peers.length === 0) {
    lines.push("None. This project has not exchanged CRDT segments with any peer.");
    lines.push("");
    lines.push("Run `hayven sync <peer_url>` to sync; peers are recorded from BOTH");
    lines.push("directions — the one you reach, and any that reaches you.");
    lines.push("");
    return lines.join("\n");
  }
  for (const p of peers) {
    lines.push(`- ${p.writer_id}`);
    lines.push(`    url:      ${p.last_url ?? "(inbound only — never dialled)"}`);
    lines.push(`    first:    ${p.first_seen}`);
    lines.push(`    last:     ${p.last_synced}`);
    // "unknown" is spelled out rather than shown as 0: an older peer omits the
    // handshake entirely, and printing a number for it would invite a reader to
    // compare against it.
    lines.push(`    protocol: ${p.protocol ?? "unknown (peer sent no handshake)"}`);
  }
  lines.push("");
  // Say what this list is NOT, so nobody reads it as an access-control list.
  lines.push("This is a record of who has synced, not a permission list: sync is");
  lines.push("unauthenticated, and being listed here grants nothing.");
  lines.push("");
  return lines.join("\n");
}

/** Human-readable rendering. Exported for a direct test on the text, so the
 *  "over the limit" wording cannot silently regress to looking healthy. */
export function renderReport(report: RetentionReport): string {
  const lines: string[] = [];
  lines.push("# CRDT op-log retention");
  lines.push("");
  lines.push(`- Total on disk: ${formatBytes(report.totalBytes)}`);
  lines.push(
    `- Segments:      ${TYPES.map((t) => `${t} ${report.segmentCounts[t]}`).join(", ")}`,
  );
  lines.push(`- Day range:     ${report.oldestDay ?? "-"} → ${report.newestDay ?? "-"}`);
  lines.push("");
  if (report.violations.length === 0) {
    lines.push("Within every growth bound.");
  } else {
    lines.push(`## Over ${report.violations.length} bound(s)`);
    lines.push("");
    for (const v of report.violations) {
      lines.push(
        `- ${v.code}: observed ${v.observed}, limit ${v.limit}` +
          (v.type !== null ? ` (type ${v.type})` : "") +
          (v.day !== null ? ` (day ${v.day})` : ""),
      );
    }
  }
  lines.push("");
  // Say the uncomfortable part out loud rather than letting a clean-looking
  // report imply the log manages itself.
  lines.push(
    "The op log is append-only: nothing prunes it, and `hydrate()` re-reads every",
  );
  lines.push(
    "segment on each daemon start. These numbers only ever grow. Crossing a bound",
  );
  lines.push("means a runaway producer, a peer pushing junk, or the wrong project root.");
  lines.push("");
  return lines.join("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
