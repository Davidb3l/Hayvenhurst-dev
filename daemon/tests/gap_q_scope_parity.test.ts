/**
 * GAP Q1 — `--include-vendored` / `--include-fixtures` scope parity.
 *
 * THE REGRESSION. These flags used to be a genuine NO-OP on the incremental
 * (`--files-stdin`) path and were not accepted by `watch` at all, so nothing
 * could diverge. Once the native side started applying ONE shared `ScopeFilter`
 * to the walker, `--files-stdin` AND the watcher, the TypeScript side became the
 * source of the divergence: it passed the flags only at the two FULL-ingest
 * sites. A project with `index.includeVendored: true` therefore got its vendored
 * files on a full ingest and SILENTLY LOST them on every watcher re-ingest, so
 * the graph oscillated with whichever path ran last.
 *
 * THE NAIVE FIX IS WORSE THAN THE BUG. Passing the flags to `startWatch` alone
 * makes the watcher report `vendor/x.ts` changes, the daemon's per-file
 * `deleteNodesByFile` purge then removes that file's rows BEFORE the re-parse,
 * and a narrow re-parse drops the file — so the nodes are deleted and never
 * restored. Three sites must move together:
 *
 *   1. `startWatch`                        (src/native/watcher.ts)
 *   2. the incremental `startParse({files})` (src/cli/daemon.ts)
 *   3. `nativeParseRunner`                 (src/conflict/verify.ts)
 *
 * Sites 1 and 3 are exercised behaviorally below with an injected spawn: the
 * assertion is on the ARGV the child is actually launched with. Site 2 lives
 * inside a closure built by an un-exported `initProject` nested in
 * `startDaemon`, which cannot be constructed without a live daemon, a real
 * index and a real native binary — so it is covered by a structural invariant
 * over the file instead ("no native invocation in daemon.ts may omit the shared
 * scope object"). That check also re-covers sites 1 and 3 at their call sites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { nativeParseRunner } from "../src/conflict/verify.ts";
import { startWatch } from "../src/native/watcher.ts";

interface Spawned {
  cmd: string[];
}

/** A child that emits `lines` then exits 0. Records the argv it was given. */
function recordingSpawn(calls: Spawned[], lines: string[] = []) {
  const encoder = new TextEncoder();
  return (opts: { cmd: string[] }) => {
    calls.push({ cmd: [...opts.cmd] });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(encoder.encode(l + "\n"));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    return {
      // `startParse` writes the `--files-stdin` payload here.
      stdin: { write: () => undefined, end: () => undefined },
      stdout,
      stderr,
      exited: Promise.resolve(0),
      kill: () => undefined,
    };
  };
}

const versionLine = JSON.stringify({
  type: "version",
  major: 0,
  minor: 0,
  patch: 1,
  protocol: 2,
});

