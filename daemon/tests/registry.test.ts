/**
 * Multi-project registry guards.
 *
 * Regression cover for the "daemon indexed the whole home directory" bug: a
 * session starting in `$HOME` saw the GLOBAL `~/.hayven` dir, concluded it was
 * inside a project, started a daemon with cwd=$HOME, and registered the user's
 * entire tree as one project — permanently, since nothing ever un-registered it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRegistrableRoot,
  isRegistrableRoot,
  pruneStaleProjects,
  readRegistry,
  readRegistryRaw,
  registerProject,
  registryFile,
  unregisterProject,
  writeRegistry,
} from "../src/daemon/registry.ts";

// MUST sandbox via $HAYVEN_HOME, not $HOME: Bun resolves `os.homedir()` once per
// process, so mutating HOME here would leave every call below pointed at the
// developer's real `~/.hayven/projects.json` and rewrite it.
let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  // realpath'd: `registerProject` stores the CANONICAL root, and on macOS
  // `tmpdir()` is `/var/folders/…` whose real path is `/private/var/folders/…`.
  // Without this the fixture and the stored value differ by a symlink hop and
  // every root assertion below compares two spellings of the same directory.
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-registry-home-")));
  process.env["HAYVEN_HOME"] = home;
  mkdirSync(join(home, ".hayven"), { recursive: true });
  // Fail loudly rather than writing to the developer's real registry — an
  // earlier draft of this file sandboxed the wrong variable and did exactly that.
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(home, { recursive: true, force: true });
});

/** A real, existing directory under the sandboxed home. */
function makeRepo(name: string): string {
  const root = join(home, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  return root;
}

describe("assertRegistrableRoot", () => {
  it("refuses $HOME", () => {
    expect(() => assertRegistrableRoot(home)).toThrow(/home directory/i);
  });

  it("refuses $HOME given with a trailing slash or a '.' segment", () => {
    expect(() => assertRegistrableRoot(home + "/")).toThrow(/home directory/i);
    expect(() => assertRegistrableRoot(join(home, "."))).toThrow(/home directory/i);
  });

  it("refuses the filesystem root", () => {
    expect(() => assertRegistrableRoot("/")).toThrow(/filesystem root/i);
  });

  it("allows a normal repo under home", () => {
    expect(() => assertRegistrableRoot(makeRepo("proj"))).not.toThrow();
  });

  it("honors an injected homeDir over the ambient one", () => {
    const other = mkdtempSync(join(tmpdir(), "hayven-other-home-"));
    expect(() => assertRegistrableRoot(other, { homeDir: other })).toThrow(/home directory/i);
    expect(() => assertRegistrableRoot(home, { homeDir: other })).not.toThrow();
    rmSync(other, { recursive: true, force: true });
  });
});

describe("isRegistrableRoot", () => {
  it("is the non-throwing form", () => {
    expect(isRegistrableRoot(home)).toBe(false);
    expect(isRegistrableRoot("/")).toBe(false);
    expect(isRegistrableRoot(makeRepo("ok"))).toBe(true);
  });
});

describe("registerProject", () => {
  it("throws rather than registering $HOME", () => {
    expect(() => registerProject(home)).toThrow(/home directory/i);
    expect(readRegistry()).toHaveLength(0);
  });

  it("still registers ordinary repos", () => {
    const root = makeRepo("myrepo");
    expect(registerProject(root).alias).toBe("myrepo");
    expect(readRegistry()).toEqual([{ alias: "myrepo", root }]);
  });

  it("is idempotent by root", () => {
    const root = makeRepo("myrepo");
    registerProject(root);
    registerProject(root);
    expect(readRegistry()).toHaveLength(1);
  });
});

describe("readRegistry", () => {
  it("drops a pre-existing $HOME entry written before the guard existed", () => {
    // Simulate an already-poisoned install: the bad entry is on disk.
    const good = makeRepo("good");
    writeRegistry([
      { alias: "davidbeltran", root: home },
      { alias: "good", root: good },
    ]);
    expect(readRegistry()).toEqual([{ alias: "good", root: good }]);
  });

  it("does not rewrite the file as a side effect of reading", () => {
    writeRegistry([{ alias: "home", root: home }]);
    readRegistry();
    // The bad entry is filtered from the RESULT but left in the FILE: reads are
    // pure, and only an explicit write (prune/register/unregister) rewrites it.
    const onDisk = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(onDisk.projects).toHaveLength(1);
    expect(readRegistry()).toHaveLength(0);
  });
});

describe("pruneStaleProjects", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** Register `name`, then delete its directory. Returns the root. */
  function registerThenDelete(name: string): string {
    const root = makeRepo(name);
    registerProject(root);
    rmSync(root, { recursive: true, force: true });
    return root;
  }

  it("does NOT remove a missing root on the first miss — it stamps it and keeps it", () => {
    const gone = registerThenDelete("unmounted-drive");
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");

    expect(pruneStaleProjects(t0)).toEqual([]);

    const onDisk = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(onDisk.projects).toHaveLength(1);
    expect(onDisk.projects[0].root).toBe(gone);
    expect(onDisk.projects[0].missing_since).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps a missing root for the whole grace window", () => {
    registerThenDelete("sleeping-share");
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");
    pruneStaleProjects(t0);
    expect(pruneStaleProjects(t0 + 6 * DAY)).toEqual([]);
    expect(JSON.parse(readFileSync(registryFile(), "utf8")).projects).toHaveLength(1);
  });

  it("removes it only once the grace window has passed", () => {
    const gone = registerThenDelete("really-deleted");
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");
    pruneStaleProjects(t0);

    const removed = pruneStaleProjects(t0 + 8 * DAY);

    expect(removed.map((e) => e.root)).toEqual([gone]);
    expect(JSON.parse(readFileSync(registryFile(), "utf8")).projects).toEqual([]);
  });

  it("clears the stamp when a root comes back (an unmounted drive is remounted)", () => {
    const root = registerThenDelete("external-drive");
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");
    pruneStaleProjects(t0);
    expect(JSON.parse(readFileSync(registryFile(), "utf8")).projects[0].missing_since).toBeDefined();

    mkdirSync(join(root, ".hayven"), { recursive: true }); // remounted
    expect(pruneStaleProjects(t0 + 2 * DAY)).toEqual([]);

    const onDisk = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(onDisk.projects).toHaveLength(1);
    expect(onDisk.projects[0].missing_since).toBeUndefined();
    // …and the countdown restarts from scratch, so it is not evicted early.
    rmSync(root, { recursive: true, force: true });
    pruneStaleProjects(t0 + 3 * DAY);
    expect(pruneStaleProjects(t0 + 9 * DAY)).toEqual([]);
  });

  it("removes a pre-guard $HOME entry, and REPORTS it rather than deleting silently", () => {
    const good = makeRepo("good");
    writeRegistry([
      { alias: "davidbeltran", root: home },
      { alias: "good", root: good },
    ]);

    const removed = pruneStaleProjects();

    expect(removed.map((e) => e.root)).toEqual([home]);
    expect(JSON.parse(readFileSync(registryFile(), "utf8")).projects).toEqual([
      { alias: "good", root: good },
    ]);
  });

  it("does not write when nothing changed", () => {
    registerProject(makeRepo("a"));
    const before = statSync(registryFile()).mtimeMs;
    expect(pruneStaleProjects()).toEqual([]);
    expect(statSync(registryFile()).mtimeMs).toBe(before);
  });
});

