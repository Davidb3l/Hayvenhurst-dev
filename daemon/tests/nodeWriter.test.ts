import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderNodeMarkdown, writeNodeMarkdown } from "../src/graph/nodeWriter.ts";
import { parseNodeMarkdown } from "../src/graph/nodeReader.ts";
import type { GraphNode } from "../src/graph/types.ts";

function sampleNode(): GraphNode {
  return {
    id: "auth/loginHandler",
    name: "loginHandler",
    qualified_name: "loginHandler",
    kind: "function",
    language: "typescript",
    file: "src/auth/login.ts",
    range: [42, 87],
    ast_hash: "7a8f",
    last_seen: Date.parse("2026-05-15T14:32:00Z"),
    logical_clock: 47,
  };
}

describe("renderNodeMarkdown", () => {
  it("includes frontmatter and the summary placeholder by default", () => {
    const md = renderNodeMarkdown(sampleNode());
    expect(md).toContain("---");
    expect(md).toContain("id: auth/loginHandler");
    expect(md).toContain("# `loginHandler`");
    expect(md).toContain("Summary pending");
    expect(md).toContain("## Observed callers (from traces)");
    expect(md).toContain("## Observed callees (from traces)");
  });

  it("renders edge lists when neighbors provided", () => {
    const md = renderNodeMarkdown(sampleNode(), {
      callers: [{ src: "api_router", dst: "auth/loginHandler", kind: "static_call", weight: 47, last_seen: 0 }],
      callees: [{ src: "auth/loginHandler", dst: "validate_session", kind: "static_call", weight: 47, last_seen: 0 }],
    });
    expect(md).toContain("- [[api_router]] (47 invocations)");
    expect(md).toContain("- [[validate_session]] (47 invocations)");
  });
});

describe("writeNodeMarkdown -> parseNodeMarkdown", () => {
  it("round-trips frontmatter fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-nodes-"));
    const node = sampleNode();
    const path = writeNodeMarkdown(dir, node);
    expect(existsSync(path)).toBe(true);
    const parsed = parseNodeMarkdown(readFileSync(path, "utf8"));
    expect(parsed.node.id).toBe(node.id);
    expect(parsed.node.kind).toBe("function");
    expect(parsed.node.range).toEqual([42, 87]);
    expect(parsed.node.ast_hash).toBe("7a8f");
    expect(parsed.node.logical_clock).toBe(47);
  });
});
