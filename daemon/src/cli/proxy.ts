/**
 * `hayven proxy [--provider anthropic|openai|gemini] [--port N] [--host ADDR]
 * [--upstream URL]` — launch the transparent context proxy (Surface #3).
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
 *
 * It binds LOOPBACK ONLY by default. `--host` may override it, but a
 * NON-loopback address is REFUSED unless `--allow-remote-access` (or
 * `HAYVEN_ALLOW_REMOTE_ACCESS=1`) is also given — the same two-step gate the
 * daemon requires, for the same reason. See {@link DEFAULT_HOST} and
 * {@link decideProxyBind}.
 */
import type { ParsedArgs } from "../cli.ts";
import { isLoopbackHost } from "./daemon.ts";
import { createProxyHandler } from "../proxy/server.ts";
import { providerById, type ProviderId } from "../proxy/providers.ts";
import { openProjectDb, requireProject } from "./_shared.ts";

const DEFAULT_PORT = 7788;
const DEFAULT_PROVIDER: ProviderId = "anthropic";
/**
 * Default bind address — LOOPBACK ONLY.
 *
 * A bare `Bun.serve({ port })` with no `hostname` binds 0.0.0.0 (verified on Bun
 * 1.3.14: `lsof` shows `TCP *:PORT (LISTEN)` and the port answers on the
 * machine's LAN address) while `server.hostname` still reports "localhost". So
 * the proxy printed "http://localhost:7788" and was in fact an OPEN LLM-API
 * relay for everyone on the network — anyone who found it could burn the user's
 * upstream credits, since the proxy attaches nothing but relays whatever auth
 * the caller sends. The daemon has always bound `config.daemon_host`
 * (127.0.0.1) explicitly; this makes the proxy match.
 */
const DEFAULT_HOST = "127.0.0.1";

/**
 * The explicit second opt-in required to publish an unauthenticated listener.
 *
 * Deliberately the SAME flag and env var the daemon requires
 * (`cli/daemon.ts::remoteAccessAllowed`, which is module-private there). A user
 * who has learned the daemon's gate must not have to learn a second one for the
 * proxy — that "two paths deciding the same question differently" shape is what
 * produced the asymmetry this closes. If `remoteAccessAllowed` is ever exported
 * from `cli/daemon.ts`, this should become an import of it.
 */
function remoteAccessAllowed(args: ParsedArgs): boolean {
  const flag = args.flags["allow-remote-access"];
  if (flag === true || flag === "true") return true;
  const env = process.env["HAYVEN_ALLOW_REMOTE_ACCESS"];
  return env === "1" || env === "true";
}

/** What {@link decideProxyBind} concluded: bind `host`, or refuse with a reason. */
export type ProxyBindDecision =
  | { ok: true; host: string; exposed: boolean }
  | { ok: false; message: string };

/**
 * NETWORK EXPOSURE GATE — the proxy half of the daemon's gate.
 *
 * The daemon refuses a non-loopback bind outright unless a SECOND explicit
 * opt-in is given, on the reasoning that a warning printed by a process which
 * then keeps serving is not a decision point and there is no authentication
 * behind it to fall back on. Every word of that applies here: `hayven proxy`
 * has no authentication of its own, it RELAYS whatever upstream credentials a
 * caller sends (so anyone who reaches the port can spend the user's LLM
 * budget), and with `--compact-history` it reads the project's code graph and
 * source to build the slices it substitutes. Before this it merely printed a
 * warning and served anyway — we had hardened the daemon and left the adjacent,
 * arguably more expensive exposure open.
 *
 * The loopback predicate is IMPORTED from `cli/daemon.ts` rather than copied.
 * `cli.ts` already statically imports that module for the `daemon` subcommand,
 * so every `hayven` process has it loaded regardless and the import is free —
 * and one predicate cannot drift from itself.
 */
export function decideProxyBind(host: string, args: ParsedArgs): ProxyBindDecision {
  if (isLoopbackHost(host)) return { ok: true, host, exposed: false };
  if (!remoteAccessAllowed(args)) {
    return {
      ok: false,
      message:
        `error: refusing to bind ${host} — that is not a loopback address, and the hayven\n` +
        "context proxy has NO authentication. Binding it publishes, to anyone who can reach\n" +
        "this machine:\n" +
        "  - an open LLM-API relay: it forwards whatever credentials a caller sends to the\n" +
        "    upstream provider, so anyone who finds it can spend your API budget\n" +
        "  - the served project's code graph and source, as slices substituted into requests\n" +
        "If you genuinely intend that, re-run with --allow-remote-access (or set\n" +
        "HAYVEN_ALLOW_REMOTE_ACCESS=1), and put it behind something that authenticates.\n" +
        "Otherwise drop --host and it will bind 127.0.0.1.\n",
    };
  }
  return { ok: true, host, exposed: true };
}

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
  const hostFlag = args.flags["host"];
  if (hostFlag === true) {
    process.stderr.write("error: --host requires a value, e.g. --host 127.0.0.1\n");
    return 1;
  }
  const requestedHost =
    typeof hostFlag === "string" && hostFlag.length > 0 ? hostFlag : DEFAULT_HOST;

  // Decide BEFORE opening the read DB or binding anything: a refusal must cost
  // nothing and leak no handle.
  const bind = decideProxyBind(requestedHost, args);
  if (!bind.ok) {
    process.stderr.write(bind.message);
    return 2;
  }
  const host = bind.host;

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

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: host, port, fetch: handler });
  } catch (err) {
    // Bun.serve throws synchronously on EADDRINUSE / an unbindable address.
    // Without this the read DB leaks and the user gets a raw stack trace.
    db.close();
    process.stderr.write(`error: failed to bind ${host}:${port}: ${(err as Error).message}\n`);
    return 1;
  }

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

  // Echo the bind address we ASKED for, never a hardcoded "localhost" — the
  // whole point of A4 is that the printed URL must not lie about who can reach
  // this. `server.hostname` is deliberately NOT trusted as the source of truth:
  // it is the field that reported "localhost" while Bun was bound to the
  // wildcard. It is only consulted to WIDEN the warning below.
  const reported = typeof server.hostname === "string" && server.hostname.length > 0
    ? server.hostname
    : host;
  const boundPort = server.port ?? port;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}`;
  // Warn if EITHER the requested address or the one the runtime reports is
  // non-loopback, so a future runtime that silently ignores `hostname` again
  // cannot produce a quiet banner.
  const exposed = bind.exposed || !isLoopbackHost(reported);
  process.stderr.write(
    `hayven context proxy [${provider.label}] on ${url} → ${upstream}\n` +
      `  serving ${ctx.paths.repoRoot}\n` +
      (compact
        ? `  history compaction ON (keep last ${compact.keepRecentMessages ?? 8} messages full)\n`
        : "") +
      (!exposed
        ? ""
        : `  WARNING: bound to ${host} — this proxy is reachable from the NETWORK.\n` +
          "  It relays whatever credentials a caller sends to the upstream provider and\n" +
          "  applies NO authentication of its own. Anyone who can reach this port can use\n" +
          "  it as an open LLM-API relay. Use --host 127.0.0.1 unless you meant this.\n") +
      `  point your client's base URL at ${url}\n`,
  );

  // Block forever (until a signal). `Bun.serve` runs in the background; keep the
  // process alive with a never-resolving promise so the read DB stays open.
  await new Promise<void>(() => {});
  return 0;
}
