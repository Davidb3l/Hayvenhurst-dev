// Model weights are a SHARED, GLOBAL asset — not per-project.
//
// THE BUG THIS PINS. `hayven models pull` used to resolve its download target as
// `requireProject().paths.hayvenDir`, so the weights landed in
// `<project>/.hayven/models/`. Weights are immutable and content-addressed (the
// registry pins a sha256), so every project got a byte-identical copy: one user
// had a 3.1 GB GGUF in a single archived clone the daemon does not even serve,
// and pulling it in their other four registered projects would have cost
// ~15.5 GB of duplicate bytes.
//
// The contract now:
//   1. a fresh pull installs ONCE into the global `~/.hayven/models/`;
//   2. an EXISTING per-project copy is still found and used (back-compat) and is
//      never re-downloaded;
//   3. readers and the writer share ONE resolver, so they cannot disagree; and
//   4. nothing here ever moves or deletes a weight file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runModels } from "../src/cli/models.ts";
import { collectForTest } from "../src/cli/doctor.ts";
import { installedBytesIn, pullModel, type FetchLike } from "../src/models/install.ts";
import {
  GGUF_FILENAME,
  MODEL_REGISTRY,
  globalModelsDir,
  isModelPresent,
  locateModelDir,
  modelDir,
  modelDirIn,
  modelLocations,
  type ModelEntry,
} from "../src/models/registry.ts";

const ID = "gemma3:1b"; // the DEFAULT tier-3 model, so `doctor` reports on it
const STUB_URL = "stub://shared/tiny.gguf";
const FIXTURE = new TextEncoder().encode("hayven-shared-store-fixture\n");
const FIXTURE_SHA = createHash("sha256").update(FIXTURE).digest("hex");

/** A fetch stub that RECORDS every request, so "did not re-download" is provable. */
function countingFetch(spy: { calls: number }): FetchLike {
  return async () => {
    spy.calls++;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(FIXTURE);
          c.close();
        },
      }),
    };
  };
}

/** Point the registry entry at the in-memory fixture (no network, ever). */
function stubArtifact(): () => void {
  const original = MODEL_REGISTRY[ID]!;
  (MODEL_REGISTRY as Record<string, ModelEntry>)[ID] = {
    ...original,
    artifacts: [{ filename: GGUF_FILENAME, url: STUB_URL, sha256: FIXTURE_SHA }],
  };
  return () => {
    (MODEL_REGISTRY as Record<string, ModelEntry>)[ID] = original;
  };
}

/** Write a complete model copy into a specific `.hayven` (bypassing resolution). */
function plantModelIn(hayvenDir: string, bytes: Uint8Array = FIXTURE): string {
  const dir = modelDirIn(hayvenDir, ID) as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, GGUF_FILENAME), bytes);
  return dir;
}

/** Capture stdout/stderr for the duration of `fn`. */
async function capture(fn: () => Promise<number> | number): Promise<{
  code: number;
  out: string;
}> {
  let out = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => ((out += c), true)) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await fn(), out };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

let tmp: string;
let home: string; // $HAYVEN_HOME — the global store lives at <home>/.hayven
let globalHayven: string;
let projectA: string;
let projectB: string;
let prevHome: string | undefined;
let prevCwd: string;
let restoreArtifact: () => void;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hayven-shared-models-"));
  home = join(tmp, "home");
  globalHayven = join(home, ".hayven");
  projectA = join(tmp, "projA");
  projectB = join(tmp, "projB");
  mkdirSync(globalHayven, { recursive: true });
  mkdirSync(join(projectA, ".hayven"), { recursive: true });
  mkdirSync(join(projectB, ".hayven"), { recursive: true });
  prevHome = process.env["HAYVEN_HOME"];
  process.env["HAYVEN_HOME"] = home;
  prevCwd = process.cwd();
  restoreArtifact = stubArtifact();
});

