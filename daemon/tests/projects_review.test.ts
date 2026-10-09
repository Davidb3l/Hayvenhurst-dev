/**
 * HAYV-12 review findings: one regression test per finding, each written to
 * FAIL against the first version of `hayven projects` / auto-relocation.
 *
 *   1. A temporarily missing root (unmounted volume) let a COPY with the same
 *      writer_id take the alias. Auto-relocation now needs the old root's
 *      parent to exist, refuses volume roots, and backs up first.
 *   2. Moving the daemon's PRIMARY repo made every hot-add from the new place
 *      fail (relocation re-pointed an alias the primary still holds).
 *   3. The foreign-home guard is blind to daemons that do not report a home;
 *      a sandboxed HAYVEN_HOME now refuses to mutate them. `relocate` only
 *      re-serves what was served, unless --serve.
 *   4. An old daemon's registry write drops every `id`; mutating commands
 *      restore them afterwards.
 *   5. `relocate` needs --force to move a registration off a repo that still
 *      exists, or to fold a row whose identity differs from the target's.
 *   6. prune: a project stopped for removal but kept by the locked pass (its
 *      drive came back) is served again.
 *   7. doctor's registry row never stats roots (a hung NFS mount would stall
 *      the suite handshake); it reports what the last daemon start stamped.
 *   8. The `projects` help line no longer claims --json for every subcommand.
 *
 * SANDBOX: `$HAYVEN_HOME` is a fresh temp dir per test, asserted to hold the
 * registry. Every CLI subprocess talks either to a free port asserted
 * unanswered, or to an in-process STUB daemon on its own port; nothing here
 * can reach 127.0.0.1:7777.
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

import { COMMANDS } from "../src/cli.ts";
import { relocationNotes } from "../src/cli/daemon.ts";
import { registryCheck } from "../src/cli/doctor.ts";
import { homeIsSandboxed } from "../src/cli/projects_live.ts";
import {
  isOnMountLocation,
  readRegistryRaw,
  registerProject,
  registerProjectDetailed,
  registryFile,
  relocateProject,
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
  home = realpathSync(mkdtempSync(join(tmpdir(), "hayv12r-home-")));
  ws = realpathSync(mkdtempSync(join(tmpdir(), "hayv12r-ws-")));
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

function makeRepo(rel: string, writerId?: string, extra: Record<string, unknown> = {}): string {
  const root = join(ws, rel);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  writeFileSync(
    join(root, ".hayven", "config.json"),
    JSON.stringify({ ...extra, ...(writerId !== undefined ? { writer_id: writerId } : {}) }),
  );
  return root;
}

function backups(): string[] {
  return readdirSync(join(home, ".hayven")).filter((n) => n.startsWith("projects.json.hayven-backup-"));
}

// ---------------------------------------------------------------------------
// 1. Unmounted volumes
// ---------------------------------------------------------------------------

describe("1: auto-relocation needs proof the old filesystem is mounted", () => {
  it("does not hand the alias to a copy when the old root's PARENT is missing too", () => {
    const original = makeRepo("vol/code/lydgr", ID_A);
    registerProject(original);
    rmSync(join(ws, "vol"), { recursive: true }); // the drive is unmounted
    const copy = makeRepo("laptop/lydgr", ID_A); // a copy made earlier

    const outcome = registerProjectDetailed(copy);
    expect(outcome.relocatedFrom).toBeUndefined();
    expect(outcome.entry.alias).toBe("lydgr-2");
    expect(outcome.ambiguousWith?.alias).toBe("lydgr");
    expect(outcome.ambiguousReason).toBe("parent-missing");
    expect(readRegistryRaw().find((e) => e.alias === "lydgr")?.root).toBe(original);
  });

  it("treats anything on a conventional mount location as unprovable, at any depth", () => {
    // A volume root: unmounting leaves /Volumes (or /mnt) standing.
    expect(isOnMountLocation("/Volumes/MyRepo")).toBe(true);
    expect(isOnMountLocation("/Volumes/MyRepo/")).toBe(true);
    expect(isOnMountLocation("/mnt/nas")).toBe(true);
    expect(isOnMountLocation("/media/dave/usb")).toBe(true);
    expect(isOnMountLocation("/run/media/dave/usb")).toBe(true);
    // INSIDE a Linux fstab mount: the empty mount-point dir /mnt/data survives
    // unmounting, so the parent check alone would call this repo "moved".
    expect(isOnMountLocation("/mnt/data/proj")).toBe(true);
    expect(isOnMountLocation("/media/dave/disk/code/proj")).toBe(true);
    expect(isOnMountLocation("/Volumes/Drive/code/repo")).toBe(true);
    // Not mount locations, and no prefix false positives.
    expect(isOnMountLocation("/Users/dave/code/repo")).toBe(false);
    expect(isOnMountLocation("/mntx/repo")).toBe(false);
    expect(isOnMountLocation("/home/dave/media/repo")).toBe(false);
  });

  it("backs up projects.json before an automatic re-point", () => {
    const oldRoot = makeRepo("lydgr", ID_A);
    registerProject(oldRoot);
    const newRoot = join(ws, "moved");
    renameSync(oldRoot, newRoot);
    expect(backups()).toEqual([]);
    expect(registerProjectDetailed(newRoot).relocatedFrom).toBe(oldRoot);
    expect(backups()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Moving the primary
// ---------------------------------------------------------------------------

describe("2: a blocked alias (the live primary) is never re-pointed", () => {
  it("registers -N and reports alias-busy with restart + relocate instructions", () => {
    const oldRoot = makeRepo("lydgr", ID_A);
    registerProject(oldRoot);
    mkdirSync(join(ws, "new"));
    const newRoot = join(ws, "new", "lydgr");
    renameSync(oldRoot, newRoot);

    const outcome = registerProjectDetailed(newRoot, undefined, { blockedAliases: ["lydgr"] });
    expect(outcome.relocatedFrom).toBeUndefined();
    expect(outcome.entry.alias).toBe("lydgr-2");
    expect(outcome.ambiguousReason).toBe("alias-busy");
    const notes = relocationNotes(outcome).join("\n");
    expect(notes).toContain(`hayven projects relocate lydgr ${newRoot}`);
    expect(notes).toContain("hayven daemon restart");
  });
});

// ---------------------------------------------------------------------------
// 5. relocate safety
// ---------------------------------------------------------------------------

describe("5: relocate refuses risky re-points without --force", () => {
  it("when the entry's OLD root still exists", () => {
    const live = makeRepo("live", ID_A);
    registerProject(live);
    const target = makeRepo("target", ID_A);
    expect(() => relocateProject("live", target)).toThrow(/still exists.*--force/s);
    expect(readRegistryRaw()[0]?.root).toBe(live);
    expect(relocateProject("live", target, { force: true }).entry.root).toBe(target);
  });

  it("when the folded row's identity differs from the target's", () => {
    const target = makeRepo("target", ID_A); // re-inited: config now says A
    writeRegistry([
      { alias: "app", root: join(ws, "gone") },
      { alias: "app-2", root: target, id: ID_B },
    ]);
    expect(() => relocateProject("app", target)).toThrow(/app-2.*--force/s);
    expect(readRegistryRaw()).toHaveLength(2);
    expect(relocateProject("app", target, { force: true }).replaced?.alias).toBe("app-2");
  });
});

// ---------------------------------------------------------------------------
// 7. doctor
// ---------------------------------------------------------------------------

describe("7: doctor's registry row reports stamps, never stats", () => {
  it("does not list a root it would have had to stat", () => {
    const row = registryCheck([{ alias: "unstamped", root: join(ws, "nowhere") }]);
    expect(row.ok).toBe(true);
    expect(row.detail).not.toContain("unstamped");
  });

  it("lists a stamped row even if the folder is back, as of the last daemon start", () => {
    const row = registryCheck([
      { alias: "stamped", root: makeRepo("back"), missing_since: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(row.ok).toBe(false);
    expect(row.gating).toBe(false);
    expect(row.detail).toContain("stamped");
    expect(row.detail).toContain("as of the last daemon start");
  });
});

// ---------------------------------------------------------------------------
// 8. help text
// ---------------------------------------------------------------------------

describe("8: the projects help line", () => {
  it("only claims --json for list", () => {
    const help = COMMANDS.find((c) => c.name === "projects")?.help ?? "";
    expect(help).toMatch(/list \[--json\]/);
    expect(help).not.toMatch(/prune\] \[--json\]/);
  });
});

// ---------------------------------------------------------------------------
// 3. sandbox predicate
// ---------------------------------------------------------------------------

describe("3: homeIsSandboxed", () => {
  it("is true only for an explicit HAYVEN_HOME that is not the real home", () => {
    expect(homeIsSandboxed({}, "/Users/x")).toBe(false);
    expect(homeIsSandboxed({ HAYVEN_HOME: "  " }, "/Users/x")).toBe(false);
    expect(homeIsSandboxed({ HAYVEN_HOME: "/Users/x" }, "/Users/x")).toBe(false);
    expect(homeIsSandboxed({ HAYVEN_HOME: "/Users/x/" }, "/Users/x")).toBe(false);
    expect(homeIsSandboxed({ HAYVEN_HOME: "/tmp/sandbox" }, "/Users/x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI against an in-process STUB daemon (3, 4, 6)
// ---------------------------------------------------------------------------

interface Stub {
  readonly port: number;
  readonly calls: string[];
  readonly served: Map<string, string>;
  stop(): void;
}

/**
 * A minimal multi-project daemon: /api/health, GET/POST/DELETE /api/projects.
 * `reportHome` decides whether it reports a `global_home` (a current daemon)
 * or not (v0.0.7). Hooks let a test simulate what a real daemon or the
 * filesystem would do mid-command.
 */
