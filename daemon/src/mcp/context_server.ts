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
import { resolveWithinRepo } from "../db/context_pack.ts";
import type { ChangeRegion, ContextPackOptions } from "../db/context_pack.ts";
import type { Db } from "../db/queries.ts";
import { isAbsolute } from "node:path";

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

/** Largest `startLine`/`endLine` we accept. No source file on earth has 10M
 *  lines; anything above it is a client sentinel (a "whole file" marker like
 *  `Number.MAX_SAFE_INTEGER`) or a typo, and MUST be refused at the wire rather
 *  than turned into work. See {@link readRegions}. */
const MAX_REGION_LINE = 10_000_000;

/** Max regions per call. A change set is a handful of hunks; thousands is a
 *  client bug or an attempt to multiply per-region work inside the packer. */
const MAX_REGIONS = 1024;

/** Max symbols per `context_for_symbols` call. Each costs a node lookup plus an
 *  FTS5 fuzzy resolve; see the bound note at the call site. */
const MAX_SYMBOLS = 1024;

/** A single changed region — mirrors {@link ChangeRegion} exactly. The bounds
 *  are advertised, not just enforced, so a client can see them before it sends
 *  a sentinel. {@link readRegions} is the enforcement. */
const CHANGE_REGION_SCHEMA = {
  type: "object",
  properties: {
    startLine: {
      type: "integer",
      minimum: 1,
      maximum: MAX_REGION_LINE,
      description: "1-based inclusive first changed line.",
    },
    endLine: {
      type: "integer",
      minimum: 1,
      maximum: MAX_REGION_LINE,
      description:
        "1-based inclusive last changed line; must be >= startLine. There is NO " +
        '"whole file" sentinel — pass the file\'s real last line.',
    },
  },
  required: ["startLine", "endLine"],
  additionalProperties: false,
} as const;

/**
 * The optional pack-shaping knobs shared by both tools — the subset of
 * {@link ContextPackOptions} that is a plain scalar (the function-valued
 * `fenceLangFor` and the object-valued `prior` are handled separately).
 *
 * `maxCallers` and `importedSymbols` are NOT here even though
 * {@link ContextPackOptions} carries them. Both tools route through
 * `buildContextPackForSymbols` (the multi-root path), and only the SINGLE-symbol
 * `buildContextPack` implements the caller hop and the imported-symbol pass — so
 * advertising them here promised behavior the server silently could not deliver
 * (verified: `importedSymbols: true` returned byte-identical output to `false`).
 * See {@link UNSUPPORTED_PACK_OPTS}, which refuses them loudly instead.
 */
const PACK_OPT_PROPERTIES = {
  neighbors: {
    type: "boolean",
    description: "Include 1-hop callee/ref neighbors (default true).",
  },
  maxNeighbors: {
    type: "integer",
    minimum: 0,
    description: "Max neighbor slices (default 10; 0 = none).",
  },
  maxHeaderLines: {
    type: "integer",
    minimum: 0,
    description: "Max lines pulled into the module-scope header (default 120).",
  },
  maxRefSliceLines: {
    type: "integer",
    minimum: 1,
    description: "Cap an included referenced-type slice to its first N lines (default 12).",
  },
} as const;

/** Knobs a client may plausibly send (they exist on the library's option type
 *  and were once advertised here) that this surface CANNOT honour. These get a
 *  NAMED reason; every other unknown key is refused generically by
 *  {@link rejectUnknownArgs}. A silently ignored knob is a client shipping a
 *  prompt it believes contains context it does not. */
const UNSUPPORTED_PACK_OPTS: Record<string, string> = {
  maxCallers:
    "the incoming-caller hop is implemented only on the single-symbol pack path, " +
    "which neither MCP tool uses",
  importedSymbols:
    "cross-file imported non-node symbols are implemented only on the " +
    "single-symbol pack path, which neither MCP tool uses",
};

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

