// Tests for runtime-trace name → graph-entity-id resolution
// (daemon/src/graph/traceResolve.ts + Db.resolvedTraceEdges).
//
// The trace collector records call edges as RUNTIME names; this proves they
// resolve back to indexed entity ids conservatively (unambiguous-only), against
// a small fixture graph that includes a deliberately-duplicated bare name to
// exercise the ambiguity guard. The last block is end-to-end-ish: it inserts
// observations via the REAL ingest path (the trace route validator + Db) and
// asserts the resolved-edges query returns the expected entity ids.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { buildApp } from "../src/daemon/server.ts";
import { createLogger } from "../src/util/log.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import { makeTestCrdtState } from "./_helpers.ts";
import {
  TraceNameResolver,
  buildTraceResolver,
  normalizeRuntimeName,
  type IndexedNode,
} from "../src/graph/traceResolve.ts";
import type { GraphNode } from "../src/graph/types.ts";

/** A fixture node from an `id` + identity fields. */
function node(
  id: string,
  name: string,
  qualifiedName: string,
): GraphNode {
  return {
    id,
    name,
    qualified_name: qualifiedName,
    kind: "function",
    language: "python",
    file: `${id}.py`,
    range: [1, 2],
    ast_hash: "deadbeef",
    last_seen: 1,
    logical_clock: 1,
  };
}

/**
 * The fixture graph used across the resolver tests:
 *   - auth/login/loginHandler   [name loginHandler,   qn loginHandler]
 *   - auth/session/Session.refresh [name refresh,      qn Session.refresh]  (a method)
 *   - a/dup + b/dup             [name dup,            qn …]  (ambiguous bare name)
 */
const FIXTURE: IndexedNode[] = [
  node("auth/login/loginHandler", "loginHandler", "loginHandler"),
  node("auth/session/Session.refresh", "refresh", "Session.refresh"),
  node("a/dup", "dup", "a.dup"),
  node("b/dup", "dup", "b.dup"),
];

/**
 * The module-hint fixture (the live `queries:close` bug). Two entities share the
 * bare name `close` in different modules; V8 sometimes emits the method WITHOUT
 * its class qualifier, so the runtime name is `<module>:close` and the bare name
 * collides. The module hint (`queries` / `ws`) is the disambiguator.
 *   - db/queries/Db.close   [name close, qn Db.close]   (the Db.close method)
 *   - routes/ws/close       [name close, qn close]      (an unrelated handler)
 */
const HINT_FIXTURE: IndexedNode[] = [
  node("db/queries/Db.close", "close", "Db.close"),
  node("routes/ws/close", "close", "close"),
];

describe("normalizeRuntimeName", () => {
  it("splits Python dotted + colon", () => {
    expect(normalizeRuntimeName("myapp.auth:loginHandler")).toEqual([
      "myapp",
      "auth",
      "loginHandler",
    ]);
  });

  it("splits Rust `::` paths", () => {
    expect(normalizeRuntimeName("myapp::auth::Session::refresh")).toEqual([
      "myapp",
      "auth",
      "Session",
      "refresh",
    ]);
  });

  it("strips Go receiver wrapping `(*Type)`", () => {
    expect(
      normalizeRuntimeName("github.com/me/app/auth.(*Session).refresh"),
    ).toEqual(["github", "com", "me", "app", "auth", "Session", "refresh"]);
  });

  it("strips a non-pointer Go receiver `(Type)`", () => {
    expect(normalizeRuntimeName("app/store.(Store).GetUser")).toEqual([
      "app",
      "store",
      "Store",
      "GetUser",
    ]);
  });

  it("strips Rust generic params", () => {
    expect(normalizeRuntimeName("std::vec::Vec<T>::push")).toEqual([
      "std",
      "vec",
      "Vec",
      "push",
    ]);
    expect(normalizeRuntimeName("Store<K, V>::get")).toEqual(["Store", "get"]);
  });

  it("drops empty segments", () => {
    expect(normalizeRuntimeName("a..b:")).toEqual(["a", "b"]);
  });
});

