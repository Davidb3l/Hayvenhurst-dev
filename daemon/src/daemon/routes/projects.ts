/**
 * Runtime project management — add/remove the repos a LIVE daemon serves with no
 * restart, plus a Server-Sent-Events stream so the viewer's project switcher
 * updates the instant the set changes.
 *
 * The heavy lifting (opening a project's index, wiring its runtime, persisting to
 * `~/.hayven/projects.json`) lives in `daemon.ts`, injected as `deps.addProject`/
 * `deps.removeProject`/`deps.subscribeProjects` on the multi-project facade. These
 * are ABSENT on a single-project daemon and in tests, so every handler degrades to
 * a clean 404 rather than throwing.
 *
 *   GET    /api/projects          — { primary, projects: [{alias, root, branch}] }
 *   POST   /api/projects          — body {path, alias?} → open + serve it live
 *   DELETE /api/projects/:alias    — stop serving it live
 *   GET    /api/projects/stream    — SSE: emits the list now + on every change
 */
import { Elysia } from "elysia";

import { canonicalRoot, hayvenHomeDir } from "../../util/paths.ts";
import type { ServerDependencies } from "../server.ts";

/** Pull a string field off an untyped JSON body without throwing. */
function bodyString(body: unknown, key: string): string | undefined {
  if (typeof body === "object" && body !== null && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * DEFENSE IN DEPTH for the global-home sandbox escape.
 *
 * A client sandboxed with `$HAYVEN_HOME` can still reach a daemon running under
 * a different home, and this route would then persist the registration into the
 * DAEMON's `projects.json` rather than the caller's. The primary guard is on the
 * client (it probes `/api/health` for our `global_home` and declines to post on
 * a mismatch), but an OLDER CLI does not probe, so refuse here too.
 *
 * OPTIONAL BY CONTRACT: an old CLI omits the field entirely, and absence means
 * "no opinion", never "mismatch". Reading absence as a mismatch would break
 * every already-installed CLI against a freshly built daemon.
 *
 * Compared CANONICALLY for the same reason the client does it: `/tmp` is a
 * symlink to `/private/tmp` on macOS, so two spellings of one directory must
 * not read as two directories.
 *
 * Returns an error message when the write must be refused, `null` to proceed.
 */
function foreignHomeRefusal(clientHome: string | undefined): string | null {
  if (clientHome === undefined) return null; // old client, no opinion
  let ours: string;
  try {
    ours = hayvenHomeDir();
  } catch {
    return null; // we cannot state our own home, so we cannot claim a mismatch
  }
  const oursCanon = canonicalRoot(ours);
  const theirsCanon = canonicalRoot(clientHome);
  if (oursCanon === theirsCanon) return null;
  return (
    "refusing to register across a global-home boundary: this daemon keeps its project registry " +
    `under ${oursCanon}, but the caller declared ${theirsCanon}. The registration would land in a ` +
    "registry the caller never reads. Talk to the daemon running under your own HAYVEN_HOME."
  );
}

export function projectsRoutes(deps: ServerDependencies) {
  return new Elysia()
    .get("/api/projects", () => ({
      primary: deps.primaryAlias ?? null,
      projects: deps.listProjects ? deps.listProjects() : [],
    }))
    .post("/api/projects", async ({ body, set }) => {
      if (!deps.addProject) {
        set.status = 404;
        return { error: "not a multi-project daemon" };
      }
      const path = bodyString(body, "path");
      if (!path) {
        set.status = 400;
        return { error: "body.path is required (an absolute repo root that has been `hayven init`'d)" };
      }
      // Checked BEFORE `addProject`, which is the call that persists to the
      // registry. A refusal must cost the caller a 409 and nothing else.
      const refusal = foreignHomeRefusal(bodyString(body, "client_home"));
      if (refusal !== null) {
        set.status = 409;
        return { error: refusal };
      }
      try {
        const result = await deps.addProject(path, bodyString(body, "alias"));
        return { ok: true, ...result };
      } catch (err) {
        set.status = 400;
        return { error: (err as Error).message };
      }
    })
    .delete("/api/projects/:alias", async ({ params, set }) => {
      if (!deps.removeProject) {
        set.status = 404;
        return { error: "not a multi-project daemon" };
      }
      try {
        const removed = await deps.removeProject(params.alias);
        if (!removed) {
          set.status = 404;
          return { error: `not served: ${params.alias}` };
        }
        return { ok: true, removed: params.alias };
      } catch (err) {
        // Refusing to remove the primary is a client error, not a server one.
        set.status = 400;
        return { error: (err as Error).message };
      }
    })
    .get("/api/projects/stream", ({ set }) => {
      const listProjects = deps.listProjects;
      const subscribe = deps.subscribeProjects;
      if (!listProjects || !subscribe) {
        set.status = 404;
        return { error: "not a multi-project daemon" };
      }
      const primary = deps.primaryAlias ?? null;
      const encoder = new TextEncoder();
      let unsubscribe: () => void = () => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let closed = false;

      // Single idempotent teardown: unsubscribe + stop the heartbeat. Called from
      // `cancel()` (client disconnected) AND proactively when an enqueue throws
      // (client vanished before `cancel()` fired), so the listener never leaks.
      const teardown = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (chunk: string): void => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              teardown(); // controller already closed — release the subscription now
            }
          };
          const send = (): void => push(`data: ${JSON.stringify({ primary, projects: listProjects() })}\n\n`);
          try {
            send(); // initial snapshot on connect
            unsubscribe = subscribe(send); // then push on every add/remove
            // Comment-line heartbeat keeps intermediaries from idling the stream out.
            heartbeat = setInterval(() => push(": ping\n\n"), 25_000);
            if (typeof heartbeat.unref === "function") heartbeat.unref();
          } catch (err) {
            teardown(); // a mid-setup throw must not leak a partial subscription
            controller.error(err);
          }
        },
        cancel() {
          teardown();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        },
      });
    });
}
