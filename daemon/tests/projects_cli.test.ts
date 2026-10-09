/**
 * HAYV-12: project registry management.
 *
 * The bug this file pins (reproduced on the owner's machine): moving a repo
 * directory made the next daemon start register it as `<alias>-2` and keep the
 * old row as a missing ghost, and the only fix was hand-editing
 * `~/.hayven/projects.json`. Covered here:
 *   - auto-relocation by identity (`writer_id`) on the daemon-start path, and
 *     the refusals when identity is absent or different;
 *   - `rename` / `relocate` / `prune` / `remove` in the registry module;
 *   - timestamped backups, capped at 10;
 *   - the `hayven projects` CLI as a subprocess;
 *   - the doctor `registry` warning row;
 *   - one REAL daemon, proving a rename re-serves the project live.
 *
 * SANDBOX: every test sets `$HAYVEN_HOME` to a fresh temp dir and asserts the
 * registry resolves under it (never `$HOME`: Bun caches `os.homedir()`). Every
 * subprocess also gets `HAYVEN_PORT` pointed at a free port that is asserted
 * unanswered, so nothing can reach the developer's real daemon on 7777.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeOk, registryCheck } from "../src/cli/doctor.ts";
import { parseDuration } from "../src/cli/projects.ts";
import {
  backupRegistry,
  pruneMissingProjects,
  pruneStaleProjects,
  readProjectIdentity,
  readRegistryRaw,
  registerProject,
  registerProjectDetailed,
  registryFile,
  relocateProject,
  renameProject,
  unregisterProjectDetailed,
  writeRegistry,
} from "../src/daemon/registry.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const NATIVE_BIN = join(import.meta.dir, "..", "..", "native", "target", "release", "hayven-native");

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

let home: string;
let ws: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env["HAYVEN_HOME"];
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayv12-home-")));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "hayv12-ws-")));
  mkdirSync(join(home, ".hayven"), { recursive: true });
  process.env["HAYVEN_HOME"] = home;
  if (!registryFile().startsWith(home)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${home}`);
  }
});

afterEach(() => {
  if (priorHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

/** A repo with `.hayven/`, optionally carrying a `writer_id` (its identity). */
function makeRepo(name: string, writerId?: string, extra: Record<string, unknown> = {}): string {
  const root = join(ws, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  const cfg = { ...extra, ...(writerId !== undefined ? { writer_id: writerId } : {}) };
  writeFileSync(join(root, ".hayven", "config.json"), JSON.stringify(cfg));
  return root;
}

function backups(): string[] {
  return readdirSync(join(home, ".hayven")).filter((n) => n.startsWith("projects.json.hayven-backup-"));
}

describe("readProjectIdentity", () => {
  it("reads writer_id without ever writing one", () => {
    const withId = makeRepo("a", ID_A.toUpperCase());
    const without = makeRepo("b");
    expect(readProjectIdentity(withId)).toBe(ID_A);
    const before = readFileSync(join(without, ".hayven", "config.json"), "utf8");
    expect(readProjectIdentity(without)).toBeUndefined();
    expect(readFileSync(join(without, ".hayven", "config.json"), "utf8")).toBe(before);
    expect(readProjectIdentity(join(ws, "nope"))).toBeUndefined();
  });
});

describe("auto-relocation (moving a repo keeps its alias)", () => {
  it("re-points the row on the daemon-start path: prune, then register the new root", () => {
    const oldRoot = makeRepo("lydgr", ID_A);
    expect(registerProject(oldRoot).alias).toBe("lydgr");
    expect(readRegistryRaw()[0]?.id).toBe(ID_A);

    const newRoot = join(ws, "moved-here");
    renameSync(oldRoot, newRoot);
    // What `daemon start` does first: the old root is now missing.
    expect(pruneStaleProjects()).toEqual([]);
    expect(readRegistryRaw()[0]?.missing_since).toBeDefined();

    const outcome = registerProjectDetailed(newRoot);
    expect(outcome.entry.alias).toBe("lydgr");
    expect(outcome.relocatedFrom).toBe(oldRoot);
    expect(outcome.ambiguousWith).toBeUndefined();
    const rows = readRegistryRaw();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ alias: "lydgr", root: newRoot, id: ID_A });
  });

  it("works for a row registered before `id` existed, once a daemon start backfilled it", () => {
    const oldRoot = makeRepo("legacy", ID_A);
    writeRegistry([{ alias: "legacy", root: oldRoot }]); // pre-HAYV-12 shape
    pruneStaleProjects(); // root present: backfills the id
    expect(readRegistryRaw()[0]?.id).toBe(ID_A);

    const newRoot = join(ws, "legacy-new");
    renameSync(oldRoot, newRoot);
    pruneStaleProjects();
    expect(registerProjectDetailed(newRoot).entry.alias).toBe("legacy");
    expect(readRegistryRaw()).toHaveLength(1);
  });

  it("keeps the explicit alias when the caller passes one", () => {
    const oldRoot = makeRepo("lydgr", ID_A);
    registerProject(oldRoot);
    const newRoot = join(ws, "elsewhere");
    renameSync(oldRoot, newRoot);
    const outcome = registerProjectDetailed(newRoot, "custom");
    expect(outcome.relocatedFrom).toBe(oldRoot);
    expect(readRegistryRaw()).toEqual([{ alias: "custom", root: newRoot, id: ID_A }]);
  });

  it("with NO recorded id: registers `-2` and reports the ambiguity", () => {
    const oldRoot = makeRepo("lydgr");
    registerProject(oldRoot);
    const parent = join(ws, "new-parent");
    mkdirSync(parent);
    const newRoot = join(parent, "lydgr");
    renameSync(oldRoot, newRoot);
    pruneStaleProjects();

    const outcome = registerProjectDetailed(newRoot);
    expect(outcome.entry.alias).toBe("lydgr-2");
    expect(outcome.relocatedFrom).toBeUndefined();
    expect(outcome.ambiguousWith?.alias).toBe("lydgr");
    expect(readRegistryRaw()).toHaveLength(2);
  });

  it("with a MISMATCHED id: registers `-2` and reports the ambiguity", () => {
    const oldRoot = makeRepo("lydgr", ID_A);
    registerProject(oldRoot);
    const parent = join(ws, "p2");
    mkdirSync(parent);
    const newRoot = join(parent, "lydgr");
    renameSync(oldRoot, newRoot);
    // Re-init at the new place: a different identity.
    writeFileSync(join(newRoot, ".hayven", "config.json"), JSON.stringify({ writer_id: ID_B }));
    pruneStaleProjects();

    const outcome = registerProjectDetailed(newRoot);
    expect(outcome.entry.alias).toBe("lydgr-2");
    expect(outcome.ambiguousWith?.alias).toBe("lydgr");
    expect(outcome.ambiguousWith?.id).toBe(ID_A);
  });

  it("never steals the alias of a PRESENT repo with the same id (a copy)", () => {
    const original = makeRepo("orig", ID_A);
    registerProject(original);
    const copy = makeRepo("copy", ID_A); // cp -r copies config.json too
    const outcome = registerProjectDetailed(copy);
    expect(outcome.entry.alias).toBe("copy");
    expect(outcome.relocatedFrom).toBeUndefined();
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["copy", "orig"]);
  });

  it("does not guess between TWO missing rows with the same id", () => {
    writeRegistry([
      { alias: "one", root: join(ws, "gone-1"), id: ID_A },
      { alias: "two", root: join(ws, "gone-2"), id: ID_A },
    ]);
    const outcome = registerProjectDetailed(makeRepo("three", ID_A));
    expect(outcome.entry.alias).toBe("three");
    expect(outcome.relocatedFrom).toBeUndefined();
    expect(outcome.ambiguousWith).toBeDefined();
    expect(readRegistryRaw()).toHaveLength(3);
  });

  it("backfills id on an existing row when registered again", () => {
    const root = makeRepo("later");
    registerProject(root);
    expect(readRegistryRaw()[0]?.id).toBeUndefined();
    writeFileSync(join(root, ".hayven", "config.json"), JSON.stringify({ writer_id: ID_B }));
    expect(registerProject(root)).toEqual({ alias: "later", root, id: ID_B });
    expect(readRegistryRaw()[0]?.id).toBe(ID_B);
  });
});

