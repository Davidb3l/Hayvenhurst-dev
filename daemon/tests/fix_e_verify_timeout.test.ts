/**
 * The Layer B verify gate spawned an UNBOUNDED typecheck on the watcher's hot
 * path.
 *
 * `defaultTypecheck` runs whole-PROJECT commands — `tsc --noEmit` ignores the
 * changed-file list entirely — with no timeout and no kill, so one file save in
 * any repo with a root `tsconfig.json` triggered a native parse, a SECOND native
 * parse of the same file, and then a full-project typecheck. `cargo check`
 * blocked on the user's own `cargo build` lock simply never returned: it wedged
 * the project's ingest chain, and the daemon's shutdown drain then timed out at
 * 5 s and closed the Db underneath it. `WATCH_INCREMENTAL_FILE_CAP` does not
 * bound any of this.
 *
 * NOTE ON FILE OWNERSHIP: the fix is in `daemon/src/conflict/verify.ts`, which
 * is not in any lane's file list. It was changed on the coordinator's explicit
 * instruction; the test lives here under the lane's `fix_e_*` name.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultTypecheck, spawnWithTimeout } from "../src/conflict/verify.ts";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "hayven-fixe-verify-"));
  writeFileSync(join(repo, "tsconfig.json"), "{}", "utf8");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("verify gate: typecheck is bounded and killed", () => {
  it("KILLS a real hanging process instead of waiting on it forever", async () => {
    const started = Date.now();
    const r = await spawnWithTimeout(["/bin/sh", "-c", "sleep 300"], {
      cwd: repo,
      timeoutMs: 400,
    });
    const elapsed = Date.now() - started;

    // THE property: it returns, and says why. Pre-fix this awaited
    // `proc.exited` forever, holding the project's ingest chain the whole time
    // (and `cargo check` blocked on a build lock does exactly this in practice).
    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
  }, 20_000);

  it("escalates to SIGKILL for a process that ignores SIGTERM", async () => {
    const started = Date.now();
    const r = await spawnWithTimeout(["/bin/sh", "-c", "trap '' TERM; sleep 300"], {
      cwd: repo,
      timeoutMs: 300,
    });
    // A bound that a process can opt out of is not a bound.
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 20_000);

  it("leaves a fast command completely unaffected", async () => {
    const r = await spawnWithTimeout(["/bin/sh", "-c", "echo hi; exit 0"], {
      cwd: repo,
      timeoutMs: 5_000,
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  }, 20_000);

  it("THROWS on a timeout rather than reporting it as a type error", async () => {
    // A killed typecheck proves nothing about the code. Reporting it as
    // `ok:false` would flag `merge_rejected` on files that may be perfectly
    // fine; throwing routes it to the ingest breaker as the GATE failure it is.
    const typecheck = defaultTypecheck({
      root: repo,
      timeoutMs: 250,
      spawn: async () => ({ exitCode: 137, stdout: "", stderr: "", timedOut: true }),
    });
    await expect(typecheck("typescript", ["src/a.ts"])).rejects.toThrow(/exceeded .*ms/);
  });

  it("still reports genuine type errors as failures, not timeouts", async () => {
    const typecheck = defaultTypecheck({
      root: repo,
      spawn: async () => ({
        exitCode: 2,
        stdout: "src/a.ts(1,1): error TS2322: nope",
        stderr: "",
        timedOut: false,
      }),
    });
    const r = await typecheck("typescript", ["src/a.ts"]);
    expect(r.configured).toBe(true);
    expect(r.ok).toBe(false);
  });
});
