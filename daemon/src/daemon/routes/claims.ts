/**
 * Claims board API — backed by the OR-Set CRDT (ARCHITECTURE.md §14 + §12).
 *
 * - `GET    /api/claims`      — list active claims from `deps.crdt.orset`.
 * - `POST   /api/claims`      — register a claim (HTTP 201). Applies an
 *   `OrAddOp` via `deps.crdt.applyOr`, which appends to the on-disk op log
 *   and updates the in-memory state. Returns 409 on duplicate id.
 * - `DELETE /api/claims/:id`  — release a claim. Builds an `OrRemoveOp` via
 *   `makeRemoveOpFor` and applies it the same way.
 *
 * The SQL `claims` table is kept as a denormalized read cache so existing
 * COUNT(*) helpers and the legacy GET-from-SQL path keep working. The CRDT
 * op log is the source of truth on restart.
 */
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import type { ServerDependencies } from "../server.ts";
import {
  makeRemoveOpFor,
  type ClaimPayload,
  type OrAddOp,
} from "../../crdt/orset.ts";
import {
  edgeAdjacency,
  findAdjacent,
  findOverlap,
  scopeNeighbors,
  suggestScope,
  type ClaimLike,
  type NeighborLookup,
} from "../../conflict/adjacency.ts";
import { selectOracle, type ConflictVerdict } from "../../conflict/oracle.ts";
import { tryLocateNativeBinary } from "../../native/locate.ts";

export interface ClaimDto {
  id: string;
  agent: string;
  intent: string;
  scope: string[];
  fingerprint: string;
  created: number;
  ttl: number;
  status: "active" | "expired";
  /**
   * Layer C audit trail. Present only when the claim was force-registered
   * (`force: true`) over a `conflict: true` oracle verdict (§17.3). The wire
   * shape of the OR-Set payload is unchanged; this rides on the SQL read-cache
   * row + the DTO only.
   */
  overriddenVerdicts?: ConflictVerdict[];
  /**
   * Tier 2.1 — graph-aware scope suggestion. Present on the POST 201 response
   * only (not persisted, not on the OR-Set wire payload, not on GET). The
   * import/call-edge neighbors of the claimed ids — the entities a change to the
   * claimed code is LIKELY to also touch. SUGGESTION only: the registered
   * `scope` is unchanged; the agent/board sees "you claimed X; these N adjacent
   * nodes are likely impacted" and can choose to widen the claim. We deliberately
   * do NOT auto-expand the claim (that would over-lock — see {@link suggestScope}).
   */
  suggestedScope?: string[];
}

export interface ClaimsResponse {
  claims: ClaimDto[];
  total: number;
  active: number;
  expired: number;
}

interface RawCreateBody {
  id?: unknown;
  agent?: unknown;
  intent?: unknown;
  scope?: unknown;
  fingerprint?: unknown;
  ttlSeconds?: unknown;
  force?: unknown;
}

interface CreatePayload {
  id: string;
  agent: string;
  intent: string;
  scope: string[];
  fingerprint: string;
  ttlSeconds: number;
  /** Force-register over a `conflict: true` Layer C verdict (§17.3). */
  force: boolean;
}