/**
 * Enforce the `additionalProperties: false` that both tool schemas ALREADY
 * declare. Returns an error message for the first unknown key, or `null`.
 *
 * Without this, "refuse loudly, never accept-and-ignore" was a two-item
 * denylist rather than a policy: `maxCallers` hard-errored while `maxCalers`
 * (one-char typo) and `maxNeighbours` (British spelling) were swallowed with
 * byte-identical output and no signal. Erroring here is the server agreeing
 * with the schema it publishes. Derived FROM the schema so the two cannot drift.
 */
function rejectUnknownArgs(toolName: string, args: Record<string, unknown>): string | null {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) return null;
  const allowed = new Set<string>(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args)) {
    if (allowed.has(key)) continue;
    // A knob we deliberately dropped gets its specific reason instead of the
    // generic "unknown"; the client asked for something real that we cannot do.
    const named = UNSUPPORTED_PACK_OPTS[key];
    if (named) return `\`${key}\` is not supported here: ${named}.`;
    return `unknown argument \`${key}\` for ${toolName} (schema is additionalProperties: false).`;
  }
  return null;
}

/** Upper bound for the integer pack knobs. They only ever CAP work, so a huge
 *  value is not itself a wedge — but `maxHeaderLines: 1e18` is a client bug, and
 *  a knob that silently means something other than what was asked is the class
 *  of defect this surface is being hardened against. */
const MAX_PACK_OPT = 100_000;

/**
 * Read one integer pack knob. Returns `undefined` when absent (the helper's own
 * default applies) or a string error message when present-but-invalid.
 *
 * Rejects rather than ignores: `typeof === "number"` used to be the whole check,
 * so `maxRefSliceLines: -1000000` sailed through and produced slices with
 * `endLine < startLine` inside the `order` continuation the client threads back,
 * plus a negative `lineCount`. (The packer now floors these too — this is the
 * wire-level half, and it is the half that TELLS the client.)
 */
function readIntOpt(
  args: Record<string, unknown>,
  key: string,
  min: number,
): number | undefined | string {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Number.isInteger(v)) return `\`${key}\` must be an integer.`;
  const n = v as number;
  if (n < min) return `\`${key}\` must be >= ${min} (got ${n}).`;
  if (n > MAX_PACK_OPT) return `\`${key}\` must be <= ${MAX_PACK_OPT} (got ${n}).`;
  return n;
}

/** Read the scalar pack opts off the tool args. Returns a string error message
 *  (for ERR_INVALID_PARAMS) when a knob is present but invalid or unsupported.
 *  Plus the append-only `prior` continuation (passed straight through — it is
 *  opaque DATA the client owns). */
