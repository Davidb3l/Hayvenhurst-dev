import { describe, expect, it } from "bun:test";

import {
  deriveEntityId,
  legacyScopeForFile,
  nodeMarkdownPath,
  remapLegacyId,
  scopeForFile,
  unresolvedEdgeId,
} from "../src/graph/idScheme.ts";

describe("scopeForFile", () => {
  it("is the file's directory path, verbatim (schema v8 — no elision)", () => {
    expect(scopeForFile("src/auth/login.ts")).toBe("src/auth");
    expect(scopeForFile("src/auth/sub/login.ts")).toBe("src/auth/sub");
  });

  it("falls back to the file directory when there is no `src/`", () => {
    expect(scopeForFile("lib/util/x.py")).toBe("lib/util");
  });

  it("returns the empty string for top-level files", () => {
    expect(scopeForFile("index.ts")).toBe("");
    expect(scopeForFile("./README.md")).toBe("");
  });

  // Monorepo P0 (bench/monorepo-astro-RESULTS.md §2a): an even older rule
  // dropped everything before the first `src/`, so every package's `src/` root
  // collapsed onto the same scope — `packages/{vercel,netlify}/src/lib/nft.ts`
  // both became `lib/nft`, ids are the PK, and 22% of astro's files silently
  // vanished (337 `src/pages/index.astro` → ONE node). Retaining the WHOLE path
  // necessarily retains the pre-`src/` prefix, so that fix is subsumed, not
  // regressed.
  it("keeps the pre-`src/` package prefix (monorepo collision fix, still held)", () => {
    expect(scopeForFile("packages/vercel/src/lib/nft.ts")).toBe("packages/vercel/src/lib");
    expect(scopeForFile("packages/netlify/src/lib/nft.ts")).toBe("packages/netlify/src/lib");
    expect(scopeForFile("packages/vercel/src/lib/nft.ts")).not.toBe(
      scopeForFile("packages/netlify/src/lib/nft.ts"),
    );
    // Files directly under a package's src/.
    expect(scopeForFile("packages/astro/src/index.ts")).toBe("packages/astro/src");
  });

  it("keeps EVERY `src` segment, including nested ones", () => {
    expect(scopeForFile("packages/a/src/gen/src/x.ts")).toBe("packages/a/src/gen/src");
  });

  // KNOWN_ISSUES #1 — THE bug this scheme change exists to fix. Under the old
  // elision both of these returned `a`, so both files derived the module id
  // `a/b`; ids are the `nodes` PRIMARY KEY, so one file's symbols were silently
  // overwritten by the other's.
  it("KNOWN_ISSUES #1: `a/src/b.ts` and `a/b.ts` no longer share a scope", () => {
    expect(scopeForFile("a/src/b.ts")).toBe("a/src");
    expect(scopeForFile("a/b.ts")).toBe("a");
    expect(scopeForFile("a/src/b.ts")).not.toBe(scopeForFile("a/b.ts"));
  });

  it("KNOWN_ISSUES #1: the scope is injective — distinct dirs, distinct scopes", () => {
    // A spread of shapes that all collapsed onto `a` (or onto each other) under
    // the elision. Every one must now be distinct.
    const files = [
      "a/b.ts",
      "a/src/b.ts",
      "src/a/b.ts",
      "a/src/src/b.ts",
      "src/b.ts",
      "b.ts",
    ];
    const scopes = files.map(scopeForFile);
    expect(new Set(scopes).size).toBe(files.length);
  });
});

describe("legacyScopeForFile (frozen pre-v8 rule, for the migration only)", () => {
  it("reproduces the elision the v7 index was written with", () => {
    expect(legacyScopeForFile("src/auth/login.ts")).toBe("auth");
    expect(legacyScopeForFile("packages/vercel/src/lib/nft.ts")).toBe("packages/vercel/lib");
    expect(legacyScopeForFile("lib/util/x.py")).toBe("lib/util");
    expect(legacyScopeForFile("index.ts")).toBe("");
  });

  it("still exhibits the collision — that is the point of keeping it", () => {
    // It must reproduce the BUG faithfully, or the migration cannot recognise
    // the ids a v7 index actually stored.
    expect(legacyScopeForFile("a/src/b.ts")).toBe(legacyScopeForFile("a/b.ts"));
  });
});

