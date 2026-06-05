import { describe, expect, it } from "bun:test";

import {
  assertVersionCompatible,
  NdjsonLineReader,
  parseLine,
  ProtocolError,
  ProtocolSkewError,
  VersionSkewError,
} from "../src/native/protocol.ts";
import { EXPECTED_NATIVE_MAJOR, EXPECTED_NATIVE_PROTOCOL } from "../src/version.ts";

describe("parseLine", () => {
  it("parses a start record", () => {
    const rec = parseLine(JSON.stringify({ type: "start", files_total: 10, version: "0.0.1" }));
    expect(rec).toEqual({ type: "start", files_total: 10, version: "0.0.1" });
  });

  it("parses a node record", () => {
    const json = JSON.stringify({
      type: "node",
      file: "src/x.ts",
      name: "foo",
      qualified_name: "foo",
      kind: "function",
      language: "typescript",
      range: [1, 10],
      ast_hash: "deadbeef",
    });
    const rec = parseLine(json);
    expect(rec.type).toBe("node");
    if (rec.type === "node") {
      expect(rec.range).toEqual([1, 10]);
      expect(rec.kind).toBe("function");
    }
  });

  it("parses an edge record", () => {
    const rec = parseLine(
      JSON.stringify({
        type: "edge",
        src_file: "src/x.ts",
        src_name: "foo",
        dst_name: "bar",
        kind: "static_call",
      }),
    );
    expect(rec.type).toBe("edge");
  });

  it("parses an import edge with import_aliases (aliased named imports)", () => {
    const rec = parseLine(
      JSON.stringify({
        type: "edge",
        src_file: "src/g/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["ca"],
        import_aliases: [{ local: "ca", imported: "checkAccess" }],
      }),
    );
    expect(rec.type).toBe("edge");
    if (rec.type === "edge") {
      expect(rec.import_aliases).toEqual([{ local: "ca", imported: "checkAccess" }]);
    }
  });

  it("omits import_aliases for non-aliased imports (additive/byte-compatible)", () => {
    const rec = parseLine(
      JSON.stringify({
        type: "edge",
        src_file: "src/g/photo.ts",
        src_name: "photo",
        dst_name: "../lib/access.ts",
        kind: "import",
        local: ["foo"],
      }),
    );
    expect(rec.type).toBe("edge");
    if (rec.type === "edge") {
      expect(rec.import_aliases).toBeUndefined();
    }
  });

  it("parses progress, warn, and done", () => {
    expect(parseLine(JSON.stringify({ type: "progress", files_done: 5 })).type).toBe("progress");
    expect(parseLine(JSON.stringify({ type: "warn", message: "x" })).type).toBe("warn");
    expect(
      parseLine(
        JSON.stringify({ type: "done", files_done: 5, nodes: 10, edges: 3, elapsed_ms: 42 }),
      ).type,
    ).toBe("done");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseLine("{not json")).toThrow(ProtocolError);
  });

  it("throws on unknown record type", () => {
    expect(() => parseLine(JSON.stringify({ type: "mystery" }))).toThrow(ProtocolError);
  });

  it("throws on bad field types", () => {
    expect(() =>
      parseLine(JSON.stringify({ type: "start", files_total: "ten", version: "1" })),
    ).toThrow(ProtocolError);
  });

  it("parses a version record (§16.4 handshake)", () => {
    const rec = parseLine(
      JSON.stringify({ type: "version", major: 0, minor: 2, patch: 0, protocol: 2 }),
    );
    expect(rec.type).toBe("version");
    if (rec.type === "version") {
      expect(rec.major).toBe(0);
      expect(rec.protocol).toBe(2);
    }
  });

  it("parses watcher records: ready, change, overflow, heartbeat, fatal (§16.2)", () => {
    expect(parseLine(JSON.stringify({ type: "ready", platform: "darwin", backend: "fsevents" })).type).toBe(
      "ready",
    );
    expect(
      parseLine(
        JSON.stringify({ type: "change", file: "src/x.ts", kind: "modify", ts_ms: 1 }),
      ).type,
    ).toBe("change");
    expect(
      parseLine(JSON.stringify({ type: "overflow", dropped: 12, since_ms: 999 })).type,
    ).toBe("overflow");
    expect(parseLine(JSON.stringify({ type: "heartbeat", ts_ms: 1 })).type).toBe("heartbeat");
    expect(parseLine(JSON.stringify({ type: "fatal", message: "x" })).type).toBe("fatal");
  });

  it("rejects unknown change.kind", () => {
    expect(() =>
      parseLine(JSON.stringify({ type: "change", file: "a", kind: "bogus", ts_ms: 1 })),
    ).toThrow(ProtocolError);
  });
});

describe("assertVersionCompatible", () => {
  it("accepts a matched major", () => {
    expect(() =>
      assertVersionCompatible({
        type: "version",
        major: EXPECTED_NATIVE_MAJOR,
        minor: 99,
        patch: 99,
        protocol: 2,
      }),
    ).not.toThrow();
  });

  it("throws VersionSkewError on mismatched major", () => {
    expect(() =>
      assertVersionCompatible({
        type: "version",
        major: EXPECTED_NATIVE_MAJOR + 1,
        minor: 0,
        patch: 0,
        protocol: 2,
      }),
    ).toThrow(VersionSkewError);
  });

  // BL-8: protocol can drift within a major — a binary advertising protocol:1
  // with a matched major must be refused, since record shapes may have changed.
  it("throws ProtocolSkewError on mismatched protocol (matched major)", () => {
    expect(() =>
      assertVersionCompatible({
        type: "version",
        major: EXPECTED_NATIVE_MAJOR,
        minor: 0,
        patch: 0,
        protocol: 1,
      }),
    ).toThrow(ProtocolSkewError);
  });

  it("accepts the expected protocol", () => {
    expect(() =>
      assertVersionCompatible({
        type: "version",
        major: EXPECTED_NATIVE_MAJOR,
        minor: 0,
        patch: 0,
        protocol: EXPECTED_NATIVE_PROTOCOL,
      }),
    ).not.toThrow();
  });
});

describe("NdjsonLineReader", () => {
  it("buffers chunks until newline-delimited", () => {
    const r = new NdjsonLineReader();
    const enc = new TextEncoder();
    r.push(enc.encode("hello\nworld"));
    expect(r.drain()).toEqual(["hello"]);
    r.push(enc.encode("\n"));
    expect(r.drain()).toEqual(["world"]);
    r.push(enc.encode("again"));
    expect(r.drain()).toEqual([]);
    r.flush();
    expect(r.drain()).toEqual(["again"]);
  });

  it("strips CR for windows line endings", () => {
    const r = new NdjsonLineReader();
    r.push(new TextEncoder().encode("a\r\nb\r\n"));
    expect(r.drain()).toEqual(["a", "b"]);
  });
});
