// Unit tests for the ONE shared package-scoped name index that both
// `EdgeResolver.addNode`/`resolveByName` and `reresolveAllEdges` now use. The
// two sites used to carry byte-identical copies of these rules; these tests pin
// the rules themselves so a future edit to the single implementation cannot
// silently change resolution on either path.
import { describe, expect, test } from "bun:test";
import { __testing } from "../src/graph/ingest.ts";

const { PackageScopedNameIndex } = __testing;

/** Minimal node row, matching what both call sites hand the index. */
function node(id: string, name: string, qn = name, kind = "function") {
  return { id, name, qualified_name: qn, kind };
}

describe("PackageScopedNameIndex", () => {
  test("first writer wins for a unique name", () => {
    const ix = new PackageScopedNameIndex();
    expect(ix.add("", node("a.ts:foo", "foo"))).toBe(true);
    expect(ix.lookup("", "foo")).toBe("a.ts:foo");
  });

  test("re-adding the SAME id does not poison the key to AMBIGUOUS", () => {
    // The candidate fetch in reresolveAllEdges can return one row per chunk
    // membership, and re-ingest replays already-indexed nodes. Neither may
    // fabricate an ambiguity verdict.
    const ix = new PackageScopedNameIndex();
    ix.add("", node("a.ts:foo", "foo"));
    ix.add("", node("a.ts:foo", "foo"));
    ix.add("", node("a.ts:foo", "foo"));
    expect(ix.lookup("", "foo")).toBe("a.ts:foo");
  });

  test("two distinct ids under one name go AMBIGUOUS and stop resolving", () => {
    const ix = new PackageScopedNameIndex();
    ix.add("", node("a.ts:foo", "foo"));
    ix.add("", node("b.ts:foo", "foo"));
    expect(ix.lookup("", "foo")).toBeNull();
  });

  test("AMBIGUOUS is sticky: a third add of the first id does not un-poison it", () => {
    const ix = new PackageScopedNameIndex();
    ix.add("", node("a.ts:foo", "foo"));
    ix.add("", node("b.ts:foo", "foo"));
    ix.add("", node("a.ts:foo", "foo"));
    expect(ix.lookup("", "foo")).toBeNull();
  });

  test("module-kind nodes are excluded from the name indexes", () => {
    const ix = new PackageScopedNameIndex();
    expect(ix.add("", node("sympify.py:module", "sympify", "sympify", "module"))).toBe(false);
    expect(ix.lookup("", "sympify")).toBeNull();
  });

  test("a module never shadows a same-named callable into AMBIGUOUS", () => {
    // The real regression: `def sympify` inside `sympify.py`. With the module
    // indexed, the name went ambiguous and every call fell through to `?:`.
    const ix = new PackageScopedNameIndex();
    ix.add("", node("sympify.py:module", "sympify", "sympify", "module"));
    ix.add("", node("sympify.py:sympify", "sympify"));
    ix.add("", node("sympify.py:module", "sympify", "sympify", "module"));
    expect(ix.lookup("", "sympify")).toBe("sympify.py:sympify");
  });

  test("package scoping isolates identical names in different packages", () => {
    const ix = new PackageScopedNameIndex();
    ix.add("packages/web", node("packages/web/a.ts:render", "render"));
    ix.add("packages/api", node("packages/api/a.ts:render", "render"));
    // Neither package is poisoned: the duplicate lives in a different scope.
    expect(ix.lookup("packages/web", "render")).toBe("packages/web/a.ts:render");
    expect(ix.lookup("packages/api", "render")).toBe("packages/api/a.ts:render");
    // And a package that defines nothing by that name gets no cross-package hit.
    expect(ix.lookup("packages/cli", "render")).toBeNull();
    expect(ix.lookup("", "render")).toBeNull();
  });

  test("lookup prefers the qualified name over the bare name", () => {
    const ix = new PackageScopedNameIndex();
    // One node whose BARE name is `handle`, and another whose QUALIFIED name is
    // the same string `handle`. A lookup of "handle" must take the qn hit.
    ix.add("", node("a.ts:Cls.handle", "handle", "Cls.handle"));
    ix.add("", node("b.ts:handle", "other", "handle"));
    expect(ix.lookup("", "handle")).toBe("b.ts:handle");
    // Node a is still reachable under its own qualified name.
    expect(ix.lookup("", "Cls.handle")).toBe("a.ts:Cls.handle");
  });

  test("an AMBIGUOUS qualified name falls through to a unique bare name", () => {
    // Behavior carried over verbatim from both original copies: the qn map is
    // consulted first, but an ambiguous (or absent) qn is a MISS for that map,
    // and the bare-name map still gets its turn.
    const ix = new PackageScopedNameIndex();
    ix.add("", node("a.ts:dup", "aName", "dup"));
    ix.add("", node("b.ts:dup", "bName", "dup"));
    ix.add("", node("c.ts:dup", "dup", "cQn"));
    expect(ix.lookup("", "dup")).toBe("c.ts:dup");
  });

  test("ambiguous in BOTH maps is unresolvable", () => {
    const ix = new PackageScopedNameIndex();
    ix.add("", node("a.ts:dup", "dup", "dup"));
    ix.add("", node("b.ts:dup", "dup", "dup"));
    expect(ix.lookup("", "dup")).toBeNull();
  });

  test("key format is the package-scoped NUL join both call sites depend on", () => {
    expect(PackageScopedNameIndex.key("pkg", "name")).toBe("pkg\0name");
    expect(PackageScopedNameIndex.key("", "name")).toBe("\0name");
  });

  test("lookup of a never-added name is null, not undefined", () => {
    const ix = new PackageScopedNameIndex();
    expect(ix.lookup("", "nope")).toBeNull();
  });
});
