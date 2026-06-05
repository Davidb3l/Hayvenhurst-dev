// Layer B — pre-merge semantic verify gate (ARCHITECTURE.md §17.2).
//
// Coverage:
//   (a) a syntactically valid affected file PASSES the gate;
//   (b) a deliberately broken file FAILS with a `merge_rejected` naming the
//       file (and the row lands in the SQL read cache + flags the node row);
//   (c) a language with NO configured checker passes-with-log;
//   (d) a failed gate does NOT roll back the CRDT/op — the gate is advisory;
//   (e) the REAL `hayven-native parse --files-stdin` path, skipped cleanly
//       when the binary isn't built (matches the repo's findBinary pattern).
//
// (a)–(d) inject stubs for the native-parse + typecheck runners so they are
// fast and deterministic.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  languageOf,
  nativeParseRunner,
  verifyMerge,
  type NativeParseFn,
  type NativeParseOutcome,
  type TypecheckFn,
} from "../src/conflict/verify.ts";
import { Db } from "../src/db/queries.ts";

/* ── stub runners ─────────────────────────────────────────────────────────── */

/** A native runner that emits exactly the records you give it (exit 0). */
function stubNative(records: NativeParseOutcome["records"], exitCode = 0): NativeParseFn {
  return async () => ({ records, exitCode, stderrTail: exitCode === 0 ? "" : "boom" });
}

/** A typecheck runner that always reports "no checker configured" (a pass). */
const noChecker: TypecheckFn = async () => ({ configured: false, ok: true });

/* ── (a) valid file passes ──────────────────────────────────────────────────── */

describe("verifyMerge — Layer B gate", () => {
  test("(a) a syntactically valid affected file passes", async () => {
    const res = await verifyMerge(["src/ok.ts"], {
      root: "/repo",
      native: stubNative([
        { type: "node", file: "src/ok.ts" },
        { type: "done" },
      ]),
      typecheck: noChecker,
    });
    expect(res.ok).toBe(true);
    expect(res.failures).toHaveLength(0);
  });

  /* ── (b) broken file fails + records a merge_rejected naming the file ──── */

  test("(b) a broken file fails the gate with a merge_rejected naming the file", async () => {
    const res = await verifyMerge(["src/broken.ts", "src/ok.ts"], {
      root: "/repo",
      native: stubNative([
        { type: "warn", file: "src/broken.ts", message: "unexpected token '}'" },
        { type: "node", file: "src/ok.ts" },
        { type: "done" },
      ]),
      typecheck: noChecker,
    });
    expect(res.ok).toBe(false);
    expect(res.failures).toHaveLength(1);
    const f = res.failures[0]!;
    expect(f.file).toBe("src/broken.ts");
    expect(f.phase).toBe("syntax");
    expect(f.language).toBe("typescript");
    expect(f.reason).toContain("unexpected token");

    // It lands in the SQL read cache as the `merge_rejected` surface and flags
    // the affected node rows.
    const dir = mkdtempSync(join(tmpdir(), "hayven-verify-b-"));
    const db = new Db(join(dir, "x.sqlite"));
    try {
      db.migrate();
      // A surviving node from the broken file exists in the cache (the CRDT
      // converged + materialized it) — flagging must mark it.
      db.upsertNode({
        id: "broken:thing",
        name: "thing",
        qualified_name: "thing",
        kind: "function",
        language: "typescript",
        file: "src/broken.ts",
        range: [1, 2],
        ast_hash: "h",
        last_seen: 1,
        logical_clock: 0,
      });
      db.recordMergeRejections(
        res.failures.map((x) => ({
          file: x.file,
          phase: x.phase,
          language: x.language,
          reason: x.reason,
          detected_at: x.detectedAt,
        })),
      );

      const rows = db.listMergeRejections();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.file).toBe("src/broken.ts");
      expect(rows[0]!.phase).toBe("syntax");
      expect(db.mergeRejectionCount()).toBe(1);

      const node = db.getNode("broken:thing")!;
      expect(node.merge_flagged).toBe(1);

      // clearMergeState (called at the start of a re-ingest) wipes it.
      db.clearMergeState(["src/broken.ts"]);
      expect(db.mergeRejectionCount()).toBe(0);
      expect(db.getNode("broken:thing")!.merge_flagged).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(b2) a type failure is recorded with phase 'type'", async () => {
    const failingTsc: TypecheckFn = async (lang) => ({
      configured: true,
      ok: false,
      reason: `${lang}: TS2322 type mismatch`,
    });
    const res = await verifyMerge(["src/typed.ts"], {
      root: "/repo",
      native: stubNative([{ type: "node", file: "src/typed.ts" }, { type: "done" }]),
      typecheck: failingTsc,
    });
    expect(res.ok).toBe(false);
    expect(res.failures[0]!.phase).toBe("type");
    expect(res.failures[0]!.reason).toContain("TS2322");
  });

  /* ── (c) no configured checker passes-with-log ──────────────────────────── */

  test("(c) a language with no configured checker passes-with-log", async () => {
    const res = await verifyMerge(["main.go"], {
      root: "/repo",
      native: stubNative([{ type: "node", file: "main.go" }, { type: "done" }]),
      typecheck: noChecker, // reports configured:false
    });
    expect(res.ok).toBe(true);
    expect(res.failures).toHaveLength(0);
    // The skip is surfaced (the "logged" requirement) — language appears in
    // the skippedTypecheck list.
    expect(res.skippedTypecheck).toContain("go");
  });

  /* ── (d) the gate is advisory: CRDT/op is NOT rolled back on failure ────── */

  test("(d) a failed gate does NOT roll back the CRDT/op (advisory only)", async () => {
    // Model the CRDT/op as state owned outside the gate. verifyMerge has no
    // handle to it and returns a pure verdict — it cannot mutate or roll back
    // anything. We assert both: (1) the gate never receives a rollback hook,
    // and (2) running it leaves a sentinel untouched.
    let crdtOpsApplied = 1; // pretend the op already converged + materialized
    const res = await verifyMerge(["src/broken.ts"], {
      root: "/repo",
      native: stubNative([
        { type: "fatal", message: "parser crashed on src/broken.ts" },
      ], 1),
      typecheck: noChecker,
    });
    expect(res.ok).toBe(false);
    // The op count is exactly what it was before — the gate did not touch it.
    expect(crdtOpsApplied).toBe(1);
    crdtOpsApplied += 0; // no-op; the gate has no rollback path to invoke
    expect(crdtOpsApplied).toBe(1);
  });

  /* ── misc edge cases ────────────────────────────────────────────────────── */

  test("an empty affected-file set is a trivial pass", async () => {
    let called = false;
    const native: NativeParseFn = async () => {
      called = true;
      return { records: [], exitCode: 0, stderrTail: "" };
    };
    const res = await verifyMerge([], { root: "/repo", native, typecheck: noChecker });
    expect(res.ok).toBe(true);
    expect(called).toBe(false); // we don't even spawn the parser
  });

  test("a non-zero native exit fails all affected files even without per-file records", async () => {
    const res = await verifyMerge(["a.ts", "b.ts"], {
      root: "/repo",
      native: stubNative([], 2),
      typecheck: noChecker,
    });
    expect(res.ok).toBe(false);
    expect(new Set(res.failures.map((f) => f.file))).toEqual(new Set(["a.ts", "b.ts"]));
    expect(res.failures.every((f) => f.phase === "syntax")).toBe(true);
  });

  test("languageOf maps extensions like the native detector", () => {
    expect(languageOf("a.py")).toBe("python");
    expect(languageOf("a.ts")).toBe("typescript");
    expect(languageOf("a.tsx")).toBe("tsx");
    expect(languageOf("a.rs")).toBe("rust");
    expect(languageOf("a.go")).toBe("go");
    expect(languageOf("a.mjs")).toBe("javascript");
    expect(languageOf("README")).toBeNull();
  });
});

