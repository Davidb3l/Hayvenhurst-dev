/**
 * Peer identity for sync — RFC-001 §4, Stage 1.
 *
 * WHY THIS EXISTS. `hayven sync <peer_url>` is one-shot and OUTBOUND-ONLY: the
 * responding daemon never learns who called it, and nothing anywhere records
 * that a sync happened. `config.sync_peers` is declared in `config/defaults.ts`
 * and validated in `config/load.ts` and read by NOTHING. So a daemon cannot
 * answer "who am I synced with?" — which is the substrate every later
 * capability (authorisation, audit, scheduled sync, offboarding) needs and
 * which `retention.ts` correctly identified as missing.
 *
 * This module is that substrate and nothing more. It stores who we have
 * exchanged segments with. It grants no permission, expresses no policy, and
 * gates nothing.
 *
 * ── IDENTITY: `writer_id`, NOT a second ID. ─────────────────────────────────
 *
 * Every daemon already has a stable `writer_id` in its project config
 * (`crdt/hlc.ts:loadOrCreateWriterId`) and the CRDT depends on it for op
 * attribution. Minting a second "who am I" would be the duplicate-decision-
 * function shape that has already caused several bugs here: two IDs drift, and
 * then every reader has to decide which one is authoritative. There is exactly
 * one peer identity and it is the writer ID.
 *
 * ── STORAGE: one file PER PEER, and why it is not one shared JSON file. ─────
 *
 * RFC-001 §4 names `<project>/.hayven/peers/known.json`, a single object keyed
 * by `writer_id`, and flags the hazard itself: a shared file is a read → modify
 * → write that two processes can interleave, and the project registry lost 8-10
 * of 24 concurrent registrations to exactly that. Its remedy is to reuse the
 * advisory lock in `daemon/src/daemon/registry.ts`.
 *
 * That lock is NOT reusable as it stands: `withRegistryLock` is module-private,
 * and its lease bookkeeping (`heldToken`, `lockDepth`, `leaseLost`) is
 * module-global state bound to the single hard-coded path `registryFile() +
 * ".lock"`, so it cannot guard a second, per-project file. The only exported
 * piece is `refreshLockFile`, the lease-renewal primitive, which is useless
 * without the acquire/reclaim/retry half. Copying those ~200 lines would create
 * the second implementation the RFC explicitly warns against.
 *
 * So the read-modify-write is REMOVED instead of locked: each peer is its own
 * file, `<project>/.hayven/peers/known/<writer_id>.json`, published with the
 * same unique-tmp + atomic-rename that `writeRegistry` uses. Recording peer A
 * and recording peer B now touch disjoint paths and cannot lose each other —
 * structurally, not by convention. Two processes recording the SAME peer race
 * only on that one peer's file, and `renameSync` makes the loser's outcome a
 * complete, valid record with a slightly older `last_synced`. No peer can be
 * erased by a write concerning a different peer, which is the precise failure
 * the registry suffered.
 *
 * The directory IS the registry: there is no `known.json` alongside it, because
 * two stores of the same fact is the duplicate-decision-function shape again.
 * If `withRegistryLock` is later generalised to `withFileLock(path, fn)` and
 * exported, this can move to a single locked file with no change to the shape
 * below.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WRITER_BYTES } from "./hlc.ts";

/**
 * Version of the sync wire protocol this daemon speaks, advertised in the
 * `/api/sync/merkle` handshake and stored per peer.
 *
 * Starts at 1: this is the first release in which the handshake carries a
 * version at all, so every daemon that omits the `peer` block is, by
 * definition, "unknown" rather than "version 0". (RFC-001 §4 shows `3` in its
 * illustrative JSON; there was no such counter in the code, and inventing a
 * history for it would make the first real bump ambiguous.)
 *
 * Bump this ONLY on a change to the sync request/response shapes. It is
 * recorded, never enforced — nothing branches on it yet, and adding a branch is
 * a later stage.
 */
export const SYNC_PROTOCOL_VERSION = 1;

