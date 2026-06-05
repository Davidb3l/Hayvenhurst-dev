// Hardened contract-diff oracle (Blocker A, candidate (b)) — production tests.
//
// Covers the four hardening deliverables:
//   1. REAL tree-sitter signature extraction via `hayven-native parse
//      --signatures` (native binary required; the cases gate cleanly when it's
//      absent, like the other binary-backed suites).
//   2. REAL dependency check = reconstructed imports ∪ the daemon's Db edge
//      index (`outgoing`/`incoming`).
//   3. The opt-in `selectOracle("contract-diff")` seam: returns the contract-diff
//      oracle ONLY when binary + db + repoRoot are present; degrades to the
//      heuristic otherwise; never flips the zero-config default.
//   4. The discrimination property: an INTERNAL edit on a real dependency is
//      benign; a CONTRACT edit on a real dependency conflicts.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContractDiffOracle,
  ContractDiffClaimOracle,
  type ContractEntity,
  type EdgeIndex,
  type EntityResolver,
  type SignatureExtractor,
  type Signature,
} from "../src/conflict/contract_diff_oracle.ts";
import { selectOracle, HeuristicOracle } from "../src/conflict/oracle.ts";
import {
  buildSignatureIndex,
  extractSignatureFromBody,
  dbEdgeIndex,
  dbEntityResolver,
  nativeSignatureExtractor,
  type DbLike,
} from "../src/conflict/native_signatures.ts";

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  for (const c of [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ]) {
    if (existsSync(c)) return c;
  }
  return null;
}
const bin = findBinary();
const maybe = bin === null ? describe.skip : describe;

function entity(over: Partial<ContractEntity> & { id: string; name: string }): ContractEntity {
  return {
    kind: "function",
    language: "typescript",
    file: `${over.name}.ts`,
    module: over.name,
    body: "",
    imports: new Set<string>(),
    ...over,
  };
}

