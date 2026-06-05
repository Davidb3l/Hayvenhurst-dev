import { describe, expect, test } from "bun:test";
import {
  edgesFromProfile,
  keepFrame,
  frameId,
  moduleFromUrl,
  type CpuProfile,
} from "../src/profile-tree.ts";

/**
 * A synthetic `Profiler.stop` CPU profile (a call tree as a flat node list).
 * This is the load-bearing fixture — live Chrome is probabilistic/unavailable,
 * so the decode is verified deterministically here.
 *
 * Tree (ids, hitCount in []), all under the same project URL:
 *
 *   1 (root)              [0]
 *   ├─ 2 main             [1]   app.js
 *   │   └─ 3 login        [2]   auth.js
 *   │       └─ 4 getUser  [5]   db.js
 *   └─ 5 (garbage collector) [3]   (synthetic, dropped)
 *
 * Inclusive hit counts:
 *   getUser(4) = 5
 *   login(3)   = 2 + 5 = 7
 *   main(2)    = 1 + 7 = 8
 *
 * Expected kept edges (caller -> callee, count = callee inclusive):
 *   app:main    -> auth:login   = 7
 *   auth:login  -> db:getUser   = 5
 * (root -> main is dropped because (root) is synthetic; GC node is dropped.)
 */
function fixture(): CpuProfile {
  return {
    startTime: 1000,
    endTime: 9000,
    nodes: [
      { id: 1, callFrame: { functionName: "(root)", url: "" }, hitCount: 0, children: [2, 5] },
      { id: 2, callFrame: { functionName: "main", url: "https://app.local/app.js", lineNumber: 1 }, hitCount: 1, children: [3] },
      { id: 3, callFrame: { functionName: "login", url: "https://app.local/auth.js", lineNumber: 4 }, hitCount: 2, children: [4] },
      { id: 4, callFrame: { functionName: "getUser", url: "https://app.local/db.js", lineNumber: 9 }, hitCount: 5, children: [] },
      { id: 5, callFrame: { functionName: "(garbage collector)", url: "" }, hitCount: 3, children: [] },
    ],
  };
}

describe("edgesFromProfile (synthetic CDP CPU profile -> edges)", () => {
  test("derives the expected caller->callee pairs with inclusive counts", () => {
    const edges = edgesFromProfile(fixture());
    const byKey = new Map(edges.map((e) => [`${e.src}->${e.dst}`, e.count]));

    expect(byKey.get("app:main->auth:login")).toBe(7);
    expect(byKey.get("auth:login->db:getUser")).toBe(5);
    // Synthetic (root)/GC frames never appear.
    expect(edges.some((e) => e.src.includes("root") || e.dst.includes("root"))).toBe(false);
    expect(edges.some((e) => e.src.includes("garbage") || e.dst.includes("garbage"))).toBe(false);
    expect(edges).toHaveLength(2);
  });

  test("climbs to the nearest kept ancestor when a frame is filtered out", () => {
    // login's caller is a chrome-extension frame, which is dropped; the edge
    // should connect main -> getUser's caller chain through the kept frames.
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
        { id: 2, callFrame: { functionName: "main", url: "https://app.local/app.js" }, hitCount: 0, children: [3] },
        // dropped: extension frame between project frames
        { id: 3, callFrame: { functionName: "inject", url: "chrome-extension://abc/x.js" }, hitCount: 0, children: [4] },
        { id: 4, callFrame: { functionName: "work", url: "https://app.local/work.js" }, hitCount: 4, children: [] },
      ],
    };
    const edges = edgesFromProfile(profile);
    const byKey = new Map(edges.map((e) => [`${e.src}->${e.dst}`, e.count]));
    // The extension frame is skipped; main is the nearest kept ancestor of work.
    expect(byKey.get("app:main->work:work")).toBe(4);
    expect(edges.some((e) => e.src.includes("inject") || e.dst.includes("inject"))).toBe(false);
  });

  test("urlPrefixes scopes which frames are kept", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
        { id: 2, callFrame: { functionName: "a", url: "https://app.local/a.js" }, hitCount: 0, children: [3] },
        { id: 3, callFrame: { functionName: "vendor", url: "https://cdn.other/v.js" }, hitCount: 0, children: [4] },
        { id: 4, callFrame: { functionName: "b", url: "https://app.local/b.js" }, hitCount: 9, children: [] },
      ],
    };
    const edges = edgesFromProfile(profile, ["https://app.local/"]);
    const byKey = new Map(edges.map((e) => [`${e.src}->${e.dst}`, e.count]));
    // Only app.local frames kept; vendor dropped, a is nearest ancestor of b.
    expect(byKey.get("a:a->b:b")).toBe(9);
    expect(edges.every((e) => !e.src.includes("vendor") && !e.dst.includes("vendor"))).toBe(true);
  });

  test("zero-count edges are dropped", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
        { id: 2, callFrame: { functionName: "a", url: "https://app.local/a.js" }, hitCount: 0, children: [3] },
        { id: 3, callFrame: { functionName: "neverSampled", url: "https://app.local/c.js" }, hitCount: 0, children: [] },
      ],
    };
    expect(edgesFromProfile(profile)).toHaveLength(0);
  });

  test("counts are clamped to uint16", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: "(root)", url: "" }, children: [2] },
        { id: 2, callFrame: { functionName: "a", url: "https://app.local/a.js" }, hitCount: 0, children: [3] },
        { id: 3, callFrame: { functionName: "hot", url: "https://app.local/c.js" }, hitCount: 99999, children: [] },
      ],
    };
    expect(edgesFromProfile(profile)[0]!.count).toBe(65535);
  });

  test("a cyclic node list does not hang", () => {
    const profile: CpuProfile = {
      nodes: [
        { id: 1, callFrame: { functionName: "a", url: "https://app.local/a.js" }, hitCount: 1, children: [2] },
        { id: 2, callFrame: { functionName: "b", url: "https://app.local/b.js" }, hitCount: 1, children: [1] },
      ],
    };
    // Should terminate and produce edges without infinite recursion.
    const edges = edgesFromProfile(profile);
    expect(Array.isArray(edges)).toBe(true);
  });
});

describe("frame id / module convention", () => {
  test("frameId is <module>:<functionName> with module = url basename sans ext", () => {
    expect(frameId({ functionName: "login", url: "https://app.local/src/auth.js?v=2" })).toBe("auth:login");
    expect(frameId({ functionName: "User.get", url: "https://app.local/db.ts" })).toBe("db:User.get");
  });

  test("anonymous frames get a line-disambiguated id", () => {
    expect(frameId({ functionName: "", url: "https://app.local/a.js", lineNumber: 12 })).toBe("a:(anonymous):12");
  });

  test("moduleFromUrl strips query, hash, path, and extension", () => {
    expect(moduleFromUrl("https://x/y/z/file.min.js?a=1#h")).toBe("file.min");
    expect(moduleFromUrl("")).toBe("");
  });

  test("keepFrame drops synthetic and internal frames by default", () => {
    expect(keepFrame({ functionName: "(root)", url: "" }, [])).toBe(false);
    expect(keepFrame({ functionName: "(idle)", url: "" }, [])).toBe(false);
    expect(keepFrame({ functionName: "x", url: "chrome-extension://a/b.js" }, [])).toBe(false);
    expect(keepFrame({ functionName: "x", url: "node:internal/fs" }, [])).toBe(false);
    expect(keepFrame({ functionName: "x", url: "https://app/a.js" }, [])).toBe(true);
  });
});