describe("TraceNameResolver", () => {
  const resolver = new TraceNameResolver(FIXTURE);

  it("Python-style `myapp.auth:loginHandler` → bare-name match", () => {
    expect(resolver.resolve("myapp.auth:loginHandler")).toBe(
      "auth/login/loginHandler",
    );
  });

  it("Rust-style `myapp::auth::Session::refresh` → 2-seg qualified match", () => {
    expect(resolver.resolve("myapp::auth::Session::refresh")).toBe(
      "auth/session/Session.refresh",
    );
  });

  it("Go-style `github.com/me/app/auth.(*Session).refresh` → 2-seg qualified match", () => {
    expect(
      resolver.resolve("github.com/me/app/auth.(*Session).refresh"),
    ).toBe("auth/session/Session.refresh");
  });

  it("ambiguous bare name → UNRESOLVED", () => {
    // `dup` resolves to two distinct ids → must not guess.
    expect(resolver.resolve("some.module:dup")).toBeNull();
    expect(resolver.resolve("dup")).toBeNull();
  });

  it("no match → UNRESOLVED", () => {
    expect(resolver.resolve("totally.unknown:doesNotExist")).toBeNull();
    expect(resolver.resolve("")).toBeNull();
  });

  it("prefers the 2-seg qualified join over a bare-name collision", () => {
    // Add a node whose bare `refresh` would be ambiguous, but the 2-seg
    // `Session.refresh` qualified join is still unique → resolves.
    const r = new TraceNameResolver([
      ...FIXTURE,
      node("other/thing/refresh", "refresh", "thing.refresh"),
    ]);
    // bare `refresh` is now ambiguous (two ids share the name).
    expect(r.resolve("just.refresh")).toBeNull();
    // but `Session.refresh` qualified is still unambiguous.
    expect(r.resolve("myapp::auth::Session::refresh")).toBe(
      "auth/session/Session.refresh",
    );
  });
});

describe("TraceNameResolver — module-hint disambiguation (the `queries:close` bug)", () => {
  const resolver = new TraceNameResolver(HINT_FIXTURE);

  it("uses the module hint to pick `Db.close` over the unrelated `close`", () => {
    // V8 dropped the `Db.` qualifier, so the runtime name is bare `close` with a
    // `queries` module hint. Bare `close` is ambiguous; the hint resolves it.
    expect(resolver.resolve("queries:close")).toBe("db/queries/Db.close");
  });

  it("uses the module hint to pick the ws handler", () => {
    expect(resolver.resolve("ws:close")).toBe("routes/ws/close");
  });

  it("aligns the hint against deeper id-path segments", () => {
    // A multi-segment hint where only one segment (`queries`) aligns with one
    // candidate id still resolves precisely.
    expect(resolver.resolve("app.db.queries:close")).toBe("db/queries/Db.close");
    expect(resolver.resolve("app.routes.ws:close")).toBe("routes/ws/close");
  });

  it("stays UNRESOLVED when the hint is absent (genuinely ambiguous)", () => {
    // No module hint at all → cannot disambiguate → must not guess.
    expect(resolver.resolve("close")).toBeNull();
  });

  it("stays UNRESOLVED when the hint matches neither candidate", () => {
    // Hint `unrelated` aligns with no candidate id → unresolved, not a guess.
    expect(resolver.resolve("unrelated:close")).toBeNull();
  });

  it("stays UNRESOLVED when the hint aligns with BOTH candidates (tie)", () => {
    // A pathological graph where the hint segment appears in both ids → tie →
    // conservative: stay unresolved rather than pick arbitrarily.
    const r = new TraceNameResolver([
      node("svc/shared/Db.close", "close", "Db.close"),
      node("svc/shared/ws.close", "close", "ws.close"),
    ]);
    expect(r.resolve("shared:close")).toBeNull();
  });

  it("still resolves a 2-seg qualified join when the qualifier IS present", () => {
    // When V8 keeps the qualifier, the normal trailing-name path handles it and
    // the hint pass never runs.
    expect(resolver.resolve("db.queries.Db.close")).toBe("db/queries/Db.close");
  });

  it("picks the MORE-SPECIFIC candidate over one sharing only the generic top segment (the `decorators:command` recall bug)", () => {
    // `command` is ambiguous: the real decorator `click/decorators/command` vs the
    // unrelated method `click/core/Group.command`. BOTH ids share the generic
    // top-package segment `click`, but only the true target also shares the
    // specific `decorators`. The old any-segment rule scored both as "aligned" →
    // manufactured a tie → dropped the coverage row (a real recall hole). Scoring
    // by # of shared hint segments resolves to the more-specific candidate.
    const r = new TraceNameResolver([
      node("click/decorators/command", "command", "command"),
      node("click/core/Group.command", "command", "Group.command"),
      node("tests/test_basic/command", "command", "command"),
    ]);
    expect(r.resolve("click.decorators:command")).toBe("click/decorators/command");
  });

  it("still stays UNRESOLVED on an EQUAL-score tie (scoring does not weaken the discipline)", () => {
    // Both candidates share exactly the hint segment `click` and nothing more →
    // equal top score → unresolved, never an arbitrary pick.
    const r = new TraceNameResolver([
      node("click/decorators/command", "command", "command"),
      node("click/core/command", "command", "command"),
    ]);
    expect(r.resolve("click:command")).toBeNull();
  });
});

