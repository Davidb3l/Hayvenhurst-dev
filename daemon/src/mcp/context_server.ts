/**
 * SURFACE #2 — the `hayven-context` MCP server: a THIN, STATELESS tool surface
 * over the shipped Surface-#1 library contract (`db/context_helper.ts`).
 *
 * What it is. Two tools — `context_for_change` and `context_for_symbols` — that
 * wrap `contextForChange` / `contextForSymbols` 1:1 and return the same
 * {@link StableContextResult}. A BUILDER's agent harness (Claude Code, Codex,
 * Gemini CLI — anything that speaks MCP) gets graph-precise, line-exact slice
 * packs for a prompt instead of re-reading whole files, the same as the CLI
 * (`hayven context`) and the daemon route (`GET /api/context`) already give.
 *
 * Why this is allowed under §9's "no long-running MCP server" lock. The lock was
 * against a STATEFUL, heavyweight MCP that OWNS session state (a keyed prior-store,
 * a `ContextSession` object, a server that must stay warm to be correct). This
 * server owns ZERO session state. The append-only CONTINUATION — the thing that
 * keeps a builder's prompt-cache prefix warm across a growing change set — is
 * passed IN and OUT as DATA: the client sends back the prior `StableContextResult`
 * as the `prior` tool input, and the tool returns the new one. The server holds
 * nothing between calls; two successive `tools/call`s are fully independent. So it
 * is a thin stateless tool surface over the library — the qualification recorded
 * in `CHANGELOG.md` / `ARCHITECTURE.md §9` — NOT the stateful long-running server
 * §9 rejected. See the `hayven-context-adoption-surfaces` design note.
 *
 * Transport. Hand-rolled, newline-delimited (NDJSON) JSON-RPC 2.0 over
 * stdin/stdout — NOT `@modelcontextprotocol/sdk`. This honours the repo's
 * anti-dependency discipline (ARCHITECTURE §9 / CLAUDE.md "Style discipline":
 * hand-rolled arg parsing, raw `bun:sqlite`, no frameworks); it is also exactly
 * the IPC framing the daemon already uses with `hayven-native` (one JSON object
 * per line). The handshake we implement is the minimal MCP set: `initialize`,
 * `notifications/initialized` (no-op), `tools/list`, `tools/call`. Anything else
 * returns a clean JSON-RPC "method not found".
 *
 * This module is split into a PURE dispatcher (`createContextMcpServer` →
 * `handle(request)`), which has no I/O and is what the test drives, and a thin
 * `runStdioLoop` that wires the dispatcher to stdin/stdout. The DB is opened once
 * (read-only) and reused across calls — that is a resource handle, not session
 * state; every tool call resolves against the same immutable read index.
 */
import {
  contextForChange,
  contextForSymbols,
  type StableContextOptions,
  type StableContextResult,
} from "../db/context_helper.ts";
import type { ChangeRegion, ContextPackOptions } from "../db/context_pack.ts";
import type { Db } from "../db/queries.ts";

/** The protocol version we advertise in the `initialize` result. MCP pins the
 *  wire contract by date; this is the revision the handshake below implements. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Server identity returned from `initialize` (the `serverInfo` block). */
const SERVER_INFO = { name: "hayven-context", version: "0.1.0" } as const;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire types (the minimal subset we read/write).
// ---------------------------------------------------------------------------

/** A JSON-RPC request or notification. A notification has no `id`. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** A JSON-RPC response (success or error). `null` means "no response" — the
 *  caller was a notification and JSON-RPC forbids replying to it. */
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: JsonRpcError };

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC error codes (the ones we emit). */
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

// ---------------------------------------------------------------------------
// Tool input schemas (advertised by `tools/list`, validated in `tools/call`).
// ---------------------------------------------------------------------------

/** A single changed region — mirrors {@link ChangeRegion} exactly. */
const CHANGE_REGION_SCHEMA = {
  type: "object",
  properties: {
    startLine: { type: "integer", description: "1-based inclusive first changed line." },
    endLine: { type: "integer", description: "1-based inclusive last changed line." },
  },
  required: ["startLine", "endLine"],
  additionalProperties: false,
} as const;