export function claimsRoutes(deps: ServerDependencies) {
  // Layer C force-override audit (§17.3). Local, non-converging metadata about
  // a *local* force decision — it intentionally rides alongside the SQL read
  // cache + DTO rather than the OR-Set wire payload (which must not change).
  // Keyed by claim id; cleared on release.
  const overriddenVerdicts = new Map<string, ConflictVerdict[]>();

  // Layer A neighbor lookup backed by the live DB edge queries (§17.1):
  // union of outgoing dst-ids and incoming src-ids. Pure w.r.t. the adjacency
  // functions, which take it as an injected dependency.
  const neighbors: NeighborLookup = (entityId) => {
    const out: string[] = [];
    for (const e of deps.db.outgoing(entityId)) out.push(e.dst);
    for (const e of deps.db.incoming(entityId)) out.push(e.src);
    return out;
  };

  // Layer C oracle (§17.3 / §18.4). When `config.conflict.oracle` names a
  // present model id AND the native binary is locatable, this is an `LlmOracle`
  // (with a `HeuristicOracle` fallback baked in); otherwise the heuristic.
  // Selection spawns nothing — the model is only invoked per-assess.
  const oracle = selectOracle(deps.config, {
    hayvenDir: deps.paths.hayvenDir,
    locateBinary: () =>
      tryLocateNativeBinary({ repoRoot: deps.paths.repoRoot }),
    // Live entity/edge index for the OPT-IN `contract-diff` oracle. Passing these
    // is additive: they are only consumed when `config.conflict.oracle ===
    // "contract-diff"`; for the default (`gemma3:1b`→heuristic) key they are
    // ignored, so the shipping behaviour is unchanged.
    db: deps.db,
    repoRoot: deps.paths.repoRoot,
    parseLanguages: deps.config.parse_languages,
    logger: deps.logger,
  });

  return new Elysia()
    .get("/api/claims", (): ClaimsResponse => {
      const now = Date.now();
      const claims = deps.crdt.orset
        .active()
        .map((op) => addOpToDto(op, now, overriddenVerdicts.get(op.claimId)));
      let active = 0;
      let expired = 0;
      for (const c of claims) {
        if (c.status === "active") active++;
        else expired++;
      }
      return { claims, total: claims.length, active, expired };
    })
    .post("/api/claims", async ({ body, set }) => {
      const validation = validateCreate(body);
      if (!validation.ok) {
        set.status = 400;
        return { error: validation.error };
      }
      const input = validation.value;
      const now = Date.now();

      const existing = findActive(deps, input.id);
      if (existing !== null) {
        // Idempotent retry: the SAME agent re-submitting the SAME claim id is a
        // safe no-op (a CLI retry after a transient error, or a deterministic
        // per-(agent,scope) id), so return the live claim with 200 rather than a
        // spurious 409 that makes a retry loop spin. A DIFFERENT agent reusing an
        // id is a genuine collision → 409.
        if (existing.agent === input.agent) {
          set.status = 200;
          return addOpToDto(existing, now);
        }
        set.status = 409;
        return {
          error: "claim id already exists (held by a different agent)",
          existing: addOpToDto(existing, now),
        };
      }

      // EXPIRED claims must NOT block (pass `now` so `active()` drops them) —
      // otherwise a leaked/abandoned claim deadlocks its scope past its TTL.
      const active: ClaimLike[] = deps.crdt.orset
        .active(now)
        .map((op) => ({ id: op.claimId, scope: op.payload.scope }));

      // (1) Overlap = hard conflict → 409 (§17.1).
      const overlap = findOverlap(input.scope, active);
      if (overlap !== null) {
        set.status = 409;
        return {
          error: "scope overlaps an active claim",
          conflictingClaimId: overlap.claim.id,
          overlappingEntities: overlap.entities,
        };
      }

      // (2) Adjacency → run the Layer C oracle once per adjacent claim (§17.3).
      // Tier 2.2: call/import GRAPH-EDGE adjacency is a first-class signal. When
      // a real edge connects the two scopes (vs. mere module co-location) we
      // strengthen the verdict reason so the agent sees the SEMANTIC link. This
      // does NOT change the gate: an adjacency conflict is still a soft 202
      // (force-able), never a hard 409 — edge adjacency must not block
      // truly-independent work (§16(4)).
      const adjacentClaims = findAdjacent(
        input.scope,
        active,
        neighbors,
        deps.config.conflict?.adjacency ?? "module+edge",
      );
      const conflictVerdicts: ConflictVerdict[] = [];
      if (adjacentClaims.length > 0) {
        const incomingCtx = {
          scope: input.scope,
          intent: input.intent,
          neighbors: scopeNeighbors(input.scope, neighbors),
        };
        for (const adj of adjacentClaims) {
          const viaEdge = edgeAdjacency(input.scope, adj.scope, neighbors);
          const verdict = await oracle.assess(incomingCtx, {
            scope: adj.scope,
            // The adjacent claim's intent is on its active OR-Set op.
            intent: intentOf(deps, adj.id),
            neighbors: scopeNeighbors(adj.scope, neighbors),
          });
          if (verdict.conflict) {
            // First-class edge-adjacency signal: annotate the reason so the
            // 202 surfaces WHY (a resolved call/import edge), not just "adjacent".
            conflictVerdicts.push(
              viaEdge
                ? {
                    ...verdict,
                    reason: `Connected by a call/import edge to active claim \`${adj.id}\`. ${verdict.reason}`,
                  }
                : verdict,
            );
          }
        }
      }

      // (3) Conflicting verdict(s) → 202 and DO NOT register, unless force.
      if (conflictVerdicts.length > 0 && input.force !== true) {
        set.status = 202;
        return {
          status: "potential-conflict",
          message:
            "Adjacent active claim(s) may break each other's assumptions; " +
            "coordinate or re-submit with force:true.",
          verdicts: conflictVerdicts,
        };
      }

      const created = Date.now();
      const ttl = created + input.ttlSeconds * 1000;
      const payload: ClaimPayload = {
        intent: input.intent,
        scope: input.scope,
        fingerprint: input.fingerprint,
        createdMs: created,
        ttlMs: ttl,
      };
      const op: OrAddOp = {
        kind: "add",
        claimId: input.id,
        agent: input.agent,
        payload,
        hlc: deps.crdt.tick(),
        writer: deps.crdt.writer,
      };
      deps.crdt.applyOr(op);
      upsertClaimRow(deps.db.handle, input, created, ttl);

      // (4) Persist the overridden verdict(s) for audit when force-registered.
      let recorded: ConflictVerdict[] | undefined;
      if (conflictVerdicts.length > 0) {
        recorded = conflictVerdicts;
        overriddenVerdicts.set(input.id, conflictVerdicts);
      }

      // (5) Tier 2.1 — surface the graph-aware suggested scope on the 201. This
      // is advisory only: the registered scope is exactly `input.scope`; the
      // suggestion lists the one-hop import/call neighbors the change is likely
      // to also touch. SUGGEST, not auto-claim (see `suggestScope` rationale).
      const dto = addOpToDto(op, Date.now(), recorded);
      const { suggested } = suggestScope(input.scope, neighbors);
      if (suggested.length > 0) dto.suggestedScope = suggested;

      set.status = 201;
      return dto;
    })
    .delete("/api/claims/:id", ({ params, set }) => {
      const id = decodeURIComponent(params.id);
      if (findActive(deps, id) === null) {
        set.status = 404;
        return { error: "claim not found" };
      }
      const op = makeRemoveOpFor(deps.crdt.orset, id, deps.crdt.tick(), deps.crdt.writer);
      deps.crdt.applyOr(op);
      deleteClaimRow(deps.db.handle, id);
      overriddenVerdicts.delete(id);
      return { ok: true, id };
    });
}

