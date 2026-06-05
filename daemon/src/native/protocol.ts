/**
 * NDJSON protocol spoken by `hayven-native` over its stdout.
 *
 * Record types (per spec coordinated with the Rust agent):
 *
 *   {"type":"version","major":N,"minor":N,"patch":N,"protocol":2}
 *   {"type":"start","files_total":N,"version":"x.y.z"}
 *   {"type":"node","file":"...","name":"...","kind":"function",
 *    "qualified_name":"...","language":"typescript",
 *    "range":[startLine,endLine],"ast_hash":"hex"}
 *   {"type":"edge","src_file":"...","src_name":"...","dst_name":"...",
 *    "kind":"static_call","line":N,"col":N}   (line/col OPTIONAL, call edges only)
 *   {"type":"progress","files_done":N}
 *   {"type":"warn","file":"...","message":"..."}
 *   {"type":"done","files_done":N,"nodes":N,"edges":N,"elapsed_ms":N}
 *
 * Watcher-specific records (§16.2): version, ready, change, overflow,
 * heartbeat, warn, fatal.
 */
import type { EdgeKind, NodeKind } from "../graph/types.ts";
import { EXPECTED_NATIVE_MAJOR, EXPECTED_NATIVE_PROTOCOL } from "../version.ts";
import type { Logger } from "../util/log.ts";

export interface VersionRecord {
  type: "version";
  major: number;
  minor: number;
  patch: number;
  protocol: number;
}

export interface StartRecord {
  type: "start";
  files_total: number;
  version: string;
}

export interface ReadyRecord {
  type: "ready";
  platform: "darwin" | "linux" | "windows" | string;
  backend: "fsevents" | "inotify" | "rdcw" | string;
}

export type ChangeKind = "create" | "modify" | "delete" | "rename";

export interface ChangeRecord {
  type: "change";
  file: string;
  kind: ChangeKind;
  ts_ms: number;
  /** Set only when `kind === "rename"`. */
  from?: string;
}

export interface OverflowRecord {
  type: "overflow";
  dropped: number;
  since_ms: number;
}

export interface HeartbeatRecord {
  type: "heartbeat";
  ts_ms: number;
}

export interface FatalRecord {
  type: "fatal";
  message: string;
}

export interface NodeRecord {
  type: "node";
  file: string;
  name: string;
  qualified_name: string;
  kind: NodeKind;
  language: string;
  range: [number, number];
  ast_hash: string;
}

export interface EdgeRecord {
  type: "edge";
  src_file: string;
  src_name: string;
  dst_name: string;
  kind: EdgeKind;
  /** Member-call receiver (`recv.method()` → "recv"). Optional; present only on
   * member-access `static_call` edges. Drives Tier-2 member-call resolution. */
  receiver?: string;
  /** Full member-call receiver chain root→immediate-object
   * (`api.client.search()` → ["api","client"]). Optional; present only on
   * MULTI-segment member-access `static_call` edges (single-segment receivers
   * carry only `receiver`). Drives Tier-2 chain resolution: bind the ROOT
   * (`receiver_chain[0]`) to an import, walk the rest to the member. Additive —
   * a payload without it still resolves via `receiver`. */
  receiver_chain?: string[];
  /** Local binding name(s) an `import` introduces (`import {api} from "x"` →
   * ["api"]). Optional; present only on `import` edges. Drives Tier-2. */
  local?: string[];
  /** Aliased named bindings on an `import` edge: `{local, imported}` pairs where
   * the local alias differs from the originally-exported name
   * (`import { checkAccess as ca }` → [{local:"ca",imported:"checkAccess"}]).
   * Optional; present only when an import introduces genuine aliases. Lets
   * resolution map a call to the local alias back to the real exported symbol.
   * Additive — absent on older payloads and the common (non-aliased) case. */
  import_aliases?: ImportAlias[];
  /** 1-based LINE of a call site on a `static_call` edge. OPTIONAL, ADDITIVE
   * (cross-lane contract — a native agent emits this; absent on import edges and
   * older binaries). One edge record == one call occurrence, so (line,col) is
   * that occurrence's position; the site's FILE is the edge's `src_file`. */
  line?: number;
  /** 1-based COLUMN of a call site on a `static_call` edge. OPTIONAL, ADDITIVE —
   * see {@link EdgeRecord.line}. */
  col?: number;
}