function startStub(opts: {
  primary: string;
  served: Record<string, string>;
  reportHome: boolean;
  onDelete?: (alias: string) => void;
  onPost?: (body: { path: string; alias?: string }) => void;
}): Stub {
  const calls: string[] = [];
  const served = new Map(Object.entries(opts.served));
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") {
        return json({ ok: true, version: "stub", ...(opts.reportHome ? { global_home: home } : {}) });
      }
      if (url.pathname === "/api/projects" && req.method === "GET") {
        return json({
          primary: opts.primary,
          projects: [...served].map(([alias, root]) => ({ alias, root, branch: null })),
        });
      }
      if (url.pathname.startsWith("/api/projects/") && req.method === "DELETE") {
        const alias = decodeURIComponent(url.pathname.slice("/api/projects/".length));
        calls.push(`DELETE ${alias}`);
        if (alias === opts.primary) return json({ error: "cannot remove the primary" }, 400);
        if (!served.delete(alias)) return json({ error: "not served" }, 404);
        opts.onDelete?.(alias);
        return json({ ok: true, removed: alias });
      }
      if (url.pathname === "/api/projects" && req.method === "POST") {
        const body = (await req.json()) as { path: string; alias?: string };
        calls.push(`POST ${body.alias ?? ""}`);
        opts.onPost?.(body);
        const alias = body.alias ?? "x";
        served.set(alias, body.path);
        return json({ ok: true, alias, root: body.path, added: true });
      }
      return json({ error: "nope" }, 404);
    },
  });
  return { port: server.port!, calls, served, stop: () => server.stop(true) };
}

