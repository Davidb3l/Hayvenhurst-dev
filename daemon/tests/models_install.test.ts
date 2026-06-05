// Model download / verify / atomic-install — ARCHITECTURE.md §18.3.
//
// Exercises the real machinery against tiny in-memory fixtures + a STUB fetch
// (no network). A real network pull is the human-run path (`hayven models pull`).
// The single optional network test is gated behind HAYVEN_MODEL_NET_TEST and
// skipped by default.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PullError,
  pullModel,
  type FetchLike,
} from "../src/models/install.ts";
import {
  MODEL_REGISTRY,
  modelDir,
  modelPath,
  type ModelEntry,
} from "../src/models/registry.ts";

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** A stub fetch backed by an in-memory URL→bytes map. */
function stubFetch(
  routes: Record<string, Uint8Array | { status: number }>,
  spy?: { urls: string[] },
): FetchLike {
  return async (url: string) => {
    spy?.urls.push(url);
    const r = routes[url];
    if (r === undefined) return { ok: false, status: 404, statusText: "Not Found", body: null };
    if (r instanceof Uint8Array) {
      return {
        ok: true,
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(r);
            c.close();
          },
        }),
      };
    }
    return { ok: false, status: r.status, statusText: "stub error", body: null };
  };
}

/**
 * Swap a registry entry's single artifact to a stub url + (optionally) the
 * fixture's real sha256, returning a restore fn. Keeps the test independent of
 * the real Hugging Face coordinates.
 */
function withStubArtifact(
  id: string,
  url: string,
  hash: string,
): { entry: ModelEntry; restore: () => void } {
  const original = MODEL_REGISTRY[id]!;
  const patched: ModelEntry = {
    ...original,
    artifacts: [{ filename: "model.gguf", url, sha256: hash }],
  };
  (MODEL_REGISTRY as Record<string, ModelEntry>)[id] = patched;
  return {
    entry: patched,
    restore: () => {
      (MODEL_REGISTRY as Record<string, ModelEntry>)[id] = original;
    },
  };
}