describe("remapLegacyId", () => {
  it("rewrites a v7 id into its v8 spelling using the node's file", () => {
    expect(remapLegacyId("auth/login", "src/auth/login.ts")).toBe("src/auth/login");
    expect(remapLegacyId("auth/login/Session.refresh", "src/auth/login.ts")).toBe(
      "src/auth/login/Session.refresh",
    );
    expect(remapLegacyId("packages/vercel/lib/nft/copyDeps", "packages/vercel/src/lib/nft.ts")).toBe(
      "packages/vercel/src/lib/nft/copyDeps",
    );
  });

  it("is identity for a file whose scope never had a `src/` to elide", () => {
    expect(remapLegacyId("lib/util/x/helper", "lib/util/x.py")).toBe("lib/util/x/helper");
  });

  it("handles top-level files (empty scope both sides)", () => {
    expect(remapLegacyId("main", "index.ts")).toBe("main");
  });

  // The refusal half is the load-bearing one: guessing at an id we do not
  // recognise is how a migration silently repoints a user's note onto the
  // wrong symbol.
  it("returns null for an id that does not sit under its file's legacy scope", () => {
    expect(remapLegacyId("?:someUnresolvedName", "src/auth/login.ts")).toBeNull();
    expect(remapLegacyId("totally/unrelated", "src/auth/login.ts")).toBeNull();
  });

  it("returns null rather than producing an empty local part", () => {
    expect(remapLegacyId("auth", "src/auth/login.ts")).toBeNull();
  });

  // The two spellings KNOWN_ISSUES #1 is about must remap to DIFFERENT ids, or
  // the migration would rewrite two anchors onto one symbol.
  it("KNOWN_ISSUES #1: the two colliding spellings remap apart", () => {
    expect(remapLegacyId("a/b/helper", "a/src/b.ts")).toBe("a/src/b/helper");
    expect(remapLegacyId("a/b/helper", "a/b.ts")).toBe("a/b/helper");
  });
});