describe("TraceNameResolver — path-suffix hints (the hono `router:match` ambiguity)", () => {
  /**
   * The hono shape (bench/affected-tests-typescript-RESULTS.md §3): FIVE router
   * modules share the file basename `router.ts`, each defining a `match` method,
   * so the bare name `match` is 5-way ambiguous and a basename-only module hint
   * (`router`) ties every candidate. A PATH-QUALIFIED hint
   * (`router/reg-exp-router/router`) must pick the right one: the longest hint
   * suffix appearing contiguously in the id wins.
   */
  const HONO_FIXTURE: IndexedNode[] = [
    node("router/reg-exp-router/router/RegExpRouter.match", "match", "RegExpRouter.match"),
    node("router/smart-router/router/SmartRouter.match", "match", "SmartRouter.match"),
    node("router/trie-router/router/TrieRouter.match", "match", "TrieRouter.match"),
    node("router/linear-router/router/LinearRouter.match", "match", "LinearRouter.match"),
    node("router/pattern-router/router/PatternRouter.match", "match", "PatternRouter.match"),
  ];
  const resolver = new TraceNameResolver(HONO_FIXTURE);

  it("basename-only hint stays UNRESOLVED across 5 same-basename modules (never guess)", () => {
    // The measured hono failure mode: the collector hinted only `router`, which
    // every candidate contains → 5-way tie → correctly refuses.
    expect(resolver.resolve("router:match")).toBeNull();
  });

  it("path-qualified hint resolves via longest-suffix-wins", () => {
    expect(resolver.resolve("router/reg-exp-router/router:match")).toBe(
      "router/reg-exp-router/router/RegExpRouter.match",
    );
    expect(resolver.resolve("router/smart-router/router:match")).toBe(
      "router/smart-router/router/SmartRouter.match",
    );
  });

  it("a PARTIAL path suffix still discriminates (`reg-exp-router/router` beats bare `router`)", () => {
    // The hint need not be the full module path — a 2-segment suffix already
    // matches only one candidate with run 2 (the rest score 1 on `router`).
    expect(resolver.resolve("reg-exp-router/router:match")).toBe(
      "router/reg-exp-router/router/RegExpRouter.match",
    );
  });

  it("drops a file-extension token from a path-shaped hint (`…/router.ts` scores as `…/router`)", () => {
    // A collector hinting with the literal file path emits `router.ts`, whose
    // `ts` token can never match an id segment; it must not zero the suffix.
    expect(resolver.resolve("router/trie-router/router.ts:match")).toBe(
      "router/trie-router/router/TrieRouter.match",
    );
  });

  it("`index`-everywhere: a path-qualified hint picks the right same-basename `index` module", () => {
    const r = new TraceNameResolver([
      node("jsx/dom/index/upgradeWebSocket", "upgradeWebSocket", "upgradeWebSocket"),
      node("adapter/deno/index/upgradeWebSocket", "upgradeWebSocket", "upgradeWebSocket"),
    ]);
    expect(r.resolve("index:upgradeWebSocket")).toBeNull(); // basename-only → tie
    expect(r.resolve("jsx/dom/index:upgradeWebSocket")).toBe(
      "jsx/dom/index/upgradeWebSocket",
    );
    expect(r.resolve("adapter/deno/index:upgradeWebSocket")).toBe(
      "adapter/deno/index/upgradeWebSocket",
    );
  });

  it("a LONGER matched suffix beats a shorter one on equal shared-segment counts", () => {
    // Both ids contain `router`, but only one contains the contiguous
    // `regexp/router` run — the longer suffix must win outright.
    const r = new TraceNameResolver([
      node("lib/regexp/router/dispatch", "dispatch", "dispatch"),
      node("lib/other/router/regexp/dispatch", "dispatch", "dispatch"),
    ]);
    // Hint `regexp/router`: candidate 1 has the contiguous run (len 2); candidate
    // 2 contains both segments but NOT as the hint-ordered contiguous suffix, so
    // it scores (1, 2) vs (2, 2) — the suffix axis is primary.
    expect(r.resolve("regexp/router:dispatch")).toBe("lib/regexp/router/dispatch");
  });

  it("equal suffix AND shared scores stay UNRESOLVED, independent of insertion order", () => {
    const a = node("pkg/mod/router/handle", "handle", "handle");
    const b = node("lib/mod/router/handle", "handle", "handle");
    for (const fixture of [[a, b], [b, a]]) {
      const r = new TraceNameResolver(fixture);
      // `mod/router` appears contiguously in BOTH ids → (2, 2) tie both ways.
      expect(r.resolve("mod/router:handle")).toBeNull();
    }
  });

  it("deeper-rooted ids (src/ prefix) still match a repo-relative hint suffix", () => {
    // The id may be rooted deeper than the hint (`src/…`); the contiguous-run
    // match is position-independent, so the suffix still lands.
    const r = new TraceNameResolver([
      node("src/router/reg-exp-router/router/RegExpRouter.match", "match", "RegExpRouter.match"),
      node("src/router/smart-router/router/SmartRouter.match", "match", "SmartRouter.match"),
    ]);
    expect(r.resolve("router/reg-exp-router/router:match")).toBe(
      "src/router/reg-exp-router/router/RegExpRouter.match",
    );
  });
});

