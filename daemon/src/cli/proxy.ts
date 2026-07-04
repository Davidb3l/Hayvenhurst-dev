/**
 * `hayven proxy [--provider anthropic|openai|gemini] [--port N] [--upstream URL]`
 * — launch the transparent context proxy (Surface #3).
 *
 * A drop-in HTTP front for an LLM provider's chat endpoint: point a client's base
 * URL at `http://localhost:<port>` and it forwards every request to `--upstream`
 * (default = the provider's canonical host), but on the provider's chat path it
 * first swaps whole-file `<file path="…">` pastes for graph-precise slice packs
 * when a smaller pack can be inferred from the live instruction — cutting context
 * tokens with NO change to the agent harness. Anything it can't confidently beat
 * is forwarded untouched (never worse than not being there).
 *
 * Stateless + read-only, daemonless, exactly like `hayven mcp` (`cli/mcp.ts`):
 * `requireProject()` → `openProjectDb(ctx, { readonly: true })`. It never ingests
 * or mutates the index, and it never stores credentials — auth headers are
 * relayed straight to the upstream.
 *
 * Point a client at it, e.g. `ANTHROPIC_BASE_URL=http://localhost:7788`
 * (or `OPENAI_BASE_URL` / a Gemini base URL for the other providers).
 */
import type { ParsedArgs } from "../cli.ts";
import { createProxyHandler } from "../proxy/server.ts";
import { providerById, type ProviderId } from "../proxy/providers.ts";
import { openProjectDb, requireProject } from "./_shared.ts";

const DEFAULT_PORT = 7788;
const DEFAULT_PROVIDER: ProviderId = "anthropic";

export async function runProxy(args: ParsedArgs): Promise<number> {
  let ctx;
  try {
    ctx = requireProject();
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }

  const provFlag = args.flags["provider"];
  const providerId = typeof provFlag === "string" ? provFlag : DEFAULT_PROVIDER;
  const provider = providerById(providerId);
  if (!provider) {
    process.stderr.write(
      `error: unknown --provider ${String(provFlag)} (expected anthropic|openai|gemini)\n`,
    );
    return 1;
  }

  const portFlag = args.flags["port"];
  const port =
    portFlag === undefined || portFlag === true ? DEFAULT_PORT : Number(portFlag);
  if (Number.isNaN(port) || port <= 0) {
    process.stderr.write(`error: invalid --port ${String(portFlag)}\n`);
    return 1;
  }
  const upFlag = args.flags["upstream"];
  const upstream =
    typeof upFlag === "string" && upFlag.length > 0 ? upFlag : provider.defaultUpstream;

  const compactOn =
    args.flags["compact-history"] === true || args.flags["compact-history"] === "true";
  const keepFlag = args.flags["keep-recent"];
  const compact = compactOn
    ? { keepRecentMessages: typeof keepFlag === "string" ? Number(keepFlag) : undefined }
    : undefined;

  const db = openProjectDb(ctx, { readonly: true });
  const handler = createProxyHandler({ db, repoRoot: ctx.paths.repoRoot, upstream, provider, compact });

  const server = Bun.serve({ port, fetch: handler });

  let closed = false;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    server.stop(true);
    db.close();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  process.stderr.write(
    `hayven context proxy [${provider.label}] on http://localhost:${port} → ${upstream}\n` +
      `  serving ${ctx.paths.repoRoot}\n` +
      (compact
        ? `  history compaction ON (keep last ${compact.keepRecentMessages ?? 8} messages full)\n`
        : "") +
      `  point your client's base URL at http://localhost:${port}\n`,
  );

  // Block forever (until a signal). `Bun.serve` runs in the background; keep the
  // process alive with a never-resolving promise so the read DB stays open.
  await new Promise<void>(() => {});
  return 0;
}