/** A single aliased import binding (`import { a as b }` → {local:"b",imported:"a"}). */
export interface ImportAlias {
  local: string;
  imported: string;
}

export interface ProgressRecord {
  type: "progress";
  files_done: number;
}

export interface WarnRecord {
  type: "warn";
  file?: string;
  message: string;
}

export interface DoneRecord {
  type: "done";
  files_done: number;
  nodes: number;
  edges: number;
  elapsed_ms: number;
}

export type NativeRecord =
  | VersionRecord
  | StartRecord
  | NodeRecord
  | EdgeRecord
  | ProgressRecord
  | WarnRecord
  | DoneRecord
  | ReadyRecord
  | ChangeRecord
  | OverflowRecord
  | HeartbeatRecord
  | FatalRecord;

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(message: string, public readonly line: string) {
    super(message);
  }
}

/** Thrown when the native binary's major version disagrees with our own. */
export class VersionSkewError extends Error {
  override readonly name = "VersionSkewError";
  constructor(
    public readonly expectedMajor: number,
    public readonly nativeMajor: number,
    public readonly nativeFull: string,
  ) {
    super(
      `hayven-native version skew: daemon expects ${expectedMajor}.x, ` +
        `native reports ${nativeFull} — refusing to run. ` +
        `Fix: run \`hayven doctor\` or reinstall the matched pair.`,
    );
  }
}

/**
 * Thrown when the native binary advertises an NDJSON protocol version the
 * daemon wasn't built against (BL-8). Distinct from {@link VersionSkewError}
 * because protocol can drift WITHIN a major: `protocol:1, major:0` would pass
 * the major check yet still ship incompatible record shapes.
 */
export class ProtocolSkewError extends Error {
  override readonly name = "ProtocolSkewError";
  constructor(
    public readonly expectedProtocol: number,
    public readonly nativeProtocol: number,
    public readonly nativeFull: string,
  ) {
    super(
      `hayven-native protocol skew: daemon expects protocol ${expectedProtocol}, ` +
        `native reports protocol ${nativeProtocol} (${nativeFull}) — refusing to run. ` +
        `Fix: run \`hayven doctor\` or reinstall the matched pair.`,
    );
  }
}

/**
 * Verify a {@link VersionRecord} matches our expected major AND protocol.
 * Throws {@link VersionSkewError} on a major mismatch and
 * {@link ProtocolSkewError} on a protocol mismatch; logs at debug otherwise.
 *
 * BL-8: we REFUSE on a protocol mismatch (rather than warn-and-continue),
 * consistent with §16.4's "refuse mismatched majors" stance — the NDJSON
 * record shapes can change within a major, and silently trusting a binary that
 * advertises a different `protocol` than we were built against (e.g.
 * `protocol:1` while we expect 2) risks misparsing every record.
 */
export function assertVersionCompatible(rec: VersionRecord, logger?: Logger): void {
  const full = `${rec.major}.${rec.minor}.${rec.patch}`;
  if (rec.major !== EXPECTED_NATIVE_MAJOR) {
    throw new VersionSkewError(EXPECTED_NATIVE_MAJOR, rec.major, full);
  }
  if (rec.protocol !== EXPECTED_NATIVE_PROTOCOL) {
    throw new ProtocolSkewError(EXPECTED_NATIVE_PROTOCOL, rec.protocol, full);
  }
  logger?.debug("native handshake", {
    major: rec.major,
    minor: rec.minor,
    patch: rec.patch,
    protocol: rec.protocol,
  });
}