/** The optional pack-shaping knobs shared by both tools — the subset of
 *  {@link ContextPackOptions} that is a plain scalar (the function-valued
 *  `fenceLangFor` and the object-valued `prior` are handled separately). */
const PACK_OPT_PROPERTIES = {
  neighbors: {
    type: "boolean",
    description: "Include 1-hop callee/ref neighbors (default true).",
  },
  maxNeighbors: { type: "integer", description: "Max neighbor slices (default 10)." },
  maxHeaderLines: {
    type: "integer",
    description: "Max lines pulled into the module-scope header (default 120).",
  },
  maxRefSliceLines: {
    type: "integer",
    description: "Cap an included referenced-type slice to its first N lines (default 12).",
  },
  maxCallers: {
    type: "integer",
    description: "Opt-in incoming-caller hop: max callers to inline (default 0 = off).",
  },
  importedSymbols: {
    type: "boolean",
    description: "Opt-in cross-file imported non-node symbols (default false).",
  },
} as const;

/** The `prior` continuation input. Opaque to the client EXCEPT that it round-trips
 *  a prior tool result; we describe it loosely so the schema stays small but the
 *  intent (pass back the whole previous result) is clear. */
const PRIOR_SCHEMA = {
  type: "object",
  description:
    "The previous StableContextResult returned by either tool. Pass it back to " +
    "make this call APPEND-ONLY against it (the preserved prefix keeps a warm " +
    "prompt cache). The continuation lives entirely in this data — the server " +
    "holds no session state. Omit on the first call.",
} as const;

/** `tools/list` entries. Names are the locked plan's: `context_for_change` /
 *  `context_for_symbols`. */
const TOOLS = [
  {
    name: "context_for_change",
    description:
      "Minimal, line-exact context pack for editing REGIONS of a file: the file's " +
      "module header + each changed entity body + 1-hop callee/ref dependencies, " +
      "never worse than reading the whole file. Returns a StableContextResult " +
      "(text + contentKey + order + estTokens + stablePrefixBytes + " +
      "priorFullyPreserved + notes). Pass the prior result back as `prior` for an " +
      "append-only, cache-stable extension across a growing change set.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Repo-relative path of the file being changed." },
        regions: {
          type: "array",
          items: CHANGE_REGION_SCHEMA,
          description: "The changed line regions (1-based inclusive).",
        },
        prior: PRIOR_SCHEMA,
        ...PACK_OPT_PROPERTIES,
      },
      required: ["file", "regions"],
      additionalProperties: false,
    },
  },
  {
    name: "context_for_symbols",
    description:
      "Minimal, line-exact context pack for a set of SYMBOLS: each resolved " +
      "entity's body + its 1-hop callee/ref deps, deduped, with one shared module " +
      "skeleton per file. Returns a StableContextResult (same shape as " +
      "context_for_change). Pass the prior result back as `prior` for an " +
      "append-only, cache-stable extension across a growing symbol set.",
    inputSchema: {
      type: "object",
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Entity ids (or fuzzy symbol names) to pack.",
        },
        prior: PRIOR_SCHEMA,
        ...PACK_OPT_PROPERTIES,
      },
      required: ["symbols"],
      additionalProperties: false,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Argument coercion — read the JSON tool args into the helper's option shapes.
// ---------------------------------------------------------------------------

/** Read the scalar pack opts off the tool args, ignoring absent/ill-typed ones
 *  so the helper falls back to its own defaults. Plus the append-only `prior`
 *  continuation (passed straight through — it is opaque DATA the client owns). */
function packOptsFrom(args: Record<string, unknown>): StableContextOptions {
  const opts: StableContextOptions = {};
  if (typeof args["neighbors"] === "boolean") opts.neighbors = args["neighbors"];
  if (typeof args["maxNeighbors"] === "number") opts.maxNeighbors = args["maxNeighbors"];
  if (typeof args["maxHeaderLines"] === "number") opts.maxHeaderLines = args["maxHeaderLines"];
  if (typeof args["maxRefSliceLines"] === "number")
    opts.maxRefSliceLines = args["maxRefSliceLines"];
  if (typeof args["maxCallers"] === "number") opts.maxCallers = args["maxCallers"];
  if (typeof args["importedSymbols"] === "boolean")
    opts.importedSymbols = args["importedSymbols"];
  // The continuation: pass the whole prior result back as DATA. We trust its
  // shape — it is something WE returned to the client on a previous call — but
  // only forward it when it actually looks like a result (has an `order` array),
  // so a malformed `prior` degrades to a fresh (non-append) render, never a crash.
  const prior = args["prior"];
  if (isStableResultish(prior)) opts.prior = prior as StableContextResult;
  return opts;
}

