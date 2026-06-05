/**
 * `POST /api/ingest` — trigger an ingest run.
 *
 * Idempotent: if one is already running, returns 409 with the in-flight
 * metadata. Actual ingest execution is delegated to an injected
 * {@link IngestController} so tests and the CLI can share logic without the
 * route layer pulling in the native binary.
 */
import { Elysia } from "elysia";

import type { IngestResult } from "../../graph/ingest.ts";
import type { ServerDependencies } from "../server.ts";

export interface IngestController {
  /** Returns the in-flight ingest, if any. */
  current(): { startedAt: number } | null;
  /** Start an ingest. Throws if one is already running. */
  start(options: { full?: boolean }): Promise<IngestResult>;
}

export function ingestRoutes(deps: ServerDependencies) {
  return new Elysia().post("/api/ingest", async ({ body, set }) => {
    const current = deps.ingest.current();
    if (current) {
      set.status = 409;
      return { error: "ingest already running", started_at: current.startedAt };
    }
    const full = isFullRequest(body);
    try {
      const result = await deps.ingest.start({ full });
      return { ok: true, result };
    } catch (err) {
      set.status = 500;
      return { error: (err as Error).message };
    }
  });
}

function isFullRequest(body: unknown): boolean {
  if (typeof body === "object" && body !== null && "full" in body) {
    return Boolean((body as Record<string, unknown>)["full"]);
  }
  return false;
}
