// LANE T / T3 — every flag this branch added is DISCOVERABLE in `hayven help`.
//
// The failure being prevented is mundane and expensive: a flag that exists and
// is undocumented is a flag nobody uses correctly. `--max-files` is the guard
// that stops `hayven init` from indexing a home directory (the whole point of
// this branch), and `hayven proxy --host` decides whether an unauthenticated
// proxy over your entire code graph is reachable from the network. Both shipped
// with no mention in the help table.
//
// Asserted against the RENDERED help — the thing a user actually reads — rather
// than against the COMMANDS table, so a help line that stops being rendered
// (wrong group, filtered out) still fails.
import { describe, expect, it } from "bun:test";

import { COMMANDS, main } from "../src/cli.ts";

async function renderedHelp(): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    expect(await main(["--help"])).toBe(0);
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("T3 — help documents this branch's new flags", () => {
  it("`hayven init` advertises --max-files", async () => {
    const help = await renderedHelp();
    expect(help).toContain("--max-files");
  });

  it("`hayven proxy` advertises --host", async () => {
    const help = await renderedHelp();
    const proxyLine = help.split("\n").find((l) => l.trim().startsWith("proxy "));
    expect(proxyLine).toBeDefined();
    expect(proxyLine).toContain("--host");
  });

  it("`hayven summarize` advertises its run-bounding flags", async () => {
    const help = await renderedHelp();
    const line = help.split("\n").find((l) => l.trim().startsWith("summarize "));
    expect(line).toContain("--limit");
    expect(line).toContain("--max-seconds");
  });

  it("the new `crdt` command is dispatchable AND listed", async () => {
    const help = await renderedHelp();
    expect(help).toContain("crdt");
    expect(COMMANDS.some((c) => c.name === "crdt")).toBe(true);
  });

  it("every command in the table renders a help line (no silent drop-outs)", async () => {
    const help = await renderedHelp();
    for (const c of COMMANDS) {
      expect(help.includes(c.help)).toBe(true);
    }
  });
});