describe("writeRegistry", () => {
  it("leaves no stray .tmp file behind", () => {
    writeRegistry([{ alias: "a", root: makeRepo("a") }]);
    const leftovers = readdirSync(join(home, ".hayven")).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("a shorter body fully REPLACES a longer one, leaving no trailing bytes", () => {
    // Honest scope: this is single-threaded, so it does NOT prove atomicity —
    // a plain `writeFileSync(file, body)` passes it too. The atomicity
    // guarantees (unique tmp name, scratch cleanup) are pinned in
    // `fix_d_registry_lock.test.ts`, which probes them directly and drives
    // real concurrent processes.
    writeRegistry(Array.from({ length: 40 }, (_, i) => ({ alias: `p${i}`, root: makeRepo(`p${i}`) })));
    writeRegistry([{ alias: "solo", root: makeRepo("solo") }]);
    const parsed = JSON.parse(readFileSync(registryFile(), "utf8"));
    expect(parsed.projects).toEqual([{ alias: "solo", root: join(home, "solo") }]);
  });
});

describe("unregisterProject", () => {
  it("removes by alias and by root", () => {
    const a = makeRepo("a");
    const b = makeRepo("b");
    registerProject(a);
    registerProject(b);
    expect(unregisterProject("a")).toBe(true);
    expect(unregisterProject(b)).toBe(true);
    expect(readRegistry()).toHaveLength(0);
  });

  it("removes ONLY its target — never entries the serve-time filter hides", () => {
    // The read → modify → write hazard: `readRegistry()` hides the $HOME entry,
    // so rewriting from THAT list would erase it as a side effect of an
    // unrelated removal. Mutations must read raw.
    const keepMe = makeRepo("keep-me");
    const dropMe = makeRepo("drop-me");
    writeRegistry([
      { alias: "poisoned", root: home },
      { alias: "keep-me", root: keepMe },
      { alias: "drop-me", root: dropMe },
    ]);

    expect(unregisterProject("drop-me")).toBe(true);

    const onDisk = JSON.parse(readFileSync(registryFile(), "utf8")).projects;
    expect(onDisk.map((e: { alias: string }) => e.alias).sort()).toEqual(["keep-me", "poisoned"]);
  });

  it("registerProject also preserves filtered entries", () => {
    const keepMe = makeRepo("keep-me");
    writeRegistry([
      { alias: "poisoned", root: home },
      { alias: "keep-me", root: keepMe },
    ]);

    registerProject(makeRepo("fresh"));

    const onDisk = JSON.parse(readFileSync(registryFile(), "utf8")).projects;
    expect(onDisk.map((e: { alias: string }) => e.alias).sort()).toEqual([
      "fresh",
      "keep-me",
      "poisoned",
    ]);
  });
});

describe("readRegistryRaw", () => {
  it("repairs a duplicate alias instead of discarding the entry", () => {
    // The file is documented as hand-editable, so a duplicated alias is a
    // plausible typo. Losing a whole repo registration to it is not acceptable.
    const a = makeRepo("a");
    const b = makeRepo("b");
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        projects: [
          { alias: "dup", root: a },
          { alias: "dup", root: b },
        ],
      }),
    );

    const raw = readRegistryRaw();
    expect(raw).toHaveLength(2);
    expect(raw.map((e) => e.root).sort()).toEqual([a, b].sort());
    expect(new Set(raw.map((e) => e.alias)).size).toBe(2); // aliases made unique
  });

  it("keeps the $HOME entry that readRegistry hides", () => {
    writeRegistry([{ alias: "poisoned", root: home }]);
    expect(readRegistryRaw()).toHaveLength(1);
    expect(readRegistry()).toHaveLength(0);
  });
});

