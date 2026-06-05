/**
 * Model download / verify / atomic-install machinery — ARCHITECTURE.md §18.3.
 *
 * `pullModel` creates the per-model directory, downloads each artifact to a temp
 * file, sha256-verifies it (when a hash is declared), then atomically renames it
 * into place. It is idempotent: a present + verified artifact is skipped.
 *
 * The network is behind an injectable `fetch` seam (`PullOptions.fetchImpl`) so
 * the whole path unit-tests against a tiny fixture + its known sha256 with NO
 * real network. Production passes the global `fetch`.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  MODEL_REGISTRY,
  modelDir,
  type ModelArtifact,
  type ModelEntry,
} from "./registry.ts";

/** Minimal fetch shape we depend on — lets tests inject a stub. */
export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  /** A web ReadableStream of the body bytes (may be null on empty bodies). */
  body: ReadableStream<Uint8Array> | null;
}>;

export interface PullOptions {
  /** Injected fetch (defaults to global fetch). */
  readonly fetchImpl?: FetchLike;
  /** Progress sink (defaults to writing to stdout). */
  readonly onProgress?: (line: string) => void;
}

export type ArtifactStatus =
  | "downloaded" // fetched, verified (or verification skipped), installed
  | "skipped-present" // already present + verified on disk
  | "verify-skipped"; // installed but no hash was available to verify against

export interface ArtifactResult {
  readonly filename: string;
  readonly status: ArtifactStatus;
}

export interface PullResult {
  readonly id: string;
  readonly dir: string;
  readonly artifacts: readonly ArtifactResult[];
}

/** Thrown when a download or verification fails; pull leaves no partial file. */
export class PullError extends Error {}

function noop(): void {}

/**
 * Stream-hash a file on disk to a lowercase-hex sha256. Reads the file through
 * a stream (NOT a full-buffer read) so re-verifying a multi-GB present model on
 * an idempotent re-pull never loads the whole weight into memory.
 */
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * Download `artifact.url` to a temp file inside `dir`, sha256-verify it (when a
 * hash is declared), and atomically rename it to `dir/<filename>`. Throws (and
 * cleans up the temp file) on any HTTP or verification failure — never leaves a
 * partial or unverified file at the final path.
 */