/**
 * Hard cap on how many DISTINCT peers the registry will hold.
 *
 * Why a cap exists at all: the sync endpoints are unauthenticated, and
 * `recordPeer` turns every syntactically valid 32-hex `peer_writer_id` a caller
 * presents into a file under `.hayven/peers/known/`. Without a ceiling, a loop
 * sending random ids creates unbounded inodes on disk and buries the real
 * fleet in noise, so `hayven crdt peers` (the whole point of the registry)
 * becomes useless exactly when someone is spoofing. Identity here is
 * self-asserted, so the only defense available is bounding the damage.
 *
 * Why 64: a fleet is a handful of laptops and CI runners syncing one project.
 * 64 is generous for any real deployment (an order of magnitude above the
 * biggest fleet this tool targets) and trivially small for an attack, which is
 * the asymmetry a cap wants.
 *
 * Semantics at the cap: a NEW id is refused (no file created, `recordPeer`
 * returns null, a one-time warning names this constant). An id that is ALREADY
 * enrolled always updates, so a full registry never stops the real fleet from
 * refreshing `last_synced`. The cap is enforced best-effort per process: two
 * processes enrolling concurrently at the boundary can land a record or two
 * over, which is acceptable for a flood defense and avoids reintroducing the
 * cross-file locking this module's design deliberately removed.
 */
export const MAX_KNOWN_PEERS = 64;

/**
 * One-time latch for the cap warning. A flood is thousands of refusals in a
 * tight loop; warning once per process tells the operator what happened
 * without turning the log itself into the amplification vector.
 */
let capWarningEmitted = false;

/** Directory holding one JSON file per known peer. */
export function knownPeersDir(peersDir: string): string {
  return join(peersDir, "known");
}

/** A peer this project has exchanged segments with. RFC-001 §4 shape. */
export interface PeerRecord {
  /** The peer's daemon `writer_id`, 32 lowercase hex chars. The primary key. */
  readonly writer_id: string;
  /**
   * The most recent URL this peer was reached at, or `null` when we only ever
   * learned of it INBOUND (it called us; we have no address for it).
   *
   * Deliberately not the key: a laptop that moves between networks changes URL
   * constantly and is still the same peer. Keying by URL would have re-created
   * it as a new peer on every DHCP lease.
   */
  readonly last_url: string | null;
  /** ISO-8601 UTC of the first exchange with this peer. */
  readonly first_seen: string;
  /** ISO-8601 UTC of the most recent exchange. */
  readonly last_synced: string;
  /**
   * The peer's advertised {@link SYNC_PROTOCOL_VERSION}, or `null` for a peer
   * that sent no `peer` block.
   *
   * `null` means UNKNOWN, and must never be read as "old" or as any particular
   * version — an older daemon omits the field entirely, and assuming a value
   * for it is how a compatibility check starts silently mis-classifying peers.
   */
  readonly protocol: number | null;
}

/** The additive `peer` block on `GET /api/sync/merkle`. */
export interface PeerHandshake {
  readonly writer_id: string;
  readonly protocol: number;
}

/**
 * True for a syntactically valid writer ID: exactly `WRITER_BYTES * 2`
 * LOWERCASE hex chars.
 *
 * Load-bearing twice over. (1) The ID becomes a FILENAME, so anything that is
 * not `[0-9a-f]` — `..`, `/`, NUL, an absolute path — must never reach `join`;
 * this rejects all of them by construction rather than by blacklist. (2) It
 * comes off the wire from an unauthenticated peer, so it is untrusted input.
 *
 * Uppercase is rejected rather than folded: `writerIdToHex` only ever emits
 * lowercase, so accepting `AB…` would let one peer occupy two records (and, on
 * a case-insensitive filesystem such as macOS's default, two records that
 * silently clobber each other).
 */
