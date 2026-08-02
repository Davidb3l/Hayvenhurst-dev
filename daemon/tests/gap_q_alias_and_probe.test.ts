/**
 * GAP Q6 — `runtimes.set(alias, runtime)` had no `has()` guard.
 * GAP Q7 — `daemon start` printed actively wrong advice for a version-skewed daemon.
 *
 * Q6 CONTEXT. `deriveAlias` only guarantees uniqueness against the REGISTRY on
 * disk, and the live `runtimes` map drifts from it: `hayven daemon unregister`
 * removes a registry entry without touching a RUNNING daemon, so the next
 * `registerProject` is free to hand back an alias this process already serves. A
 * bare `runtimes.set` then orphans the first runtime — its `Db` handle and its
 * `hayven-native watch` child stay alive with nothing referencing them, so TWO
 * watchers and TWO writers end up on ONE `.hayven/index.sqlite` WAL, which
 * `util/paths.ts` states is corruption.
 *
 * `addProjectLive` / the startup loader are closures inside `startDaemon`, which
 * cannot be constructed without a live daemon, real indexes and a real native
 * binary — so Q6 is covered by a structural invariant over the file (every
 * `runtimes.set` is preceded by a `runtimes.has` guard) plus a direct check of
 * the registry-drift premise it defends against.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveAlias,
  readRegistry,
  registerProject,
  registryFile,
  unregisterProject,
} from "../src/daemon/registry.ts";

// MUST sandbox via $HAYVEN_HOME, not $HOME: Bun resolves `os.homedir()` once per
// process, so mutating HOME would leave every call below pointed at the
// developer's real `~/.hayven/projects.json` and rewrite it.
let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-gapq-alias-home-")));
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

function makeRepo(name: string): string {
  const root = join(home, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  return root;
}

describe("Q6 — the premise: registry uniqueness is NOT live-map uniqueness", () => {
  test("after `unregister`, the next register hands the SAME alias to a different repo", () => {
    // `hayven daemon unregister app` while the daemon is up: the daemon keeps
    // serving `app`, but the registry has forgotten it.
    const first = registerProject(makeRepo("app"));
    unregisterProject(first.alias);
    // A different repo whose basename derives the same alias now gets it.
    const second = registerProject(makeRepo("nested/app"));
    expect(second.alias).toBe(first.alias);
    expect(second.root).not.toBe(first.root);
    // So a live daemon still holding `first` under that alias would be handed a
    // colliding entry with nothing in the registry to stop it.
    expect(readRegistry().length).toBe(1);
  });

  test("deriveAlias only ever consults the REGISTRY entries it is given", () => {
    // Nothing about it knows what a running daemon currently serves — hand it an
    // empty registry and the alias it returns is free of any live-map knowledge.
    const root = makeRepo("solo");
    expect(deriveAlias(root, undefined, [])).toBe("solo");
    // With the name taken IN THE REGISTRY it disambiguates; with the name taken
    // only in a live daemon's map (which it is never shown) it cannot.
    expect(deriveAlias(root, undefined, [{ alias: "solo", root: "/elsewhere" }])).not.toBe("solo");
  });
});

describe("Q6 — every live-map insertion is guarded", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "daemon.ts"), "utf8");

  test("no `runtimes.set` in cli/daemon.ts is unguarded", () => {
    const lines = source.split("\n");
    const setLines = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /\bruntimes\.set\(/.test(l));
    // The startup loader and the live hot-add.
    expect(setLines.length).toBe(2);
    for (const { i } of setLines) {
      // The guard is a `runtimes.has(...)` check within the preceding 30 lines
      // (the comment explaining WHY sits between them).
      const window = lines.slice(Math.max(0, i - 30), i).join("\n");
      expect(window).toMatch(/runtimes\.has\(/);
    }
  });

  test("the hot-add guard refuses rather than silently renaming", () => {
    expect(source).toContain("is already served by this daemon");
  });

  test("the startup loader skips a duplicate alias loudly", () => {
    expect(source).toContain("skipping project — its alias is already served");
  });
});

describe("Q6 — DELETE /api/projects/:alias does not FORGET a registration", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "daemon.ts"), "utf8");

  test("removeProjectLive never calls unregisterProject", () => {
    // "Stop serving it live" and "permanently forget it" are different powers,
    // and an unauthenticated localhost call must only have the first. The
    // decision is stated explicitly at the call site so it cannot be
    // re-introduced by accident.
    const start = source.indexOf("const removeProjectLive");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("const subscribeProjects", start);
    const body = source.slice(start, end);
    // The ONLY mention of `unregisterProject` in this function must be the
    // comment saying it is deliberately not called.
    expect(body).toContain("deliberately NOT `unregisterProject`");
    expect(body.split("unregisterProject").length - 1).toBe(1);
    expect(body).not.toMatch(/unregisterProject\(/);
  });
});

describe("Q7 — `daemon start` prints the probe's reason for a version-skewed daemon", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "daemon.ts"), "utf8");

  test("the generic 'not a hayven daemon' advice is only the FALLBACK", () => {
    // `foreign` covers both "not a hayven daemon at all" and "a hayven daemon we
    // are version-incompatible with". Only the former is fixed by picking a free
    // port; telling a user with a stale daemon to start on another port leaves
    // two daemons up. `probe.reason` is set only for the version case.
    const at = source.indexOf('if (probe.kind === "foreign")');
    expect(at).toBeGreaterThan(-1);
    const block = source.slice(at, at + 900);
    expect(block).toContain("probe.reason !== undefined");
    // The reason must be printed BEFORE the generic wording in the ternary.
    const reasonAt = block.indexOf("`error: ${probe.reason}\\n`");
    const genericAt = block.indexOf("is in use by something that is NOT a hayven daemon");
    expect(reasonAt).toBeGreaterThan(-1);
    expect(genericAt).toBeGreaterThan(reasonAt);
  });
});
