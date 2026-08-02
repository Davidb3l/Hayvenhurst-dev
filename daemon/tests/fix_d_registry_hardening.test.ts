/**
 * Registry hardening: root canonicalization, hand-edit preservation, clock-skew
 * tolerance in the stale-eviction window, and collision-safe alias derivation.
 *
 * Every case here is a "plausible default causing silent wrongness": a repo
 * registered twice under two aliases, a hand-edited row erased by an unrelated
 * write, a grace window defeated by a clock jump, an alias fallback that
 * collides with itself. None of them produced an error message.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  deriveAlias,
  pruneStaleProjects,
  readRegistry,
  readRegistryRaw,
  registerProject,
  registryFile,
  writeRegistry,
} from "../src/daemon/registry.ts";

let home: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayven-harden-home-")));
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

/** The raw rows on disk, untouched by any read-time repair. */
function onDisk(): Array<{ alias: string; root: string; missing_since?: string }> {
  return JSON.parse(readFileSync(registryFile(), "utf8")).projects;
}

describe("root canonicalization", () => {
  it("registers ONE entry for a root spelled with a trailing slash", () => {
    // Both spellings used to be stored verbatim and deduped by exact string,
    // yielding aliases `myrepo` and `myrepo-2` for one repo. `cli/daemon.ts`
    // then starts a runtime per alias: two watchers, two ingest pipelines and
    // two `Db` handles on a single `.hayven/index.sqlite` WAL.
    const root = makeRepo("myrepo");
    registerProject(root);
    registerProject(root + "/");
    expect(readRegistry().map((e) => e.alias)).toEqual(["myrepo"]);
  });

  it("registers ONE entry for a root spelled with a '/.' segment", () => {
    const root = makeRepo("myrepo");
    registerProject(root);
    // Concatenated, NOT `join(root, ".")` — `join` already normalizes the dot
    // away, so that spelling would exercise nothing and pass without the fix.
    registerProject(root + "/.");
    expect(readRegistry().map((e) => e.alias)).toEqual(["myrepo"]);
  });

  it("registers ONE entry for a symlinked spelling of the same repo", () => {
    const real = makeRepo("real-repo");
    const link = join(home, "linked-repo");
    symlinkSync(real, link);
    registerProject(real);
    registerProject(link);
    const served = readRegistry();
    expect(served).toHaveLength(1);
    expect(served[0]!.root).toBe(real);
  });

  it("dedupes non-canonical duplicates that were HAND-EDITED into the file", () => {
    // The module docstring invites hand-editing, so the alias-spelling duplicate
    // arrives through that door too, not only through `registerProject`.
    const root = makeRepo("myrepo");
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        projects: [
          { alias: "myrepo", root },
          { alias: "myrepo-again", root: root + "/" },
        ],
      }),
    );
    expect(readRegistryRaw()).toHaveLength(1);
  });

  it("PRECONDITION: two genuinely different repos are still two entries", () => {
    // Without this, every assertion above would also pass for an implementation
    // that collapsed everything into one entry.
    registerProject(makeRepo("a"));
    registerProject(makeRepo("b"));
    expect(readRegistry()).toHaveLength(2);
  });
});

describe("hand-edited rows are never silently erased", () => {
  it("repairs a leading `~` instead of dropping the row", () => {
    // `~` is the most likely hand-edit mistake — every docstring in the module
    // spells global paths that way. The row used to fail `isAbsolute` and be
    // dropped from `readRegistryRaw`, and since every mutation rewrites from
    // that list, the next unrelated write deleted it from disk permanently.
    const keep = makeRepo("keep");
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        projects: [
          { alias: "handedit", root: "~/code/myrepo" },
          { alias: "keep", root: keep },
        ],
      }),
    );

    registerProject(makeRepo("fresh")); // an UNRELATED write

    const rows = onDisk();
    expect(rows.map((r) => r.alias).sort()).toEqual(["fresh", "handedit", "keep"]);
    const repaired = rows.find((r) => r.alias === "handedit")!;
    expect(isAbsolute(repaired.root)).toBe(true);
    expect(repaired.root).toBe(join(homedir(), "code", "myrepo"));
  });

  it("preserves an unrepairable relative root verbatim, and refuses to serve it", () => {
    const keep = makeRepo("keep");
    writeFileSync(
      registryFile(),
      JSON.stringify({
        version: 1,
        projects: [
          { alias: "relative", root: "code/myrepo" },
          { alias: "keep", root: keep },
        ],
      }),
    );

    registerProject(makeRepo("fresh"));

    const rows = onDisk();
    expect(rows.find((r) => r.alias === "relative")?.root).toBe("code/myrepo");
    // Preserved on disk but NEVER served: `isRegistrableRoot` would otherwise
    // `resolve()` it against whatever cwd the daemon started in and serve an
    // arbitrary directory.
    expect(readRegistry().map((e) => e.alias).sort()).toEqual(["fresh", "keep"]);
  });

  it("does not evict a preserved relative row as 'missing'", () => {
    writeFileSync(
      registryFile(),
      JSON.stringify({ version: 1, projects: [{ alias: "relative", root: "code/myrepo" }] }),
    );
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");
    expect(pruneStaleProjects(t0)).toEqual([]);
    expect(pruneStaleProjects(t0 + 30 * 24 * 60 * 60 * 1000)).toEqual([]);
    expect(onDisk()).toEqual([{ alias: "relative", root: "code/myrepo" }]);
  });

  it("carries missing_since across an alias rename", () => {
    // Rebuilding the entry from scratch dropped the stamp, silently restarting
    // the 7-day countdown for a root that is currently unreachable.
    const gone = makeRepo("external-drive");
    registerProject(gone);
    rmSync(gone, { recursive: true, force: true });
    const t0 = Date.parse("2026-08-01T00:00:00.000Z");
    pruneStaleProjects(t0);
    const stamp = onDisk()[0]!.missing_since;
    expect(stamp).toBeDefined();

    registerProject(gone, "renamed");

    expect(onDisk()[0]!.alias).toBe("renamed");
    expect(onDisk()[0]!.missing_since).toBe(stamp);
  });
});