describe("renameProject", () => {
  it("renames, keeping root, id and missing_since, and backs up first", () => {
    const stamp = "2026-10-01T00:00:00.000Z";
    writeRegistry([{ alias: "old", root: join(ws, "gone"), id: ID_A, missing_since: stamp }]);
    const change = renameProject("old", "new");
    expect(change.entry).toEqual({ alias: "new", root: join(ws, "gone"), id: ID_A, missing_since: stamp });
    expect(readRegistryRaw()).toEqual([change.entry]);
    expect(change.backup).not.toBeNull();
    expect(existsSync(change.backup!)).toBe(true);
    expect(JSON.parse(readFileSync(change.backup!, "utf8")).projects[0].alias).toBe("old");
  });

  it("refuses a collision", () => {
    registerProject(makeRepo("a"));
    registerProject(makeRepo("b"));
    expect(() => renameProject("a", "b")).toThrow(/already used/);
    expect(readRegistryRaw().map((e) => e.alias)).toEqual(["a", "b"]);
    expect(backups()).toEqual([]);
  });

  it("refuses an alias that would need sanitizing, and says what it would become", () => {
    registerProject(makeRepo("a"));
    expect(() => renameProject("a", "My Repo")).toThrow(/would become "my-repo"/);
    expect(() => renameProject("a", "")).toThrow(/not a valid alias/);
    expect(readRegistryRaw()[0]?.alias).toBe("a");
  });

  it("refuses an unknown alias, listing the known ones", () => {
    registerProject(makeRepo("a"));
    expect(() => renameProject("zzz", "b")).toThrow(/Registered aliases: a/);
  });

  it("dryRun validates without writing", () => {
    registerProject(makeRepo("a"));
    const before = readFileSync(registryFile(), "utf8");
    expect(renameProject("a", "b", { dryRun: true }).entry.alias).toBe("b");
    expect(readFileSync(registryFile(), "utf8")).toBe(before);
    expect(backups()).toEqual([]);
  });
});

