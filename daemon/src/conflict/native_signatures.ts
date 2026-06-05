/**
 * REAL tree-sitter signature extraction for the contract-diff oracle.
 *
 * This is the production replacement for the old regex/line-based signature
 * parser that used to live in {@link ../conflict/contract_diff_oracle.ts}. It
 * shells out to `hayven-native parse --signatures` (the ADDITIVE opt-in native
 * output — see `native/src/parse/signature.rs`) and consumes the emitted
 * `signature` NDJSON records, which carry the entity's contract derived from the
 * actual AST: parameter arity, per-parameter types, return type, and visibility.
 *
 * Two consumption shapes:
 *   1. {@link buildSignatureIndex} — parse a whole repo ROOT once and index every
 *      definition's signature by `file::qualifiedName` (and a coarse
 *      `file::name`). The oracle/daemon look an entity up by identity.
 *   2. {@link extractSignatureFromBody} — parse ONE entity body string by writing
 *      it to a temp file of the right extension and parsing that single file.
 *      Used by the ceiling bench's true before/after diff and as the oracle's
 *      per-entity fallback when an entity is not in a pre-built index.
 *
 * Determinism + safety: the native binary is REQUIRED for these paths; callers
 * that cannot guarantee it (the daemon's live claim route) keep the heuristic as
 * the fallback oracle. This module throws / returns null rather than guessing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Signature, SignatureExtractor, EntityResolver, EdgeIndex } from "./contract_diff_oracle.ts";

/** Map a language id to a source file extension the native walker recognizes. */
const EXT_BY_LANG: Record<string, string> = {
  typescript: "ts",
  ts: "ts",
  tsx: "tsx",
  javascript: "js",
  js: "js",
  jsx: "js",
  python: "py",
  py: "py",
  rust: "rs",
  rs: "rs",
  go: "go",
  golang: "go",
};

/** A native `signature` NDJSON record (see `native/src/proto.rs`). */
interface NativeSignatureRecord {
  type: "signature";
  file: string;
  name: string;
  qualified_name: string;
  kind: string;
  language: string;
  arity: number;
  params: string[];
  return_type: string | null;
  visibility: "public" | "private" | "unknown";
}

/** Convert a native record into the oracle's {@link Signature} shape. */
function toSignature(r: NativeSignatureRecord): Signature {
  return {
    name: r.name,
    arity: r.arity,
    params: r.params,
    returnType: r.return_type,
    // The native layer already maps to public|private|unknown.
    visibility: r.visibility,
    // A native `signature` record is only emitted for a real callable/typed
    // definition, so its presence IS the "has a callable contract" signal.
    hasCallable: true,
  };
}

/** Parse every `signature` record out of a native parse stdout blob. */
function parseSignatureRecords(stdout: string): NativeSignatureRecord[] {
  const out: NativeSignatureRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    if (!line.includes('"type":"signature"')) continue;
    try {
      const rec = JSON.parse(line) as NativeSignatureRecord;
      if (rec.type === "signature") out.push(rec);
    } catch {
      // Skip a malformed line — the stream is best-effort per file.
    }
  }
  return out;
}

/**
 * A repo-wide signature index: parse `root` once with `--signatures` and key the
 * results so a caller can resolve an entity's real contract by identity.
 *
 * Lookup keys, most-specific first:
 *   - `file::qualifiedName` (exact)
 *   - `file::name`          (bare name within a file)
 *   - `qualifiedName`       (cross-file, last resort — may collide)
 */
export interface SignatureIndex {
  /** Resolve by file + qualified name (preferred), falling back to bare name. */
  get(file: string, qualifiedName: string, name: string): Signature | null;
  /** Total signatures indexed (diagnostics). */
  readonly size: number;
}

export function buildSignatureIndex(opts: {
  binary: string;
  root: string;
  languages?: string[];
  timeoutMs?: number;
}): SignatureIndex {
  const args = ["parse", "--root", opts.root, "--signatures"];
  if (opts.languages && opts.languages.length > 0) {
    args.push("--langs", opts.languages.join(","));
  }
  const res = spawnSync(opts.binary, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 120_000,
  });
  const stdout = res.stdout ?? "";
  const records = parseSignatureRecords(stdout);

  const byFileQual = new Map<string, Signature>();
  const byFileName = new Map<string, Signature>();
  const byQual = new Map<string, Signature>();
  for (const r of records) {
    const sig = toSignature(r);
    byFileQual.set(`${r.file}::${r.qualified_name}`, sig);
    // First-writer-wins for the coarser keys (a file may shadow a bare name).
    const fn = `${r.file}::${r.name}`;
    if (!byFileName.has(fn)) byFileName.set(fn, sig);
    if (!byQual.has(r.qualified_name)) byQual.set(r.qualified_name, sig);
  }

  return {
    size: byFileQual.size,
    get(file: string, qualifiedName: string, name: string): Signature | null {
      return (
        byFileQual.get(`${file}::${qualifiedName}`) ??
        byFileName.get(`${file}::${name}`) ??
        byQual.get(qualifiedName) ??
        byQual.get(name) ??
        null
      );
    },
  };
}