/** Intent text of an active claim by id (empty string if not found). */
function intentOf(deps: ServerDependencies, claimId: string): string {
  const op = findActive(deps, claimId);
  return op?.payload.intent ?? "";
}

function findActive(deps: ServerDependencies, claimId: string): OrAddOp | null {
  for (const op of deps.crdt.orset.active()) {
    if (op.claimId === claimId) return op;
  }
  return null;
}

function addOpToDto(
  op: OrAddOp,
  now: number,
  overriddenVerdicts?: ConflictVerdict[],
): ClaimDto {
  const created = op.payload.createdMs;
  const ttl = op.payload.ttlMs;
  const dto: ClaimDto = {
    id: op.claimId,
    agent: op.agent,
    intent: op.payload.intent,
    scope: [...op.payload.scope],
    fingerprint: op.payload.fingerprint,
    created,
    ttl,
    status: ttl > now ? "active" : "expired",
  };
  if (overriddenVerdicts && overriddenVerdicts.length > 0) {
    dto.overriddenVerdicts = overriddenVerdicts;
  }
  return dto;
}

type ValidateResult =
  | { ok: true; value: CreatePayload }
  | { ok: false; error: string };

function validateCreate(body: unknown): ValidateResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = body as RawCreateBody;
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return { ok: false, error: "`id` must be a non-empty string" };
  }
  if (typeof raw.agent !== "string" || raw.agent.length === 0) {
    return { ok: false, error: "`agent` must be a non-empty string" };
  }
  if (typeof raw.intent !== "string" || raw.intent.length === 0) {
    return { ok: false, error: "`intent` must be a non-empty string" };
  }
  if (!Array.isArray(raw.scope) || raw.scope.length === 0) {
    return { ok: false, error: "`scope` must be a non-empty array of strings" };
  }
  const scope: string[] = [];
  for (let i = 0; i < raw.scope.length; i++) {
    const entry = raw.scope[i];
    if (typeof entry !== "string" || entry.length === 0) {
      return { ok: false, error: `scope[${i}] must be a non-empty string` };
    }
    scope.push(entry);
  }
  if (typeof raw.fingerprint !== "string" || raw.fingerprint.length === 0) {
    return { ok: false, error: "`fingerprint` must be a non-empty string" };
  }
  const ttlSeconds = Number(raw.ttlSeconds);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    return { ok: false, error: "`ttlSeconds` must be a positive integer" };
  }
  if (raw.force !== undefined && typeof raw.force !== "boolean") {
    return { ok: false, error: "`force` must be a boolean when present" };
  }
  return {
    ok: true,
    value: {
      id: raw.id,
      agent: raw.agent,
      intent: raw.intent,
      scope,
      fingerprint: raw.fingerprint,
      ttlSeconds,
      force: raw.force === true,
    },
  };
}

function upsertClaimRow(
  db: Database,
  input: CreatePayload,
  created: number,
  ttl: number,
): void {
  db.query(
    `INSERT INTO claims (id, agent, scope_json, fingerprint, intent, created, ttl)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agent       = excluded.agent,
       scope_json  = excluded.scope_json,
       fingerprint = excluded.fingerprint,
       intent      = excluded.intent,
       created     = excluded.created,
       ttl         = excluded.ttl`,
  ).run(
    input.id,
    input.agent,
    JSON.stringify(input.scope),
    input.fingerprint,
    input.intent,
    created,
    ttl,
  );
}

function deleteClaimRow(db: Database, id: string): void {
  db.query("DELETE FROM claims WHERE id = ?").run(id);
}
