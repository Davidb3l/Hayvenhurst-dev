/**
 * `hayven node body <id> [--body "..."] [--file PATH] [--json]`
 *
 * BL-12: CRDT-aware node-body write path. Updates a code-entity's markdown
 * body through the LWW-Register CRDT (ARCHITECTURE.md §12.1) by calling the
 * daemon's `PUT /api/nodes/:id/body` route — which mints an `LwwOp`, persists
 * it to the op log (so it participates in Merkle sync), updates the markdown
 * source-of-truth under `.hayven/nodes/`, and refreshes the SQL read cache.
 *
 * Body source precedence: `--body <text>` > `--file <path>` > stdin. Going
 * through the daemon (not a direct op-log write) keeps the §14.3 "one writer
 * per segment per daemon" invariant — the daemon owns the op log.
 */
import { readFileSync } from "node:fs";

import { assertDaemonServesProject, isJson, requireProject } from "./_shared.ts";
import type { ParsedArgs } from "../cli.ts";

export async function runNode(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];
  if (sub !== "body") {
    process.stderr.write(
      "usage: hayven node body <id> [--body \"...\"] [--file PATH] [--json]\n",
    );
    return 2;
  }
  const id = args.positionals[1];
  if (!id) {
    process.stderr.write(
      "usage: hayven node body <id> [--body \"...\"] [--file PATH] [--json]\n",
    );
    return 2;
  }

  let body: string | null;
  try {
    body = await resolveBody(args);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  if (body === null) {
    process.stderr.write(
      "error: provide the new body via --body \"<text>\", --file <path>, or stdin\n",
    );
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

  // node body writes to the LWW op-log via the daemon — refuse if the daemon at
  // this port serves a DIFFERENT repo (verified foreign-write footgun).
  const identity = await assertDaemonServesProject(base, ctx);
  if (!identity.ok) {
    process.stderr.write(`error: ${identity.message}\n`);
    return 1;
  }
  if (identity.warning) process.stderr.write(`warning: ${identity.warning}\n`);

  let res: Response;
  try {
    res = await fetch(`${base}/api/nodes/${encodeURIComponent(id)}/body`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
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
    process.stdout.write(
      `# Node body updated\n\n- id:   \`${id}\`\n- file: ${String(payload["path"] ?? "(written)")}\n`,
    );
    return 0;
  }
  if (res.status === 404) {
    process.stderr.write(
      `error: no node with id \`${id}\` — try \`hayven query ${id}\` to fuzzy-find it.\n`,
    );
    return 1;
  }
  process.stderr.write(`error: daemon returned ${res.status}: ${String(payload["error"] ?? "")}\n`);
  return 1;
}

/** Resolve the new body from --body, then --file, then stdin. Null if none. */
async function resolveBody(args: ParsedArgs): Promise<string | null> {
  const inline = args.flags["body"];
  if (typeof inline === "string") return inline;

  const file = args.flags["file"];
  if (typeof file === "string" && file.length > 0) {
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") throw new Error(`no such file: ${file}`);
      if (e.code === "EISDIR") throw new Error(`--file is a directory, not a file: ${file}`);
      throw new Error(`could not read --file ${file}: ${e.message}`);
    }
  }

  // Fall back to stdin if it's piped (not a TTY).
  if (!process.stdin.isTTY) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
    }
    if (chunks.length > 0) {
      return Buffer.concat(chunks).toString("utf8");
    }
  }
  return null;
}
