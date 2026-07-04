/**
 * Runtime project management routes (`/api/projects`) + the SSE stream.
 *
 * These test the ROUTE contract against an injected manager (add/remove/list/
 * subscribe), so they don't need a real native binary or on-disk `.hayven/`. The
 * daemon wires the real manager (open the index, persist the registry) in
 * `daemon.ts`; live end-to-end behavior is exercised by the running daemon.
 */
import { describe, expect, it } from "bun:test";

import { projectsRoutes } from "../src/daemon/routes/projects.ts";
import type {
  ProjectAddResult,
  ProjectSummary,
  ServerDependencies,
} from "../src/daemon/server.ts";

/** A minimal facade exposing just the fields the projects routes read. */
function makeDeps(overrides: Partial<ServerDependencies> = {}): ServerDependencies {
  return { primaryAlias: "alpha", ...overrides } as unknown as ServerDependencies;
}

function get(deps: ServerDependencies, path: string): Promise<Response> {
  return projectsRoutes(deps).handle(new Request(`http://localhost${path}`));
}
function post(deps: ServerDependencies, path: string, body: unknown): Promise<Response> {
  return projectsRoutes(deps).handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}
function del(deps: ServerDependencies, path: string): Promise<Response> {
  return projectsRoutes(deps).handle(new Request(`http://localhost${path}`, { method: "DELETE" }));
}
/** Loosely-typed JSON body reader (test-only). */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /api/projects", () => {
  it("lists projects + primary from the facade", async () => {
    const projects: ProjectSummary[] = [
      { alias: "alpha", root: "/a", branch: null },
      { alias: "beta", root: "/b", branch: "main" },
    ];
    const res = await get(makeDeps({ listProjects: () => projects }), "/api/projects");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { primary: string; projects: ProjectSummary[] };
    expect(j.primary).toBe("alpha");
    expect(j.projects.map((p) => p.alias)).toEqual(["alpha", "beta"]);
  });

  it("returns an empty list on a single-project daemon (no listProjects)", async () => {
    const res = await get(makeDeps({ primaryAlias: undefined }), "/api/projects");
    const j = (await res.json()) as { primary: string | null; projects: unknown[] };
    expect(j.primary).toBeNull();
    expect(j.projects).toEqual([]);
  });
});

describe("POST /api/projects (hot-add)", () => {
  it("adds a repo and echoes the manager's result", async () => {
    let seen: { root: string; alias?: string } = { root: "" };
    const addProject = async (root: string, alias?: string): Promise<ProjectAddResult> => {
      seen = { root, alias };
      return { alias: alias ?? "myrepo", root, added: true };
    };
    const res = await post(makeDeps({ addProject }), "/api/projects", { path: "/abs/repo", alias: "myrepo" });
    expect(res.status).toBe(200);
    expect(seen).toEqual({ root: "/abs/repo", alias: "myrepo" });
    const j = (await res.json()) as { ok: boolean; added: boolean; alias: string };
    expect(j).toMatchObject({ ok: true, added: true, alias: "myrepo" });
  });

  it("400s when body.path is missing", async () => {
    const res = await post(makeDeps({ addProject: async () => ({ alias: "x", root: "/x", added: true }) }), "/api/projects", {});
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("path is required");
  });

  it("404s on a single-project daemon (no addProject)", async () => {
    const res = await post(makeDeps(), "/api/projects", { path: "/x" });
    expect(res.status).toBe(404);
  });

  it("surfaces a manager error as 400 (e.g. no .hayven/)", async () => {
    const addProject = async (): Promise<ProjectAddResult> => {
      throw new Error("no .hayven/ directory at /x — run `hayven init` there first");
    };
    const res = await post(makeDeps({ addProject }), "/api/projects", { path: "/x" });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("no .hayven/");
  });
});

describe("DELETE /api/projects/:alias (hot-remove)", () => {
  it("removes a served project", async () => {
    let removed = "";
    const removeProject = async (a: string): Promise<boolean> => {
      removed = a;
      return true;
    };
    const res = await del(makeDeps({ removeProject }), "/api/projects/beta");
    expect(res.status).toBe(200);
    expect(removed).toBe("beta");
    expect(await readJson(res)).toMatchObject({ ok: true, removed: "beta" });
  });

  it("404s when the alias isn't served", async () => {
    const res = await del(makeDeps({ removeProject: async () => false }), "/api/projects/ghost");
    expect(res.status).toBe(404);
  });

  it("400s when the manager refuses (e.g. the primary)", async () => {
    const removeProject = async (): Promise<boolean> => {
      throw new Error("cannot remove the primary project (alpha) — it owns the daemon's port");
    };
    const res = await del(makeDeps({ removeProject }), "/api/projects/alpha");
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toContain("primary");
  });
});

describe("GET /api/projects/stream (SSE)", () => {
  it("emits the current list on connect, then again on every change", async () => {
    let list: ProjectSummary[] = [{ alias: "alpha", root: "/a", branch: null }];
    const listeners = new Set<() => void>();
    const deps = makeDeps({
      listProjects: () => list,
      subscribeProjects: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });

    const res = await get(deps, "/api/projects/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // Initial snapshot — includes `primary` (the viewer's default selection).
    const first = dec.decode((await reader.read()).value);
    expect(first).toContain("data: ");
    const firstPayload = JSON.parse(first.replace(/^data: /, "").trim());
    expect(firstPayload.primary).toBe("alpha");
    expect(firstPayload.projects).toHaveLength(1);

    // Simulate a hot-add: mutate the list, then fire the subscriber.
    list = [...list, { alias: "beta", root: "/b", branch: null }];
    expect(listeners.size).toBe(1);
    for (const l of listeners) l();

    const second = dec.decode((await reader.read()).value);
    expect(JSON.parse(second.replace(/^data: /, "").trim()).projects).toHaveLength(2);

    // Cancelling the stream must unsubscribe (no listener leak).
    await reader.cancel();
    expect(listeners.size).toBe(0);
  });

  it("firing the subscriber after cancel does not throw (enqueue-after-close guard)", async () => {
    // Keep a live reference to the listener even across unsubscribe, so we can
    // prove that a stale post-cancel fire no-ops instead of throwing on a closed
    // controller.
    let listener: (() => void) | null = null;
    const deps = makeDeps({
      listProjects: () => [{ alias: "alpha", root: "/a", branch: null }],
      subscribeProjects: (l: () => void) => {
        listener = l;
        return () => {}; // no-op: deliberately retain the ref for this test
      },
    });
    const res = await get(deps, "/api/projects/stream");
    const reader = res.body!.getReader();
    await reader.read(); // consume the initial snapshot
    await reader.cancel(); // teardown → closed = true
    expect(() => listener?.()).not.toThrow();
  });

  it("404s on a single-project daemon (no subscribeProjects)", async () => {
    const res = await get(makeDeps({ listProjects: () => [] }), "/api/projects/stream");
    expect(res.status).toBe(404);
  });
});
