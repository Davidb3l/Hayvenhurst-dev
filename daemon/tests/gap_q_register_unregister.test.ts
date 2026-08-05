/**
 * GAP Q (Lane P handoff) — two `hayven daemon` subcommands that threw away
 * work Lane P had already done.
 *
 *  1. `unregister` printed a bare `not found: <arg>`. The rule is that an
 *     argument is an ALIAS xor a PATH and a bare name is NEVER resolved against
 *     the cwd — but a user who only ever sees "not found" reads that as "no such
 *     project" when the real answer is "I matched aliases only".
 *     `unregisterProjectDetailed` returns a message that says which
 *     interpretation it used and what exists instead; printing anything else
 *     discards the diagnostic.
 *
 *  2. `register` had NO pre-walk file-count ceiling. `graph/ingest.ts` does cap
 *     `files_total`, but only off the native `start` record — i.e. after the
 *     walker has already walked the whole tree — so a `$HOME`-sized registration
 *     still cost a full traversal and then sat in the registry to be re-opened,
 *     re-watched and re-walked on every daemon start.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDaemon } from "../src/cli/daemon.ts";
import { readRegistry, registerProject, registryFile } from "../src/daemon/registry.ts";

// MUST sandbox via $HAYVEN_HOME, not $HOME: Bun resolves `os.homedir()` once per
// process, so mutating HOME would leave every call below pointed at the
// developer's real `~/.hayven/projects.json` and rewrite it.
let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapq-reg-home-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

/** Run a `hayven daemon <sub>` and capture what it wrote. */
async function run(
  positionals: string[],
  flags: Record<string, string | boolean> = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: unknown }).write = (s: string) => {
    out += s;
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (s: string) => {
    err += s;
    return true;
  };
  try {
    const code = await runDaemon({ positionals, flags });
    return { code, out, err };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = realOut;
    (process.stderr as unknown as { write: unknown }).write = realErr;
  }
}

function makeRepo(name: string, files = 0): string {
  const root = join(home, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  // Pin the port to one nothing listens on. Without a config the fixture falls
  // back to the DEFAULT 7777, so `register` hot-adds into whatever daemon is
  // running on the developer's machine, and THAT daemon writes the row into its
  // own real registry. Sandboxing HAYVEN_HOME cannot prevent it: the escape is
  // an HTTP call to another process, not a path this one resolves. That is how
  // roughly 76 of these fixtures ended up in a real `~/.hayven/projects.json`.
  // Port 1 is privileged and unbound, so the hot-add fails fast and the test
  // exercises the no-daemon path it always meant to.
  writeFileSync(
    join(root, ".hayven", "config.json"),
    `${JSON.stringify({ daemon_port: 1 }, null, 2)}\n`,
  );
  for (let i = 0; i < files; i++) {
    writeFileSync(join(root, "src", `f${i}.ts`), "export const x = 1;\n");
  }
  return root;
}

describe("Q/P1 — `daemon unregister` surfaces the alias-vs-path diagnostic", () => {
  test("a MISS explains that a bare name was read as an alias, and lists what exists", async () => {
    registerProject(makeRepo("zzz"));
    const { code, out } = await run(["unregister", "repo"]);
    expect(code).toBe(0);
    // The old output was exactly `not found: repo` — true, and useless.
    expect(out).not.toMatch(/^not found:/m);
    expect(out).toContain('no registered project with the alias "repo"');
    expect(out).toContain("Registered aliases: zzz");
    expect(out).toContain("treated as an ALIAS only");
    expect(out).toContain("./repo");
  });

  test("a MISS by PATH says it read the argument as a path", async () => {
    registerProject(makeRepo("zzz"));
    const { out } = await run(["unregister", "./not-a-project"]);
    expect(out).toContain("no registered project rooted at");
    expect(out).toContain("a bare name would have been an alias");
  });

  test("a HIT names which interpretation removed it", async () => {
    const entry = registerProject(makeRepo("keeper"));
    const { code, out } = await run(["unregister", entry.alias]);
    expect(code).toBe(0);
    expect(out).toContain(`unregistered alias "${entry.alias}"`);
    expect(readRegistry().length).toBe(0);
  });

  test("removing by PATH still works and says so", async () => {
    const root = makeRepo("byPath");
    registerProject(root);
    const { out } = await run(["unregister", root]);
    expect(out).toContain("unregistered the project rooted at");
    expect(readRegistry().length).toBe(0);
  });
});

describe("Q/P2 — `daemon register` refuses an oversized tree BEFORE persisting it", () => {
  test("a tree above the ceiling is refused, registers nothing, and exits 1", async () => {
    const root = makeRepo("huge", 12);
    const { code, err } = await run(["register", root], { "max-files": "5" });
    expect(code).toBe(1);
    expect(err).toContain("refusing to initialize");
    expect(err).toContain("hayven daemon register --max-files");
    // The whole point: nothing reached the registry, so no later `daemon start`
    // re-opens, re-watches and re-walks it.
    expect(readRegistry().length).toBe(0);
  });

  test("a tree under the ceiling registers normally", async () => {
    const root = makeRepo("small", 3);
    const { code } = await run(["register", root], { "max-files": "5000" });
    expect(code).toBe(0);
    expect(readRegistry().map((e) => e.root)).toContain(realpathSync(root));
  });

  test("`--max-files=off` disables the ceiling (the escape hatch the message names)", async () => {
    const root = makeRepo("optout", 12);
    const { code } = await run(["register", root], { "max-files": "off" });
    expect(code).toBe(0);
    expect(readRegistry().length).toBe(1);
  });

  test("a TYPO'd --max-files is refused, never silently defaulted", async () => {
    // `--max-files=5O000` (letter O) must not quietly re-arm the unbounded walk.
    const root = makeRepo("typo", 2);
    const { code, err } = await run(["register", root], { "max-files": "5O000" });
    expect(code).toBe(2);
    expect(err).toContain("--max-files must be a positive integer");
    expect(readRegistry().length).toBe(0);
  });
});
