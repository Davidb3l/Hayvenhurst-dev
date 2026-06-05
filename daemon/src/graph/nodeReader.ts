/**
 * Parses markdown node files written by {@link writeNodeMarkdown} back into
 * `GraphNode` objects. Source of truth: the markdown files themselves.
 *
 * Frontmatter is parsed by a small hand-rolled reader ({@link parseFrontmatter}).
 * The writer (`nodeWriter.renderFrontmatter`) emits a closed, simple subset —
 * one `key: value` per line, JSON-quoted strings for anything non-trivial, and a
 * single `range: [n, n]` flow array — so a full YAML dependency is unwarranted
 * (ARCHITECTURE.md §9 / PRD §2.4 "original where it matters").
 */
import { readFileSync } from "node:fs";

import type { GraphNode, NodeKind } from "./types.ts";

const KNOWN_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "module",
  "constant",
  "type",
  "trait",
  "enum",
  "other",
]);

function asKind(value: unknown): NodeKind {
  if (typeof value === "string" && (KNOWN_KINDS as Set<string>).has(value)) {
    return value as NodeKind;
  }
  return "other";
}

function asRange(value: unknown): [number, number] {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [value[0], value[1]];
  }
  return [0, 0];
}

function stripBlakePrefix(s: string): string {
  return s.startsWith("blake3:") ? s.slice("blake3:".length) : s;
}

export interface ParsedNodeFile {
  node: GraphNode;
  /** The free-form summary body (everything between the heading and the "Observed callers" section). */
  body: string;
}

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Parse a leading `--- … ---` frontmatter block (CRLF- and BOM-tolerant) into
 * `{ data, content }` — the ~30-line replacement for `gray-matter`. Handles
 * exactly what `nodeWriter.renderFrontmatter` emits: one `key: value` per line,
 * bare or JSON-quoted string values, bare numbers, and a `[a, b]` flow array.
 * No frontmatter block → `{ data: {}, content: <whole text> }`.
 */
function parseFrontmatter(text: string): ParsedFrontmatter {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!block) return { data: {}, content: src };
  const data: Record<string, unknown> = {};
  for (const raw of block[1]!.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const sep = raw.indexOf(":");
    if (sep <= 0) continue; // no key, or a line with no `:` separator
    const key = raw.slice(0, sep).trim();
    if (key.length === 0) continue;
    data[key] = parseScalar(raw.slice(sep + 1).trim());
  }
  return { data, content: src.slice(block[0].length) };
}

/** Parse one frontmatter scalar: JSON string, `[…]` flow array, number, or bare string. */
function parseScalar(value: string): unknown {
  if (value.length === 0) return "";
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value; // malformed quote — keep the raw text rather than throwing
    }
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner.length === 0 ? [] : inner.split(",").map((p) => parseScalar(p.trim()));
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

export function parseNodeMarkdown(text: string): ParsedNodeFile {
  const parsed = parseFrontmatter(text);
  const data = parsed.data;

  const id = typeof data["id"] === "string" ? data["id"] : "";
  const name = typeof data["name"] === "string" ? data["name"] : id.split("/").pop() ?? id;
  const qualified_name = typeof data["qualified_name"] === "string" ? data["qualified_name"] : name;
  const language = typeof data["language"] === "string" ? data["language"] : "unknown";
  const file = typeof data["file"] === "string" ? data["file"] : "";
  const astHash = typeof data["ast_hash"] === "string" ? stripBlakePrefix(data["ast_hash"]) : "";
  const lastSeenStr = typeof data["last_seen"] === "string" ? data["last_seen"] : undefined;
  const lastSeenDate = lastSeenStr ? new Date(lastSeenStr).getTime() : Date.now();
  const logical_clock = typeof data["logical_clock"] === "number" ? data["logical_clock"] : 0;
  const last_modified_by = typeof data["last_modified_by"] === "string" ? data["last_modified_by"] : undefined;

  // Body: text up to the first "## Observed" heading.
  const body = extractSummaryBody(parsed.content);

  const node: GraphNode = {
    id,
    name,
    qualified_name,
    kind: asKind(data["kind"]),
    language,
    file,
    range: asRange(data["range"]),
    ast_hash: astHash,
    summary: body,
    last_seen: Number.isFinite(lastSeenDate) ? lastSeenDate : Date.now(),
    logical_clock,
    ...(last_modified_by ? { last_modified_by } : {}),
  };
  return { node, body };
}

function extractSummaryBody(content: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let pastHeading = false;
  for (const line of lines) {
    if (/^##\s+Observed\s+/i.test(line)) break;
    if (!pastHeading) {
      // Skip the leading "# `name`" heading line.
      if (/^#\s+/.test(line)) {
        pastHeading = true;
        continue;
      }
      // Skip blank lines before the heading too.
      if (line.trim().length === 0) continue;
      pastHeading = true;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

export function readNodeFile(path: string): ParsedNodeFile {
  return parseNodeMarkdown(readFileSync(path, "utf8"));
}