function packOptsFrom(args: Record<string, unknown>): StableContextOptions | string {
  const opts: StableContextOptions = {};
  if (args["neighbors"] !== undefined) {
    if (typeof args["neighbors"] !== "boolean") return "`neighbors` must be a boolean.";
    opts.neighbors = args["neighbors"];
  }
  for (const [key, min] of [
    ["maxNeighbors", 0],
    ["maxHeaderLines", 0],
    // 0 would yield an inverted slice range (`start .. start-1`); 1 is the floor.
    ["maxRefSliceLines", 1],
  ] as const) {
    const got = readIntOpt(args, key, min);
    if (typeof got === "string") return got;
    if (got !== undefined) opts[key] = got;
  }
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

/**
 * Coerce the `regions` arg into validated {@link ChangeRegion}[]. Returns a
 * string error message (for ERR_INVALID_PARAMS) when malformed.
 *
 * BOUNDS — this used to check only `typeof === "number"`, with no magnitude
 * limit and no ordering rule. The packer's gap-fill then walked the whole
 * `[startLine..endLine]` range: a single `endLine: 2e10` against a 10-line file
 * measured 197 SECONDS, and `Number.MAX_SAFE_INTEGER` (a plausible "the whole
 * file" sentinel from a client) extrapolates to years. The stdio server is
 * synchronous and single-process, so that is not a slow call — it is a
 * PERMANENTLY WEDGED server: no further tool calls, DB handle held, one core
 * pinned, no error and no log line. Reject rather than clamp, so a client
 * sending a sentinel learns it was wrong instead of silently getting a
 * different file's worth of context than it asked for.
 *
 * The packer ALSO clamps regions to the file's real line count (see
 * `buildContextPackForChange`); that is the intrinsic bound protecting every
 * other caller (CLI, daemon route, proxy). This is the wire-level one.
 */
function readRegions(raw: unknown): ChangeRegion[] | string {
  if (!Array.isArray(raw)) return "`regions` must be an array of {startLine,endLine}.";
  if (raw.length > MAX_REGIONS) {
    return `too many regions (${raw.length} > ${MAX_REGIONS}).`;
  }
  const out: ChangeRegion[] = [];
  for (const r of raw) {
    if (typeof r !== "object" || r === null) {
      return "each region must be an object with numeric `startLine` and `endLine`.";
    }
    const { startLine, endLine } = r as ChangeRegion;
    // `Number.isInteger` rejects non-numbers, NaN, ±Infinity and fractions in
    // one predicate — all of which produce a nonsense or non-terminating range.
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      return "each region must be an object with integer `startLine` and `endLine`.";
    }
    if (startLine < 1 || endLine < 1) {
      return "region lines are 1-based; `startLine` and `endLine` must be >= 1.";
    }
    if (endLine < startLine) {
      return "each region must have `endLine` >= `startLine`.";
    }
    if (endLine > MAX_REGION_LINE) {
      return `region \`endLine\` exceeds the ${MAX_REGION_LINE}-line limit (got ${endLine}).`;
    }
    out.push({ startLine, endLine });
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
      const unknown = rejectUnknownArgs(name, args);
      if (unknown) return fail(id, ERR_INVALID_PARAMS, unknown);
      const file = args["file"];
      if (typeof file !== "string" || file.length === 0) {
        return fail(id, ERR_INVALID_PARAMS, "`file` (string) is required.");
      }
      // SECURITY — `file` is fully client-controlled and flows into a
      // `readFileSync`. An MCP host (or a prompt injection riding inside an
      // indexed source file, which is the same thing once an agent relays it)
      // could otherwise ask for `/etc/passwd`, `~/.aws/credentials`, `.env` or
      // `~/.ssh/id_rsa` and get the contents back inside a model prompt. The
      // packer enforces containment too (`resolveWithinRepo` in the file
      // reader); refusing HERE is what turns a silent empty result into a
      // visible protocol error, and what rejects an absolute path outright —
      // this tool's contract is a REPO-RELATIVE path.
      if (isAbsolute(file)) {
        return fail(id, ERR_INVALID_PARAMS, "`file` must be repo-relative, not absolute.");
      }
      if (resolveWithinRepo(repoRoot, file) === null) {
        return fail(id, ERR_INVALID_PARAMS, "`file` resolves outside the repository.");
      }
      const regions = readRegions(args["regions"]);
      if (typeof regions === "string") return fail(id, ERR_INVALID_PARAMS, regions);
      const opts = packOptsFrom(args);
      if (typeof opts === "string") return fail(id, ERR_INVALID_PARAMS, opts);
      const result = contextForChange(db, repoRoot, file, regions, opts);
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
      const unknown = rejectUnknownArgs(name, args);
      if (unknown) return fail(id, ERR_INVALID_PARAMS, unknown);
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
      // BOUND — same class as `regions`' MAX_REGIONS. Every element costs a
      // `getNode` plus an FTS5 fuzzy lookup, so an unbounded array is a
      // linear-cost wedge of the synchronous stdio server; one 64 MB request
      // line holds millions of short strings. A pack is a handful of symbols.
      if (symbols.length > MAX_SYMBOLS) {
        return fail(
          id,
          ERR_INVALID_PARAMS,
          `too many symbols (${symbols.length} > ${MAX_SYMBOLS}).`,
        );
      }
      const opts = packOptsFrom(args);
      if (typeof opts === "string") return fail(id, ERR_INVALID_PARAMS, opts);
      const result = contextForSymbols(db, repoRoot, symbols, opts);
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
 * Max characters we will hold for ONE not-yet-terminated line. Generous against
 * the largest legitimate request — a `prior` continuation round-trips a whole
 * rendered pack — while still bounded: without a cap, a client that opens a
 * connection and never sends a newline grows the buffer until the process is
 * OOM-killed. */
export const MAX_PENDING_LINE_CHARS = 64 * 1024 * 1024;

/**
 * Max characters in ONE response line.
 *
 * The input side was capped while the OUTPUT side was not, which is the wrong
 * way round for an amplifier: a 156-BYTE `context_for_change` request naming a
 * 32 MiB in-repo file produced a 67.1 MB response (430,000x), and a 100 MiB
 * file reached `RangeError: Out of memory` on the real stdio path — inside
 * `JSON.stringify`, i.e. before a single byte could be written or logged. The
 * packer's {@link MAX_PACK_FILE_BYTES} bound makes that hard to reach now; this
 * is the belt to that braces, and it turns an OOM crash into an error a client
 * can read. */
export const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

/**
 * Run the server over a newline-delimited (one JSON object per line) JSON-RPC
 * stream. Reads requests from `input`, writes responses to `write`. Each inbound
 * line is parsed independently; a parse error yields a JSON-RPC parse-error
 * response (id `null`, per spec). Returns when the input stream ends.
 *
 * A line that exceeds {@link MAX_PENDING_LINE_CHARS} is refused with a JSON-RPC
 * invalid-request error and then SKIPPED to the next newline — the framing has
 * already been violated, so the only safe resynchronisation point is the next
 * line boundary. Dropping it loudly beats buffering it until the OOM killer
 * takes the whole server down mid-session.
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
  /** True while we are discarding the tail of an over-long line. */
  let skipping = false;
  const emit = (resp: JsonRpcResponse | null): void => {
    if (resp === null) return;
    let line: string;
    try {
      line = JSON.stringify(resp);
    } catch (err) {
      // `JSON.stringify` is where a too-large response actually dies (a
      // RangeError, thrown before anything reaches stdout). Answer the client
      // instead of taking the server down mid-session.
      write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: (resp as { id: string | number | null }).id,
          error: {
            code: ERR_INTERNAL,
            message: `response could not be serialized: ${(err as Error).message}`,
          },
        }) + "\n",
      );
      return;
    }
    if (line.length > MAX_RESPONSE_CHARS) {
      write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: (resp as { id: string | number | null }).id,
          error: {
            code: ERR_INTERNAL,
            message:
              `response of ${line.length} chars exceeds the ${MAX_RESPONSE_CHARS}-char ` +
              "limit — narrow the request (fewer regions/symbols, or a smaller file)",
          },
        }) + "\n",
      );
      return;
    }
    write(line + "\n");
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

  const tooLong = (): void => {
    emit({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: ERR_INVALID_REQUEST,
        message: `line exceeds ${MAX_PENDING_LINE_CHARS} chars — discarded`,
      },
    });
  };

  for await (const chunk of input) {
    // Decode BEFORE the skip branch so a multi-byte character split across the
    // chunk boundary is still stitched by the streaming decoder — dropping the
    // chunk undecoded would corrupt the first character of the NEXT line.
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    if (skipping) {
      // Still inside the over-long line: throw characters away until a newline
      // gives us a clean frame boundary again.
      const nl = text.indexOf("\n");
      if (nl < 0) continue;
      skipping = false;
      buf = text.slice(nl + 1);
    } else {
      buf += text;
    }
    // Drain complete lines, refusing any SINGLE line longer than the cap. The
    // length test lives inside this loop, not after it, so the cap is absolute:
    // an over-long line whose terminating newline arrives in the same chunk as
    // the overflow is refused too, rather than being parsed because the buffer
    // happened to be drained before the check.
    for (;;) {
      const nl = buf.indexOf("\n");
      if ((nl < 0 ? buf.length : nl) > MAX_PENDING_LINE_CHARS) {
        tooLong();
        if (nl < 0) {
          // No boundary yet — drop what we hold and skip to the next newline.
          buf = "";
          skipping = true;
          break;
        }
        buf = buf.slice(nl + 1); // drop the whole over-long line, keep the rest
        continue;
      }
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      processLine(line);
    }
  }
  // Flush a trailing line with no terminating newline (never the discarded tail
  // of an over-long one).
  if (!skipping && buf.trim().length > 0) processLine(buf);
}
