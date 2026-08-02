/**
 * P1 — `unregister` must never delete a project the user did not name.
 *
 * The bug (verified silent data loss): a NON-absolute argument was resolved
 * against `process.cwd()` AND matched against every entry's ROOT, on top of the
 * alias match. With a registry of `[{alias:"zzz", root:"$SB/real/repo"}]` and a
 * cwd of `$SB/real`, `unregisterProject("repo")` returned true and deleted
 * `zzz`. So `hayven daemon unregister myproject` run from a parent folder
 * silently unregistered a DIFFERENT project.
 *
 * The fix is a rule, not a patch: an argument is an ALIAS xor a PATH, and a
 * bare name is never resolved against the cwd.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyUnregisterArg,
  readRegistryRaw,
  registerProject,
  registryFile,
  unregisterProject,
  unregisterProjectDetailed,
  writeRegistry,
} from "../src/daemon/registry.ts";

// MUST sandbox via $HAYVEN_HOME, not $HOME: Bun resolves `os.homedir()` once per
// process, so mutating HOME here would leave every call below pointed at the
// developer's real `~/.hayven/projects.json` and rewrite it.
let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapp-unreg-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
  // Tripwire copied from registry.test.ts: fail loudly rather than writing to
  // the developer's real registry.
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

function makeRepo(...segments: string[]): string {
  const root = join(home, ...segments);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  return root;
}

describe("unregisterProject: a bare name is an alias, never a cwd-relative path", () => {
  it("THE BUG: a bare name matching a cwd-relative root does NOT delete that project", () => {
    // The reviewer's exact probe. `zzz` is deliberately NOT the alias asked for.
    const repo = makeRepo("real", "repo");
    writeRegistry([{ alias: "zzz", root: repo }]);

    // `cwd` is injected rather than `process.chdir`'d: Bun runs test files in
    // one process, and a chdir would leak into every other test in this run.
    const outcome = unregisterProjectDetailed("repo", join(home, "real"));

    expect(outcome.removed).toBe(false);
    expect(outcome.target.kind).toBe("alias");
    // The entry is STILL THERE — this is the whole point.
    expect(readRegistryRaw()).toEqual([{ alias: "zzz", root: repo }]);
  });

  it("positive control: the same registry DOES yield to the real alias", () => {
    // Differs from the case above only in the argument. Proves the removal
    // machinery works and that it was the interpretation rule that stopped the
    // bad delete — not a broken fixture or a registry that was never written.
    const repo = makeRepo("real", "repo");
    writeRegistry([{ alias: "zzz", root: repo }]);

    expect(unregisterProjectDetailed("zzz", join(home, "real")).removed).toBe(true);
    expect(readRegistryRaw()).toEqual([]);
  });

  it("positive control: an explicit relative PATH still removes by root", () => {
    // A bare name is an alias, but `./repo` names a location and must behave
    // like one — otherwise the fix would have removed a capability instead of
    // fixing a bug.
    const repo = makeRepo("real", "repo");
    writeRegistry([{ alias: "zzz", root: repo }]);

    const outcome = unregisterProjectDetailed("./repo", join(home, "real"));
    expect(outcome.target.kind).toBe("path");
    expect(outcome.removed).toBe(true);
    expect(readRegistryRaw()).toEqual([]);
  });

  it("an alias that coincides with a sibling directory name removes the RIGHT one", () => {
    // The realistic shape of the incident: two registered repos, and the user
    // types the alias of one while standing next to a directory named the same
    // as... nothing in particular. The old code matched `other` by root.
    const wanted = makeRepo("wanted");
    const bystander = makeRepo("work", "myproject");
    writeRegistry([
      { alias: "myproject", root: wanted },
      { alias: "bystander", root: bystander },
    ]);

    expect(unregisterProject.length).toBeGreaterThanOrEqual(1); // arity sanity
    const outcome = unregisterProjectDetailed("myproject", join(home, "work"));

    expect(outcome.removed).toBe(true);
    // `bystander` survives, `myproject` (the ALIAS) is gone.
    expect(readRegistryRaw().map((e) => e.alias)).toEqual(["bystander"]);
  });

  it("absolute paths and `~` are still paths", () => {
    const repo = makeRepo("abs-repo");
    registerProject(repo, "abs-repo");
    expect(classifyUnregisterArg(repo).kind).toBe("path");
    expect(classifyUnregisterArg("~/somewhere").kind).toBe("path");
    expect(classifyUnregisterArg(".").kind).toBe("path");
    expect(classifyUnregisterArg("..").kind).toBe("path");
    expect(classifyUnregisterArg("a/b").kind).toBe("path");
    // ...and a bare, alias-shaped token is not.
    expect(classifyUnregisterArg("abs-repo").kind).toBe("alias");
    expect(unregisterProject(repo)).toBe(true);
  });
});

describe("unregisterProject: the miss message says how the argument was read", () => {
  it("an unmatched bare name lists the aliases that DO exist", () => {
    const repo = makeRepo("real", "repo");
    writeRegistry([{ alias: "zzz", root: repo }]);

    const { message } = unregisterProjectDetailed("repo", join(home, "real"));
    expect(message).toMatch(/alias "repo"/);
    expect(message).toMatch(/Registered aliases: zzz/);
    // Tells the user the escape hatch, so "it did nothing" is actionable.
    expect(message).toMatch(/pass a path/i);
  });

  it("an unmatched path names the resolved root, not the raw argument", () => {
    const { message } = unregisterProjectDetailed("./nope", join(home, "real"));
    expect(message).toContain(join(home, "real", "nope"));
    expect(message).toMatch(/as a path/);
  });
});