describe("Q1 site 1 — startWatch spawns `watch` with the ingest scope", () => {
  test("passes both flags through to the child argv", async () => {
    const calls: Spawned[] = [];
    const w = startWatch({
      binary: "/fake/hayven-native",
      root: "/fake/repo",
      spawn: recordingSpawn(calls, [versionLine]) as never,
      onBatch: () => undefined,
      onOverflow: () => undefined,
      includeVendored: true,
      includeFixtures: true,
      // Keep this test off the restart treadmill: the fake child exits
      // immediately, and we only care about the FIRST spawn's argv.
      heartbeatStallMs: 0,
    });
    // Let the supervisor spawn its first child.
    await new Promise((r) => setTimeout(r, 20));
    await w.stop();

    expect(calls.length).toBeGreaterThan(0);
    const argv = calls[0]!.cmd;
    expect(argv).toContain("watch");
    expect(argv).toContain("--include-vendored");
    expect(argv).toContain("--include-fixtures");
  });

  test("omits them when the project does not opt in (the default)", async () => {
    const calls: Spawned[] = [];
    const w = startWatch({
      binary: "/fake/hayven-native",
      root: "/fake/repo",
      spawn: recordingSpawn(calls, [versionLine]) as never,
      onBatch: () => undefined,
      onOverflow: () => undefined,
      heartbeatStallMs: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    await w.stop();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.cmd).not.toContain("--include-vendored");
    expect(calls[0]!.cmd).not.toContain("--include-fixtures");
  });
});

describe("Q1 site 3 — nativeParseRunner re-parses with the ingest scope", () => {
  test("forwards both flags to the `--files-stdin` parse", async () => {
    const calls: Spawned[] = [];
    const run = nativeParseRunner({
      binary: "/fake/hayven-native",
      root: "/fake/repo",
      languages: ["typescript"],
      jobs: 1,
      includeVendored: true,
      includeFixtures: true,
      // `startParse` reads `spawn` off ParseOptions; nativeParseRunner has no
      // seam of its own, so we go through the module-level Bun.spawn override
      // below instead. See `withSpawn`.
    });
    await withSpawn(recordingSpawn(calls, [versionLine]), () => run(["vendor/x.ts"]));

    expect(calls.length).toBe(1);
    const argv = calls[0]!.cmd;
    expect(argv).toContain("--files-stdin");
    expect(argv).toContain("--include-vendored");
    expect(argv).toContain("--include-fixtures");
  });

  test("omits them when the project does not opt in", async () => {
    const calls: Spawned[] = [];
    const run = nativeParseRunner({
      binary: "/fake/hayven-native",
      root: "/fake/repo",
      languages: ["typescript"],
      jobs: 1,
    });
    await withSpawn(recordingSpawn(calls, [versionLine]), () => run(["src/x.ts"]));

    expect(calls.length).toBe(1);
    expect(calls[0]!.cmd).not.toContain("--include-vendored");
    expect(calls[0]!.cmd).not.toContain("--include-fixtures");
  });
});

/** Swap `Bun.spawn` for the duration of `fn`. `startParse` falls back to it when
 *  `ParseOptions.spawn` is absent, which is exactly the production path
 *  `nativeParseRunner` takes. */
async function withSpawn<T>(fake: unknown, fn: () => Promise<T>): Promise<T> {
  const original = Bun.spawn;
  (Bun as unknown as { spawn: unknown }).spawn = fake;
  try {
    return await fn();
  } finally {
    (Bun as unknown as { spawn: unknown }).spawn = original;
  }
}

describe("Q1 site 2 — every native invocation in cli/daemon.ts carries the scope", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "cli", "daemon.ts"),
    "utf8",
  );

  /**
   * Slice out each `<callee>({ … })` argument object, brace-balanced, so we can
   * assert on the OPTIONS the call site actually builds. A regex over the whole
   * file would happily match a `...scope` belonging to a different call.
   */
  function callArgs(callee: string): string[] {
    const out: string[] = [];
    const needle = `${callee}({`;
    let from = 0;
    for (;;) {
      const at = source.indexOf(needle, from);
      if (at === -1) break;
      let depth = 0;
      let i = at + callee.length + 1; // first '{'
      for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(source.slice(at, i + 1));
      from = i + 1;
    }
    return out;
  }

  test("the shared scope object exists and is derived from index config", () => {
    expect(source).toContain("const scope = {");
    expect(source).toContain("includeVendored: config.index?.includeVendored ?? false");
    expect(source).toContain("includeFixtures: config.index?.includeFixtures ?? false");
  });

  test("every startParse call spreads it — including the incremental one", () => {
    const calls = callArgs("startParse");
    // full ingest, incremental watch re-parse, branch-repoint freshen.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call).toContain("...scope");
    }
    // The incremental call is the one that regressed; assert it exists AND is
    // among the ones carrying the scope, so this cannot pass on the other two.
    const incremental = calls.filter((c) => c.includes("files: [...changed]"));
    expect(incremental.length).toBe(1);
    expect(incremental[0]!).toContain("...scope");
  });

  test("startWatch and nativeParseRunner spread it too", () => {
    for (const callee of ["startWatch", "nativeParseRunner"]) {
      const calls = callArgs(callee);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) expect(call).toContain("...scope");
    }
  });
});