/** A light duck-type for a round-tripped `StableContextResult`: the only field
 *  `renderAppendOnly` reads off the prior is `order` (an array of slice refs). */
function isStableResultish(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    Array.isArray((v as { order?: unknown }).order)
  );
}

/** Coerce the `regions` arg into validated {@link ChangeRegion}[]. Returns a
 *  string error message (for ERR_INVALID_PARAMS) when malformed. */
function readRegions(raw: unknown): ChangeRegion[] | string {
  if (!Array.isArray(raw)) return "`regions` must be an array of {startLine,endLine}.";
  const out: ChangeRegion[] = [];
  for (const r of raw) {
    if (
      typeof r !== "object" ||
      r === null ||
      typeof (r as ChangeRegion).startLine !== "number" ||
      typeof (r as ChangeRegion).endLine !== "number"
    ) {
      return "each region must be an object with numeric `startLine` and `endLine`.";
    }
    out.push({
      startLine: (r as ChangeRegion).startLine,
      endLine: (r as ChangeRegion).endLine,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP tool-call results.
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link StableContextResult} as an MCP `tools/call` result. We return the
 * result BOTH as readable text (the rendered pack — what an agent prompt embeds)
 * AND as `structuredContent` (the full typed object — what a programmatic builder
 * reads `order`/`stablePrefixBytes`/`priorFullyPreserved` off to thread the next
 * append-only call). This is the standard MCP shape for a tool that yields data.
 */
function toolResult(result: StableContextResult): unknown {
  return {
    content: [{ type: "text", text: result.text }],
    structuredContent: result,
  };
}

/** A clean, non-throwing MCP tool ERROR result (`isError: true` + a message),
 *  used when the helper returns `null` (nothing resolved). Per the MCP spec a
 *  tool-level failure is a normal result with `isError`, NOT a JSON-RPC error —
 *  the latter is reserved for protocol faults (bad params, unknown tool). */
function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------------------------------------------------------------------------
// The pure dispatcher.
// ---------------------------------------------------------------------------

/** What {@link runStdioLoop} needs from a built server: a pure request handler
 *  and a `close()` for the underlying DB handle. */
export interface ContextMcpServer {
  /** Handle one parsed JSON-RPC request. Returns the response, or `null` for a
   *  notification (no `id`) — JSON-RPC forbids replying to those. Never throws:
   *  every failure becomes a JSON-RPC error response (or, for tool faults, an
   *  `isError` tool result). */
  handle(request: JsonRpcRequest): JsonRpcResponse | null;
  /** Release the read DB handle. */
  close(): void;
}

/**
 * Build a stateless `hayven-context` MCP server over an already-open read DB and
 * its repoRoot. The DB is the only retained resource (a read handle, reused
 * across calls); there is NO per-session/per-client state — the append-only
 * continuation is carried by the client in each call's `prior` argument.
 */
export function createContextMcpServer(db: Db, repoRoot: string): ContextMcpServer {
  const ok = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  });
  const fail = (
    id: JsonRpcRequest["id"],
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  });

  const callTool = (id: JsonRpcRequest["id"], params: unknown): JsonRpcResponse => {
    if (typeof params !== "object" || params === null) {
      return fail(id, ERR_INVALID_PARAMS, "`tools/call` params must be an object.");
    }
    const { name, arguments: rawArgs } = params as {
      name?: unknown;
      arguments?: unknown;
    };
    const args: Record<string, unknown> =
      typeof rawArgs === "object" && rawArgs !== null
        ? (rawArgs as Record<string, unknown>)
        : {};

    if (name === "context_for_change") {
      const file = args["file"];
      if (typeof file !== "string" || file.length === 0) {
        return fail(id, ERR_INVALID_PARAMS, "`file` (string) is required.");
      }
      const regions = readRegions(args["regions"]);
      if (typeof regions === "string") return fail(id, ERR_INVALID_PARAMS, regions);
      const result = contextForChange(db, repoRoot, file, regions, packOptsFrom(args));
      if (!result) {
        return ok(
          id,
          toolError(
            `no context resolved for changes to \`${file}\` ` +
              "(no enclosing entity and no readable module frame).",
          ),
        );
      }
      return ok(id, toolResult(result));
    }

    if (name === "context_for_symbols") {
      const symbolsRaw = args["symbols"];
      if (
        !Array.isArray(symbolsRaw) ||
        symbolsRaw.some((s) => typeof s !== "string")
      ) {
        return fail(id, ERR_INVALID_PARAMS, "`symbols` must be an array of strings.");
      }
      const symbols = symbolsRaw as string[];
      if (symbols.length === 0) {
        return fail(id, ERR_INVALID_PARAMS, "`symbols` must be non-empty.");
      }
      const result = contextForSymbols(db, repoRoot, symbols, packOptsFrom(args));
      if (!result) {
        return ok(
          id,
          toolError(
            `no context resolved — none of [${symbols.join(", ")}] matched an indexed symbol.`,
          ),
        );
      }
      return ok(id, toolResult(result));
    }

    return fail(id, ERR_INVALID_PARAMS, `unknown tool: ${String(name)}`, {
      available: TOOLS.map((t) => t.name),
    });
  };

  const handle = (req: JsonRpcRequest): JsonRpcResponse | null => {
    // A notification has no `id` — handle its effect, never reply.
    const isNotification = req.id === undefined;

    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      if (isNotification) return null;
      return fail(req.id, ERR_INVALID_REQUEST, "not a JSON-RPC 2.0 request.");
    }

    switch (req.method) {
      case "initialize":
        // We ignore the client's requested protocolVersion and advertise ours;
        // a mismatch is the client's to reconcile. We declare the `tools`
        // capability only — no resources/prompts/sampling.
        return ok(req.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case "notifications/initialized":
      case "initialized":
        // Post-handshake ack from the client — a notification, no-op, no reply.
        return null;

      case "tools/list":
        return ok(req.id, { tools: TOOLS });

      case "tools/call":
        if (isNotification) return null; // a call MUST have an id; ignore if not.
        return callTool(req.id, req.params);

      case "ping":
        return ok(req.id, {});

      default:
        if (isNotification) return null;
        return fail(req.id, ERR_METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  };

  return {
    handle: (req) => {
      try {
        return handle(req);
      } catch (err) {
        // Last-resort guard: a bug in dispatch must surface as a clean JSON-RPC
        // error, never a torn stdout / crashed server.
        if (req.id === undefined) return null;
        return fail(req.id, ERR_INTERNAL, `internal error: ${(err as Error).message}`);
      }
    },
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// Stdio transport — newline-delimited JSON-RPC over stdin/stdout.
// ---------------------------------------------------------------------------

/**
 * Run the server over a newline-delimited (one JSON object per line) JSON-RPC
 * stream. Reads requests from `input`, writes responses to `write`. Each inbound
 * line is parsed independently; a parse error yields a JSON-RPC parse-error
 * response (id `null`, per spec). Returns when the input stream ends.
 *
 * Split out from the loop's I/O so the framing is testable without real fds:
 * the test drives {@link createContextMcpServer}'s `handle` directly; this
 * function exists for the real `hayven mcp` process.
 */
export async function runStdioLoop(
  server: ContextMcpServer,
  input: AsyncIterable<Uint8Array | string>,
  write: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  const emit = (resp: JsonRpcResponse | null): void => {
    if (resp !== null) write(JSON.stringify(resp) + "\n");
  };
  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      emit({ jsonrpc: "2.0", id: null, error: { code: ERR_PARSE, message: "parse error" } });
      return;
    }
    emit(server.handle(req));
  };

  for await (const chunk of input) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      processLine(line);
    }
  }
  // Flush a trailing line with no terminating newline.
  if (buf.trim().length > 0) processLine(buf);
}
