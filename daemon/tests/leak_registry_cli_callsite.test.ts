/**
 * THE GLOBAL-HOME SANDBOX ESCAPE, at the CLI call site.
 *
 * `leak_registry_sandbox.test.ts` proves `hotAddToRunningDaemon` declines to
 * post. This proves the command on top of it behaves the way the fix requires:
 * the LOCAL registration (into our own sandboxed home) still happens, the remote
 * hot-add is skipped, the user is told which two homes disagreed, and the exit
 * code stays 0. A skipped hot-add is a warning. It has always been best effort,
 * and turning it into a failure would break `init` for anyone who happens to
 * have an unrelated daemon on port 7777.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDaemon } from "../src/cli/daemon.ts";
import { readRegistry, registryFile } from "../src/daemon/registry.ts";

let callerHome: string;
let daemonHome: string;
let realHayvenHome: string | undefined;
let server: ReturnType<typeof Bun.serve>;
let posts: Array<Record<string, unknown>>;

function daemonRegistryFile(): string {
  return join(daemonHome, ".hayven", "projects.json");
}

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  callerHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-cli-home-")));
  daemonHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-cli-daemon-")));
  process.env["HAYVEN_HOME"] = callerHome;
  mkdirSync(join(callerHome, ".hayven"), { recursive: true });
  mkdirSync(join(daemonHome, ".hayven"), { recursive: true });
  if (!registryFile().startsWith(callerHome)) {
    throw new Error(`registry sandbox escaped: ${registryFile()} is not under ${callerHome}`);
  }
  posts = [];
  // A daemon anchored to a DIFFERENT global home, on its own ephemeral port.
  // Never port 7777: the developer has real daemons running on this machine.
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") {
        return Response.json({
          ok: true,
          version: "9.9.9",
          root: join(daemonHome, "other"),
          projects: [],
          global_home: daemonHome,
        });
      }
      if (url.pathname === "/api/projects" && req.method === "POST") {
        posts.push((await req.json()) as Record<string, unknown>);
        writeFileSync(
          daemonRegistryFile(),
          JSON.stringify({ version: 1, projects: [{ alias: "leaked", root: "?" }] }, null, 2) + "\n",
        );
        return Response.json({ ok: true, alias: "leaked", added: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(callerHome, { recursive: true, force: true });
  rmSync(daemonHome, { recursive: true, force: true });
});

/** Run `hayven daemon <sub>` and capture what it wrote. */
async function run(positionals: string[]): Promise<{ code: number; out: string; err: string }> {
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
    const code = await runDaemon({ positionals, flags: {} });
    return { code, out, err };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = realOut;
    (process.stderr as unknown as { write: unknown }).write = realErr;
  }
}

/** A repo whose config points its daemon at the foreign-home stand-in. */
function makeRepo(name: string): string {
  const root = join(callerHome, name);
  mkdirSync(join(root, ".hayven"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
  writeFileSync(
    join(root, ".hayven", "config.json"),
    JSON.stringify({ daemon_host: "127.0.0.1", daemon_port: server.port }, null, 2) + "\n",
  );
  return root;
}

describe("hayven daemon register against a foreign-home daemon", () => {
  it("registers locally, skips the hot-add, names both homes, and exits 0", async () => {
    const root = makeRepo("myrepo");

    const { code, out, err } = await run(["register", root]);

    // The LOCAL registration is correct and must still happen: our own sandboxed
    // registry is ours to write.
    expect(code).toBe(0);
    expect(out).toContain("registered");
    expect(readRegistry().map((e) => e.root)).toContain(root);
    // The REMOTE one is skipped, with no request sent at all.
    expect(posts).toEqual([]);
    expect(existsSync(daemonRegistryFile())).toBe(false);
    // Reported as a note, not an error, and it names both sides.
    expect(err).toContain("note:");
    expect(err).toContain("skipped the live hot-add");
    expect(err).toContain(callerHome);
    expect(err).toContain(daemonHome);
    expect(err).not.toContain("error:");
  });

  it("the caller's own registry is the ONLY registry that changed", async () => {
    const root = makeRepo("second");
    await run(["register", root]);
    expect(registryFile().startsWith(callerHome)).toBe(true);
    const ours = JSON.parse(readFileSync(registryFile(), "utf8")) as { projects: unknown[] };
    expect(ours.projects).toHaveLength(1);
    expect(existsSync(daemonRegistryFile())).toBe(false);
  });
});