describe("relocateProject", () => {
  it("points the alias at the new root and clears missing_since", () => {
    writeRegistry([{ alias: "app", root: join(ws, "gone"), missing_since: "2026-10-01T00:00:00.000Z" }]);
    const target = makeRepo("app-new", ID_A);
    const change = relocateProject("app", target);
    expect(change.entry).toEqual({ alias: "app", root: target, id: ID_A });
    expect(change.replaced).toBeUndefined();
    expect(readRegistryRaw()).toEqual([change.entry]);
    expect(change.backup).not.toBeNull();
  });

  it("folds the `-2` row for the same root back in (the lydgr / lydgr-2 case)", () => {
    const oldRoot = makeRepo("lydgr"); // no id: auto-relocation cannot help
    registerProject(oldRoot);
    const parent = join(ws, "moved");
    mkdirSync(parent);
    const newRoot = join(parent, "lydgr");
    renameSync(oldRoot, newRoot);
    expect(registerProject(newRoot).alias).toBe("lydgr-2");

    const change = relocateProject("lydgr", newRoot);
    expect(change.replaced?.alias).toBe("lydgr-2");
    expect(readRegistryRaw()).toEqual([{ alias: "lydgr", root: newRoot }]);
  });

  it("refuses a target with a different identity unless --force", () => {
    writeRegistry([{ alias: "app", root: join(ws, "gone"), id: ID_A }]);
    const other = makeRepo("other", ID_B);
    expect(() => relocateProject("app", other)).toThrow(/different project/);
    expect(readRegistryRaw()[0]?.root).toBe(join(ws, "gone"));
    const forced = relocateProject("app", other, { force: true });
    expect(forced.entry).toEqual({ alias: "app", root: other, id: ID_B });
  });

  it("requires an existing directory with .hayven/", () => {
    writeRegistry([{ alias: "app", root: join(ws, "gone") }]);
    expect(() => relocateProject("app", join(ws, "nowhere"))).toThrow(/not a directory/);
    mkdirSync(join(ws, "plain"));
    expect(() => relocateProject("app", join(ws, "plain"))).toThrow(/no \.hayven/);
    expect(() => relocateProject("zzz", makeRepo("x"))).toThrow(/no registered project/);
  });
});