describe("clock skew does not break the grace window", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-08-01T00:00:00.000Z");

  /** A registered-then-deleted root carrying a hand-set `missing_since`. */
  function missingWithStamp(stamp: string): string {
    const gone = makeRepo("drive");
    registerProject(gone);
    rmSync(gone, { recursive: true, force: true });
    writeRegistry([{ alias: "drive", root: gone, missing_since: stamp }]);
    return gone;
  }

  it("does not evict on a stamp from a dead RTC (backward-then-forward jump)", () => {
    // Boot with a dead clock reads 2000-01-01 and stamps that on the FIRST
    // miss; NTP then corrects to 2026 and the next start sees ~26 years > 7
    // days and evicts — on what was really the first miss, defeating the whole
    // point of the window (an unmounted external drive).
    missingWithStamp("2000-01-01T00:00:00.000Z");
    expect(pruneStaleProjects(NOW)).toEqual([]);
    // …and it is re-stamped to now, so a REAL absence still evicts on schedule.
    expect(onDisk()[0]!.missing_since).toBe(new Date(NOW).toISOString());
    expect(pruneStaleProjects(NOW + 8 * DAY).map((e) => e.alias)).toEqual(["drive"]);
  });

  it("evicts an entry whose stamp is in the FUTURE, once a real window passes", () => {
    // A future stamp keeps `now - since` negative, so the entry was NEVER
    // evicted — immortal, and invisible.
    missingWithStamp(new Date(NOW + 400 * DAY).toISOString());
    expect(pruneStaleProjects(NOW)).toEqual([]);
    expect(onDisk()[0]!.missing_since).toBe(new Date(NOW).toISOString());
    expect(pruneStaleProjects(NOW + 8 * DAY).map((e) => e.alias)).toEqual(["drive"]);
  });

  it("PRECONDITION: an ordinary in-window stamp is still honored, not re-stamped", () => {
    // Guards the two tests above from passing via a "re-stamp everything"
    // implementation, which would make eviction unreachable entirely.
    const stamp = new Date(NOW - 3 * DAY).toISOString();
    missingWithStamp(stamp);
    expect(pruneStaleProjects(NOW)).toEqual([]);
    expect(onDisk()[0]!.missing_since).toBe(stamp);
    // 3 days already elapsed + 5 more > the 7-day window.
    expect(pruneStaleProjects(NOW + 5 * DAY).map((e) => e.alias)).toEqual(["drive"]);
  });
});

describe("deriveAlias collision fallback", () => {
  it("returns a unique alias for every one of 1,200 rows sharing an alias", () => {
    // The old fallback after 999 attempts was `${base}-${Date.now()}`, and
    // `readRegistryRaw`'s repair loop makes many calls inside one millisecond:
    // measured 1,018 distinct aliases from 1,200 rows. `cli/daemon.ts`'s
    // `runtimes.set(alias, …)` then silently drops a project per collision.
    const n = 1200;
    const projects = Array.from({ length: n }, (_, i) => ({
      alias: "dup",
      root: join(home, `repo-${i}`),
    }));
    writeFileSync(registryFile(), JSON.stringify({ version: 1, projects }));

    const raw = readRegistryRaw();

    expect(raw).toHaveLength(n);
    expect(new Set(raw.map((e) => e.alias)).size).toBe(n);
  });

  it("keeps counting past 999 instead of falling back to a timestamp", () => {
    // Assert the EXACT alias, not merely "not already taken". The old
    // implementation gave up at n=999 and returned `base-<Date.now()>`, which
    // is also not in `taken` — so a "not taken" assertion passes with the fix
    // reverted and proves nothing.
    const taken = Array.from({ length: 1500 }, (_, i) => ({
      alias: i === 0 ? "base" : `base-${i + 1}`,
      root: join(home, `r${i}`),
    }));
    expect(deriveAlias(join(home, "new"), "base", taken)).toBe("base-1501");
  });
});