describe("TraceNameResolver — ambiguous dotted stems (the vitest `index.test` ×44 ceiling)", () => {
  /**
   * The Bun collector attributes per-test coverage to the TEST FILE's module
   * node, whose qualified name is the dotted stem (`index.test`) — shared by
   * 44 files on hono, so the trailing 2-segment join is AMBIGUOUS and, before
   * this pass, conservatively dropped (measured 39 correct / 95 dropped / 0
   * wrong). The path-qualified name the collector emits must now disambiguate
   * through the SAME hint scoring, keyed on the retained qualified candidates.
   */
  const VITEST_FIXTURE: IndexedNode[] = [
    node("jsx/dom/index.test", "index.test", "index.test"),
    node("middleware/basic-auth/index.test", "index.test", "index.test"),
    node("adapter/deno/index.test", "index.test", "index.test"),
  ];
  const resolver = new TraceNameResolver(VITEST_FIXTURE);

  it("a bare ambiguous stem stays UNRESOLVED (no hint, no guess)", () => {
    expect(resolver.resolve("index.test")).toBeNull();
  });

  it("path-qualified stems resolve each same-stem test file uniquely", () => {
    expect(resolver.resolve("src/jsx/dom/index.test")).toBe("jsx/dom/index.test");
    expect(resolver.resolve("src/middleware/basic-auth/index.test")).toBe(
      "middleware/basic-auth/index.test",
    );
    expect(resolver.resolve("src/adapter/deno/index.test")).toBe(
      "adapter/deno/index.test",
    );
  });

  it("a genuinely tied qualified stem still refuses, insertion-order independent", () => {
    const a = node("pkg/dom/index.test", "index.test", "index.test");
    const b = node("lib/dom/index.test", "index.test", "index.test");
    for (const fixture of [[a, b], [b, a]]) {
      const r = new TraceNameResolver(fixture);
      expect(r.resolve("dom/index.test")).toBeNull(); // `dom` run of 1 in both → tie
    }
  });

  it("multi-dot stems resolve via the 3-segment trailing join", () => {
    const r = new TraceNameResolver([
      node("utils/common.case.test", "common.case.test", "common.case.test"),
      node("jsx/dom/index.test", "index.test", "index.test"),
    ]);
    // Unique 3-segment stem: exact byQualified hit at n=3.
    expect(r.resolve("src/utils/common.case.test")).toBe("utils/common.case.test");
  });

  it("ambiguous multi-dot stems disambiguate by path at the 3-segment join", () => {
    const r = new TraceNameResolver([
      node("client/common.case.test", "common.case.test", "common.case.test"),
      node("server/common.case.test", "common.case.test", "common.case.test"),
    ]);
    expect(r.resolve("common.case.test")).toBeNull(); // no hint → refuse
    expect(r.resolve("src/client/common.case.test")).toBe("client/common.case.test");
    expect(r.resolve("src/server/common.case.test")).toBe("server/common.case.test");
  });

  it("the 2-segment exact-unique precedence is unchanged (methods still win outright)", () => {
    // A unique `Class.method` qualified join must keep winning before any
    // stem-candidate scoring is consulted.
    const r = new TraceNameResolver([
      node("auth/session/Session.refresh", "refresh", "Session.refresh"),
      node("jsx/dom/index.test", "index.test", "index.test"),
    ]);
    expect(r.resolve("worker_3/auth.session:Session.refresh")).toBe(
      "auth/session/Session.refresh",
    );
  });
});

