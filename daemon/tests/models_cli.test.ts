// `hayven models <list|pull>` CLI surface — ARCHITECTURE.md §18.3.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runModels } from "../src/cli/models.ts";
import {
  MODEL_REGISTRY,
  modelDir,
  modelPath,
  type ModelEntry,
} from "../src/models/registry.ts";

/** Capture process.stdout/stderr writes for the duration of `fn`. */
async function capture(fn: () => Promise<number> | number): Promise<{
  code: number;
  out: string;
  err: string;
}> {
  let out = "";
  let err = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => ((err += chunk), true)) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

/**
 * Swap a registry entry's single artifact to a stub url + hash, returning a
 * restore fn — keeps a pull test off the real Hugging Face coordinates.
 */
function withStubArtifact(id: string, url: string, hash: string): { restore: () => void } {
  const original = MODEL_REGISTRY[id]!;
  (MODEL_REGISTRY as Record<string, ModelEntry>)[id] = {
    ...original,
    artifacts: [{ filename: "model.gguf", url, sha256: hash }],
  };
  return {
    restore: () => {
      (MODEL_REGISTRY as Record<string, ModelEntry>)[id] = original;
    },
  };
}

let tmp: string;
let prevCwd: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hayven-models-cli-"));
  mkdirSync(join(tmp, ".hayven"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(tmp);
  // Weights resolve GLOBAL-first, so the per-test store must be sandboxed here
  // or presence would leak between tests (and from other test files) through
  // the process-wide sandbox. Pointing `$HAYVEN_HOME` at `tmp` makes the global
  // store and this project's `.hayven` the same fresh directory.
  prevHome = process.env["HAYVEN_HOME"];
  process.env["HAYVEN_HOME"] = tmp;
});
afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("models list", () => {
  test("prints a table with the registry ids, tiers, and presence", async () => {
    const { code, out } = await capture(() => runModels({ positionals: ["list"], flags: {} }));
    expect(code).toBe(0);
    expect(out).toContain("ID");
    expect(out).toContain("PRESENT?");
    expect(out).toContain("gemma4:e2b");
    expect(out).toContain("gemma4:e4b");
    expect(out).toContain("tier-3");
    // None are present in a fresh project.
    expect(out).not.toContain("yes");
  });

  test("reflects a present model after one is installed on disk", async () => {
    const hayvenDir = join(tmp, ".hayven");
    const md = modelDir(hayvenDir, "gemma4:e2b")!;
    mkdirSync(md, { recursive: true });
    // A model is "present" once model.gguf is on disk: the tokenizer is built
    // from the GGUF metadata by `hayven-native infer` (BL-14 resolved), so no
    // sidecar tokenizer.json is required.
    writeFileSync(modelPath(hayvenDir, "gemma4:e2b")!, "weights");

    const { out } = await capture(() => runModels({ positionals: ["list"], flags: {} }));
    expect(out).toContain("yes");
  });

  test("--json emits a machine-readable array", async () => {
    const { out } = await capture(() =>
      runModels({ positionals: ["list"], flags: { json: true } }),
    );
    const rows = JSON.parse(out);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r: { id: string }) => r.id === "gemma4:e2b")).toBe(true);
    expect(rows[0]).toHaveProperty("present");
  });
});

describe("models pull — argument handling", () => {
  test("unknown id exits 1 with a helpful message", async () => {
    const { code, err } = await capture(() =>
      runModels({ positionals: ["pull", "nope:0b"], flags: {} }),
    );
    expect(code).toBe(1);
    expect(err).toContain("unknown model id");
    expect(err).toContain("gemma4:e2b"); // lists known ids
  });

  test("missing id exits 2 with usage", async () => {
    const { code, err } = await capture(() => runModels({ positionals: ["pull"], flags: {} }));
    expect(code).toBe(2);
    expect(err).toContain("hayven models pull <id>");
  });

  // SUPERSEDED audit H1. H1's rule was "a valid id in a non-project must refuse
  // before touching the filesystem or the network", because the download target
  // was whatever `.hayven` the cwd walk landed on — mis-resolvable. The target is
  // now the GLOBAL store, a pure function of `$HAYVEN_HOME`, so there is nothing
  // to mis-resolve; pulling a shared, immutable asset no longer requires standing
  // in a repo. What H1 actually protected — never creating a stray `.hayven` in
  // the tree you happen to be standing in — is still asserted here.
  test("a valid id pulls into the GLOBAL store from a bare non-project dir", async () => {
    const bare = mkdtempSync(join(tmpdir(), "hayven-noproj-")); // no .hayven, no .git
    const home = mkdtempSync(join(tmpdir(), "hayven-noproj-home-"));
    const prev = process.cwd();
    const prevHome = process.env["HAYVEN_HOME"];
    const realFetch = globalThis.fetch;
    process.chdir(bare);
    process.env["HAYVEN_HOME"] = home;
    // Stub the network: `runPull` uses the global fetch, and this test must
    // never reach Hugging Face.
    const bytes = new TextEncoder().encode("stub-weights\n");
    const { restore } = withStubArtifact(
      "gemma4:e2b",
      "stub://cli/tiny.gguf",
      createHash("sha256").update(bytes).digest("hex"),
    );
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    })) as unknown as typeof fetch;
    try {
      const { code } = await capture(() =>
        runModels({ positionals: ["pull", "gemma4:e2b"], flags: {} }),
      );
      expect(code).toBe(0);
      // Landed in the global store, ONCE...
      expect(existsSync(join(home, ".hayven", "models", "gemma4_e2b", "model.gguf"))).toBe(true);
      // ...and created nothing in the tree the user happened to be standing in.
      expect(existsSync(join(bare, ".hayven"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      restore();
      process.chdir(prev);
      if (prevHome === undefined) delete process.env["HAYVEN_HOME"];
      else process.env["HAYVEN_HOME"] = prevHome;
      rmSync(bare, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("models — dispatch", () => {
  test("no subcommand exits 2 with usage", async () => {
    const { code, err } = await capture(() => runModels({ positionals: [], flags: {} }));
    expect(code).toBe(2);
    expect(err).toContain("hayven models list");
  });

  test("unknown subcommand exits 2", async () => {
    const { code, err } = await capture(() => runModels({ positionals: ["frob"], flags: {} }));
    expect(code).toBe(2);
    expect(err).toContain("unknown models subcommand");
  });
});