describe("pruneMissingProjects", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;

  function seed(): string {
    const present = makeRepo("present");
    writeRegistry([
      { alias: "present", root: present },
      { alias: "old-gone", root: join(ws, "a"), missing_since: new Date(now - 10 * day).toISOString() },
      { alias: "new-gone", root: join(ws, "b"), missing_since: new Date(now - 1 * day).toISOString() },
      { alias: "unstamped", root: join(ws, "c") },
      { alias: "relative", root: "code/thing" },
    ]);
    return present;
  }

  it("with no minimum removes everything missing right now, and never a relative row", () => {
    seed();
    const out = pruneMissingProjects({ nowMs: now });
    expect(out.removed.map((e) => e.alias).sort()).toEqual(["new-gone", "old-gone", "unstamped"]);
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["present", "relative"]);
    expect(out.backup).not.toBeNull();
  });

  it("with a minimum keeps recent and unstamped rows", () => {
    seed();
    const out = pruneMissingProjects({ minMissingMs: 7 * day, nowMs: now });
    expect(out.removed.map((e) => e.alias)).toEqual(["old-gone"]);
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["new-gone", "present", "relative", "unstamped"]);
  });

  it("dryRun reports without writing", () => {
    seed();
    const before = readFileSync(registryFile(), "utf8");
    expect(pruneMissingProjects({ dryRun: true, nowMs: now }).removed).toHaveLength(3);
    expect(readFileSync(registryFile(), "utf8")).toBe(before);
    expect(backups()).toEqual([]);
  });

  it("parses durations, refusing a unitless non-zero number", () => {
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(day);
    expect(parseDuration("7d")).toBe(7 * day);
    expect(parseDuration("7")).toBeInstanceOf(Error);
    expect(parseDuration("soon")).toBeInstanceOf(Error);
  });
});

describe("backups", () => {
  it("returns null when there is no registry file yet", () => {
    expect(backupRegistry()).toBeNull();
  });

  it("names them projects.json.hayven-backup-YYYYMMDD-HHMMSS, suffixes same-second ones, keeps the newest 10", () => {
    registerProject(makeRepo("a"));
    const at = new Date(2026, 9, 9, 8, 7, 6);
    const made: string[] = [];
    for (let i = 0; i < 13; i++) made.push(backupRegistry(at)!);
    expect(made[0]!.endsWith("projects.json.hayven-backup-20261009-080706")).toBe(true);
    expect(made[1]!.endsWith("projects.json.hayven-backup-20261009-080706-2")).toBe(true);
    const left = backups();
    expect(left).toHaveLength(10);
    // The three OLDEST went; the newest survived.
    expect(left).toContain("projects.json.hayven-backup-20261009-080706-13");
    expect(left).not.toContain("projects.json.hayven-backup-20261009-080706");
    expect(left).not.toContain("projects.json.hayven-backup-20261009-080706-3");
  });

  it("never counts or deletes hand-made projects.json.bak-* copies", () => {
    registerProject(makeRepo("a"));
    const dir = join(home, ".hayven");
    writeFileSync(join(dir, "projects.json.bak-20260805-020734"), "{}\n");
    const at = new Date(2026, 9, 9, 8, 7, 6);
    for (let i = 0; i < 12; i++) backupRegistry(at);
    expect(readdirSync(dir)).toContain("projects.json.bak-20260805-020734");
    expect(backups()).toHaveLength(10);
  });

  it("every user-commanded mutation backs up; the daemon-start prune does not", () => {
    const a = makeRepo("a");
    registerProject(a);
    rmSync(a, { recursive: true });
    pruneStaleProjects();
    expect(backups()).toEqual([]);
    renameProject("a", "b");
    expect(backups()).toHaveLength(1);
    const removed = unregisterProjectDetailed("b", ws, { backup: true });
    expect(removed.removed).toBe(true);
    expect(removed.removedEntries.map((e) => e.alias)).toEqual(["b"]);
    expect(removed.backup).not.toBeNull();
    expect(backups()).toHaveLength(2);
  });
});