describe("Db.resolvedTraceEdges (read-time join)", () => {
  function seededDb(): Db {
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNodes(FIXTURE.map((n) => node(n.id, n.name, n.qualified_name)));
    return db;
  }

  it("resolves both endpoints of an observation edge, flags unresolved", () => {
    const db = seededDb();
    db.insertObservations([
      {
        src: "myapp.auth:loginHandler",
        dst: "myapp::auth::Session::refresh",
        ts: 1000,
        observed: 3,
        weight: 300,
        source: "python",
      },
      // dst is ambiguous (`dup`) → stays unresolved; src resolves.
      {
        src: "myapp.auth:loginHandler",
        dst: "some.module:dup",
        ts: 1000,
        observed: 1,
        weight: 100,
        source: "python",
      },
    ]);

    const edges = db.resolvedTraceEdges();
    db.close();

    const e0 = edges.find((e) => e.rawDst === "myapp::auth::Session::refresh")!;
    expect(e0.resolvedSrc).toBe("auth/login/loginHandler");
    expect(e0.resolvedDst).toBe("auth/session/Session.refresh");
    expect(e0.observed).toBe(3);
    expect(e0.weight).toBe(300);
    expect(e0.samples).toBe(1);

    const e1 = edges.find((e) => e.rawDst === "some.module:dup")!;
    expect(e1.resolvedSrc).toBe("auth/login/loginHandler");
    expect(e1.resolvedDst).toBeNull(); // ambiguous → flagged
  });

  it("sums observed/weight across same-(src,dst) rows", () => {
    const db = seededDb();
    db.insertObservations([
      {
        src: "myapp.auth:loginHandler",
        dst: "myapp::auth::Session::refresh",
        ts: 1000,
        observed: 2,
        weight: 200,
        source: "python",
      },
      {
        src: "myapp.auth:loginHandler",
        dst: "myapp::auth::Session::refresh",
        ts: 2000,
        observed: 1,
        weight: 100,
        source: "python",
      },
    ]);
    const edges = db.resolvedTraceEdges();
    db.close();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.observed).toBe(3);
    expect(edges[0]!.weight).toBe(300);
    expect(edges[0]!.samples).toBe(2);
  });

  it("buildTraceResolver reflects the live node index", () => {
    const db = seededDb();
    const resolver = buildTraceResolver(db);
    db.close();
    expect(resolver.resolve("x.y:loginHandler")).toBe("auth/login/loginHandler");
  });
});

describe("e2e: ingest via the real trace route, then resolve", () => {
  it("observations posted to /api/traces/observations resolve to entity ids", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hayven-trace-resolve-"));
    const paths = hayvenPathsFor(repoRoot);
    const db = new Db(":memory:");
    db.migrate();
    db.upsertNodes(FIXTURE.map((n) => node(n.id, n.name, n.qualified_name)));
    const app = buildApp({
      db,
      config: DEFAULT_CONFIG,
      paths,
      logger: createLogger({ toFile: false, toStderr: false }),
      crdt: makeTestCrdtState(),
      daemonVersion: "test",
      ingest: {
        current: () => null,
        start: async () => {
          throw new Error("not used in this test");
        },
      },
    });

    const res = await app.handle(
      new Request("http://localhost/api/traces/observations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "go",
          sample_rate: 100,
          observations: [
            {
              src: "myapp.auth:loginHandler",
              dst: "github.com/me/app/auth.(*Session).refresh",
              ts: 1_715_789_520,
              observed: 5,
              weight: 500,
            },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);

    // The raw names are stored VERBATIM (collector ground truth)...
    const edges = db.resolvedTraceEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rawSrc).toBe("myapp.auth:loginHandler");
    expect(edges[0]!.rawDst).toBe("github.com/me/app/auth.(*Session).refresh");
    // ...and resolve to the indexed entity ids at read time.
    expect(edges[0]!.resolvedSrc).toBe("auth/login/loginHandler");
    expect(edges[0]!.resolvedDst).toBe("auth/session/Session.refresh");

    // Filter form: only edges with this runtime src.
    const filtered = db.resolvedTraceEdges({ rawSrc: "myapp.auth:loginHandler" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.resolvedDst).toBe("auth/session/Session.refresh");
    db.close();
  });
});
