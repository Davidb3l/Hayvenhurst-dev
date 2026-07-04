/**
 * `hayven mcp` — launch the `hayven-context` MCP server (Surface #2).
 *
 * A long-lived foreground process that speaks newline-delimited JSON-RPC 2.0
 * over stdin/stdout — the transport every MCP host (Claude Code, Codex, Gemini
 * CLI) spawns a stdio server with. It exposes two tools, `context_for_change`
 * and `context_for_symbols`, that wrap the shipped Surface-#1 library contract
 * (`db/context_helper.ts`) so an agent harness gets graph-precise, line-exact
 * slice packs instead of re-reading whole files.
 *
 * STATELESS by construction (the §9 qualification): the server holds NO session
 * state — the append-only continuation is carried by the client as the `prior`
 * tool argument and returned in the tool result. This is a thin stateless tool
 * surface over the library, not the stateful long-running MCP §9 rejected.
 *
 * Daemonless + read-only, exactly like `hayven context` (`cli/context.ts`):
 * `requireProject()` → `openProjectDb(ctx, { readonly: true })`. It NEVER spawns
 * an ingest or mutates the index. The read DB stays open for the life of the
 * process and is closed on stream end / SIGINT / SIGTERM.
 *
 * Config a host's `mcpServers` entry with:
 *   { "command": "hayven", "args": ["mcp"], "cwd": "<repo with .hayven/>" }
 */
import type { ParsedArgs } from "../cli.ts";
import { createContextMcpServer, runStdioLoop } from "../mcp/context_server.ts";
import { openProjectDb, requireProject } from "./_shared.ts";

export async function runMcp(_args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const db = openProjectDb(ctx, { readonly: true });
  const server = createContextMcpServer(db, ctx.paths.repoRoot);

  // Close the read handle exactly once, on either a signal or stream end.
  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    server.close();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  // Announce on stderr (stdout is the JSON-RPC channel and must stay clean).
  process.stderr.write(
    `hayven-context MCP server ready (stdio) for ${ctx.paths.repoRoot}\n`,
  );

  try {
    await runStdioLoop(server, Bun.stdin.stream(), (line) => process.stdout.write(line));
  } finally {
    shutdown();
  }
  return 0;
}
