/**
 * Default Hayvenhurst configuration.
 *
 * Per PRD §14. The local-model defaults are UNGATED bartowski Q4_K_M Gemma-3
 * builds, NOT the PRD's aspirational Gemma-4: candle-transformers 0.10.2 (the
 * locked §18 engine) has no quantized Gemma-4 loader, so a Gemma-4 GGUF cannot
 * load today. Gemma-3 loads and already saturates the conflict oracle's
 * instruction-following task (IFEval ~90). (Google's QAT q4_0 Gemma-3 is higher
 * quality but HF-gated — a documented opt-in, not the default; see the registry
 * module header.) See CHANGELOG "BL-18".
 *
 * `conflict.oracle` defaults to the deterministic `contract-diff` oracle
 * (ARCHITECTURE.md §17.3 / CLAUDE.md item 6(b)). This is a DELIBERATE, measured
 * flip from the former `gemma3:1b` default: on REAL entity bodies + the real edge
 * index (daemon/tests/conflict_rate_contractdiff.test.ts, 8 seeds) contract-diff
 * cuts adjacent-benign over-blocking from ~52-64% to ~10-21% while keeping
 * conflict-escapes EQUAL-OR-BETTER and independent-overblock at 0 (the heuristic
 * itself over-blocks 4-9 "independent" pairs on the real graph via shared-third-
 * neighbor structure; contract-diff does not). The local single-shot LLM oracle
 * was measured WORSE than the heuristic and never fires inside the 2 s timeout
 * (docs/ORACLE_WARMTH_DECISION.md §9), so the former `gemma3:1b` default added no
 * Layer-C value zero-config.
 *
 * SAFE WITHOUT A NATIVE BINARY: `selectOracle` requires a locatable native binary
 * + a live Db + a repoRoot to build contract-diff; lacking any of them it degrades
 * to the deterministic `heuristic-v1` (oracle.ts), so the zero-config / no-binary
 * experience is UNCHANGED. Layer A (overlap → 409) and Layer B (merge-time verify)
 * are independent of the oracle, so the §16(4) realized-conflict number does not
 * depend on this choice — only Layer-C precision on adjacent claims does.
 */

export interface ModelConfig {
  provider: string;
  model: string;
}

export interface HayvenConfig {
  models: {
    tier1: ModelConfig;
    tier2: ModelConfig;
    tier3: ModelConfig;
    fallback: ModelConfig;
  };
  trace_sample_rate: number;
  sync_peers: string[];
  daemon_port: number;
  daemon_host: string;
  auto_sync_interval_minutes: number;
  max_node_summary_tokens: number;
  /** Languages the native binary should parse on ingest. */
  parse_languages: string[];
  /** Parser parallelism. 0 = autodetect (let native binary decide). */
  parse_jobs: number;
  /** Timeout in seconds for a single ingest invocation. */
  ingest_timeout_seconds: number;
  /**
   * Layer C conflict-defense settings (ARCHITECTURE.md §17.3). Optional; the
   * claim path defaults to the deterministic `heuristic-v1` oracle when unset.
   * The Tier-3 LLM oracle (PRD §7.3/§8) is selected here later by id.
   */
  conflict?: {
    /** Oracle id, e.g. "heuristic-v1". Drop-in selection seam. */
    oracle?: string;
  };
  /**
   * Branch-aware (per-branch) indexing (Phase 0.0.4.5 §5 item 3). When enabled
   * AND the project is a git repo, each branch gets its own cached index at
   * `.hayven/branches/<branchKey>/index.sqlite`, so switching back to a
   * previously-indexed branch is INSTANT (the index already exists — no
   * re-ingest, and never any re-embedding since hayven is embedding-free). The
   * legacy `.hayven/index.sqlite` stays as a read fallback for branches that
   * have not been ingested yet. Off (or non-git) → the legacy single index is
   * used exactly as before.
   */
  index?: {
    /** Per-branch caching. Default true; only takes effect in a git repo. */
    perBranch?: boolean;
    /**
     * LRU cap on the number of cached per-branch indexes; the
     * least-recently-ingested branches beyond this are evicted so `.hayven`
     * does not grow unbounded. Default 8. The legacy index is never evicted.
     */
    maxBranches?: number;
  };
  /**
   * Test-impact selection (`hayven affected-tests`). `patterns` overrides the
   * PATH patterns that mark a file as a test file (substring match on the
   * repo-relative path); when unset, `db/test_nodes.ts::DEFAULT_TEST_PATH_PATTERNS`
   * is used. Language-based NAME conventions (`test_*`, `Test*`, …) are facts of
   * each runner and always apply regardless of this setting.
   */
  test?: {
    /** Path patterns that mark a file as a test file. Replaces the defaults. */
    patterns?: string[];
  };
}

export const DEFAULT_CONFIG: HayvenConfig = {
  models: {
    tier1: { provider: "anthropic", model: "claude-opus-4-7" },
    tier2: { provider: "local", model: "gemma3:4b" },
    tier3: { provider: "local", model: "gemma3:1b" },
    fallback: { provider: "groq", model: "llama-3.3-70b" },
  },
  trace_sample_rate: 100,
  sync_peers: [],
  daemon_port: 7777,
  daemon_host: "127.0.0.1",
  auto_sync_interval_minutes: 30,
  max_node_summary_tokens: 500,
  // NOTE: "tsx" is distinct from "typescript" in the native parser (separate
  // tree-sitter grammar — `.tsx` files). Omitting it silently dropped the entire
  // Preact component layer from the index (`.tsx`=0 entities) until 2026-06.
  // "astro" has NO Astro grammar: the native parser indexes only the `---…---`
  // TypeScript frontmatter of `.astro` files (imports / Props / server logic)
  // via the TS grammar; the HTML+JSX template is skipped. Without "astro" here
  // the daemon's `--langs` ingest filter drops `.astro` entirely (the same
  // filter that hid `.tsx`). See native/docs/TREE_SITTER_NOTES.md "Astro".
  parse_languages: ["python", "typescript", "tsx", "javascript", "rust", "go", "astro"],
  parse_jobs: 0,
  ingest_timeout_seconds: 300,
  // Deterministic contract-diff oracle (§17.3) is the measured default. Degrades
  // to `heuristic-v1` when no native binary / Db / repoRoot is available, so the
  // zero-config / no-binary path stays safe. See the module header for the gate.
  conflict: { oracle: "contract-diff" },
  // Per-branch index caching (§5 item 3). Default on; a no-op outside a git
  // repo. Legacy `.hayven/index.sqlite` remains the fallback for un-ingested
  // branches, so existing single-index projects are unaffected.
  index: { perBranch: true, maxBranches: 8 },
};
