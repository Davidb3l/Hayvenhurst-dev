import { describe, expect, test } from "bun:test";

import { makeResolver, moduleOf, urlToPath } from "../src/names.ts";

describe("urlToPath / moduleOf", () => {
  test("decodes file:// urls to filesystem paths", () => {
    expect(urlToPath("file:///proj/src/auth.ts")).toBe("/proj/src/auth.ts");
    expect(urlToPath("file:///proj/a%20b/x.ts")).toBe("/proj/a b/x.ts");
    expect(urlToPath("/already/a/path.ts")).toBe("/already/a/path.ts");
    expect(urlToPath("")).toBe("");
  });

  test("module is the basename without extension", () => {
    expect(moduleOf("/proj/src/auth.ts")).toBe("auth");
    expect(moduleOf("/proj/index.js")).toBe("index");
    expect(moduleOf("/proj/noext")).toBe("noext");
    expect(moduleOf("")).toBe("");
  });
});

describe("makeResolver (entity-id convention + scoping)", () => {
  test("emits <module>:<functionName>; V8 qualifies methods as Class.method", () => {
    const r = makeResolver({ projectPaths: ["/proj/"] });
    expect(r.nameOf({ functionName: "login", url: "file:///proj/auth.ts" })).toBe("auth:login");
    expect(r.nameOf({ functionName: "Session.login", url: "file:///proj/auth.ts" })).toBe(
      "auth:Session.login",
    );
  });

  test("drops V8 pseudo-frames and anonymous frames", () => {
    const r = makeResolver({ projectPaths: ["/proj/"] });
    expect(r.nameOf({ functionName: "(root)", url: "" })).toBeNull();
    expect(r.nameOf({ functionName: "(program)", url: "" })).toBeNull();
    expect(r.nameOf({ functionName: "(garbage collector)", url: "" })).toBeNull();
    expect(r.nameOf({ functionName: "", url: "file:///proj/a.ts" })).toBeNull();
  });

  test("drops node_modules / node: / bun: internals by default", () => {
    const r = makeResolver();
    expect(r.nameOf({ functionName: "readFile", url: "node:fs" })).toBeNull();
    expect(r.nameOf({ functionName: "x", url: "bun:jsc" })).toBeNull();
    expect(
      r.nameOf({ functionName: "dep", url: "file:///proj/node_modules/lib/index.js" }),
    ).toBeNull();
  });

  test("includeInternal keeps internal frames", () => {
    const r = makeResolver({ includeInternal: true });
    expect(r.nameOf({ functionName: "readFile", url: "node:fs" })).toBe("fs:readFile");
  });

  test("projectPaths restricts to in-scope frames (path OR module-id prefix)", () => {
    const r = makeResolver({ projectPaths: ["/proj/src/"] });
    expect(r.nameOf({ functionName: "f", url: "file:///proj/src/a.ts" })).toBe("a:f");
    expect(r.nameOf({ functionName: "g", url: "file:///other/b.ts" })).toBeNull();
  });

  test("never records the collector's own frames", () => {
    const r = makeResolver({ includeInternal: true });
    expect(
      r.nameOf({ functionName: "harvest", url: "file:///repo/trace/bun/src/tracer.ts" }),
    ).toBeNull();
  });
});
