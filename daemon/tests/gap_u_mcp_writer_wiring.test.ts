/**
 * The MCP stdio backpressure fix must actually be WIRED UP.
 *
 * `runStdioLoop` grew a drain-aware writer contract because a bare
 * `process.stdout.write` against a stalled reader grows without bound —
 * measured at 8k pipelined requests → 207 MB, 30k → 1.4 GB, 60k → 2.7 GB,
 * linear and silent. That mechanism is tested behaviourally in
 * `gap_s_stdio_backpressure.test.ts`.
 *
 * But `daemon/src/cli/mcp.ts` is the ONLY production call site, and it was
 * passing `(line) => process.stdout.write(line)` — so the entire fix was inert
 * and the 2.7 GB behaviour was what shipped. Nothing in the suite touched
 * `cli/mcp.ts` at all, so reverting that one line was invisible.
 *
 * That is the same shape as two other misses in this codebase: log rotation
 * where every test called the helper directly while the real write path was
 * never exercised, and a knob whose every assertion went through a validating
 * layer that rejected first. See DESIGN_LESSONS #1.
 *
 * WHAT THIS TEST IS, HONESTLY: a source-level assertion, not a behavioural one.
 * Exercising the real path needs a spawned `hayven mcp`, a real project fixture
 * and a deliberately stalled pipe — that is what the Lane S test does for the
 * MECHANISM. This pins the WIRING, which is the part that was missing and the
 * part a refactor silently breaks. It fails if the call site reverts to a bare
 * writer, which is exactly the regression it exists to catch.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MCP_CLI = join(import.meta.dir, "..", "src", "cli", "mcp.ts");

describe("hayven mcp wires the drain-aware writer", () => {
  const source = readFileSync(MCP_CLI, "utf8");

  it("passes createDrainAwareWriter to runStdioLoop, not a bare write", () => {
    // Match to the STATEMENT terminator, not the first `)`. A lazy `\)` stops
    // at `Bun.stdin.stream()` and never sees the writer argument at all — the
    // first draft of this test did exactly that and failed identically with
    // and without the fix, i.e. its mutation check was meaningless.
    const call = source.match(/runStdioLoop\([^;]*;/);
    expect(call).not.toBeNull();
    const text = call![0];

    expect(text).toContain("createDrainAwareWriter");
    // The specific regression: a lambda forwarding straight to stdout.
    expect(text).not.toMatch(/process\.stdout\.write/);
  });

  it("imports it, so the symbol is real rather than a stale identifier", () => {
    // Guards the failure mode where the call site looks right but the import
    // was dropped in a merge — tsc would catch it, but only if tsc is run.
    expect(source).toMatch(
      /import\s*\{[^}]*createDrainAwareWriter[^}]*\}\s*from\s*["']\.\.\/mcp\/context_server\.ts["']/,
    );
  });
});
