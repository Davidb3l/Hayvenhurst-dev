// `hayven models <list|pull>` CLI surface — ARCHITECTURE.md §18.3.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runModels } from "../src/cli/models.ts";
import { modelDir, modelPath } from "../src/models/registry.ts";

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

let tmp: string;
let prevCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hayven-models-cli-"));
  mkdirSync(join(tmp, ".hayven"), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
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

  // audit H1: never mkdirSync + download multi-GB weights into a mis-resolved or
  // uninitialized `.hayven/models/`. A valid id in a non-project must refuse
  // BEFORE touching the filesystem or the network.
  test("a valid id refuses (no download) when there is no initialized project", async () => {
    const bare = mkdtempSync(join(tmpdir(), "hayven-noproj-")); // no .hayven, no .git
    const prev = process.cwd();
    process.chdir(bare);
    try {
      const { code, err } = await capture(() =>
        runModels({ positionals: ["pull", "gemma4:e2b"], flags: {} }),
      );
      expect(code).toBe(1);
      expect(err.toLowerCase()).toContain("hayven init");
      // Crucially: it created nothing in the bare tree.
      expect(existsSync(join(bare, ".hayven"))).toBe(false);
    } finally {
      process.chdir(prev);
      rmSync(bare, { recursive: true, force: true });
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
