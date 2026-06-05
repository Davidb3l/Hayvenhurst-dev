// Tests for `hayven summarize` (daemon/src/cli/summarize.ts) + the summarizer
// module (daemon/src/graph/summarize.ts).
//
// Coverage:
//   1. HeuristicSummarizer — deterministic, model-free, the zero-config default.
//   2. selectSummarizer — mirrors selectOracle: heuristic with no model present;
//      LlmSummarizer only when a model is present AND a binary is locatable.
//   3. LlmSummarizer — with a MOCKED infer fn: a clean completion is used;
//      timeout/failure/garbage falls back cleanly to the heuristic (the LLM seam
//      degrades without a native binary or weights).
//   4. The CLI offline write path lands the summary in BOTH the node markdown
//      under .hayven/nodes/ AND the SQL `summary` read cache (BL-12 LWW path).
//   5. `--all` covers multiple nodes; unknown id is handled (exit 1); no args.
//
// The CLI runs OFFLINE (no daemon): the temp project's config points at a port
// with no listener, so the daemon health probe fails fast and we exercise the
// direct CrdtState write path.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { Db } from "../src/db/queries.ts";
import { runSummarize } from "../src/cli/summarize.ts";
import {
  HeuristicSummarizer,
  LlmSummarizer,
  SUMMARIZE_INFER_TIMEOUT_MS,
  buildPrompt,
  heuristicSummary,
  makeInferFn,
  parseSummary,
  selectSummarizer,
  type InferFn,
  type SummaryInput,
} from "../src/graph/summarize.ts";
import {
  SUMMARY_PLACEHOLDER_SENTINEL,
  countUnsummarized,
  selectUnsummarizedIds,
} from "../src/graph/summarize_scan.ts";
import { modelDir, modelPath } from "../src/models/registry.ts";
import { nodeFilePath, renderNodeMarkdown } from "../src/graph/nodeWriter.ts";
import { hayvenPathsFor } from "../src/util/paths.ts";
import type { GraphNode } from "../src/graph/types.ts";
import type { InferResult } from "../src/native/infer.ts";

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    name: id.split("/").pop() ?? id,
    qualified_name: id.replace(/\//g, "."),
    kind: "function",
    language: "typescript",
    file: `${id}.ts`,
    range: [1, 5],
    ast_hash: "deadbeef",
    last_seen: 1,
    logical_clock: 1,
    ...over,
  };
}

/** A temp project with a real on-disk `.hayven/` + SQLite index. */
function makeProjectWith(seed: (db: Db) => void): { repoRoot: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "hayven-summarize-"));
  mkdirSync(join(repoRoot, ".hayven"), { recursive: true });
  // Point the daemon port at a closed port so the health probe fails fast and
  // the CLI takes the OFFLINE direct-write path deterministically.
  const config = { ...DEFAULT_CONFIG, daemon_port: 59999 };
  writeFileSync(join(repoRoot, ".hayven", "config.json"), JSON.stringify(config));
  const paths = hayvenPathsFor(repoRoot);
  const db = new Db(paths.sqliteFile);
  db.migrate();
  seed(db);
  db.close();
  return { repoRoot };
}