export function isWriterIdHex(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${WRITER_BYTES * 2}}$`).test(value);
}

/**
 * Read the `peer` block off a `/api/sync/merkle` response.
 *
 * ADDITIVE-ONLY CONTRACT: an older peer omits the block, and that is NOT an
 * error — it returns `null`, meaning "unknown, assume nothing". Anything
 * malformed is treated the same way, because the alternative is that one peer
 * running a broken build makes `hayven sync` fail outright for a feature that
 * only records metadata. Identity is a nice-to-have on top of segment
 * exchange; it must never be able to break segment exchange.
 */
export function parsePeerHandshake(value: unknown): PeerHandshake | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { writer_id?: unknown; protocol?: unknown };
  if (!isWriterIdHex(raw.writer_id)) return null;
  const protocol = raw.protocol;
  if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol < 0) return null;
  return { writer_id: raw.writer_id, protocol };
}

/** Parse one on-disk record, or `null` if the file is not a usable record. */
function parseRecord(text: string, expectedWriterId: string): PeerRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  // Trust the FILENAME over the body's `writer_id`. The filename is what makes
  // records disjoint, so a body claiming a different ID (hand-edited, or a
  // half-written copy) must not be able to smuggle a second identity into a
  // listing that is supposed to be keyed by file.
  if (raw["writer_id"] !== expectedWriterId) return null;
  const firstSeen = typeof raw["first_seen"] === "string" ? raw["first_seen"] : null;
  const lastSynced = typeof raw["last_synced"] === "string" ? raw["last_synced"] : null;
  if (firstSeen === null || lastSynced === null) return null;
  const url = typeof raw["last_url"] === "string" ? raw["last_url"] : null;
  const protocolRaw = raw["protocol"];
  const protocol =
    typeof protocolRaw === "number" && Number.isInteger(protocolRaw) && protocolRaw >= 0
      ? protocolRaw
      : null;
  return {
    writer_id: expectedWriterId,
    last_url: url,
    first_seen: firstSeen,
    last_synced: lastSynced,
    protocol,
  };
}

/**
 * Every known peer, sorted by `writer_id` for a stable listing.
 *
 * READ-ONLY and DAEMONLESS: it stats and reads a handful of tiny files and
 * touches nothing else, so it is safe to run against a live daemon's project
 * and works with no daemon running at all.
 *
 * Never throws for a missing directory (a project that has never synced) or an
 * unreadable/corrupt record (skipped). `hayven crdt peers` is a diagnostic; a
 * diagnostic that crashes on the state it exists to describe is useless.
 */
export function readKnownPeers(peersDir: string): PeerRecord[] {
  const dir = knownPeersDir(peersDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PeerRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // skips our own `.tmp.*` publish scratch
    const writerId = name.slice(0, -".json".length);
    if (!isWriterIdHex(writerId)) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const rec = parseRecord(text, writerId);
    if (rec !== null) out.push(rec);
  }
  out.sort((a, b) => (a.writer_id < b.writer_id ? -1 : a.writer_id > b.writer_id ? 1 : 0));
  return out;
}

/** One known peer by ID, or `null`. */
export function readKnownPeer(peersDir: string, writerId: string): PeerRecord | null {
  if (!isWriterIdHex(writerId)) return null;
  let text: string;
  try {
    text = readFileSync(join(knownPeersDir(peersDir), `${writerId}.json`), "utf8");
  } catch {
    return null;
  }
  return parseRecord(text, writerId);
}

/**
 * How many registry SLOTS are occupied: files in `known/` whose name is a
 * valid `<writer_id>.json`. Counts filenames, not parsed records, on purpose:
 * a corrupt-but-hex-named file still occupies an inode (the resource the cap
 * bounds), and parsing every record just to count would make the cap check
 * O(registry bytes) on every inbound request.
 */
function countKnownPeerFiles(peersDir: string): number {
  let names: string[];
  try {
    names = readdirSync(knownPeersDir(peersDir));
  } catch {
    return 0; // no directory yet: an empty registry
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue; // skips `.tmp.*` publish scratch
    if (isWriterIdHex(name.slice(0, -".json".length))) count += 1;
  }
  return count;
}

export interface RecordPeerOptions {
  /** The peer's `writer_id`, straight off the wire — validated here. */
  readonly writerId: unknown;
  /** URL we reached the peer at (outbound). Omit for inbound: a caller's
   *  address is not a URL we can dial back. */
  readonly url?: string | undefined;
  /** The peer's advertised protocol version, or `null`/omitted if unknown. */
  readonly protocol?: number | null | undefined;
  /**
   * THIS daemon's own `writer_id`. Required, and not optional by design: a
   * daemon must never enrol itself as its own peer.
   *
   * `hayven sync` pushes pulled segments into its OWN local daemon over the
   * same `/api/sync/push` route it uses for the remote, so without this guard
   * the very first sync would create a self-record — and every later feature
   * built on "who am I synced with?" (scheduled sync, offboarding) would then
   * treat the local daemon as a remote peer.
   */
  readonly selfWriterId: string;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  readonly now?: () => number;
}

/**
 * Record an exchange with a peer, creating or updating its file.
 *
 * Returns the stored record, or `null` when nothing was recorded: an invalid
 * writer ID, the peer being us, or a NEW peer arriving with the registry
 * already at {@link MAX_KNOWN_PEERS}. Never throws — a failed write is reported by
 * the `null` return, because losing the ABILITY TO SYNC over a failure to write
 * a metadata file would be a strictly worse bug than not having the metadata.
 *
 * `first_seen` is preserved across updates: it is the one field that answers
 * "how long has this peer been in the fleet?", and recomputing it on every
 * sync would silently pin it to the most recent one.
 */
export function recordPeer(peersDir: string, opts: RecordPeerOptions): PeerRecord | null {
  const { writerId, selfWriterId } = opts;
  if (!isWriterIdHex(writerId)) return null;
  // Self is not a peer — see RecordPeerOptions.selfWriterId.
  if (writerId === selfWriterId) return null;

  const nowMs = (opts.now ?? Date.now)();
  const stamp = new Date(nowMs).toISOString();
  const existing = readKnownPeer(peersDir, writerId);
  // Flood defense (see MAX_KNOWN_PEERS): a NEW id must not mint a file once
  // the registry is full. KNOWN ids fall through, so a full registry still
  // refreshes `last_synced` for the real fleet. `existing` is the parsed
  // record, so an id whose file exists but is corrupt reads as "new" here;
  // that is fine, because its slot is already counted below and the refusal
  // just declines to repair a record a flood may itself have produced.
  if (existing === null && countKnownPeerFiles(peersDir) >= MAX_KNOWN_PEERS) {
    if (!capWarningEmitted) {
      capWarningEmitted = true;
      process.stderr.write(
        `hayven: peer registry is at its cap of ${MAX_KNOWN_PEERS} known peers; ` +
          "refusing to enroll new peer ids (further refusals will not be logged). " +
          "If these are real peers, prune stale records under .hayven/peers/known/.\n",
      );
    }
    return null;
  }
  const protocol =
    typeof opts.protocol === "number" && Number.isInteger(opts.protocol) && opts.protocol >= 0
      ? opts.protocol
      : // Keep what we already knew rather than downgrading a known peer to
        // "unknown" because one exchange (an inbound push, which carries no
        // handshake) did not restate it.
        (existing?.protocol ?? null);
  const record: PeerRecord = {
    writer_id: writerId,
    // Same reasoning as `protocol`: an inbound exchange has no URL, and must
    // not erase the address a previous outbound sync learned.
    last_url: opts.url ?? existing?.last_url ?? null,
    first_seen: existing?.first_seen ?? stamp,
    last_synced: stamp,
    protocol,
  };

  const dir = knownPeersDir(peersDir);
  const finalPath = join(dir, `${writerId}.json`);
  // Unique tmp + rename, the same publish `writeRegistry` uses. A plain
  // `writeFileSync` to `finalPath` is not atomic: a crash or a concurrent
  // reader mid-write yields a truncated file, i.e. a peer that reads as corrupt
  // and is silently skipped by `readKnownPeers`.
  const tmpPath = join(
    dir,
    `.tmp.${writerId}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
  );
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n", "utf8");
    renameSync(tmpPath, finalPath);
  } catch {
    // Read-only FS, ENOSPC, bad perms. Best-effort cleanup so a failed publish
    // does not leave scratch files accumulating in the peers directory.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* nothing further to try */
    }
    return null;
  }
  return record;
}
