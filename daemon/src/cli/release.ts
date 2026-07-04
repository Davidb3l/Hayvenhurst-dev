/**
 * `hayven release <claim_id> [--json]`
 *
 * Releases (removes) a work claim from the running daemon's OR-Set claim board
 * via `DELETE /api/claims/:id`. This MUTATES the board, so — like `claim` and
 * the other network-mutating commands — it carries the project-identity guard
 * (`assertDaemonServesProject`) before sending the request: every project
 * defaults to port 7777, and without the `/api/health` `root` check a release
 * could silently mutate a DIFFERENT repo's daemon that happens to be on the
 * port. See `claim.ts` for the canonical pattern.
 *
 * Status mapping:
 *   200 → released.
 *   404 → no active claim with that id (already released / never existed).
 */
import { assertDaemonServesProject, isJson, reportIdentity, requireProject } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

export async function runRelease(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("usage: hayven release <claim_id> [--json]\n");
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
  // to port 7777). Verify the daemon at `base` serves this repo before DELETEing.
  const identity = await assertDaemonServesProject(base, ctx);
  if (!reportIdentity(identity)) return 1;

  let res: Response;
  try {
    res = await fetch(`${base}/api/claims/${encodeURIComponent(id)}`, {
      method: "DELETE",
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
    return res.status === 200 ? 0 : 1;
  }

  if (res.status === 200) {
    process.stdout.write(`# Claim released\n\n- id: \`${String(payload["id"] ?? id)}\`\n`);
    return 0;
  }

  if (res.status === 404) {
    process.stderr.write(`error: no active claim \`${id}\`\n`);
    return 1;
  }

  process.stderr.write(`error: daemon returned ${res.status}: ${String(payload["error"] ?? "")}\n`);
  return 1;
}