/* ── 1. REAL tree-sitter signature extraction ──────────────────────────────── */
maybe("native signature extraction (parse --signatures)", () => {
  test("extractSignatureFromBody reads arity / param types / return / visibility", () => {
    const sig = extractSignatureFromBody({
      binary: bin!,
      body: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      language: "typescript",
      name: "add",
    })!;
    expect(sig).not.toBeNull();
    expect(sig.arity).toBe(2);
    expect(sig.params).toEqual(["number", "number"]);
    expect(sig.returnType).toBe("number");
    expect(sig.visibility).toBe("public");
    expect(sig.hasCallable).toBe(true);
  });

  test("a Python method body excludes the self receiver from arity", () => {
    const sig = extractSignatureFromBody({
      binary: bin!,
      body: "    def greet(self, name: str) -> bool:\n        return True\n",
      language: "python",
      name: "greet",
      kind: "method",
    })!;
    expect(sig.arity).toBe(1);
    expect(sig.params).toEqual(["str"]);
    expect(sig.returnType).toBe("bool");
  });

  test("a repo-wide signature index resolves real entities by file::name", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-sigidx-"));
    try {
      writeFileSync(join(dir, "m.ts"), "export function f(x: string): void {}\nfunction g(): number { return 1; }\n");
      const index = buildSignatureIndex({ binary: bin!, root: dir });
      expect(index.size).toBeGreaterThanOrEqual(2);
      const f = index.get("m.ts", "f", "f")!;
      expect(f.arity).toBe(1);
      expect(f.visibility).toBe("public");
      const g = index.get("m.ts", "g", "g")!;
      expect(g.visibility).toBe("unknown"); // not exported
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ── 2 + 4. Dependency union + the discrimination property ─────────────────── */
describe("ContractDiffOracle discrimination (deterministic, no native needed)", () => {
  // A stub extractor: caller (no public surface gating needed) + callee public.
  const publicCallable: SignatureExtractor = {
    signatureOf: (): Signature => ({
      name: "x",
      arity: 1,
      params: ["string"],
      returnType: "void",
      visibility: "public",
      hasCallable: true,
    }),
  };

  const caller = entity({ id: "a/caller", name: "caller", module: "a", imports: new Set(["b/callee"]) });
  const callee = entity({ id: "b/callee", name: "callee", module: "b" });

  test("CONTRACT edit on a real dependency conflicts", () => {
    const o = new ContractDiffOracle({ signatureExtractor: publicCallable });
    const v = o.assess(
      { target: callee, scope: ["b/callee"], intent: "Change the public signature / return type of callee; callers must adapt." },
      { target: caller, scope: ["a/caller"], intent: "Refactor the internal implementation of caller; its public signature is unchanged." },
    );
    expect(v.conflict).toBe(true);
  });

  test("INTERNAL edit on a real dependency is benign (the over-block the heuristic can't avoid)", () => {
    const o = new ContractDiffOracle({ signatureExtractor: publicCallable });
    const v = o.assess(
      { target: callee, scope: ["b/callee"], intent: "Refactor the internal implementation of callee; its public signature is unchanged." },
      { target: caller, scope: ["a/caller"], intent: "Refactor the internal implementation of caller; its public signature is unchanged." },
    );
    expect(v.conflict).toBe(false);
  });

  test("the REAL Db edge index supplies a dependency the reconstructed imports missed", () => {
    // Neither entity carries an `imports` edge; the dependency lives only in the
    // Db edge index (the real static_call/import edges).
    const c1 = entity({ id: "a/one", name: "one", module: "a" });
    const c2 = entity({ id: "b/two", name: "two", module: "b" });
    const edgeIndex: EdgeIndex = {
      dependsOn: (from, to) => from === "a/one" && to === "b/two",
    };
    const o = new ContractDiffOracle({ signatureExtractor: publicCallable, edgeIndex });
    const v = o.assess(
      { target: c2, scope: ["b/two"], intent: "Change the signature of two; callers must adapt." },
      { target: c1, scope: ["a/one"], intent: "Refactor the internal logic of one." },
    );
    expect(v.conflict).toBe(true);
  });

  test("a 'contract' claim on a PRIVATE-surface entity is downgraded (no cross-file break)", () => {
    const privateSurface: SignatureExtractor = {
      signatureOf: (): Signature => ({
        name: "x",
        arity: 0,
        params: [],
        returnType: null,
        visibility: "private",
        hasCallable: true,
      }),
    };
    const o = new ContractDiffOracle({ signatureExtractor: privateSurface });
    const v = o.assess(
      { target: callee, scope: ["b/callee"], intent: "Change the signature of callee; callers must adapt." },
      { target: caller, scope: ["a/caller"], intent: "Internal logic only." },
    );
    expect(v.conflict).toBe(false);
  });
});

/* ── 2. Db adapters wire to a real Db-shaped stub ──────────────────────────── */
describe("Db adapters (dbEntityResolver / dbEdgeIndex)", () => {
  const db: DbLike = {
    getNode: (id) =>
      id === "conflict/oracle"
        ? {
            id,
            name: "oracle",
            qualified_name: "oracle",
            kind: "function",
            language: "typescript",
            file: "missing.ts",
            range_start: 1,
            range_end: 2,
          }
        : null,
    outgoing: (id) => (id === "conflict/oracle" ? [{ dst: "conflict/adjacency" }] : []),
    incoming: () => [],
  };

  test("resolver returns null for an unknown id and a record for a known id", () => {
    const r = dbEntityResolver(db, "/nonexistent-root");
    expect(r.resolve("nope")).toBeNull();
    const e = r.resolve("conflict/oracle")!;
    expect(e.name).toBe("oracle");
    expect(e.module).toBe("missing"); // file stem
    // Body is empty because the source file doesn't exist at the fake root —
    // the resolver degrades gracefully rather than throwing.
    expect(e.body).toBe("");
  });

  test("edge index honors outgoing edges in either direction", () => {
    const ei = dbEdgeIndex(db);
    expect(ei.dependsOn("conflict/oracle", "conflict/adjacency")).toBe(true);
    expect(ei.dependsOn("conflict/oracle", "conflict/unrelated")).toBe(false);
  });
});

/* ── 3. The opt-in selectOracle seam ───────────────────────────────────────── */
describe("selectOracle — contract-diff is OPT-IN and never the default", () => {
  const db: DbLike = { getNode: () => null, outgoing: () => [], incoming: () => [] };

  test("zero-config default is the heuristic (contract-diff is never auto-selected)", () => {
    expect(selectOracle().id).toBe("heuristic-v1");
    expect(selectOracle({ conflict: { oracle: "heuristic-v1" } }).id).toBe("heuristic-v1");
  });

  test("contract-diff requested but no binary/db/repoRoot → degrades to heuristic", () => {
    const o = selectOracle(
      { conflict: { oracle: "contract-diff" } },
      { locateBinary: () => null, db, repoRoot: "/x" },
    );
    expect(o).toBeInstanceOf(HeuristicOracle);
    const o2 = selectOracle(
      { conflict: { oracle: "contract-diff" } },
      { locateBinary: () => "/bin/hayven-native" /* no db / repoRoot */ },
    );
    expect(o2).toBeInstanceOf(HeuristicOracle);
  });

  maybe("contract-diff requested WITH binary + db + repoRoot → ContractDiffClaimOracle", () => {
    test("selects the contract-diff oracle", () => {
      const o = selectOracle(
        { conflict: { oracle: "contract-diff" } },
        { locateBinary: () => bin!, db, repoRoot: import.meta.dir },
      );
      expect(o).toBeInstanceOf(ContractDiffClaimOracle);
      expect(o.id).toBe("contract-diff");
    });
  });
});

/* ── ContractDiffClaimOracle adapter abstains on unresolved scopes ──────────── */
describe("ContractDiffClaimOracle adapter", () => {
  const resolver: EntityResolver = {
    resolve: (id) =>
      id === "a/known"
        ? { id, name: "known", kind: "function", language: "typescript", file: "a.ts", module: "a", body: "" }
        : null,
  };

  test("abstains (benign, confidence 0) when a scope resolves to no indexed entity", async () => {
    const o = new ContractDiffClaimOracle({ resolver });
    const v = await o.assess(
      { scope: ["a/known"], intent: "x", neighbors: [] },
      { scope: ["z/unknown"], intent: "y", neighbors: [] },
    );
    expect(v.conflict).toBe(false);
    expect(v.confidence).toBe(0);
    expect(v.oracle).toBe("contract-diff");
  });

  maybe("native extractor end-to-end: same-entity overlap always conflicts", () => {
    test("overlap on the same entity id is a hard conflict", async () => {
      const index = buildSignatureIndex({ binary: bin!, root: import.meta.dir });
      const o = new ContractDiffClaimOracle({
        resolver,
        signatureExtractor: nativeSignatureExtractor({ binary: bin!, index, perBodyFallback: false }),
      });
      const v = await o.assess(
        { scope: ["a/known"], intent: "edit", neighbors: [] },
        { scope: ["a/known"], intent: "edit", neighbors: [] },
      );
      expect(v.conflict).toBe(true);
    });
  });
});