/** Validate a parsed JSON value as a {@link NativeRecord}. */
export function validateRecord(value: unknown, line: string): NativeRecord {
  if (typeof value !== "object" || value === null) {
    throw new ProtocolError("not an object", line);
  }
  const obj = value as Record<string, unknown>;
  const type = obj["type"];
  switch (type) {
    case "version":
      return {
        type: "version",
        major: asNumber(obj["major"], "version.major", line),
        minor: asNumber(obj["minor"], "version.minor", line),
        patch: asNumber(obj["patch"], "version.patch", line),
        protocol: asNumber(obj["protocol"], "version.protocol", line),
      };
    case "start":
      return {
        type: "start",
        files_total: asNumber(obj["files_total"], "start.files_total", line),
        version: asString(obj["version"], "start.version", line),
      };
    case "node":
      return {
        type: "node",
        file: asString(obj["file"], "node.file", line),
        name: asString(obj["name"], "node.name", line),
        qualified_name: asString(obj["qualified_name"], "node.qualified_name", line),
        kind: asString(obj["kind"], "node.kind", line) as NodeKind,
        language: asString(obj["language"], "node.language", line),
        range: asRange(obj["range"], "node.range", line),
        ast_hash: asString(obj["ast_hash"], "node.ast_hash", line),
      };
    case "edge": {
      // `receiver`/`local` are OPTIONAL (native emits them only on member-call /
      // import edges; older binaries omit them). Carry them THROUGH so Tier-2
      // member-call resolution (graph/ingest.ts::resolveEdges) can fire — they
      // were previously dropped here, which silently disabled member resolution.
      const receiver = typeof obj["receiver"] === "string" ? (obj["receiver"] as string) : undefined;
      // `receiver_chain` is the additive multi-segment receiver path (newer
      // binaries only; absent on single-segment receivers and older payloads).
      const chainRaw = obj["receiver_chain"];
      const receiverChain =
        Array.isArray(chainRaw) && chainRaw.every((x): x is string => typeof x === "string")
          ? (chainRaw as string[])
          : undefined;
      const localRaw = obj["local"];
      const local = Array.isArray(localRaw)
        ? localRaw.filter((x): x is string => typeof x === "string")
        : undefined;
      // `import_aliases` is the additive {local,imported} pair list for aliased
      // named imports (newer binaries only; absent on the non-aliased common
      // case and older payloads). Keep only well-formed pairs.
      const aliasRaw = obj["import_aliases"];
      const importAliases = Array.isArray(aliasRaw)
        ? aliasRaw.filter(
            (x): x is ImportAlias =>
              typeof x === "object" &&
              x !== null &&
              typeof (x as { local?: unknown }).local === "string" &&
              typeof (x as { imported?: unknown }).imported === "string",
          )
        : undefined;
      // `line`/`col` are the additive 1-based call-site coordinates on a
      // `static_call` edge (a native agent emits them; absent on import edges
      // and older binaries). Include ONLY when a finite number — mirroring the
      // optional-field handling above so older payloads stay byte-identical.
      const lineRaw = obj["line"];
      const callLine =
        typeof lineRaw === "number" && Number.isFinite(lineRaw) ? lineRaw : undefined;
      const colRaw = obj["col"];
      const callCol =
        typeof colRaw === "number" && Number.isFinite(colRaw) ? colRaw : undefined;
      return {
        type: "edge",
        src_file: asString(obj["src_file"], "edge.src_file", line),
        src_name: asString(obj["src_name"], "edge.src_name", line),
        dst_name: asString(obj["dst_name"], "edge.dst_name", line),
        kind: asString(obj["kind"], "edge.kind", line) as EdgeKind,
        ...(receiver !== undefined ? { receiver } : {}),
        ...(receiverChain !== undefined && receiverChain.length > 0
          ? { receiver_chain: receiverChain }
          : {}),
        ...(local !== undefined ? { local } : {}),
        ...(importAliases !== undefined && importAliases.length > 0
          ? { import_aliases: importAliases }
          : {}),
        ...(callLine !== undefined ? { line: callLine } : {}),
        ...(callCol !== undefined ? { col: callCol } : {}),
      };
    }
    case "progress":
      return { type: "progress", files_done: asNumber(obj["files_done"], "progress.files_done", line) };
    case "warn":
      return {
        type: "warn",
        ...(typeof obj["file"] === "string" ? { file: obj["file"] } : {}),
        message: asString(obj["message"], "warn.message", line),
      };
    case "done":
      return {
        type: "done",
        files_done: asNumber(obj["files_done"], "done.files_done", line),
        nodes: asNumber(obj["nodes"], "done.nodes", line),
        edges: asNumber(obj["edges"], "done.edges", line),
        elapsed_ms: asNumber(obj["elapsed_ms"], "done.elapsed_ms", line),
      };
    case "ready":
      return {
        type: "ready",
        platform: asString(obj["platform"], "ready.platform", line),
        backend: asString(obj["backend"], "ready.backend", line),
      };
    case "change": {
      const kind = asString(obj["kind"], "change.kind", line);
      if (kind !== "create" && kind !== "modify" && kind !== "delete" && kind !== "rename") {
        throw new ProtocolError(`change.kind must be create|modify|delete|rename, got ${kind}`, line);
      }
      return {
        type: "change",
        file: asString(obj["file"], "change.file", line),
        kind,
        ts_ms: asNumber(obj["ts_ms"], "change.ts_ms", line),
        ...(typeof obj["from"] === "string" ? { from: obj["from"] } : {}),
      };
    }
    case "overflow":
      return {
        type: "overflow",
        dropped: asNumber(obj["dropped"], "overflow.dropped", line),
        since_ms: asNumber(obj["since_ms"], "overflow.since_ms", line),
      };
    case "heartbeat":
      return {
        type: "heartbeat",
        ts_ms: asNumber(obj["ts_ms"], "heartbeat.ts_ms", line),
      };
    case "fatal":
      return {
        type: "fatal",
        message: asString(obj["message"], "fatal.message", line),
      };
    default:
      throw new ProtocolError(`unknown record type: ${String(type)}`, line);
  }
}