describe("doctor registry check", () => {
  it("is a non-gating WARNING that names the fix and leaves the envelope ok", () => {
    const row = registryCheck([
      { alias: "here", root: makeRepo("here") },
      { alias: "ghost", root: join(ws, "ghost"), missing_since: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(row.name).toBe("registry");
    expect(row.ok).toBe(false);
    expect(row.gating).toBe(false);
    expect(row.detail).toContain("WARNING");
    expect(row.detail).toContain("ghost");
    expect(row.detail).toContain("hayven projects relocate ghost <new-root>");
    expect(row.detail).toContain("hayven projects remove ghost");
    expect(row.detail).toContain("hayven projects prune");
    expect(computeOk([{ name: "bun_version", ok: true, detail: "", gating: true }, row])).toBe(true);
  });

  it("says none missing on a healthy registry", () => {
    expect(registryCheck([{ alias: "here", root: makeRepo("here") }]).detail).toContain("none missing");
  });
});

// ---------------------------------------------------------------------------
// CLI subprocess
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("could not obtain a free port from the OS");
  return port;
}

async function assertPortUnanswered(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new Error(`test precondition failed: something is already answering on port ${port}`);
}

function childEnv(port: number): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    HAYVEN_HOME: home,
    HAYVEN_PORT: String(port),
    HAYVEN_HOST: "127.0.0.1",
    HAYVEN_LOG_LEVEL: "warn",
    HAYVEN_NATIVE_BIN: process.env["HAYVEN_NATIVE_BIN"] ?? NATIVE_BIN,
  };
}

function runCli(args: string[], port: number, cwd: string = ws): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({ cmd: ["bun", CLI, ...args], cwd, env: childEnv(port), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("hayven projects (subprocess)", () => {
  it("--json prints a stable array; served is null with no daemon", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const root = makeRepo("listed", ID_A);
    writeFileSync(join(root, ".hayven", "index.sqlite"), "x".repeat(2048));
    registerProject(root);
    writeRegistry([...readRegistryRaw(), { alias: "ghost", root: join(ws, "ghost") }]);

    const r = runCli(["projects", "--json"], port);
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    expect(rows.map((x) => x["alias"])).toEqual(["listed", "ghost"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["alias", "id", "index_bytes", "index_modified", "missing_since", "root", "served", "served_alias", "status"],
      );
      expect(row["served"]).toBeNull();
    }
    expect(rows[0]).toMatchObject({ status: "ok", id: ID_A, index_bytes: 2048 });
    expect(rows[1]).toMatchObject({ status: "missing", index_bytes: null, id: null });

    const human = runCli(["projects"], port);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("2.0 KB");
    expect(human.stdout).toContain("not running");
  });

  it("relocate via the CLI folds the -2 row back in and prints what happened", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const oldRoot = makeRepo("lydgr");
    registerProject(oldRoot);
    mkdirSync(join(ws, "moved"));
    const newRoot = join(ws, "moved", "lydgr");
    renameSync(oldRoot, newRoot);
    registerProject(newRoot);

    const r = runCli(["projects", "relocate", "lydgr", newRoot], port);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`relocated "lydgr"`);
    expect(r.stdout).toContain(`removed "lydgr-2"`);
    expect(r.stdout).toContain("backup: ");
    expect(r.stdout).toContain("not running");
    expect(readRegistryRaw()).toEqual([{ alias: "lydgr", root: newRoot }]);
  });

  it("refuses bad input with exit 2 and changes nothing", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    registerProject(makeRepo("a"));
    const before = readFileSync(registryFile(), "utf8");
    expect(runCli(["projects", "prune", "--missing-for", "7"], port).code).toBe(2);
    expect(runCli(["projects", "rename", "a"], port).code).toBe(2);
    expect(runCli(["projects", "relocate", "--force", "a", ws], port).code).toBe(2);
    expect(runCli(["projects", "remove", "zzz"], port).code).toBe(1);
    expect(readFileSync(registryFile(), "utf8")).toBe(before);
  });

  it("`daemon register` from a moved repo prints the relocation", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const oldRoot = makeRepo("mover", ID_A);
    registerProject(oldRoot);
    const newRoot = join(ws, "mover-new");
    renameSync(oldRoot, newRoot);
    const r = runCli(["daemon", "register", newRoot], port, newRoot);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`registered mover`);
    expect(r.stdout).toContain(`moved from ${oldRoot}`);
    expect(r.stdout).toContain("no running daemon");
    expect(readRegistryRaw()).toEqual([{ alias: "mover", root: newRoot, id: ID_A }]);
  });

  it("`daemon register` of an unprovable move prints the exact relocate command", async () => {
    const port = await freePort();
    await assertPortUnanswered(port);
    const oldRoot = makeRepo("mover"); // no identity on record
    registerProject(oldRoot);
    mkdirSync(join(ws, "p"));
    const newRoot = join(ws, "p", "mover");
    renameSync(oldRoot, newRoot);
    const r = runCli(["daemon", "register", newRoot], port, newRoot);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("registered mover-2");
    expect(r.stdout).toContain(`hayven projects relocate mover ${newRoot}`);
  });
});