afterEach(() => {
  restoreArtifact();
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolution — one resolver, global first, project fallback", () => {
  test("a model present ONLY globally resolves from every project", () => {
    const dir = plantModelIn(globalHayven);

    for (const project of [projectA, projectB]) {
      const hayvenDir = join(project, ".hayven");
      expect(isModelPresent(hayvenDir, ID)).toBe(true);
      expect(modelDir(hayvenDir, ID)).toBe(dir);
      expect(locateModelDir(ID, hayvenDir)).toBe(dir);
    }
    // One copy on disk, shared — not one per project.
    expect(existsSync(join(modelDirIn(join(projectA, ".hayven"), ID) as string, GGUF_FILENAME)))
      .toBe(false);
  });

  test("BACK-COMPAT: a model present ONLY per-project still resolves there", () => {
    const hayvenDir = join(projectA, ".hayven");
    const dir = plantModelIn(hayvenDir);

    expect(isModelPresent(hayvenDir, ID)).toBe(true);
    expect(modelDir(hayvenDir, ID)).toBe(dir);
    // Nothing was silently relocated or invented in the global store.
    expect(existsSync(join(globalModelsDir(), "gemma3_1b", GGUF_FILENAME))).toBe(false);
    // ...and it is NOT visible from an unrelated project, which is exactly why
    // global is the canonical home.
    expect(isModelPresent(join(projectB, ".hayven"), ID)).toBe(false);
  });

  test("the global copy WINS when both exist", () => {
    plantModelIn(join(projectA, ".hayven"));
    const globalDir = plantModelIn(globalHayven);
    expect(modelDir(join(projectA, ".hayven"), ID)).toBe(globalDir);
  });

  test("with no copy anywhere, the resolver names the GLOBAL install target", () => {
    expect(isModelPresent(join(projectA, ".hayven"), ID)).toBe(false);
    expect(locateModelDir(ID, join(projectA, ".hayven"))).toBeNull();
    expect(modelDir(join(projectA, ".hayven"), ID)).toBe(join(globalModelsDir(), "gemma3_1b"));
  });

  test("isModelPresent implies the resolved dir actually holds the weights", () => {
    // The invariant every reader depends on: `conflict/oracle.ts`,
    // `graph/summarize.ts` and `db/fts.ts` all gate on isModelPresent and then
    // hand `modelDir` straight to `hayven-native infer --model`. If those two
    // ever disagreed, infer would be launched against a directory with no GGUF.
    for (const where of [globalHayven, join(projectA, ".hayven")]) {
      const planted = plantModelIn(where);
      const hayvenDir = join(projectA, ".hayven");
      expect(isModelPresent(hayvenDir, ID)).toBe(true);
      expect(existsSync(join(modelDir(hayvenDir, ID) as string, GGUF_FILENAME))).toBe(true);
      rmSync(planted, { recursive: true, force: true });
    }
  });

  test("modelSearchHomes dedupes when the project IS the global dir", () => {
    // Running in $HOME: the "project" .hayven and the global one are the same
    // directory. Without the dedupe, one copy would be listed twice and
    // `models list` would call it a redundant duplicate of itself.
    const locs = modelLocations(ID, globalHayven);
    expect(locs.length).toBe(1);
    expect(locs[0]!.scope).toBe("global");
  });

  test("the dedupe survives a SYMLINKED home (two spellings, one directory)", () => {
    // `globalHayvenDir()` keeps symlinks (it comes from `$HAYVEN_HOME`/
    // `homedir()`), while the project arm comes from `process.cwd()` and is
    // always physical. Comparing the raw strings misses on any host with a
    // symlinked home, ONE directory gets reported as two present copies, and
    // `models list` then tells the user their only multi-GB weight file is a
    // redundant duplicate they can delete. Compare canonically instead.
    const physical = join(tmp, "physical-home");
    const link = join(tmp, "linked-home");
    mkdirSync(join(physical, ".hayven"), { recursive: true });
    symlinkSync(physical, link);
    process.env["HAYVEN_HOME"] = link; // global spelled through the symlink
    plantModelIn(join(physical, ".hayven"));

    // The project arm, spelled physically — as `detectRepoRoot` would give it.
    const locs = modelLocations(ID, join(realpathSync(link), ".hayven"));
    expect(locs.length).toBe(1);
    expect(locs[0]!.scope).toBe("global");
    expect(locs[0]!.present).toBe(true);
  });
});

describe("pull — download once, never re-download what the user already has", () => {
  test("a fresh pull installs into the GLOBAL store, not the project", async () => {
    const spy = { calls: 0 };
    const res = await pullModel(join(projectA, ".hayven"), ID, {
      fetchImpl: countingFetch(spy),
    });

    expect(spy.calls).toBe(1);
    expect(res.dir).toBe(join(globalModelsDir(), "gemma3_1b"));
    expect(existsSync(join(res.dir, GGUF_FILENAME))).toBe(true);
    expect(existsSync(join(projectA, ".hayven", "models"))).toBe(false);
  });

  test("a second project's pull re-uses the global copy — ZERO bytes fetched", async () => {
    const first = { calls: 0 };
    await pullModel(join(projectA, ".hayven"), ID, { fetchImpl: countingFetch(first) });
    expect(first.calls).toBe(1);

    const second = { calls: 0 };
    const res = await pullModel(join(projectB, ".hayven"), ID, {
      fetchImpl: countingFetch(second),
    });
    // This is the whole point: the duplicate multi-GB download does not happen.
    expect(second.calls).toBe(0);
    expect(res.artifacts[0]!.status).toBe("skipped-present");
  });

  test("BACK-COMPAT: an existing per-project copy is used, NOT re-downloaded", async () => {
    const projectDir = plantModelIn(join(projectA, ".hayven"));
    const spy = { calls: 0 };

    const res = await pullModel(join(projectA, ".hayven"), ID, {
      fetchImpl: countingFetch(spy),
    });

    expect(spy.calls).toBe(0); // never re-fetch GBs the user already has
    expect(res.dir).toBe(projectDir);
    expect(res.artifacts[0]!.status).toBe("skipped-present");
    // And the pull did not quietly duplicate it into the global store either.
    expect(existsSync(join(globalModelsDir(), "gemma3_1b", GGUF_FILENAME))).toBe(false);
  });

  test("a CORRUPT legacy per-project copy is repaired into the GLOBAL store", async () => {
    // The resolver prefers an existing project copy on existence alone, so a
    // truncated or corrupt one would otherwise send the multi-GB re-download
    // straight back into the per-project directory, re-creating the exact
    // duplication this change exists to end.
    const projectDir = plantModelIn(join(projectA, ".hayven"), new TextEncoder().encode("corrupt"));
    const spy = { calls: 0 };

    const res = await pullModel(join(projectA, ".hayven"), ID, {
      fetchImpl: countingFetch(spy),
    });

    expect(spy.calls).toBe(1);
    expect(res.dir).toBe(join(globalModelsDir(), "gemma3_1b"));
    expect(new Uint8Array(readFileSync(join(res.dir, GGUF_FILENAME)))).toEqual(FIXTURE);
    // The user's bad file is left EXACTLY where it was — reported, never deleted.
    expect(new Uint8Array(readFileSync(join(projectDir, GGUF_FILENAME)))).toEqual(
      new TextEncoder().encode("corrupt"),
    );
  });

  test("a pull NEVER moves or deletes an existing per-project copy", async () => {
    // Prior incident in this codebase: automated cleanup deleted files it did
    // not own. A user's multi-GB weights are theirs; migration is opt-in and
    // manual.
    const projectDir = plantModelIn(join(projectA, ".hayven"));
    const projectFile = join(projectDir, GGUF_FILENAME);
    plantModelIn(globalHayven); // global now shadows it

    await pullModel(join(projectA, ".hayven"), ID, { fetchImpl: countingFetch({ calls: 0 }) });

    expect(existsSync(projectFile)).toBe(true);
    expect(new Uint8Array(readFileSync(projectFile))).toEqual(FIXTURE);
  });
});