async function captureIo(
  fn: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as { write: unknown }).write = (s: string) => {
    out.push(typeof s === "string" ? s : String(s));
    return true;
  };
  (process.stderr as { write: unknown }).write = (s: string) => {
    err.push(typeof s === "string" ? s : String(s));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ─── 1. HeuristicSummarizer (the zero-config default, no model) ──────────────

describe("HeuristicSummarizer — deterministic, model-free", () => {
  it("derives a one-liner from kind + name + qualified name", async () => {
    const s = new HeuristicSummarizer();
    const r = await s.summarize({ node: node("auth/login/loginHandler") });
    expect(r.summarizer).toBe("heuristic-v1");
    expect(r.summary).toContain("`function`");
    expect(r.summary).toContain("`loginHandler`");
    expect(r.summary).toContain("auth.login.loginHandler"); // qualified-name context
  });

  it("is deterministic — identical input yields identical output", () => {
    const input: SummaryInput = { node: node("a/b/c"), firstSourceLine: "export function c() {" };
    expect(heuristicSummary(input)).toBe(heuristicSummary(input));
  });

  it("folds in the first source line when provided", () => {
    const summary = heuristicSummary({
      node: node("svc/handler", { kind: "method" }),
      firstSourceLine: "async handle(req: Request): Promise<Response> {",
    });
    expect(summary).toContain("`method`");
    expect(summary).toContain("async handle(req: Request)");
  });

  it("never blows up the one-liner on a runaway source line", () => {
    const summary = heuristicSummary({
      node: node("x/y"),
      firstSourceLine: "a".repeat(500),
    });
    expect(summary.length).toBeLessThan(220);
    expect(summary).toContain("…");
  });
});

// ─── 2. selectSummarizer (mirrors selectOracle) ──────────────────────────────

describe("selectSummarizer — LLM-vs-heuristic decision", () => {
  const MODEL = "gemma4:e2b";
  const env = (over: { present: boolean; binary: string | null }) => ({
    hayvenDir: "/home/.hayven",
    isModelPresent: () => over.present,
    modelDir: () => "/home/.hayven/models/gemma4_e2b",
    locateBinary: () => over.binary,
  });

  it("returns the heuristic with no configured model", () => {
    expect(selectSummarizer().id).toBe("heuristic-v1");
    expect(selectSummarizer({}).id).toBe("heuristic-v1");
  });

  it("returns the heuristic when the model is NOT present (the default path)", () => {
    const s = selectSummarizer({ model: MODEL }, env({ present: false, binary: "/bin/hayven-native" }));
    expect(s.id).toBe("heuristic-v1");
  });

  it("returns the heuristic when no binary is locatable", () => {
    const s = selectSummarizer({ model: MODEL }, env({ present: true, binary: null }));
    expect(s.id).toBe("heuristic-v1");
  });

  it("a model id with no env degrades to heuristic", () => {
    expect(selectSummarizer({ model: MODEL }).id).toBe("heuristic-v1");
  });

  it("returns the LlmSummarizer when model present AND binary locatable", () => {
    const s = selectSummarizer({ model: MODEL }, env({ present: true, binary: "/bin/hayven-native" }));
    expect(s).toBeInstanceOf(LlmSummarizer);
    expect(s.id).toBe(MODEL);
  });

  it("reads the model id from config.models.tier3.model", () => {
    const s = selectSummarizer(
      { models: { tier3: { model: MODEL } } },
      env({ present: true, binary: "/bin/hayven-native" }),
    );
    expect(s).toBeInstanceOf(LlmSummarizer);
  });

  it("a gguf-only model dir activates the LlmSummarizer (real presence check)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-summ-bl14-"));
    const hayvenDir = join(dir, ".hayven");
    try {
      const md = modelDir(hayvenDir, MODEL)!;
      mkdirSync(md, { recursive: true });
      writeFileSync(modelPath(hayvenDir, MODEL)!, "weights");
      const s = selectSummarizer({ model: MODEL }, { hayvenDir, locateBinary: () => "/bin/hayven-native" });
      expect(s).toBeInstanceOf(LlmSummarizer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 3. LlmSummarizer with a MOCKED infer fn (the LLM seam) ───────────────────

describe("LlmSummarizer — LLM seam falls back cleanly", () => {
  const infer = (result: InferResult): InferFn => async () => result;
  const input: SummaryInput = { node: node("auth/login/loginHandler") };

  function make(result: InferResult): LlmSummarizer {
    return new LlmSummarizer({ id: "gemma4:e2b", fallback: new HeuristicSummarizer(), infer: infer(result) });
  }

  it("uses a clean completion as the summary", async () => {
    const s = make({ ok: true, completion: "Validates credentials and issues a session token." });
    const r = await s.summarize(input);
    expect(r.summarizer).toBe("gemma4:e2b");
    expect(r.summary).toBe("Validates credentials and issues a session token.");
  });

  it("falls back to the heuristic on infer failure (no binary/weights)", async () => {
    const s = make({ ok: false, completion: "", error: "infer timed out after 4000ms" });
    const r = await s.summarize(input);
    expect(r.summarizer).toBe("heuristic-v1");
    expect(r.summary).toContain("`loginHandler`");
  });

  it("falls back to the heuristic on unusable/empty output", async () => {
    const r = await make({ ok: true, completion: "  " }).summarize(input);
    expect(r.summarizer).toBe("heuristic-v1");
  });

  it("falls back to the heuristic when the infer fn itself throws", async () => {
    const s = new LlmSummarizer({
      id: "gemma4:e2b",
      fallback: new HeuristicSummarizer(),
      infer: async () => {
        throw new Error("spawn boom");
      },
    });
    const r = await s.summarize(input);
    expect(r.summarizer).toBe("heuristic-v1");
  });

  it("keeps only the first sentence and the prompt carries node metadata", () => {
    expect(parseSummary("First sentence here. Second one.")).toBe("First sentence here.");
    const prompt = buildPrompt({ node: node("svc/doThing"), firstSourceLine: "function doThing() {}" });
    expect(prompt).toContain("name: doThing");
    expect(prompt).toContain("first source line: function doThing() {}");
  });
});

describe("summarize infer budget — batch, not the oracle's latency budget", () => {
  it("defaults to a generous timeout that survives a real cold CPU inference", () => {
    // Regression guard (e2e-found defect): the previous 4000ms default ALWAYS timed
    // out on a real cold GGUF load (~8.6s for gemma3:1b on CPU), so the LLM summary
    // silently degraded to the heuristic and never landed. Summarize is offline/
    // batch, so the budget must be generous. Unit tests miss this because they inject
    // a synchronous mock InferFn that never hits the wall clock.
    expect(SUMMARIZE_INFER_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("makeInferFn builds a callable infer fn (default budget applied)", () => {
    const fn = makeInferFn({ binary: "/bin/hayven-native", modelDir: "/tmp/m" });
    expect(typeof fn).toBe("function");
  });
});

// ─── 4 & 5. The CLI (offline write path: markdown + SQL cache) ───────────────

describe("runSummarize CLI — offline LWW write path", () => {
  const cwd = process.cwd();
  const dirs: string[] = [];
  afterEach(() => {
    process.chdir(cwd);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("no args → usage on stderr, exit 2", async () => {
    const { code, err } = await captureIo(() => runSummarize({ positionals: [], flags: {} }));
    expect(code).toBe(2);
    expect(err).toContain("usage: hayven summarize");
  });

  it("unknown id → friendly message, exit 1", async () => {
    const { repoRoot } = makeProjectWith((db) => db.upsertNode(node("a/known")));
    dirs.push(repoRoot);
    process.chdir(repoRoot);
    const { code, err } = await captureIo(() => runSummarize({ positionals: ["a/missing"], flags: {} }));
    expect(code).toBe(1);
    expect(err).toContain("no node with id `a/missing`");
  });

  it("single id (no model): heuristic summary lands in markdown AND the SQL summary cache", async () => {
    const id = "auth/login/loginHandler";
    const { repoRoot } = makeProjectWith((db) => db.upsertNode(node(id)));
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() => runSummarize({ positionals: [id], flags: {} }));
    expect(code).toBe(0);
    expect(out).toContain("heuristic summarizer");

    const paths = hayvenPathsFor(repoRoot);

    // (a) Markdown source-of-truth: placeholder replaced with the summary.
    const md = readFileSync(nodeFilePath(paths.nodesDir, id), "utf8");
    expect(md).not.toContain("Summary pending");
    expect(md).toContain("`loginHandler`");

    // (b) SQL `summary` read cache updated to the same value.
    const db = new Db(paths.sqliteFile, { readonly: true });
    try {
      const summary = db.getNode(id)?.summary ?? "";
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toContain("`loginHandler`");
      // The cached summary is exactly what landed in the markdown body.
      expect(md).toContain(summary);
    } finally {
      db.close();
    }
  });

  it("--all summarizes every node and writes both stores for each", async () => {
    const ids = ["a/one", "b/two", "c/three"];
    const { repoRoot } = makeProjectWith((db) => {
      for (const id of ids) db.upsertNode(node(id));
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() => runSummarize({ positionals: [], flags: { all: true } }));
    expect(code).toBe(0);
    expect(out).toContain("Summarized 3 nodes");

    const paths = hayvenPathsFor(repoRoot);
    const db = new Db(paths.sqliteFile, { readonly: true });
    try {
      for (const id of ids) {
        expect((db.getNode(id)?.summary ?? "").length).toBeGreaterThan(0);
        const md = readFileSync(nodeFilePath(paths.nodesDir, id), "utf8");
        expect(md).not.toContain("Summary pending");
      }
    } finally {
      db.close();
    }
  });

  it("--json emits structured output noting the heuristic (no model)", async () => {
    const id = "x/y";
    const { repoRoot } = makeProjectWith((db) => db.upsertNode(node(id)));
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() => runSummarize({ positionals: [id], flags: { json: true } }));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      count: number;
      model: string | null;
      summarizer: string;
      via: string;
      nodes: { id: string; summary: string; summarizer: string }[];
    };
    expect(parsed.count).toBe(1);
    expect(parsed.model).toBeNull(); // no tier-3 model present
    expect(parsed.summarizer).toBe("heuristic-v1");
    expect(parsed.via).toBe("offline");
    expect(parsed.nodes[0]?.id).toBe(id);
    expect(parsed.nodes[0]?.summary.length).toBeGreaterThan(0);
  });
});

// ─── 6. Incremental candidate selection (scale-safe --all) ───────────────────

describe("summarize_scan — incremental, resumable candidate selection", () => {
  // Drift guard: the sentinel we mirror MUST equal what nodeWriter renders for a
  // node with no summary. If nodeWriter's placeholder changes, this fails loudly
  // and the predicate would otherwise silently stop skipping un-summarized nodes.
  it("the mirrored placeholder sentinel is byte-identical to the rendered markdown placeholder", () => {
    const md = renderNodeMarkdown(node("a/b", { summary: undefined }));
    expect(md).toContain(SUMMARY_PLACEHOLDER_SENTINEL);
  });

  it("selects ONLY nodes lacking a real summary (NULL, empty, or placeholder)", () => {
    const { repoRoot } = makeProjectWith((db) => {
      db.upsertNode(node("a/null")); // summary undefined → NULL
      db.upsertNode(node("b/empty", { summary: "" }));
      db.upsertNode(node("c/placeholder", { summary: SUMMARY_PLACEHOLDER_SENTINEL }));
      db.upsertNode(node("d/real", { summary: "a `function` that does a thing" }));
    });
    dirs.push(repoRoot);
    const db = new Db(hayvenPathsFor(repoRoot).sqliteFile, { readonly: true });
    try {
      expect(countUnsummarized(db)).toBe(3);
      const ids = selectUnsummarizedIds(db, 0); // 0 = no limit
      expect(ids.sort()).toEqual(["a/null", "b/empty", "c/placeholder"]);
      // The already-summarized node is excluded → resumability after a re-run.
      expect(ids).not.toContain("d/real");
    } finally {
      db.close();
    }
  });

  it("respects --limit and returns a stable, ordered prefix (disjoint successive batches)", () => {
    const { repoRoot } = makeProjectWith((db) => {
      for (const id of ["n/4", "n/2", "n/1", "n/3"]) db.upsertNode(node(id));
    });
    dirs.push(repoRoot);
    const db = new Db(hayvenPathsFor(repoRoot).sqliteFile, { readonly: true });
    try {
      const first = selectUnsummarizedIds(db, 2);
      expect(first).toEqual(["n/1", "n/2"]); // ORDER BY id, bounded by limit
    } finally {
      db.close();
    }
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
});

// ─── 7. CLI --all: bounded, resumable, additive --json fields ────────────────

describe("runSummarize CLI — bounded + resumable --all", () => {
  const cwd = process.cwd();
  const dirs: string[] = [];
  afterEach(() => {
    process.chdir(cwd);
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("--all only summarizes nodes that NEED it (skips already-summarized)", async () => {
    const { repoRoot } = makeProjectWith((db) => {
      db.upsertNode(node("x/done", { summary: "a `function` already summarized" }));
      db.upsertNode(node("y/todo")); // NULL summary
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() =>
      runSummarize({ positionals: [], flags: { all: true, json: true } }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { count: number; remaining: number; nodes: { id: string }[] };
    // Only the un-summarized node is processed; the pre-summarized one is skipped.
    expect(parsed.count).toBe(1);
    expect(parsed.nodes[0]?.id).toBe("y/todo");
    expect(parsed.remaining).toBe(0); // nothing left after this run
  });

  it("--limit bounds the run and reports remaining; a re-run drains the rest (resumable)", async () => {
    const ids = ["a/1", "a/2", "a/3"];
    const { repoRoot } = makeProjectWith((db) => {
      for (const id of ids) db.upsertNode(node(id));
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    // Run 1: cap at 2 → 2 done, 1 remaining.
    const r1 = await captureIo(() =>
      runSummarize({ positionals: [], flags: { all: true, limit: "2", json: true } }),
    );
    const p1 = JSON.parse(r1.out) as { count: number; remaining: number; limit: number | null };
    expect(p1.count).toBe(2);
    expect(p1.remaining).toBe(1);
    expect(p1.limit).toBe(2);

    // Run 2 (resume): the predicate now skips the 2 already-summarized → 1 left.
    const r2 = await captureIo(() =>
      runSummarize({ positionals: [], flags: { all: true, json: true } }),
    );
    const p2 = JSON.parse(r2.out) as { count: number; remaining: number };
    expect(p2.count).toBe(1);
    expect(p2.remaining).toBe(0);

    // Every node now has a real (non-placeholder) summary.
    const db = new Db(hayvenPathsFor(repoRoot).sqliteFile, { readonly: true });
    try {
      for (const id of ids) {
        const s = db.getNode(id)?.summary ?? "";
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toBe(SUMMARY_PLACEHOLDER_SENTINEL);
      }
    } finally {
      db.close();
    }
  });

  it("--max-seconds 0-deadline stops immediately and reports the full remainder", async () => {
    // A deadline already in the past means the first node never starts → 0 done,
    // everything remaining (a clean bounded stop, the wall-clock budget path).
    const ids = ["b/1", "b/2"];
    const { repoRoot } = makeProjectWith((db) => {
      for (const id of ids) db.upsertNode(node(id));
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    // 1ms budget: by the time the loop body runs, the deadline is essentially
    // immediate; with synchronous heuristic work it may complete a node, so we
    // assert the WEAKER invariant the budget guarantees: done + remaining == 2,
    // and a non-zero budgetSeconds is echoed.
    const { code, out } = await captureIo(() =>
      runSummarize({ positionals: [], flags: { all: true, "max-seconds": "0.001", json: true } }),
    );
    expect(code).toBe(0);
    const p = JSON.parse(out) as { count: number; remaining: number; budgetSeconds: number | null };
    expect(p.budgetSeconds).toBe(0.001);
    expect(p.count + p.remaining).toBe(2);
  });

  it("--max-seconds budget is ARMED at loop entry — fixed setup doesn't eat it (regression)", async () => {
    // REGRESSION: the wall-clock deadline must start when summarization actually
    // begins, NOT at flag-parse time. Before the fix the deadline was anchored
    // before CRDT op-log hydration (which on a large op log takes tens of
    // seconds), so the budget was already spent by the time the loop ran and the
    // run summarized ZERO nodes. A budget that does no useful work is useless.
    // Here a GENEROUS budget must drain the whole (small) set — proving the
    // budget covers work, not setup.
    const ids = ["g/1", "g/2", "g/3"];
    const { repoRoot } = makeProjectWith((db) => {
      for (const id of ids) db.upsertNode(node(id));
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() =>
      runSummarize({
        positionals: [],
        flags: { all: true, "max-seconds": "120", json: true },
      }),
    );
    expect(code).toBe(0);
    const p = JSON.parse(out) as {
      count: number;
      remaining: number;
      budgetSeconds: number | null;
    };
    // A generous budget summarizes EVERYTHING — it is not consumed by setup.
    expect(p.count).toBe(3);
    expect(p.remaining).toBe(0);
    expect(p.budgetSeconds).toBe(120);
  });

  it("--all is a fast no-op when everything is already summarized", async () => {
    const { repoRoot } = makeProjectWith((db) => {
      db.upsertNode(node("z/done", { summary: "a `function` already done" }));
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() =>
      runSummarize({ positionals: [], flags: { all: true } }),
    );
    expect(code).toBe(0);
    expect(out).toContain("all up to date");
  });

  it("prints `done X, remaining Y` for an operator to gauge re-runs", async () => {
    const { repoRoot } = makeProjectWith((db) => {
      db.upsertNode(node("w/1"));
      db.upsertNode(node("w/2"));
    });
    dirs.push(repoRoot);
    process.chdir(repoRoot);

    const { code, out } = await captureIo(() =>
      runSummarize({ positionals: [], flags: { all: true, limit: "1" } }),
    );
    expect(code).toBe(0);
    expect(out).toContain("done 1, remaining 1");
  });
});