/** ASYNC spawn: the stub lives in this process, so a blocking spawn would deadlock it. */
async function runCli(args: string[], port: number): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    cwd: ws,
    env: {
      ...(process.env as Record<string, string>),
      HAYVEN_HOME: home,
      HAYVEN_PORT: String(port),
      HAYVEN_HOST: "127.0.0.1",
      HAYVEN_LOG_LEVEL: "warn",
      HAYVEN_NATIVE_BIN: process.env["HAYVEN_NATIVE_BIN"] ?? NATIVE_BIN,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("CLI against a stub daemon", () => {
  let stub: Stub | null = null;
  afterEach(() => {
    stub?.stop();
    stub = null;
  });

  it("3: a sandboxed HAYVEN_HOME never mutates a daemon that does not report its home", async () => {
    const app = makeRepo("app");
    const p = makeRepo("p");
    writeRegistry([
      { alias: "app", root: app },
      { alias: "p", root: p },
    ]);
    stub = startStub({ primary: "p", served: { p, app }, reportHome: false });
    const r = await runCli(["projects", "rename", "app", "app2"], stub.port);
    expect(r.code).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(r.stdout).toContain("left alone");
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["app2", "p"]);
  });

  it("3: relocate re-serves only what was served, unless --serve", async () => {
    const p = makeRepo("p");
    const t1 = makeRepo("t1");
    const t2 = makeRepo("t2");
    writeRegistry([
      { alias: "one", root: join(ws, "gone1") },
      { alias: "two", root: join(ws, "gone2") },
      { alias: "p", root: p },
    ]);
    stub = startStub({ primary: "p", served: { p }, reportHome: true });

    const quiet = await runCli(["projects", "relocate", "one", t1], stub.port);
    expect(quiet.code).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(quiet.stdout).toContain("--serve");

    const loud = await runCli(["projects", "relocate", "two", t2, "--serve"], stub.port);
    expect(loud.code).toBe(0);
    expect(stub.calls).toEqual(["POST two"]);
  });

  it("4: ids an old daemon dropped during the command are restored, including a MISSING row's", async () => {
    const app = makeRepo("app", ID_A);
    const p = makeRepo("p");
    // A missing row has no config to re-read its id from, and it is exactly the
    // row auto-relocation will need the id for when the repo turns up again.
    const ghost = join(ws, "moved-away", "ghost");
    mkdirSync(join(ws, "moved-away"), { recursive: true });
    writeRegistry([
      { alias: "app", root: app, id: ID_A },
      { alias: "ghost", root: ghost, id: ID_B },
      { alias: "p", root: p },
    ]);
    // A v0.0.7 daemon rewrites the registry on hot-add without any `id`.
    const stripIds = (): void => {
      const file = registryFile();
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { projects: Array<Record<string, unknown>> };
      parsed.projects = parsed.projects.map(({ id: _drop, ...rest }) => rest);
      writeFileSync(file, JSON.stringify(parsed));
    };
    stub = startStub({ primary: "p", served: { p, app }, reportHome: true, onPost: stripIds });
    const r = await runCli(["projects", "rename", "app", "app2"], stub.port);
    expect(r.code).toBe(0);
    expect(stub.calls).toEqual(["DELETE app", "POST app2"]);
    expect(readRegistryRaw().find((e) => e.alias === "app2")?.id).toBe(ID_A);
    expect(readRegistryRaw().find((e) => e.alias === "ghost")?.id).toBe(ID_B);
  });

  it("6: prune serves again what it stopped but did not remove (the drive came back)", async () => {
    const p = makeRepo("p");
    const gone = join(ws, "drive", "gone");
    writeRegistry([
      { alias: "gone", root: gone },
      { alias: "p", root: p },
    ]);
    stub = startStub({
      primary: "p",
      served: { p, gone },
      reportHome: true,
      onDelete: (alias) => {
        if (alias === "gone") mkdirSync(join(gone, ".hayven"), { recursive: true }); // remounted
      },
    });
    const r = await runCli(["projects", "prune"], stub.port);
    expect(r.code).toBe(0);
    expect(stub.calls).toEqual(["DELETE gone", "POST gone"]);
    expect(r.stdout).toContain("came back");
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["gone", "p"]);
    expect(existsSync(gone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. A REAL daemon whose primary repo is moved while it runs
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

describe("2: moving the PRIMARY repo while the daemon runs", () => {
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

  /** Start a real daemon in `primary-repo`, wait until it serves, then move the repo. */
  async function startAndMovePrimary(): Promise<{ port: number; base: string; oldRoot: string; newRoot: string }> {
    const port = await freePort();
    await assertPortUnanswered(port);
    const oldRoot = makeRepo("primary-repo", undefined, { daemon_host: "127.0.0.1", daemon_port: port });
    writeFileSync(join(oldRoot, "a.ts"), "export const a = 1;\n");
    child = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "start", "--foreground", "--port", String(port)],
      cwd: oldRoot,
      env: {
        ...(process.env as Record<string, string>),
        HAYVEN_HOME: home,
        HAYVEN_PORT: String(port),
        HAYVEN_HOST: "127.0.0.1",
        HAYVEN_LOG_LEVEL: "warn",
        HAYVEN_NATIVE_BIN: process.env["HAYVEN_NATIVE_BIN"] ?? NATIVE_BIN,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try {
        up = (await fetch(`${base}/api/projects`, { signal: AbortSignal.timeout(1_000) })).ok;
      } catch {
        /* not up yet */
      }
      if (!up) await Bun.sleep(100);
    }
    expect(up).toBe(true);
    // The daemon recorded the identity it minted on open.
    expect(readRegistryRaw().find((e) => e.alias === "primary-repo")?.id).toBeDefined();
    mkdirSync(join(ws, "elsewhere"));
    const newRoot = join(ws, "elsewhere", "primary-repo");
    renameSync(oldRoot, newRoot);
    return { port, base, oldRoot, newRoot };
  }

  it("the claim/sync hot-add path still serves the moved repo (as -2)", async () => {
    const { base, newRoot } = await startAndMovePrimary();
    // Exactly what `assertDaemonServesProject` sends from the moved repo.
    const res = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: newRoot, client_home: home }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { alias?: string; added?: boolean; error?: string };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ alias: "primary-repo-2", added: true });
    expect(readRegistryRaw().map((e) => e.alias).sort()).toEqual(["primary-repo", "primary-repo-2"]);
  }, 60_000);

  it("`daemon register` from the moved primary serves it and prints the restart + relocate fix", async () => {
    const { port, newRoot } = await startAndMovePrimary();
    const proc = Bun.spawn({
      cmd: ["bun", CLI, "daemon", "register", newRoot],
      cwd: newRoot,
      env: {
        ...(process.env as Record<string, string>),
        HAYVEN_HOME: home,
        HAYVEN_PORT: String(port),
        HAYVEN_HOST: "127.0.0.1",
        HAYVEN_LOG_LEVEL: "warn",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("registered primary-repo-2");
    expect(stdout).toContain("added live");
    expect(stdout).toContain(`hayven projects relocate primary-repo ${newRoot}`);
    expect(stdout).toContain("hayven daemon restart");
  }, 60_000);
});