describe("models list — reports where copies live, deletes nothing", () => {
  test("--json names the resolved scope, dir, and every candidate location", async () => {
    plantModelIn(globalHayven);
    process.chdir(projectA);

    const { out } = await capture(() => runModels({ positionals: ["list"], flags: { json: true } }));
    const row = JSON.parse(out).find((r: { id: string }) => r.id === ID);

    expect(row.present).toBe(true);
    expect(row.scope).toBe("global");
    expect(row.dir).toBe(join(globalModelsDir(), "gemma3_1b"));
    expect(row.redundant).toBe(false);
    expect(row.locations.map((l: { scope: string }) => l.scope)).toEqual(["global", "project"]);
  });

  test("a shadowed per-project copy is REPORTED as redundant, with its size", async () => {
    plantModelIn(globalHayven);
    // A DIFFERENT payload size in the project copy, so the reported size can
    // only be right if it was measured in the project dir — sizing the global
    // copy instead would tell the user the wrong number of bytes to reclaim.
    const bulky = new Uint8Array(FIXTURE.byteLength * 3);
    const projectDir = plantModelIn(join(projectA, ".hayven"), bulky);
    process.chdir(projectA);

    const { out } = await capture(() => runModels({ positionals: ["list"], flags: {} }));

    expect(out).toContain("Redundant per-project copies");
    expect(out).toContain(projectDir);
    expect(out).toContain("will NOT delete");
    // Reporting only — the file is still there after `list`.
    expect(existsSync(join(projectDir, GGUF_FILENAME))).toBe(true);
    expect(installedBytesIn(join(projectA, ".hayven"), ID)).toBe(bulky.byteLength);
    expect(installedBytesIn(globalHayven, ID)).toBe(FIXTURE.byteLength);
  });

  test("no redundancy section when there is only one copy", async () => {
    plantModelIn(globalHayven);
    process.chdir(projectA);
    const { out } = await capture(() => runModels({ positionals: ["list"], flags: {} }));
    expect(out).not.toContain("Redundant per-project copies");
  });
});

describe("doctor — resolves the SAME way as the resolver", () => {
  test("reports PRESENT for a globally-installed model outside any project", () => {
    plantModelIn(globalHayven);
    // A bare directory: no `.hayven`, no `.git`. Doctor used to short-circuit
    // here with "model presence is per-project" and report nothing, which after
    // the move would hide a model that is genuinely installed and loadable.
    const bare = join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    process.chdir(bare);

    const check = collectForTest().checks.find((c) => c.name === "tier3_model");
    expect(check).toBeDefined();
    expect(check!.ok).toBe(true);
    expect(check!.detail).toContain("present");
  });

  test("reports NOT DOWNLOADED — and agrees with isModelPresent — when absent", () => {
    process.chdir(projectA);
    const check = collectForTest().checks.find((c) => c.name === "tier3_model");
    expect(check!.ok).toBe(false);
    expect(isModelPresent(join(projectA, ".hayven"), ID)).toBe(false);
  });

  test("sees a legacy per-project copy (no false 'missing')", () => {
    plantModelIn(join(projectA, ".hayven"));
    process.chdir(projectA);
    const check = collectForTest().checks.find((c) => c.name === "tier3_model");
    expect(check!.ok).toBe(true);
  });
});
