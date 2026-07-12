// The suite event spine — hayven's PRODUCER side (SUITE_CONTRACTS §2).
//
// Every time the watcher re-ingests changed code we append ONE `code.changed`
// event to `<repoRoot>/.suite/events/<UTC-date>.jsonl`. The file is a plain
// JSONL append log, daily-bucketed by the event's UTC day, shared across every
// tool in the suite. Consumers tail it; we only ever append.
//
// The ONE hard invariant: every line we emit — INCLUDING its trailing `\n` —
// is < 4096 bytes of UTF-8. A write below the OS pipe/file atomic-write size,
// done as a single O_APPEND write, is atomic and needs no lock: concurrent
// producers never interleave a partial line. So we bound the line and write it
// whole, once. If the natural payload would blow the budget we progressively
// shed data (symbols first, then files) rather than ever emit an oversized —
// and therefore possibly torn — line.
//
// BEST-EFFORT: the spine is telemetry, never a dependency of ingest. Any
// failure here (missing dir we can't create, no perms, a serialize error) is
// logged to stderr and swallowed. It MUST NEVER break or fail re-ingest, and
// callers only invoke it AFTER the re-ingest is durable.

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { utcDate } from "./crdt/oplog.ts";

/**
 * Max bytes for a spine line, trailing `\n` included. Kept below the atomic
 * single-write size so one O_APPEND write can never tear against a concurrent
 * producer. Every `buildCodeChangedLine` output satisfies `byteLen(line)+1 < MAX`.
 */
const MAX_LINE_BYTES = 4096;

const SOURCE = "hayven" as const;
const TYPE = "code.changed" as const;

/** UTF-8 byte length of a string (not its UTF-16 `.length`). */
function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Serialize one spine envelope to a single line (no trailing newline). */
function envelope(
  id: string,
  ts: string,
  refs: string[],
  data: Record<string, unknown>,
): string {
  return JSON.stringify({ v: 1, id, ts, source: SOURCE, type: TYPE, refs, data });
}

/** Does this line — plus its future trailing `\n` — fit the atomic budget? */
function fits(line: string): boolean {
  return byteLen(line) + 1 < MAX_LINE_BYTES;
}

/**
 * Build the `code.changed` line for the given change set, guaranteeing it fits
 * `MAX_LINE_BYTES` with room for the newline. Mirrors Sirius's Rust spine:
 *   1. Full payload `{files, symbols}` with `refs = hayven:node/<id>` per symbol.
 *   2. On overflow, PRESERVE files, drop symbols/refs: `{files, symbols:[], truncated:true}`.
 *   3. If even that overflows (huge file set), the minimal marker `{truncated:true}`.
 * Step 3 always fits — the envelope skeleton is a few dozen bytes.
 */
export function buildCodeChangedLine(opts: {
  id: string;
  ts: string;
  files: string[];
  symbols: string[];
}): string {
  const { id, ts, files, symbols } = opts;
  const refs = symbols.map((s) => `hayven:node/${s}`);

  const full = envelope(id, ts, refs, { files, symbols });
  if (fits(full)) return full;

  // Shed symbols first — the file list is the more useful survivor for a
  // downstream consumer, and it's usually far smaller than the symbol set.
  const filesOnly = envelope(id, ts, [], { files, symbols: [], truncated: true });
  if (fits(filesOnly)) return filesOnly;

  // Last resort: an empty marker so the line still fits and stays atomic.
  return envelope(id, ts, [], { truncated: true });
}

/**
 * Append one `code.changed` event to the shared spine. Best-effort: never
 * throws. `now` is injectable for deterministic tests; production omits it.
 */
export function emitCodeChanged(opts: {
  repoRoot: string;
  files: string[];
  symbols: string[];
  now?: () => number;
}): void {
  try {
    const nowMs = opts.now ? opts.now() : Date.now();
    const id = randomUUID(); // lowercase, hyphenated UUIDv4 per contract
    const ts = new Date(nowMs).toISOString(); // ISO-8601 UTC, `Z`-suffixed
    const line = buildCodeChangedLine({
      id,
      ts,
      files: opts.files,
      symbols: opts.symbols,
    });

    const path = join(opts.repoRoot, ".suite", "events", `${utcDate(nowMs)}.jsonl`);
    // Create the events dir on first write; append the whole line in one call.
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line + "\n");
  } catch (err) {
    // Telemetry must never break ingest — log and swallow.
    process.stderr.write(
      `hayven spine: code.changed emit failed (non-fatal): ${(err as Error).message}\n`,
    );
  }
}