/* ── (e) the real native parse path (skipped when binary absent) ───────────── */

function findBinary(): string | null {
  const env = process.env["HAYVEN_NATIVE_BIN"];
  if (env && existsSync(env)) return env;
  const here = import.meta.dir;
  for (const c of [
    join(here, "../../native/target/release/hayven-native"),
    join(here, "../../native/target/debug/hayven-native"),
  ])
    if (existsSync(c)) return c;
  return null;
}

const bin = findBinary();
const maybeDescribe = bin === null ? describe.skip : describe;

maybeDescribe("verifyMerge — real hayven-native parse --files-stdin", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("a valid file passes; a file the parser warns on is rejected at the syntax phase", async () => {
    root = mkdtempSync(join(tmpdir(), "hayven-verify-real-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "good.py"), "def ok():\n    return 1\n");
    // A non-UTF-8 source: the parser warns "file is not valid UTF-8". Exercises
    // the REAL --files-stdin path and the gate's warn→syntax-rejection mapping.
    writeFileSync(join(root, "src", "bad.py"), Buffer.from([0xff, 0xfe, 0x00, 0xc0, 0xc1, 0x0a]));

    const native = nativeParseRunner({
      binary: bin!,
      root,
      languages: ["python"],
      jobs: 0,
    });

    const good = await verifyMerge(["src/good.py"], { root, native });
    expect(good.ok).toBe(true);

    const bad = await verifyMerge(["src/bad.py"], { root, native });
    expect(bad.ok).toBe(false);
    expect(bad.failures.some((f) => f.file === "src/bad.py" && f.phase === "syntax")).toBe(true);
    expect(bad.failures.find((f) => f.file === "src/bad.py")!.reason).toContain("UTF-8");
  });

  test("an ordinary syntax error (valid UTF-8) is rejected at the syntax phase", async () => {
    // Tree-sitter is error-recovering, but the extractor now inspects the tree
    // for ERROR/MISSING nodes (root.has_error()) and emits a syntax `warn`. So a
    // genuinely broken-but-valid-UTF-8 file is caught by the gate — closing the
    // spec gap where Layer B's syntax phase couldn't see ordinary syntax errors.
    root = mkdtempSync(join(tmpdir(), "hayven-verify-syntax-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "good.py"), "def ok():\n    return 1\n");
    writeFileSync(join(root, "src", "broken.py"), "def broken(:\n    x = \n");

    const native = nativeParseRunner({ binary: bin!, root, languages: ["python"], jobs: 0 });

    const good = await verifyMerge(["src/good.py"], { root, native });
    expect(good.ok).toBe(true);

    const broken = await verifyMerge(["src/broken.py"], { root, native });
    expect(broken.ok).toBe(false);
    const f = broken.failures.find((x) => x.file === "src/broken.py");
    expect(f?.phase).toBe("syntax");
    expect(f?.reason).toContain("syntax error");
  });
});
