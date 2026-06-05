/**
 * `hayven remember` / `hayven recall` — fleet memory (Phase 0.0.4).
 *
 * Durable, cross-agent/cross-session knowledge keyed to the code graph: an agent
 * records a decision / dead-end / gotcha / note, and a LATER agent recalls it
 * instead of re-deriving. Distinct from `claim` (which coordinates concurrent
 * EDITS): this is shared KNOWLEDGE, read-mostly, never blocks.
 *
 *   hayven remember "<note>" [--node <id>] [--kind decision|deadend|gotcha|note]
 *                            [--scope a,b] [--ttl <seconds>] [--agent <name>] [--json]
 *   hayven recall [<term>] [--node <id>] [--kind <k>] [--limit N] [--json]
 *   hayven recall --forget <id>
 *
 * Writes go to the project's index directly (daemonless, like `query`/`refs`);
 * additive + low-contention, so no claim/daemon round-trip is required.
 */
import type { ParsedArgs } from "../cli.ts";
import {
  forgetMemory,
  listMemory,
  memoryForNode,
  recordMemory,
  searchMemory,
  type MemoryKind,
  type MemoryNote,
} from "../db/fleet_memory.ts";
import { isJson, openProjectDb, requireProject } from "./_shared.ts";

const KINDS: ReadonlySet<string> = new Set(["decision", "deadend", "gotcha", "note"]);

function flagStr(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** `hayven remember "<note>" [flags]` — write a note. */
export async function runRemember(args: ParsedArgs): Promise<number> {
  const note = args.positionals.join(" ").trim();
  if (!note) {
    process.stderr.write(
      'usage: hayven remember "<note>" [--node <id>] [--kind decision|deadend|gotcha|note] ' +
        "[--scope a,b] [--ttl <seconds>] [--agent <name>] [--json]\n",
    );
    return 2;
  }
  const kind = flagStr(args, "kind") ?? "note";
  if (!KINDS.has(kind)) {
    process.stderr.write(`error: --kind must be one of: ${[...KINDS].join(", ")}\n`);
    return 2;
  }
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const scopeRaw = flagStr(args, "scope");
  const scope = scopeRaw
    ? scopeRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const ttlRaw = flagStr(args, "ttl");
  const ttl = ttlRaw !== undefined && Number.isFinite(Number(ttlRaw)) ? Number(ttlRaw) : null;

  const db = openProjectDb(ctx, { readonly: false });
  try {
    const stored = recordMemory(db, {
      agent: flagStr(args, "agent"),
      nodeId: flagStr(args, "node") ?? null,
      kind: kind as MemoryKind,
      note,
      scope,
      ttl,
      now: Date.now(),
    });
    if (isJson(args.flags)) {
      process.stdout.write(JSON.stringify(stored, null, 2) + "\n");
    } else {
      process.stdout.write(`remembered \`${stored.id}\` (${stored.kind})\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/** `hayven recall [<term>] [flags]` / `hayven recall --forget <id>` — read/delete. */
export async function runRecall(args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  const forgetId = flagStr(args, "forget");
  const node = flagStr(args, "node");
  const kindRaw = flagStr(args, "kind");
  const kind = kindRaw && KINDS.has(kindRaw) ? (kindRaw as MemoryKind) : undefined;
  const limitRaw = flagStr(args, "limit");
  const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : undefined;
  const term = args.positionals.join(" ").trim();

  const db = openProjectDb(ctx, { readonly: forgetId === undefined ? true : false });
  try {
    if (forgetId !== undefined) {
      const removed = forgetMemory(db, forgetId);
      process.stdout.write(removed ? `forgot \`${forgetId}\`\n` : `no such note \`${forgetId}\`\n`);
      return removed ? 0 : 1;
    }
    const now = Date.now();
    let notes: MemoryNote[];
    if (node) notes = memoryForNode(db, node, now);
    else if (term) notes = searchMemory(db, term, now, limit);
    else notes = listMemory(db, now, { kind, limit });

    if (isJson(args.flags)) {
      process.stdout.write(JSON.stringify({ count: notes.length, notes }, null, 2) + "\n");
      return 0;
    }
    if (notes.length === 0) {
      process.stdout.write("(no matching memory)\n");
      return 0;
    }
    const lines = [`# Fleet memory — ${notes.length} note(s)`, ""];
    for (const n of notes) {
      const where = n.nodeId ? ` @\`${n.nodeId}\`` : n.scope.length ? ` @[${n.scope.join(", ")}]` : "";
      const who = n.agent ? ` — ${n.agent}` : "";
      lines.push(`- [${n.kind}]${where} ${n.note}  \`${n.id}\`${who}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}
