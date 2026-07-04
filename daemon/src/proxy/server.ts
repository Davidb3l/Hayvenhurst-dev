/**
 * SURFACE #3 — the transparent context proxy's THIN FORWARDING SHELL.
 *
 * A drop-in HTTP proxy for an LLM provider's chat endpoint. A client points its
 * base URL at this server; on the provider's chat path the shell runs that
 * provider's rewrite (the shared packing core, `context_rewrite.ts`, bound to the
 * vendor's request shape in `providers.ts`) — swapping whole-file pastes for
 * graph-precise slice packs — then forwards the (possibly smaller) request
 * upstream and relays the response verbatim. Every other request is forwarded
 * untouched. The provider (Anthropic / OpenAI / Gemini) is chosen at launch.
 *
 * Stateless + read-only: like `hayven mcp`, this holds only an open read DB
 * handle (a resource, not session state) and never ingests or mutates. The
 * upstream `fetch` is injectable so the whole thing is testable against a local
 * stub with no network / API key.
 *
 * Never-break: if the body isn't JSON we can parse, or the rewrite throws, or
 * anything is off, we forward the ORIGINAL bytes. The proxy degrading to a plain
 * pass-through is always preferable to failing the agent's request.
 */
import type { ProxyProvider } from "./providers.ts";
import type { Db } from "../db/queries.ts";

/** Hop-by-hop / length headers we must NOT copy onto the forwarded request — the
 *  runtime sets content-length from the (possibly rewritten) body, and `host`
 *  must reflect the upstream, not us. */
const STRIP_REQUEST_HEADERS = new Set(["host", "content-length", "connection"]);

/** Headers we must NOT copy from the UPSTREAM response onto ours. The runtime's
 *  `fetch` already DECODES the body (gzip/br/deflate) before we hand it back as a
 *  stream, so re-advertising the upstream's `content-encoding` would make the
 *  client try to decompress already-plain bytes (a `ZlibError` against the real
 *  Anthropic API — stub upstreams in tests don't compress, which is why this only
 *  showed up dogfooding the live process). `content-length` is likewise stale once
 *  the body is decoded; let the runtime recompute it. */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

export interface ProxyDeps {
  /** The open read index for the project being served. */
  db: Db;
  /** Absolute repo root — the base the `<file path>` markers resolve against. */
  repoRoot: string;
  /** Upstream base URL (e.g. `https://api.anthropic.com`). No trailing slash. */
  upstream: string;
  /** The vendor binding: which path to rewrite + how to walk the request shape. */
  provider: ProxyProvider;
  /** Opt-in graph-aware history compaction (all providers — the provider walks
   *  its own message shape): compact OLDER
   *  native `Read` tool results to a task-relevant slice + recovery pointer,
   *  keeping the last `keepRecentMessages` messages intact. Omit to disable. */
  compact?: { keepRecentMessages?: number };
  /** Injectable upstream fetch (defaults to global `fetch`; the test stubs it). */
  fetchImpl?: typeof fetch;
  /** Optional per-request savings sink (defaults to a one-line stderr note). */
  onSavings?: (note: string) => void;
}

/** Build the request handler. Pure construction — no listening; the CLI wires it
 *  to `Bun.serve`, the test calls it directly with synthetic `Request`s. */
export function createProxyHandler(deps: ProxyDeps): (req: Request) => Promise<Response> {
  const fetchUpstream = deps.fetchImpl ?? fetch;
  const upstream = deps.upstream.replace(/\/+$/, "");
  const emit = deps.onSavings ?? ((note: string) => process.stderr.write(note + "\n"));
  const { provider } = deps;

  /** Copy the inbound headers minus the ones that must be recomputed/retargeted.
   *  Auth (`x-api-key` / `authorization` / `x-goog-api-key`) and any vendor
   *  version header pass straight through — the proxy never stores credentials. */
  const forwardHeaders = (req: Request): Headers => {
    const h = new Headers();
    req.headers.forEach((value, key) => {
      if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) h.set(key, value);
    });
    return h;
  };

  /** Relay an upstream response (status + body STREAM — SSE flows through
   *  unbuffered; we never await the body), minus the encoding/length headers the
   *  runtime already invalidated by decoding the body (see STRIP_RESPONSE_HEADERS). */
  const relay = (res: Response): Response => {
    const headers = new Headers();
    res.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) headers.set(key, value);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const target = upstream + url.pathname + url.search;

    // Only POST to the provider's chat path is a rewrite candidate; everything
    // else relays as-is so the proxy is a faithful front for the whole API.
    const isRewriteCandidate = req.method === "POST" && provider.matchPath(url.pathname);
    if (!isRewriteCandidate) {
      const init: RequestInit = { method: req.method, headers: forwardHeaders(req) };
      if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.text();
      return relay(await fetchUpstream(target, init));
    }

    const raw = await req.text();

    // Parse → rewrite (→ compact) → forward. ANY failure falls back to `raw`.
    let forwardBody = raw;
    try {
      const parsed: unknown = JSON.parse(raw);
      // eslint-disable-next-line prefer-const -- body/changed are reassigned by the compaction pass
      let { body, stats, changed } = provider.rewrite(deps.db, deps.repoRoot, parsed);

      // Second pass: graph-aware history compaction over the vendor's shape
      // (anthropic / openai / gemini — the provider knows how to walk its own
      // messages and tolerates a non-conforming body).
      let compactSaved = 0;
      let compacted = 0;
      if (deps.compact) {
        const c = provider.compactHistory(
          deps.db,
          deps.repoRoot,
          body,
          provider.collectIntent(body),
          { keepRecentMessages: deps.compact.keepRecentMessages },
        );
        if (c.changed) {
          body = c.body as typeof body;
          changed = true;
          compactSaved = c.stats.savedTokens;
          compacted = c.stats.occurrencesCompacted;
        }
      }

      if (changed) {
        forwardBody = JSON.stringify(body);
        const compactNote = compacted > 0 ? `, compacted ${compacted} old read(s) ~${compactSaved} tok` : "";
        emit(
          `hayven proxy [${provider.id}]: packed ${stats.filesPacked}/${stats.filesDetected} ` +
            `file(s), ~${stats.savedTokens} tok saved (${stats.tokensBefore}→${stats.tokensAfter})${compactNote}`,
        );
      } else if (stats.filesDetected > 0) {
        emit(
          `hayven proxy [${provider.id}]: ${stats.filesDetected} file marker(s), none beaten ` +
            `(${stats.perFile.map((s) => s.action).join(",")}) — forwarded as-is`,
        );
      }
    } catch {
      forwardBody = raw; // not JSON / unexpected shape — forward untouched
    }

    return relay(
      await fetchUpstream(target, { method: "POST", headers: forwardHeaders(req), body: forwardBody }),
    );
  };
}
