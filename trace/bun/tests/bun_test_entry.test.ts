/**
 * The `bun test --preload` entry (bun-test.ts), driven END-TO-END: a real
 * `bun test` subprocess over a fixture suite, flushing to a mock daemon.
 *
 * Contract under test:
 *   - HAYVEN_TRACE=1 + --preload traces the run and emits `test_coverage`
 *     rows attributed PER TEST FILE (the window-boundary attribution): each
 *     fixture file's burn function appears under ITS OWN file context and
 *     never under the other file's (the harvest-on-context-change guarantee
 *     across bun:test's sequential single-process file walk).
 *   - contexts are path-qualified module ids relative to
 *     HAYVEN_TRACE_MODULE_ROOT (`tests/alpha.test`, not `alpha.test`).
 *   - the traced suite EXITS 0 (tracing never fails a passing suite) and the
 *     process actually terminates (no armed profiler holding the run open).
 *   - WITHOUT HAYVEN_TRACE the preload is a byte-silent no-op: zero POSTs.
 *
 * Mirrors the subprocess discipline of daemon tests: fixture in a temp dir,
 * mock daemon via Bun.serve on an ephemeral port, spawn the real runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WirePayload } from "../src/flusher.ts";

const ENTRY = join(import.meta.dir, "..", "bun-test.ts");

/** Received wire payloads, appended by the mock daemon as they arrive. */
const received: WirePayload[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method === "POST" && new URL(req.url).pathname === "/api/traces/observations") {
      received.push((await req.json()) as WirePayload);
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
});

let fixtureDir: string | undefined;

afterAll(() => {
  server.stop(true);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

/**
 * A two-file fixture suite. Each file defines a DISTINCT, named, CPU-bound
 * function called only from inside its own tests, so the profiler has a
 * stable frame name whose file attribution is unambiguous — cross-file
 * bleed would be visible as (say) `alphaBurn` under the `beta.test` context.
 */
function buildFixture(): string {
  // realpath: macOS tmpdir is /var/... but Bun.main reports the resolved
  // /private/var/... path — MODULE_ROOT must match the frames' real paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hayven-bun-entry-")));
  mkdirSync(join(root, "tests"), { recursive: true });
  const burnModule = (name: string): string => `
export function ${name}Leaf(n) {
  let s = 0;
  for (let i = 1; i < n; i++) s += Math.sqrt(i) * Math.sin(i) + Math.log(i);
  return s;
}
export function ${name}Burn(ms) {
  let acc = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) acc += ${name}Leaf(4000);
  return acc;
}
`;
  const testFile = (name: string): string => `
import { test, expect } from "bun:test";
import { ${name}Burn } from "../${name}.mjs";
test("${name} burns", () => {
  expect(${name}Burn(350)).toBeGreaterThan(0);
});
`;
  writeFileSync(join(root, "alpha.mjs"), burnModule("alpha"));
  writeFileSync(join(root, "beta.mjs"), burnModule("beta"));
  writeFileSync(join(root, "tests", "alpha.test.mjs"), testFile("alpha"));
  writeFileSync(join(root, "tests", "beta.test.mjs"), testFile("beta"));
  fixtureDir = root;
  return root;
}

async function runFixtureSuite(
  root: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "test", "--preload", ENTRY],
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
}

describe("bun-test preload entry (subprocess e2e)", () => {
  test(
    "traced run: per-file coverage contexts, no cross-file bleed, clean exit",
    async () => {
      const root = buildFixture();
      received.length = 0;

      const { exitCode, stderr } = await runFixtureSuite(root, {
        HAYVEN_TRACE: "1",
        HAYVEN_TRACE_URL: server.url.href,
        HAYVEN_TRACE_MODULE_ROOT: root,
        HAYVEN_TRACE_PROJECT: root,
      });

      // Tracing must never fail a passing suite, and the run must terminate.
      expect(stderr).toContain("2 pass");
      expect(exitCode).toBe(0);

      const rows = received.flatMap((p) => p.test_coverage ?? []);
      if (rows.length === 0 && stderr.includes("CPU profiler unavailable")) {
        return; // graceful-degradation runtime — nothing to assert on.
      }

      // Contexts are MODULE_ROOT-relative test-file module ids.
      const contexts = new Set(rows.map((r) => r.test));
      expect(contexts.has("tests/alpha.test")).toBe(true);
      expect(contexts.has("tests/beta.test")).toBe(true);

      // Each file's burn attributed to ITS context…
      const entitiesOf = (ctx: string): string[] =>
        rows.filter((r) => r.test === ctx).map((r) => r.entity);
      expect(entitiesOf("tests/alpha.test").some((e) => e.includes("alpha"))).toBe(true);
      expect(entitiesOf("tests/beta.test").some((e) => e.includes("beta"))).toBe(true);
      // …and NEVER to the other file's (window harvested before the context
      // flips at the file boundary). The burns run only inside their tests,
      // so any cross row would be a real attribution bug.
      expect(entitiesOf("tests/alpha.test").some((e) => e.includes("betaBurn"))).toBe(false);
      expect(entitiesOf("tests/beta.test").some((e) => e.includes("alphaBurn"))).toBe(false);
    },
    60000,
  );

  test(
    "without HAYVEN_TRACE the preload is a silent no-op (zero POSTs)",
    async () => {
      const root = fixtureDir ?? buildFixture();
      received.length = 0;

      const { exitCode } = await runFixtureSuite(root, {
        HAYVEN_TRACE: "",
        HAYVEN_TRACE_URL: server.url.href,
      });

      expect(exitCode).toBe(0);
      expect(received).toHaveLength(0);
    },
    60000,
  );
});