// ---------------------------------------------------------------------------
// A REAL daemon: rename of a served, non-primary project re-serves it live.
// ---------------------------------------------------------------------------

describe("live daemon", () => {
  let child: ReturnType<typeof Bun.spawn> | null = null;

  afterEach(async () => {
    if (child) {
      child.kill("SIGTERM");
      const done = await Promise.race([child.exited.then(() => true), Bun.sleep(8_000).then(() => false)]);
      if (!done) {
        child.kill("SIGKILL");
        await child.exited;
      }
      child = null;
    }
  });

  async function servedAliases(base: string): Promise<{ primary: string | null; aliases: string[] }> {
    const res = await fetch(`${base}/api/projects`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { primary: string | null; projects: Array<{ alias: string }> };
    return { primary: body.primary, aliases: body.projects.map((p) => p.alias).sort() };
  }

  /** Start a real daemon in `primary-repo` that also serves `secondary-repo`. */
  async function startTwoProjectDaemon(): Promise<{ port: number; base: string; primary: string; secondary: string }> {
    const port = await freePort();
    await assertPortUnanswered(port);
    const cfg = { daemon_host: "127.0.0.1", daemon_port: port };
    const primary = makeRepo("primary-repo", undefined, cfg);
    const secondary = makeRepo("secondary-repo", undefined, cfg);
    writeFileSync(join(primary, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(secondary, "b.ts"), "export const b = 2;\n");

    const reg = runCli(["daemon", "register", secondary], port, secondary);
    expect(reg.code).toBe(0);
    expect(reg.stdout).toContain("no running daemon"); // the sandbox held

    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: primary,
      env: childEnv(port),
      stdout: "pipe",
      stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    let served = { primary: null as string | null, aliases: [] as string[] };
    for (let i = 0; i < 200; i++) {
      try {
        served = await servedAliases(base);
        if (served.aliases.length >= 2) break;
      } catch {
        /* not up yet */
      }
      await Bun.sleep(100);
    }
    expect(served).toEqual({ primary: "primary-repo", aliases: ["primary-repo", "secondary-repo"] });
    return { port, base, primary, secondary };
  }

  it("moving a SERVED repo, then registering it, keeps its alias and re-serves it live", async () => {
    const { port, base, secondary } = await startTwoProjectDaemon();
    // The daemon wrote the identity on start; the registry row learned it.
    expect(readProjectIdentity(secondary)).toBeDefined();
    const moved = join(ws, "secondary-moved");
    renameSync(secondary, moved);

    const r = runCli(["daemon", "register", moved], port, moved);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`registered secondary-repo`);
    expect(r.stdout).toContain(`moved from ${secondary}`);
    // The daemon retired the runtime for the vanished root instead of
    // refusing the alias as "already served".
    expect(r.stdout).toContain("added live");
    const res = await fetch(`${base}/api/projects`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { projects: Array<{ alias: string; root: string }> };
    expect(body.projects.find((p) => p.alias === "secondary-repo")?.root).toBe(moved);
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["primary-repo", "secondary-repo"]);
  }, 60_000);

  it("rename of a served non-primary project re-serves it under the new alias; the primary waits for restart", async () => {
    const { port, base } = await startTwoProjectDaemon();

    const r = runCli(["projects", "rename", "secondary-repo", "sec"], port);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`daemon: stopped serving "secondary-repo"`);
    expect(r.stdout).toContain(`now serving it as "sec"`);
    expect(await servedAliases(base)).toEqual({ primary: "primary-repo", aliases: ["primary-repo", "sec"] });
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["primary-repo", "sec"]);

    // The listing agrees with the daemon.
    const list = JSON.parse(runCli(["projects", "--json"], port).stdout) as Array<Record<string, unknown>>;
    expect(list.find((x) => x["alias"] === "sec")).toMatchObject({ served: true, served_alias: "sec" });

    // The PRIMARY is never removed live: registry changes, daemon keeps it.
    const p = runCli(["projects", "rename", "primary-repo", "prim"], port);
    expect(p.code).toBe(0);
    expect(p.stdout).toContain("PRIMARY");
    expect(p.stdout).toContain("hayven daemon restart");
    expect((await servedAliases(base)).aliases).toEqual(["primary-repo", "sec"]);
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["prim", "sec"]);
  }, 60_000);
});
