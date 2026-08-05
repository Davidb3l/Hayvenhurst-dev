/**
 * THE GLOBAL-HOME SANDBOX ESCAPE (client half).
 *
 * `$HAYVEN_HOME` is the ONLY way to sandbox global state, and every test that
 * touches the project registry sets it. But registration does not stay in the
 * process that sandboxed itself: `hayven init` and `hayven daemon register` both
 * call `hotAddToRunningDaemon`, which POSTs to `/api/projects` on whatever daemon
 * is listening on the configured port, and THAT daemon persists the row under ITS
 * OWN `$HAYVEN_HOME`. So a perfectly-sandboxed child process still caused a write
 * to the developer's real `~/.hayven/projects.json`.
 *
 * That is not a hypothetical. The owner's registry accumulated 86 entries, about
 * 76 of them fixture directories created by tests that sandbox CORRECTLY and even
 * assert `registryFile().startsWith(home)` before they run. The assertion held.
 * The escape was the HTTP hop, which the assertion cannot see.
 *
 * These tests drive `hotAddToRunningDaemon` against a stand-in daemon that
 * reports a home of our choosing and records every POST it receives, plus writes
 * to a registry file of its own so a leak is visible as a real on-disk row. A
 * stand-in is used rather than a second real daemon because `hayvenHomeDir()`
 * reads a PROCESS-level env var: two different homes cannot exist in one test
 * process, and the daemon's home reaches the client only as a field on
 * `/api/health` anyway, which is exactly what is being tested.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every import here PREDATES the fix, deliberately. This file is the regression
// proof, so it has to stay RUNNABLE against the unfixed code: if it pulled in a
// symbol the fix introduced it would die at module load, and "fails before the
// fix" would only mean "the import is missing", which proves nothing about
// behavior. The new helpers are tested in `leak_registry_home_compare.test.ts`.
import { assertDaemonServesProject, hotAddToRunningDaemon } from "../src/cli/_shared.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { registryFile } from "../src/daemon/registry.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";

/* ------------------------------------------------------------------ *
 * The stand-in daemon
 * ------------------------------------------------------------------ */

/**
 * What the stand-in reports as its global home:
 *   a string  → that value verbatim (a match, a mismatch, or a symlinked spelling)
 *   "omit"    → no `global_home` key at all, i.e. a daemon built before this field
 */
let reportedHome: string | "omit" = "omit";
/** Every `POST /api/projects` body the stand-in received. A leak is length > 0. */
let posts: Array<Record<string, unknown>> = [];
/** The home the stand-in persists into, standing in for the developer's real one. */
let daemonHome: string;
/** The sandbox the CLIENT process runs under. */
let callerHome: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let realHayvenHome: string | undefined;

/** The stand-in daemon's own registry file, under ITS home, not ours. */
function daemonRegistryFile(): string {
  return join(daemonHome, ".hayven", "projects.json");
}

function daemonRegistryRows(): Array<{ alias: string; root: string }> {
  const file = daemonRegistryFile();
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { projects?: Array<{ alias: string; root: string }> };
  return parsed.projects ?? [];
}