async function installArtifact(
  dir: string,
  artifact: ModelArtifact,
  fetchImpl: FetchLike,
  log: (line: string) => void,
): Promise<ArtifactStatus> {
  const finalPath = join(dir, artifact.filename);
  const hasHash = artifact.sha256.length > 0;

  // Idempotent: a present file that still verifies is skipped. A present file
  // with no declared hash is trusted-as-present (we can't re-verify it).
  if (existsSync(finalPath)) {
    if (!hasHash) {
      log(`  ${artifact.filename}: present (no hash to re-verify) — skipping`);
      return "skipped-present";
    }
    const actual = await sha256File(finalPath);
    if (actual === artifact.sha256) {
      log(`  ${artifact.filename}: present + verified — skipping`);
      return "skipped-present";
    }
    log(`  ${artifact.filename}: present but sha256 mismatch — re-downloading`);
  }

  if (!hasHash) {
    // Every artifact CURRENTLY in MODEL_REGISTRY has its real published HF LFS
    // oid pinned (re-verified for BL-18 via `POST /api/models/<repo>/paths-info`
    // → `lfs.oid`), so this branch is never hit by a registry pull today. It
    // remains the honest fallback for any FUTURE artifact whose hash we cannot
    // obtain: warn loudly and skip verification rather than inventing a hash.
    // NOTE: not reachable for any model currently in MODEL_REGISTRY — every
    // shipped entry (gemma3:1b/4b, gemma2:2b, gemma4:e2b/e4b/26b) has its real
    // published HF LFS oid pinned (BL-18). This warning is the honest fallback
    // for any FUTURE registry entry added with an empty `sha256`; to pin it,
    // read the oid from the HF API and set `sha256` on that entry.
    log(
      `  WARNING: ${artifact.filename} has NO pinned sha256 in the registry — ` +
        `downloading WITHOUT integrity verification.\n` +
        `  To pin it, obtain the real HF LFS oid (sha256) for ${artifact.url} ` +
        `and set it on this entry in registry.ts.\n` +
        `  (HF API: POST /api/models/<repo>/paths-info/main {"paths":["<file>.gguf"]} → lfs.oid)`,
    );
  }

  // Download to a unique temp file in the SAME directory (so rename is atomic —
  // same filesystem, no cross-device copy).
  const tmpPath = join(dir, `.${artifact.filename}.${process.pid}.${Date.now()}.tmp`);

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    log(`  ${artifact.filename}: downloading ${artifact.url}`);
    res = await fetchImpl(artifact.url);
  } catch (err) {
    throw new PullError(
      `download failed for ${artifact.filename}: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new PullError(
      `download failed for ${artifact.filename}: HTTP ${res.status} ${res.statusText ?? ""}`.trim(),
    );
  }
  if (!res.body) {
    throw new PullError(`download failed for ${artifact.filename}: empty response body`);
  }

  // Stream the body to the temp file while incrementally hashing, so a
  // multi-GB weight never has to live fully in memory.
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const out = createWriteStream(tmpPath);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          hash.update(value);
          bytes += value.byteLength;
          if (!out.write(value)) {
            await new Promise<void>((resolve) => out.once("drain", resolve));
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    safeUnlink(tmpPath);
    throw new PullError(
      `write failed for ${artifact.filename}: ${(err as Error).message}`,
    );
  }

  // Verify before install. A mismatch must NOT leave a file at the final path.
  if (hasHash) {
    const actual = hash.digest("hex");
    if (actual !== artifact.sha256) {
      safeUnlink(tmpPath);
      throw new PullError(
        `sha256 mismatch for ${artifact.filename}: expected ${artifact.sha256}, got ${actual} ` +
          `(${bytes} bytes downloaded). Refusing to install.`,
      );
    }
    log(`  ${artifact.filename}: verified sha256 ${actual.slice(0, 12)}… (${bytes} bytes)`);
  }

  // Atomic install: rename within the same dir.
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    safeUnlink(tmpPath);
    throw new PullError(
      `install failed for ${artifact.filename}: ${(err as Error).message}`,
    );
  }

  return hasHash ? "downloaded" : "verify-skipped";
}

function safeUnlink(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Pull every artifact for a model id into its per-model directory.
 * Idempotent; verifies each artifact; atomic per-artifact install.
 */
export async function pullModel(
  hayvenDir: string,
  id: string,
  opts: PullOptions = {},
): Promise<PullResult> {
  const entry: ModelEntry | undefined = MODEL_REGISTRY[id];
  if (!entry) {
    throw new PullError(`unknown model id: "${id}" (not in the registry)`);
  }
  const dir = modelDir(hayvenDir, id);
  if (!dir) {
    // Unreachable given the entry check, but keeps the type honest.
    throw new PullError(`no model directory for id: "${id}"`);
  }
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const log = opts.onProgress ?? noop;

  mkdirSync(dir, { recursive: true });
  log(`Pulling ${id} → ${dir}`);

  const results: ArtifactResult[] = [];
  for (const artifact of entry.artifacts) {
    const status = await installArtifact(dir, artifact, fetchImpl, log);
    results.push({ filename: artifact.filename, status });
  }

  return { id, dir, artifacts: results };
}

/** Total size on disk (bytes) of an installed model's artifacts, best-effort. */
export function installedBytes(hayvenDir: string, id: string): number {
  const dir = modelDir(hayvenDir, id);
  const entry = MODEL_REGISTRY[id];
  if (!dir || !entry) return 0;
  let total = 0;
  for (const a of entry.artifacts) {
    const p = join(dir, a.filename);
    try {
      if (existsSync(p)) total += statSync(p).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}
