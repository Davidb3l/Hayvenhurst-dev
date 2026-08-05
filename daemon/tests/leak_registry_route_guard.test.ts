/**
 * THE GLOBAL-HOME SANDBOX ESCAPE (server half).
 *
 * The client-side probe in `cli/_shared.ts` is the primary guard, but it only
 * protects a caller that KNOWS to probe. An older CLI posts straight to
 * `/api/projects` and would still write a row into a daemon's registry across a
 * home boundary, so the route refuses it too.
 *
 * The contract in one line: the `client_home` field is OPTIONAL, absence means
 * "no opinion", and only a PRESENT-and-different value is a refusal. Getting
 * that backwards would break every already-installed CLI the moment a user
 * upgraded their daemon, which is a far worse failure than the leak.
 *
 * Companion to `leak_registry_sandbox.test.ts`, which covers the client half.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { healthRoutes } from "../src/daemon/routes/health.ts";
import { projectsRoutes } from "../src/daemon/routes/projects.ts";
import type { ProjectAddResult, ServerDependencies } from "../src/daemon/server.ts";

/** The home THIS process (standing in for the daemon) is anchored to. */
let daemonHome: string;
let realHayvenHome: string | undefined;

beforeEach(() => {
  realHayvenHome = process.env["HAYVEN_HOME"];
  daemonHome = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-route-home-")));
  process.env["HAYVEN_HOME"] = daemonHome;
  mkdirSync(join(daemonHome, ".hayven"), { recursive: true });
});

afterEach(() => {
  if (realHayvenHome === undefined) delete process.env["HAYVEN_HOME"];
  else process.env["HAYVEN_HOME"] = realHayvenHome;
  rmSync(daemonHome, { recursive: true, force: true });
});

/** Records every add the route lets through, so a refusal is provably inert. */
function makeDeps(): { deps: ServerDependencies; added: string[] } {
  const added: string[] = [];
  const addProject = async (root: string, alias?: string): Promise<ProjectAddResult> => {
    added.push(root);
    return { alias: alias ?? "repo", root, added: true };
  };
  return {
    deps: { primaryAlias: "alpha", addProject } as unknown as ServerDependencies,
    added,
  };
}

function post(deps: ServerDependencies, body: unknown): Promise<Response> {
  return projectsRoutes(deps).handle(
    new Request("http://localhost/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /api/projects refuses a foreign global home", () => {
  it("409s and does NOT call addProject when client_home differs", async () => {
    const { deps, added } = makeDeps();
    const foreign = realpathSync(mkdtempSync(join(tmpdir(), "hayven-leak-other-home-")));
    try {
      const res = await post(deps, { path: "/abs/repo", client_home: foreign });
      expect(res.status).toBe(409);
      // The refusal must land BEFORE the registry write, not after it.
      expect(added).toEqual([]);
      const err = String((await readJson(res)).error);
      expect(err).toContain(daemonHome);
      expect(err).toContain(foreign);
      expect(err).toContain("global-home boundary");
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("accepts a body with NO client_home (an older CLI keeps working exactly as before)", async () => {
    const { deps, added } = makeDeps();
    const res = await post(deps, { path: "/abs/repo", alias: "repo" });
    expect(res.status).toBe(200);
    expect(added).toEqual(["/abs/repo"]);
  });

  it("accepts a matching client_home", async () => {
    const { deps, added } = makeDeps();
    const res = await post(deps, { path: "/abs/repo", client_home: daemonHome });
    expect(res.status).toBe(200);
    expect(added).toEqual(["/abs/repo"]);
  });

  it("accepts a symlinked spelling of the same home", async () => {
    const { deps, added } = makeDeps();
    const link = join(daemonHome, "link");
    symlinkSync(daemonHome, link);
    const res = await post(deps, { path: "/abs/repo", client_home: `${link}/` });
    expect(res.status).toBe(200);
    expect(added).toEqual(["/abs/repo"]);
  });

  it("a missing path still 400s before the home guard is consulted", async () => {
    const { deps, added } = makeDeps();
    const res = await post(deps, { client_home: "/somewhere/else" });
    expect(res.status).toBe(400);
    expect(added).toEqual([]);
  });
});

describe("GET /api/health reports the daemon's global home", () => {
  it("carries global_home so a client can compare before posting", async () => {
    const deps = {
      daemonVersion: "9.9.9",
      paths: { repoRoot: "/abs/repo" },
      primaryAlias: "alpha",
    } as unknown as ServerDependencies;
    const res = await healthRoutes(deps).handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body["ok"]).toBe(true);
    expect(body["global_home"]).toBe(daemonHome);
    // Additive only: the fields existing clients read are untouched.
    expect(body["root"]).toBe("/abs/repo");
    expect(body["version"]).toBe("9.9.9");
  });

  it("stays up when the home cannot be resolved, degrading to null", async () => {
    // A relative `$HAYVEN_HOME` makes `hayvenHomeDir()` throw. `/api/health` is
    // the liveness endpoint, so it must answer anyway: a diagnostic field is
    // never allowed to 500 the probe every `daemon start` waits on.
    process.env["HAYVEN_HOME"] = "relative/not/absolute";
    const deps = {
      daemonVersion: "9.9.9",
      paths: { repoRoot: "/abs/repo" },
    } as unknown as ServerDependencies;
    const res = await healthRoutes(deps).handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body["ok"]).toBe(true);
    expect(body["global_home"]).toBeNull();
  });
});
