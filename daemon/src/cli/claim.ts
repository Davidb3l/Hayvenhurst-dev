/**
 * `hayven claim <ids...> --intent "..." [--agent X] [--ttl N] [--force] [--json]`
 *
 * Registers a work claim against the running daemon's OR-Set board and runs
 * the Layer A overlap / Layer C adjacency-oracle path (ARCHITECTURE.md §17).
 *
 * Status mapping:
 *   201 → registered.
 *   409 → scope overlaps an active claim (hard conflict) OR id already exists.
 *   202 → adjacent active claim(s) flagged a potential conflict; coordinate or
 *         re-run with `--force` to register anyway (the verdict is recorded for
 *         audit on the registered claim).
 */
import { createHash } from "node:crypto";

import { assertDaemonServesProject, requireProject } from "./_shared.ts";
import { isJson } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

interface ConflictVerdict {
  conflict: boolean;
  reason: string;
  confidence: number;
  oracle: string;
}

export async function runClaim(args: ParsedArgs): Promise<number> {
  const scope = args.positionals;
  if (scope.length === 0) {
    process.stderr.write(
      "usage: hayven claim <ids...> --intent \"...\" [--agent X] [--ttl SECONDS] [--force] [--suggest-scope] [--json]\n",
    );
    return 2;
  }

  const intent = flagStr(args.flags["intent"]);
  if (!intent) {
    process.stderr.write("error: --intent \"<what you're about to do>\" is required\n");
    return 2;
  }

  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const base = `http://${ctx.config.daemon_host}:${ctx.config.daemon_port}`;

  // Guard against mutating a DIFFERENT project's daemon (every project defaults
  // to port 7777). Verify the daemon at `base` serves this repo before POSTing.
  const identity = await assertDaemonServesProject(base, ctx);
  if (!identity.ok) {
    process.stderr.write(`error: ${identity.message}\n`);
    return 1;
  }
  if (identity.warning) process.stderr.write(`warning: ${identity.warning}\n`);

  const ttlSeconds = Math.max(1, Number(args.flags["ttl"]) || 3600);
  const force = args.flags["force"] === true || args.flags["force"] === "true";
  // Tier 2.1 — opt-in: print the graph-aware suggested adjacent scope (the
  // one-hop import/call neighbors of the claimed ids) on a successful claim.
  const suggestScope =
    args.flags["suggest-scope"] === true || args.flags["suggest-scope"] === "true";
  const agent = flagStr(args.flags["agent"]) ?? "cli";
  // Deterministic default id from (agent, scope): a retry of the SAME claim by
  // the SAME agent reuses the SAME id, so the daemon treats it as an idempotent
  // re-claim (200) instead of minting a fresh random id every call — which used
  // to LEAK a new active claim per retry and, combined with TTL-blind blocking,
  // could deadlock a contended scope. Pass an explicit `--id` to override, and a
  // distinct `--agent` per worker so different agents still serialize on a scope.
  const defaultId = `claim_${createHash("sha256")
    .update(`${agent}\0${[...scope].sort().join(",")}`)
    .digest("hex")
    .slice(0, 12)}`;
  const body = {
    id: flagStr(args.flags["id"]) ?? defaultId,
    agent,
    intent,
    scope,
    fingerprint: flagStr(args.flags["fingerprint"]) ?? "cli:unfingerprinted",
    ttlSeconds,
    force,
  };

  let res: Response;
  try {
    res = await fetch(`${base}/api/claims`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    process.stderr.write(
      `error: could not reach daemon at ${base} (${(err as Error).message}).\n` +
        "Start it with `hayven daemon start`.\n",
    );
    return 1;
  }

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (isJson(args.flags)) {
    process.stdout.write(JSON.stringify({ status: res.status, ...payload }, null, 2) + "\n");
    return res.status === 201 ? 0 : res.status === 202 ? 3 : 1;
  }

  if (res.status === 201) {
    const id = String(payload["id"] ?? body.id);
    const verdicts = payload["overriddenVerdicts"] as ConflictVerdict[] | undefined;
    let out = `# Claim registered\n\n- id:    \`${id}\`\n- scope: ${scope.map((s) => `\`${s}\``).join(", ")}\n`;
    if (verdicts && verdicts.length > 0) {
      out += `\nForce-registered over ${verdicts.length} conflict verdict(s) (recorded for audit):\n`;
      for (const v of verdicts) out += `- ${v.reason} (${v.oracle}, confidence ${v.confidence})\n`;
    }
    // Tier 2.1 — graph-aware scope suggestion. Opt-in via `--suggest-scope`: the
    // daemon always returns `suggestedScope` (the one-hop import/call neighbors
    // the change is likely to also touch), but we only surface it when asked, to
    // keep the default output terse. SUGGESTION only — the claim is NOT widened.
    if (suggestScope) {
      const suggested = (payload["suggestedScope"] as string[] | undefined) ?? [];
      if (suggested.length > 0) {
        out +=
          `\nSuggested adjacent scope (likely also impacted — NOT claimed; ` +
          `re-run \`hayven claim\` with these ids to widen):\n` +
          suggested.map((s) => `- \`${s}\``).join("\n") +
          "\n";
      } else {
        out += "\nSuggested adjacent scope: none (no import/call neighbors).\n";
      }
    }
    process.stdout.write(out);
    return 0;
  }

  if (res.status === 202) {
    const verdicts = (payload["verdicts"] as ConflictVerdict[] | undefined) ?? [];
    let out =
      "# Potential conflict — claim NOT registered\n\n" +
      "Adjacent active claim(s) may break each other's assumptions.\n" +
      "Coordinate with the other agent, or re-run with `--force` to register anyway.\n\n";
    for (const v of verdicts) out += `- ${v.reason} (${v.oracle}, confidence ${v.confidence})\n`;
    process.stdout.write(out);
    return 3;
  }

  if (res.status === 409) {
    const conflictingId = payload["conflictingClaimId"];
    const entities = payload["overlappingEntities"] as string[] | undefined;
    if (conflictingId) {
      process.stderr.write(
        `error: scope overlaps active claim \`${String(conflictingId)}\`` +
          (entities ? ` on ${entities.map((e) => `\`${e}\``).join(", ")}` : "") +
          " — this is a hard conflict (resolve before claiming).\n",
      );
    } else {
      process.stderr.write(`error: ${String(payload["error"] ?? "claim already exists")}\n`);
    }
    return 1;
  }

  process.stderr.write(`error: daemon returned ${res.status}: ${String(payload["error"] ?? "")}\n`);
  return 1;
}

function flagStr(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