describe("symlinked home", () => {
  // The guard compares against `homedir()`, which keeps symlinks, while every
  // caller passes a realpath'd root (`canonicalRoot`, or `process.cwd()`, which
  // is already physical). On a host where $HOME has a symlinked component
  // (/home/x -> /mnt/..., autofs/NFS homes, a relocated macOS home) a raw
  // string compare misses and the original bug walks straight through.
  it("blocks BOTH the symlink spelling and the canonical spelling", () => {
    const base = mkdtempSync(join(tmpdir(), "hayven-symhome-"));
    const real = join(base, "real-home");
    const link = join(base, "linked-home");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);

    // Home is known by its symlink path; the caller supplies the resolved one.
    expect(isRegistrableRoot(link, { homeDir: link })).toBe(false);
    expect(isRegistrableRoot(real, { homeDir: link })).toBe(false);
    // …and the reverse spelling too.
    expect(isRegistrableRoot(link, { homeDir: real })).toBe(false);
    expect(isRegistrableRoot(real, { homeDir: real })).toBe(false);
    // A genuine repo under it is still fine.
    const proj = join(real, "proj");
    mkdirSync(proj, { recursive: true });
    expect(isRegistrableRoot(proj, { homeDir: link })).toBe(true);

    rmSync(base, { recursive: true, force: true });
  });
});
