import { describe, expect, test } from "bun:test";

import { makeResolver, moduleIdOf, moduleOf, urlToPath } from "../src/names.ts";

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

describe("moduleIdOf (path-qualified module hints)", () => {
  test("under the root: repo-relative path, extension stripped", () => {
    expect(moduleIdOf("/repo/src/utils/body.ts", "/repo")).toBe("src/utils/body");
    expect(moduleIdOf("/repo/src/utils/body.test.ts", "/repo/")).toBe("src/utils/body.test");
    expect(moduleIdOf("/repo/src/jsx/dom/index.test.tsx", "/repo")).toBe("src/jsx/dom/index.test");
  });

  test("outside the root (or no root): falls back to the basename", () => {
    expect(moduleIdOf("/elsewhere/x.ts", "/repo")).toBe("x");
    expect(moduleIdOf("/repo/src/a.ts", undefined)).toBe("a");
    expect(moduleIdOf("/repo/src/a.ts", "")).toBe("a");
  });

  test("dotfile basenames keep their name (no empty stem)", () => {
    expect(moduleIdOf("/repo/src/.env", "/repo")).toBe("src/.env");
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

  test("moduleRoot emits path-qualified ids for in-repo frames, basename otherwise", () => {
    const r = makeResolver({ projectPaths: ["/proj/"], moduleRoot: "/proj" });
    expect(r.nameOf({ functionName: "parseBody", url: "file:///proj/src/utils/body.ts" })).toBe(
      "src/utils/body:parseBody",
    );
    // Default (no moduleRoot) stays the bare basename — backward compatible.
    const r2 = makeResolver({ projectPaths: ["/proj/"] });
    expect(r2.nameOf({ functionName: "parseBody", url: "file:///proj/src/utils/body.ts" })).toBe(
      "body:parseBody",
    );
  });
});
