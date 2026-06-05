// Per-CRDT-type Merkle tree over the §14 segment files. ARCHITECTURE.md §15.1.
//
// A leaf corresponds to one HLC-day segment. Its hash is computed over the
// *set* of op composite keys in that segment (sorted, de-duplicated) — NOT
// the raw file bytes. This is load-bearing: two peers that hold the same
// op-set for a day produce the same leaf even though their segment files
// append those ops in different orders. Hashing raw bytes (the original
// design) could never converge two real peers, because each appends in its
// own order.
//
// Domain separation: leaves are hashed with a 0x00 prefix, internal nodes
// with 0x01, so a leaf hash can never be mistaken for an internal-node hash
// (second-preimage defense). Odd levels promote the unpaired node unchanged
// rather than duplicating it (the classic Merkle duplication weakness where
// root([A,B,C]) == root([A,B,C,C])).
//
// A per-segment leaf-hash cache lives in `.hayven/crdt/merkle.json`, keyed by
// (mtime, size, tailHex); decoding a segment to extract its op keys is the
// expensive part and the cache skips it for unchanged days.
//
// BL-3: the cache key carries a content discriminator (`tailHex`, the
// segment's last ≤16 bytes) in addition to (mtime, size). On a filesystem
// with second-resolution mtime, a same-second overwrite that lands the SAME
// byte length would otherwise re-serve a stale leaf hash — two divergent peers
// would then report equal roots and sync would wrongly skip. The file tail
// changes with overwhelming probability on any append or torn-write rewrite,
// so this closes the stale-leaf hole at the cost of one tiny tail read (done
// inside `OpLog.segmentStat`). This also makes §15.1's implicit cache
// invalidation correct without an explicit `invalidate()` hook (see BL-6).

import { blake3 } from "@noble/hashes/blake3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CrdtType, OpLog } from "./oplog.ts";

const TYPES: readonly CrdtType[] = ["lww", "gset", "orset"];
const LEAF_TAG = 0x00;
const NODE_TAG = 0x01;

export interface SegmentLeaf {
  /** Segment day — `YYYY-MM-DD`. */
  path: string;
  /** blake3 hex over the segment's sorted op-key set (leaf-domain). */
  hash: string;
}

export interface MerkleSnapshot {
  roots: Record<CrdtType, string>;
  leaves: Record<CrdtType, SegmentLeaf[]>;
}

interface CacheEntry {
  hash: string;
  mtimeMs: number;
  size: number;
  /** Content discriminator: the segment's last ≤16 bytes, hex (BL-3). */
  tailHex: string;
}

interface CacheFileV2 {
  v: 2;
  segments: Record<string, CacheEntry>;
}

const EMPTY_ROOT_HEX = bytesToHex(blake3(Uint8Array.of(NODE_TAG)));

/**
 * Compute a fresh snapshot from the op log's segments. Re-uses cached
 * per-segment leaf hashes when (mtime, size, tailHex) match; otherwise decodes
 * the segment to extract its op-key set. Persists the updated cache.
 */
export function computeMerkle(oplog: OpLog): MerkleSnapshot {
  const cacheFile = join(oplog.root, "merkle.json");
  const cache = loadCache(cacheFile);
  const roots = {} as Record<CrdtType, string>;
  const leaves = {} as Record<CrdtType, SegmentLeaf[]>;
  let dirty = false;

  for (const type of TYPES) {
    const typeLeaves: SegmentLeaf[] = [];
    for (const day of oplog.listSegmentDays(type)) {
      const cacheKey = `${type}/${day}`;
      const stat = oplog.segmentStat(type, day);
      const cached = cache.segments[cacheKey];
      let hash: string;
      if (
        stat &&
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.size === stat.size &&
        cached.tailHex === stat.tailHex
      ) {
        hash = cached.hash;
      } else {
        hash = leafHash(oplog.segmentCompositeKeys(type, day));
        if (stat) {
          cache.segments[cacheKey] = {
            hash,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            tailHex: stat.tailHex,
          };
          dirty = true;
        }
      }
      typeLeaves.push({ path: day, hash });
    }
    leaves[type] = typeLeaves;
    roots[type] = rootOf(typeLeaves);
  }

  if (dirty) saveCache(cacheFile, cache);
  return { roots, leaves };
}

/** Just the per-type root hashes — for the GET /api/sync/merkle handler. */
export function computeRoots(oplog: OpLog): Record<CrdtType, string> {
  return computeMerkle(oplog).roots;
}

export interface MerkleDiff {
  /** Segments present remotely-but-not-locally, or where the hash differs. */
  pull: { type: CrdtType; path: string; hash: string }[];
  /** Segments present locally-but-not-remotely. */
  push: { type: CrdtType; path: string; hash: string }[];
}

export function diffSnapshots(ours: MerkleSnapshot, theirs: MerkleSnapshot): MerkleDiff {
  const pull: MerkleDiff["pull"] = [];
  const push: MerkleDiff["push"] = [];
  for (const type of TYPES) {
    const ourByPath = new Map<string, string>();
    for (const l of ours.leaves[type]) ourByPath.set(l.path, l.hash);
    const theirByPath = new Map<string, string>();
    for (const l of theirs.leaves[type]) theirByPath.set(l.path, l.hash);

    for (const [path, hash] of theirByPath) {
      if (ourByPath.get(path) !== hash) pull.push({ type, path, hash });
    }
    for (const [path, hash] of ourByPath) {
      if (!theirByPath.has(path)) push.push({ type, path, hash });
    }
  }
  return { pull, push };
}

/** Leaf hash: 0x00 domain tag, then each sorted op key's bytes. */
function leafHash(sortedKeysHex: string[]): string {
  let totalLen = 1;
  const keyByteArrays = sortedKeysHex.map((k) => hexToBytes(k));
  for (const k of keyByteArrays) totalLen += k.length;
  const buf = new Uint8Array(totalLen);
  buf[0] = LEAF_TAG;
  let off = 1;
  for (const k of keyByteArrays) {
    buf.set(k, off);
    off += k.length;
  }
  return bytesToHex(blake3(buf));
}

/** Canonical root over leaves: sort by hash, pair with 0x01-tagged combine,
 *  promote (not duplicate) an odd node. Insertion-order-independent. */
function rootOf(leaves: SegmentLeaf[]): string {
  if (leaves.length === 0) return EMPTY_ROOT_HEX;
  let level = leaves
    .map((l) => l.hash)
    .sort()
    .map((h) => hexToBytes(h));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        next.push(combine(level[i]!, level[i + 1]!));
      } else {
        next.push(level[i]!); // promote unpaired node unchanged
      }
    }
    level = next;
  }
  return bytesToHex(level[0]!);
}

function combine(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [first, second] = byteCompare(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(1 + first.length + second.length);
  buf[0] = NODE_TAG;
  buf.set(first, 1);
  buf.set(second, 1 + first.length);
  return blake3(buf);
}

function byteCompare(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    if (av !== bv) return av - bv;
  }
  return a.length - b.length;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex string must have even length: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function loadCache(path: string): CacheFileV2 {
  if (!existsSync(path)) return { v: 2, segments: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 2 &&
      typeof (parsed as { segments?: unknown }).segments === "object"
    ) {
      return parsed as CacheFileV2;
    }
  } catch {
    // Corrupt cache → treat as empty; every segment re-decodes.
  }
  return { v: 2, segments: {} };
}

function saveCache(path: string, cache: CacheFileV2): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache) + "\n", "utf8");
}