beforeAll(() => {
  daemonHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-daemon-home-")));
  mkdirSync(join(daemonHome, ".hayven"), { recursive: true });
  writeFileSync(daemonRegistryFile(), JSON.stringify({ version: 1, projects: [] }, null, 2) + "\n");

  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") {
        const body: Record<string, unknown> = {
          ok: true,
          version: "9.9.9",
          root: join(daemonHome, "somerepo"),
          projects: [],
        };
        if (reportedHome !== "omit") body["global_home"] = reportedHome;
        return Response.json(body);
      }
      if (url.pathname === "/api/projects" && req.method === "POST") {
        const parsed = (await req.json()) as Record<string, unknown>;
        posts.push(parsed);
        // Persist exactly the way the real daemon would: under the DAEMON's home,
        // which is the whole point. This row is the damage.
        const rows = daemonRegistryRows();
        rows.push({ alias: "leaked", root: String(parsed["path"]) });
        writeFileSync(daemonRegistryFile(), JSON.stringify({ version: 1, projects: rows }, null, 2) + "\n");
        return Response.json({ ok: true, alias: "leaked", root: parsed["path"], added: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(daemonHome, { recursive: true, force: true });
});

beforeEach(() => {
  posts = [];
  reportedHome = "omit";
  // Reset the stand-in's registry between tests: it is shared across the file,
  // and a stale row from the happy-path case would otherwise look like a leak.
  writeFileSync(daemonRegistryFile(), JSON.stringify({ version: 1, projects: [] }, null, 2) + "\n");
  realHayvenHome = process.env["HAYVEN_HOME"];
  callerHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-caller-home-")));
  process.env["HAYVEN_HOME"] = callerHome;
  mkdirSync(join(callerHome, ".hayven"), { recursive: true });
  // The same guard the well-behaved existing tests use. It passes both before
  // and after the fix, which is precisely why it was never enough on its own.
  if (!registryFile().startsWith(callerHome)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${callerHome}`);
  }
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(callerHome, { recursive: true, force: true });
});

/** A project-shaped root under the caller's sandbox. */
function project(name: string): string {
  const root = join(callerHome, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  return root;
}

/* ------------------------------------------------------------------ *
 * The regression
 * ------------------------------------------------------------------ */

describe("hotAddToRunningDaemon does not register across a global-home boundary", () => {
  it("REGRESSION: a sandboxed caller leaves a foreign daemon's registry untouched", async () => {
    reportedHome = daemonHome; // the daemon lives in a different home than we do
    const root = project("sandboxed-repo");

    const res = await hotAddToRunningDaemon(root, base);

    // 1. Nothing was sent. Not "sent and rejected": not sent.
    expect(posts).toEqual([]);
    // 2. The foreign registry gained no row. This is the user-visible damage.
    expect(daemonRegistryRows()).toEqual([]);
    // 3. The caller is told, in terms that name both homes.
    expect(res.kind).toBe("foreign-home");
    const skip = res as { ourHome: string; daemonHome: string; message: string };
    expect(skip.ourHome).toBe(realpathSync(callerHome));
    expect(skip.daemonHome).toBe(realpathSync(daemonHome));
    expect(skip.message).toContain(callerHome);
    expect(skip.message).toContain(daemonHome);
  });

  it("happy path: matching homes still hot-add", async () => {
    reportedHome = callerHome;
    const root = project("ours");

    const res = await hotAddToRunningDaemon(root, base, "ours");

    expect(res.kind).toBe("added");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ path: root, alias: "ours" });
  });

  it("a symlinked spelling of the SAME home is a match, not a mismatch", async () => {
    // On macOS `/tmp` is a symlink to `/private/tmp`, so the two spellings of one
    // directory must compare equal. A naive string compare would refuse every
    // hot-add on this platform, which is a worse bug than the one being fixed.
    const link = join(callerHome, "alias-link");
    symlinkSync(callerHome, link);
    reportedHome = `${link}/`; // symlinked AND trailing-slashed, both at once
    const root = project("symlinked");

    const res = await hotAddToRunningDaemon(root, base);

    expect(res.kind).toBe("added");
    expect(posts).toHaveLength(1);
  });

  it("an OLD daemon with no global_home field is 'cannot verify', and still hot-adds", async () => {
    // Absence must never read as mismatch. If it did, upgrading the CLI would
    // break registration against every daemon already running on this machine.
    //
    // This is also the RESIDUAL EXPOSURE, pinned here so it is visible rather
    // than implied: against a pre-handshake daemon the post still goes through,
    // and that daemon has no guard of its own. `cli/_shared.ts` documents the
    // measurement behind accepting that, and the stricter rule that would close
    // it. If this expectation is ever flipped to `foreign-home`, four existing
    // test files that hot-add against stub daemons must be updated with it.
    reportedHome = "omit";
    const root = project("old-daemon");

    const res = await hotAddToRunningDaemon(root, base);

    expect(res.kind).toBe("added");
    expect(posts).toHaveLength(1);
  });

  it("declares our own home in the POST body so a new daemon can refuse an old CLI", async () => {
    reportedHome = callerHome;
    await hotAddToRunningDaemon(project("declares"), base);
    expect(posts[0]).toMatchObject({ client_home: realpathSync(callerHome) });
  });
});

/* ------------------------------------------------------------------ *
 * The mutating-command path
 * ------------------------------------------------------------------ */

describe("assertDaemonServesProject inherits the skip", () => {
  it("refuses to mutate a foreign-home daemon and says the registration was SKIPPED", async () => {
    // `claim`/`release`/`node body`/`sync` all funnel through here, and step 3
    // of its resolution is a live hot-add. That is a fourth door onto the same
    // POST, so it has to inherit the same refusal rather than reinvent one.
    // The message must not read as a version problem: nothing is broken, the
    // two processes simply keep their global state in different places.
    reportedHome = daemonHome;
    const root = project("mutating");
    const ctx = { paths: hayvenPathsFor(root), config: DEFAULT_CONFIG, configSources: [] };

    const res = await assertDaemonServesProject(base, ctx);

    expect(res.ok).toBe(false);
    expect(posts).toEqual([]);
    expect(daemonRegistryRows()).toEqual([]);
    const message = (res as { message: string }).message;
    expect(message).toContain("live registration SKIPPED");
    expect(message).toContain(daemonHome);
    expect(message).not.toContain("old version");
  });
});