/** Parse a single NDJSON line. */
export function parseLine(line: string): NativeRecord {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new ProtocolError("empty line", line);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new ProtocolError(`invalid JSON: ${(err as Error).message}`, line);
  }
  return validateRecord(parsed, line);
}

/**
 * A small streaming line buffer. Feed it raw `Uint8Array` chunks via
 * {@link push}; iterate the records via the async iterator returned by
 * {@link records}. Designed to work with `Bun.spawn().stdout` (a
 * `ReadableStream<Uint8Array>`).
 */
export class NdjsonLineReader {
  private buf = "";
  private readonly decoder = new TextDecoder("utf-8");
  private readonly lines: string[] = [];

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      // Strip trailing CR for Windows line endings.
      this.lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }

  /** Drain any remaining text as a final line. Call after EOF. */
  flush(): void {
    if (this.buf.length > 0) {
      this.lines.push(this.buf);
      this.buf = "";
    }
  }

  drain(): string[] {
    const out = this.lines.splice(0, this.lines.length);
    return out;
  }
}

/* ---------- small validators ---------- */
function asString(value: unknown, label: string, line: string): string {
  if (typeof value !== "string") throw new ProtocolError(`${label} must be a string`, line);
  return value;
}
function asNumber(value: unknown, label: string, line: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${label} must be a finite number`, line);
  }
  return value;
}
function asRange(value: unknown, label: string, line: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number") {
    throw new ProtocolError(`${label} must be [number, number]`, line);
  }
  return [value[0], value[1]];
}