let tmp: string;
let hayvenDir: string;
const FIXTURE = new TextEncoder().encode("hayven-tiny-gguf-fixture\n");
const FIXTURE_SHA = sha256(FIXTURE);
const URL = "stub://models/tiny.gguf";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hayven-install-"));
  hayvenDir = join(tmp, ".hayven");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("pullModel — download + verify + atomic install", () => {
  test("happy path: downloads, verifies, installs model.gguf in the model dir", async () => {
    const { restore } = withStubArtifact("gemma4:e2b", URL, FIXTURE_SHA);
    try {
      const res = await pullModel(hayvenDir, "gemma4:e2b", {
        fetchImpl: stubFetch({ [URL]: FIXTURE }),
      });
      expect(res.artifacts[0]!.status).toBe("downloaded");
      const p = modelPath(hayvenDir, "gemma4:e2b")!;
      expect(existsSync(p)).toBe(true);
      expect(new Uint8Array(readFileSync(p))).toEqual(FIXTURE);
    } finally {
      restore();
    }
  });

  test("sha256 mismatch: throws PullError and leaves NO file at the final path", async () => {
    const wrongHash = sha256(new TextEncoder().encode("different content"));
    const { restore } = withStubArtifact("gemma4:e2b", URL, wrongHash);
    try {
      await expect(
        pullModel(hayvenDir, "gemma4:e2b", { fetchImpl: stubFetch({ [URL]: FIXTURE }) }),
      ).rejects.toBeInstanceOf(PullError);

      const dir = modelDir(hayvenDir, "gemma4:e2b")!;
      // No model.gguf installed, and no leftover temp file.
      expect(existsSync(modelPath(hayvenDir, "gemma4:e2b")!)).toBe(false);
      const leftovers = existsSync(dir) ? readdirSync(dir) : [];
      expect(leftovers).toEqual([]);
    } finally {
      restore();
    }
  });

  test("HTTP error: throws PullError, no partial file", async () => {
    const { restore } = withStubArtifact("gemma4:e2b", URL, FIXTURE_SHA);
    try {
      await expect(
        pullModel(hayvenDir, "gemma4:e2b", {
          fetchImpl: stubFetch({ [URL]: { status: 503 } }),
        }),
      ).rejects.toBeInstanceOf(PullError);
      expect(existsSync(modelPath(hayvenDir, "gemma4:e2b")!)).toBe(false);
    } finally {
      restore();
    }
  });

  test("idempotent: a second pull skips the present+verified artifact (no re-fetch)", async () => {
    const { restore } = withStubArtifact("gemma4:e2b", URL, FIXTURE_SHA);
    try {
      const spy = { urls: [] as string[] };
      const fetchImpl = stubFetch({ [URL]: FIXTURE }, spy);
      await pullModel(hayvenDir, "gemma4:e2b", { fetchImpl });
      expect(spy.urls.length).toBe(1);

      const res2 = await pullModel(hayvenDir, "gemma4:e2b", { fetchImpl });
      expect(res2.artifacts[0]!.status).toBe("skipped-present");
      expect(spy.urls.length).toBe(1); // not fetched again
    } finally {
      restore();
    }
  });

  test("present-but-corrupt file is re-downloaded and re-verified", async () => {
    const { restore } = withStubArtifact("gemma4:e2b", URL, FIXTURE_SHA);
    try {
      const fetchImpl = stubFetch({ [URL]: FIXTURE });
      // Pre-seed a corrupt model.gguf.
      const { mkdirSync } = await import("node:fs");
      mkdirSync(modelDir(hayvenDir, "gemma4:e2b")!, { recursive: true });
      writeFileSync(modelPath(hayvenDir, "gemma4:e2b")!, "corrupt");

      const res = await pullModel(hayvenDir, "gemma4:e2b", { fetchImpl });
      expect(res.artifacts[0]!.status).toBe("downloaded");
      expect(new Uint8Array(readFileSync(modelPath(hayvenDir, "gemma4:e2b")!))).toEqual(FIXTURE);
    } finally {
      restore();
    }
  });

  test("re-verify of a present file streams the hash (no full-buffer of a large file)", async () => {
    // Regression: sha256File must stream the on-disk file through the hash, not
    // readFile() the whole thing into memory — otherwise an idempotent re-pull
    // of a multi-GB present model would buffer the entire weight in RAM.
    // A multi-MB fixture that is larger than one stream chunk (64 KiB) proves
    // the chunked path assembles the hash correctly and the present file is
    // skipped (which only happens when the streamed hash MATCHES).
    const big = new Uint8Array(5 * 1024 * 1024 + 7); // 5 MiB + odd tail
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const bigHash = sha256(big);
    const { restore } = withStubArtifact("gemma4:e2b", URL, bigHash);
    try {
      const spy = { urls: [] as string[] };
      const fetchImpl = stubFetch({ [URL]: big }, spy);
      // First pull installs it.
      await pullModel(hayvenDir, "gemma4:e2b", { fetchImpl });
      expect(spy.urls.length).toBe(1);
      // Second pull must re-verify the present file by streaming, match, and
      // skip without re-fetching.
      const res2 = await pullModel(hayvenDir, "gemma4:e2b", { fetchImpl });
      expect(res2.artifacts[0]!.status).toBe("skipped-present");
      expect(spy.urls.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("empty sha256: installs WITHOUT verification (verify-skipped status)", async () => {
    const { restore } = withStubArtifact("gemma4:e2b", URL, "");
    try {
      const res = await pullModel(hayvenDir, "gemma4:e2b", {
        fetchImpl: stubFetch({ [URL]: FIXTURE }),
      });
      expect(res.artifacts[0]!.status).toBe("verify-skipped");
      expect(existsSync(modelPath(hayvenDir, "gemma4:e2b")!)).toBe(true);
    } finally {
      restore();
    }
  });

  test("unknown id: rejects with PullError before touching disk", async () => {
    await expect(
      pullModel(hayvenDir, "nope:0b", { fetchImpl: stubFetch({}) }),
    ).rejects.toBeInstanceOf(PullError);
    expect(existsSync(join(hayvenDir, "models"))).toBe(false);
  });

  // Opt-in real-network smoke test for the human to run on their machine.
  // Default-skipped — set HAYVEN_MODEL_NET_TEST=1 to actually hit Hugging Face
  // (downloads multi-GB weights; not for CI).
  const netTest = process.env["HAYVEN_MODEL_NET_TEST"] === "1" ? test : test.skip;
  netTest("real network: pulls + verifies the configured tier-3 model", async () => {
    const id = "gemma4:e2b";
    const res = await pullModel(hayvenDir, id, {
      onProgress: (l) => console.log(l),
    });
    expect(res.artifacts.every((a) => a.status !== "verify-skipped")).toBe(true);
  });
});