describe("deriveEntityId", () => {
  it("composes scope + qualified_name when no moduleName is given (module nodes)", () => {
    expect(deriveEntityId("src/auth/login.ts", "loginHandler")).toBe("src/auth/loginHandler");
    expect(deriveEntityId("src/auth/login.ts", "Session.refresh")).toBe("src/auth/Session.refresh");
  });

  it("handles top-level files (no scope)", () => {
    expect(deriveEntityId("index.ts", "main")).toBe("main");
  });

  it("falls back to filename when qualified_name is empty", () => {
    expect(deriveEntityId("src/util/x.py", "")).toBe("src/util/x");
  });

  it("monorepo: sibling packages' same-named files derive DISTINCT ids", () => {
    const vercel = deriveEntityId("packages/vercel/src/lib/nft.ts", "copyDependenciesToFunction", {
      moduleName: "nft",
      kind: "function",
    });
    const netlify = deriveEntityId("packages/netlify/src/lib/nft.ts", "copyDependenciesToFunction", {
      moduleName: "nft",
      kind: "function",
    });
    expect(vercel).toBe("packages/vercel/src/lib/nft/copyDependenciesToFunction");
    expect(netlify).toBe("packages/netlify/src/lib/nft/copyDependenciesToFunction");
    expect(vercel).not.toBe(netlify);
  });

  describe("module-prefix disambiguation", () => {
    it("prepends moduleName for non-module entities to prevent sibling-file collisions", () => {
      // src/parse/hash.rs::do_something  vs  src/parse/extract.rs::do_something
      // Without disambiguation both collapse to `parse/do_something` (PK collision).
      const a = deriveEntityId("src/parse/hash.rs", "do_something", { moduleName: "hash" });
      const b = deriveEntityId("src/parse/extract.rs", "do_something", { moduleName: "extract" });
      expect(a).toBe("src/parse/hash/do_something");
      expect(b).toBe("src/parse/extract/do_something");
      expect(a).not.toBe(b);
    });

    it("does NOT prepend moduleName when it equals the qualified_name (module node itself)", () => {
      // The module record arrives with qualified_name === moduleName.
      // Prepending would produce `parse/hash/hash`.
      expect(
        deriveEntityId("src/parse/hash.rs", "hash", { moduleName: "hash" }),
      ).toBe("src/parse/hash");
    });

    it("preserves dotted qualified_names for methods on classes", () => {
      expect(
        deriveEntityId("src/auth/login.ts", "Session.refresh", { moduleName: "login" }),
      ).toBe("src/auth/login/Session.refresh");
    });

    it("does not double-prefix if the qualified_name already starts with `<module>/`", () => {
      // Defensive — some parsers may pre-prefix with the module + slash. We
      // shouldn't produce `parse/hash/hash/do_something`. The slash separator
      // is unambiguous (unlike a dot), so this stays a pure de-dup.
      expect(
        deriveEntityId("src/parse/hash.rs", "hash/do_something", { moduleName: "hash" }),
      ).toBe("src/parse/hash/do_something");
    });

    // BL-16: a leading `<module>.` on a TOP-LEVEL entity is a redundant module
    // qualifier, not a `Class.method` dot. It must collapse to a proper
    // `<scope>/<module>/<name>` id, NOT the old misleading `<scope>/<module>.<name>`
    // (which read like a method on a class named after the module).
    it("BL-16: strips a redundant `<module>.` qualifier on a top-level entity and module-prefixes it", () => {
      // `struct MyStruct` in `hash.rs`, parser-emitted as `hash.MyStruct`.
      // OLD behavior (pre-BL-16) returned `parse/hash.MyStruct`.
      expect(
        deriveEntityId("src/parse/hash.rs", "hash.MyStruct", { moduleName: "hash", kind: "struct" }),
      ).toBe("src/parse/hash/MyStruct");
      // Default (no kind) treats a leading `<module>.` as a qualifier too — the
      // common top-level case — so callers that don't thread kind still get the
      // fixed, disambiguated id.
      expect(
        deriveEntityId("src/parse/hash.rs", "hash.MyStruct", { moduleName: "hash" }),
      ).toBe("src/parse/hash/MyStruct");
    });

    it("BL-16: a real Class.method still collapses (dot kept, module-prefixed)", () => {
      // The dot here is a class separator, not a module qualifier.
      expect(
        deriveEntityId("src/auth/login.ts", "Session.refresh", { moduleName: "login", kind: "method" }),
      ).toBe("src/auth/login/Session.refresh");
    });

    it("BL-16: a method whose class name coincides with the module name keeps the dotted name", () => {
      // module `hash`, a method `hash.foo` on a class literally named `hash`.
      // Because kind === "method", the leading `hash.` is NOT stripped — it is
      // a real `Class.method`, so we get `parse/hash/hash.foo`.
      expect(
        deriveEntityId("src/parse/hash.rs", "hash.foo", { moduleName: "hash", kind: "method" }),
      ).toBe("src/parse/hash/hash.foo");
    });

    // idScheme collision fix: a FUNCTION whose name equals its module basename
    // (`sympify` in `sympify.py`) must get a DISTINCT id from the module node,
    // or the SQLite UPSERT clobbers one with the other. The fix makes the
    // module-prefix KIND-AWARE: a non-module entity whose qn equals the module
    // name still gets the prefix.
    it("idScheme collision: a function named like its module gets `<scope>/<mod>/<fn>`", () => {
      // Module node — no moduleName supplied (kind:"module").
      const moduleId = deriveEntityId("src/parse/sympify.py", "sympify", { kind: "module" });
      // Function node — moduleName supplied, kind:"function".
      const fnId = deriveEntityId("src/parse/sympify.py", "sympify", {
        moduleName: "sympify",
        kind: "function",
      });
      expect(moduleId).toBe("src/parse/sympify");
      expect(fnId).toBe("src/parse/sympify/sympify");
      expect(fnId).not.toBe(moduleId);
    });

    it("idScheme collision: a class/struct named like its module is also distinct", () => {
      expect(
        deriveEntityId("src/parse/widget.ts", "widget", { moduleName: "widget", kind: "class" }),
      ).toBe("src/parse/widget/widget");
    });

    it("idScheme collision: a method named like the module keeps its dotted qn and prefixes", () => {
      // `Session.sympify` method in `sympify.py` — dot is a class separator.
      expect(
        deriveEntityId("src/parse/sympify.py", "Session.sympify", {
          moduleName: "sympify",
          kind: "method",
        }),
      ).toBe("src/parse/sympify/Session.sympify");
    });
  });
});

describe("unresolvedEdgeId", () => {
  it("prefixes with `?:`", () => {
    expect(unresolvedEdgeId("doThing")).toBe("?:doThing");
  });
});

describe("nodeMarkdownPath", () => {
  it("maps id slashes to directories and appends .md", () => {
    expect(nodeMarkdownPath("auth/loginHandler")).toBe("auth/loginHandler.md");
    expect(nodeMarkdownPath("a/b/c")).toBe("a/b/c.md");
    expect(nodeMarkdownPath("main")).toBe("main.md");
  });

  it("sanitizes unsafe characters", () => {
    expect(nodeMarkdownPath("foo:bar/baz")).toBe("foo_bar/baz.md");
  });
});
