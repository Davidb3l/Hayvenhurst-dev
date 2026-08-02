/**
 * Round 2 — the wedge tests, made able to FAIL.
 *
 * The earlier bounds tests asserted `elapsed < BUDGET` AFTER the call returned.
 * With the fix reverted the call never returns, so the assertion never runs:
 * bun's per-test timeout is cooperative and cannot preempt a synchronous JS
 * loop (observed one failure at 27.8s, then no output for 90+ seconds until the
 * runner was killed by hand). A test that can only HANG is not a test.
 *
 * So every wedge scenario runs in a `Bun.spawn` SUBPROCESS with a wall-clock
 * kill. A hang is now an observable, deterministic failure: the child is
 * SIGKILLed and the assertion reports it, in bounded time, whatever the child's
 * loop is doing. This is the only mechanism that survives a synchronous
 * uninterruptible wedge — including the FIFO case, where the block is inside a
 * blocking `read(2)` and no JS-level timeout could ever fire.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const PACK_MODULE = join(import.meta.dir, "..", "src", "db", "context_pack.ts");
const DB_MODULE = join(import.meta.dir, "..", "src", "db", "queries.ts");

/**
 * The child: seeds a fixture graph over `root` and runs one scenario. Prints
 * `OK <ms>` and exits 0 on success. If the packer wedges, it prints nothing and
 * never exits — which is exactly what the parent's wall-clock kill detects.
 */
const RUNNER = `
import { buildContextPackForChange } from ${JSON.stringify(PACK_MODULE)};
import { Db } from ${JSON.stringify(DB_MODULE)};

const [root, scenario, file, entityCount, spanStr] = process.argv.slice(2);
const db = new Db(":memory:");
db.migrate();
const span = Number(spanStr);
for (let i = 0; i < Number(entityCount); i++) {
  const start = i * span + 1;
  db.upsertNode({
    id: \`\${file}::e\${start}\`,
    name: \`e\${start}\`,
    qualified_name: \`\${file}::e\${start}\`,
    kind: "function",
    language: "typescript",
    file,
    range: [start, start + span - 1],
    ast_hash: "h",
    last_seen: 0,
    logical_clock: 0,
  });
}

const REGIONS = {
  "huge-endline": [{ startLine: 1, endLine: Number.MAX_SAFE_INTEGER }],
  "huge-2e10": [{ startLine: 1, endLine: 20_000_000_000 }],
  "many-huge": Array.from({ length: 20_000 }, () => ({ startLine: 1, endLine: 20_000_000_000 })),
  "tiled-max-regions": Array.from({ length: 1024 }, () => ({ startLine: 1, endLine: 8000 })),
  fifo: [{ startLine: 1, endLine: 10 }],
};

const t0 = performance.now();
buildContextPackForChange(db, root, file, REGIONS[scenario]);
process.stdout.write("OK " + Math.round(performance.now() - t0) + "\\n");
db.close();
`;

interface RunResult {
  completed: boolean;
  exitCode: number | null;
  stdout: string;
  wallMs: number;
}

/** Run one scenario with a hard wall-clock kill. Never hangs the suite. */
async function runScenario(
  root: string,
  scenario: string,
  file: string,
  entityCount: number,
  span: number,
  killAfterMs: number,
): Promise<RunResult> {
  const runner = join(mkdtempSync(join(tmpdir(), "hayven-fixa-runner-")), "run.ts");
  dirs.push(join(runner, ".."));
  writeFileSync(runner, RUNNER);

  const child = Bun.spawn(
    ["bun", runner, root, scenario, file, String(entityCount), String(span)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const t0 = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL"); // SIGTERM cannot interrupt a synchronous JS loop
  }, killAfterMs);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const stdout = await new Response(child.stdout).text();
  return {
    completed: !timedOut,
    exitCode,
    stdout,
    wallMs: performance.now() - t0,
  };
}

/** A small repo with `n` lines in `file`. */
function makeRepo(lines: number, file = "t.ts"): string {
  const root = mkdtempSync(join(tmpdir(), "hayven-fixa-wedge-"));
  dirs.push(root);
  writeFileSync(
    join(root, file),
    Array.from({ length: lines }, (_, i) => `const v${i} = ${i};`).join("\n"),
  );
  return root;
}

/** Generous: a correct run is single-digit-to-hundreds of ms plus ~250ms of
 *  bun startup. Every wedged variant measured 76s+ or never terminated. */
const KILL_AFTER_MS = 20_000;

describe("round 2 — wedge scenarios terminate (subprocess, wall-clock killed)", () => {
  it("MAX_SAFE_INTEGER endLine against a 10-line file", async () => {
    const root = makeRepo(10);
    const r = await runScenario(root, "huge-endline", "t.ts", 2, 3, KILL_AFTER_MS);
    expect(r.completed).toBe(true); // false == the child had to be SIGKILLed
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK");
  }, 60_000);

  it("the measured 2e10 endLine case", async () => {
    const root = makeRepo(10);
    const r = await runScenario(root, "huge-2e10", "t.ts", 2, 3, KILL_AFTER_MS);
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it("20,000 overlapping huge regions", async () => {
    const root = makeRepo(10);
    const r = await runScenario(root, "many-huge", "t.ts", 2, 3, KILL_AFTER_MS);
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it("MAX_REGIONS whole-file straddles over a gap-free tiled file", async () => {
    // The classification-loop wedge: 76 SECONDS before the coverage bitmap.
    const root = makeRepo(8000);
    const r = await runScenario(root, "tiled-max-regions", "t.ts", 2000, 4, KILL_AFTER_MS);
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(0);
  }, 60_000);

  it("a FIFO inside the repo", async () => {
    // The only scenario where NO in-process timeout could ever help: the block
    // is inside a blocking read(2), not a JS loop.
    const root = mkdtempSync(join(tmpdir(), "hayven-fixa-fifo-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    const mk = spawnSync("mkfifo", [join(root, "src", "pipe.ts")]);
    if (mk.status !== 0) {
      console.warn("SKIP: mkfifo unavailable on this platform");
      return;
    }
    const r = await runScenario(root, "fifo", "src/pipe.ts", 0, 1, KILL_AFTER_MS);
    expect(r.completed).toBe(true);
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