/**
 * Extract the real signature of a SINGLE entity body by parsing it as a
 * standalone file. Returns the signature whose `name` matches `name` (preferred)
 * or the first callable signature found, or `null` when the body exposes no
 * callable/typed contract (so the caller can treat it as "no public surface").
 *
 * This is the true-AST path the ceiling bench uses for before/after diffs: it
 * writes `body` to a temp `*.{ext}` file and runs `parse --signatures` on it, so
 * the diff is over genuine tree-sitter signatures, not a regex of the first line.
 */
export function extractSignatureFromBody(opts: {
  binary: string;
  body: string;
  language: string;
  name: string;
  kind?: string;
  timeoutMs?: number;
}): Signature | null {
  const ext = EXT_BY_LANG[opts.language.toLowerCase()];
  if (!ext) return null;

  // A method/impl body sliced out of its enclosing class is not a valid file on
  // its own (a bare `pub fn f(&self)` is fine in Rust; a TS `method(): void {}`
  // is NOT a valid top-level statement). Wrap the body in a minimal enclosing
  // scope per language so tree-sitter parses the signature cleanly. We only need
  // the SIGNATURE to parse, not the whole file to be semantically valid.
  const wrapped = wrapBodyForParse(opts.body, opts.language.toLowerCase(), opts.kind);

  const dir = mkdtempSync(join(tmpdir(), "hayven-sig-"));
  const file = join(dir, `entity.${ext}`);
  try {
    writeFileSync(file, wrapped, "utf8");
    const res = spawnSync(
      opts.binary,
      ["parse", "--root", dir, "--signatures"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs ?? 30_000 },
    );
    const records = parseSignatureRecords(res.stdout ?? "");
    if (records.length === 0) return null;
    const exact = records.find((r) => r.name === opts.name);
    return toSignature(exact ?? records[0]!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A {@link SignatureExtractor} backed by `hayven-native parse --signatures`.
 *
 * Resolution order for an entity:
 *   1. A pre-built repo {@link SignatureIndex} lookup by `file::qualifiedName`
 *      (cheap — one parse for the whole repo, reused across every claim). This
 *      is the production path the daemon uses.
 *   2. A per-body parse ({@link extractSignatureFromBody}) when the entity is not
 *      in the index but a body is available (the ceiling bench's before/after
 *      diff, or an entity outside the indexed root).
 *
 * Returns `null` only when neither resolves a real callable contract — the
 * oracle then treats the entity conservatively (possibly-public).
 */
export function nativeSignatureExtractor(opts: {
  binary: string;
  index?: SignatureIndex | undefined;
  /** When true, fall back to a per-body temp-file parse on an index miss.
   * Default true. Set false in the hot daemon path to avoid a spawn per claim. */
  perBodyFallback?: boolean;
  timeoutMs?: number;
}): SignatureExtractor {
  const perBody = opts.perBodyFallback ?? true;
  return {
    signatureOf(entity): Signature | null {
      if (opts.index && entity.file) {
        const qn = entity.qualifiedName ?? entity.name;
        const hit = opts.index.get(entity.file, qn, entity.name);
        if (hit) return hit;
      }
      if (perBody && entity.body && entity.body.trim().length > 0) {
        return extractSignatureFromBody({
          binary: opts.binary,
          body: entity.body,
          language: entity.language,
          name: entity.name,
          ...(entity.kind ? { kind: entity.kind } : {}),
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
      }
      return null;
    },
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * Daemon wiring — build the contract-diff oracle's real-data dependencies from
 * the live `Db` (NodeRow + outgoing/incoming edges) and the repo source tree.
 * ════════════════════════════════════════════════════════════════════════════ */

/** The subset of `Db` the contract-diff wiring needs (avoids a hard Db import
 * here; the daemon passes its real `Db`, tests pass a stub). */
export interface DbLike {
  getNode(id: string): {
    id: string;
    name: string;
    qualified_name: string;
    kind: string;
    language: string | null;
    file: string | null;
    range_start: number;
    range_end: number;
  } | null;
  outgoing(id: string): Array<{ dst: string }>;
  incoming(id: string): Array<{ src: string }>;
}

/** Slice a 1-based inclusive line range out of a file's text. */
function sliceLines(text: string, start: number, end: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, start - 1), end).join("\n");
}

/** The file stem path used as the "module" key for the same-module rule
 * (mirrors the bench's `fileModule`: dir + basename-without-extension). */
function fileModule(file: string): string {
  const slash = file.lastIndexOf("/");
  const base = file.slice(slash + 1);
  return file.slice(0, slash + 1) + base.replace(/\.\w+$/, "");
}

/**
 * Build an {@link EntityResolver} from the live `Db` + repo source. Resolves an
 * entity id to its name/kind/language/file/module and the REAL body (sliced from
 * `<repoRoot>/<file>` over the node's line range — so the per-body signature
 * fallback has real source). Bodies are cached per file.
 */
export function dbEntityResolver(db: DbLike, repoRoot: string): EntityResolver {
  const fileCache = new Map<string, string | null>();
  const read = (rel: string): string | null => {
    if (fileCache.has(rel)) return fileCache.get(rel)!;
    let txt: string | null = null;
    try {
      const abs = join(repoRoot, rel);
      if (existsSync(abs)) txt = readFileSync(abs, "utf8");
    } catch {
      txt = null;
    }
    fileCache.set(rel, txt);
    return txt;
  };
  return {
    resolve(id) {
      const n = db.getNode(id);
      if (!n || !n.file) return null;
      const src = read(n.file);
      const body = src === null ? "" : sliceLines(src, n.range_start, n.range_end);
      return {
        id: n.id,
        name: n.name,
        kind: n.kind,
        language: n.language ?? "unknown",
        file: n.file,
        module: fileModule(n.file),
        body,
      };
    },
  };
}

/**
 * Build an {@link EdgeIndex} from the live `Db`: a dependency from `fromId` to
 * `toId` exists iff a real static edge connects them in EITHER direction of the
 * daemon's `outgoing ∪ incoming` union — the exact same neighbor relation the
 * Layer A adjacency lookup uses. This is the REAL static_call/import edge index
 * the native parser materialized, not the reconstructed token set.
 */
export function dbEdgeIndex(db: DbLike): EdgeIndex {
  return {
    dependsOn(fromId, toId) {
      for (const e of db.outgoing(fromId)) if (e.dst === toId) return true;
      for (const e of db.incoming(fromId)) if (e.src === toId) return true;
      return false;
    },
  };
}

/**
 * Wrap an entity body so it parses as a top-level definition. A
 * function/free-function body usually parses as-is; a class method does not, so
 * we re-home it under a trivial class/impl. Best-effort: if the body already
 * begins with its own enclosing keyword we leave it alone.
 */
function wrapBodyForParse(body: string, lang: string, kind?: string): string {
  const isMethod = kind === "method";
  const trimmed = body.trimStart();

  if (lang === "python" || lang === "py") {
    // A method body is indented under a class; wrap it so the `def` is a method.
    if (isMethod || trimmed.startsWith("def ") === false) {
      // Indent the whole body one level and place under a stub class.
      const indented = body
        .split("\n")
        .map((l) => (l.length > 0 ? "    " + l : l))
        .join("\n");
      return `class __Wrap__:\n${indented}\n`;
    }
    return body;
  }

  if (lang === "rust" || lang === "rs") {
    // A free `fn` parses at top level; a method (`fn f(&self)`) needs an impl.
    if (isMethod || trimmed.includes("self")) {
      return `impl __Wrap__ {\n${body}\n}\n`;
    }
    return body;
  }

  if (lang === "go" || lang === "golang") {
    // Go funcs/methods both parse at the top level of a file (a method carries
    // its own receiver). Prepend a package clause so the file is well-formed.
    return `package wrap\n${body}\n`;
  }

  // ts / tsx / js / jsx: a `function` declaration parses at top level; a class
  // method does not, so wrap it in a stub class.
  if (isMethod || /^\s*(public|private|protected|static|async|get|set|#|\*)?\s*[A-Za-z_$#]/.test(trimmed) && !/^\s*(export\s+)?(async\s+)?function\b/.test(trimmed) && !/^\s*(export\s+)?(abstract\s+)?class\b/.test(trimmed) && !/^\s*(export\s+)?interface\b/.test(trimmed) && !/^\s*(export\s+)?type\b/.test(trimmed) && !/^\s*(export\s+)?const\b/.test(trimmed)) {
    return `class __Wrap__ {\n${body}\n}\n`;
  }
  return body;
}
