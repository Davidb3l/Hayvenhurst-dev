/**
 * `cli.ts` must turn a "this index is newer than me" refusal into an actionable
 * message, not a stack trace.
 *
 * Before this, `main` had no top-level try/catch, so a genuinely newer schema
 * surfaced from all 18 readonly `openProjectDb` sites as a raw
 * `SQLiteError: no such column: kind` with internal file:line — and the MCP
 * server relayed it to the agent as `-32603 internal error`.
 *
 * We drive `main`'s dispatch with a command whose `run` throws, rather than
 * through a real subcommand: `ingest` already catches this itself, so routing
 * the test through it would pass whether or not `cli.ts` does anything.
 */
import { afterEach, describe, expect, it } from "bun:test";

import { COMMANDS, main } from "../src/cli.ts";
import { SchemaTooNewError } from "../src/db/migrations.ts";

/** Swap one command's `run`, returning a restore function. */
function stubCommand(name: string, run: () => Promise<number>): () => void {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd === undefined) throw new Error(`no such command: ${name}`);
  const original = cmd.run;
  cmd.run = run;
  return () => {
    cmd.run = original;
  };
}

let restore: (() => void) | null = null;
let errors: string[] = [];
const realError = console.error;

function captureStderr(): void {
  errors = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
}

afterEach(() => {
  console.error = realError;
  restore?.();
  restore = null;
});

describe("cli.ts top-level schema guard", () => {
  it("turns SchemaTooNewError into `error: …` and exit 1", async () => {
    restore = stubCommand("query", async () => {
      throw new SchemaTooNewError(42, 7);
    });
    captureStderr();

    const code = await main(["query", "foo"]);

    expect(code).toBe(1);
    const printed = errors.join("\n");
    expect(printed).toContain("error:");
    expect(printed).toContain("v42");
    expect(printed).toContain("v7");
    // No stack trace leaked to the user. Check for the file:line signature
    // rather than "at " — the prose legitimately contains the word.
    expect(printed).not.toMatch(/\.ts:\d+/);
  });

  it("does NOT swallow other errors — those must still surface as bugs", async () => {
    restore = stubCommand("query", async () => {
      throw new Error("some genuine bug");
    });
    captureStderr();

    // Swallowing everything would hide real failures behind a tidy exit code.
    await expect(main(["query", "foo"])).rejects.toThrow("some genuine bug");
  });

  it("passes a normal exit code straight through", async () => {
    restore = stubCommand("query", async () => 7);
    const code = await main(["query", "foo"]);
    expect(code).toBe(7);
  });
});
