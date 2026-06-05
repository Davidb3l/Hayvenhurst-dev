/**
 * Local model registry — ARCHITECTURE.md §18.2 source of truth.
 *
 * Maps a model id (the string `config.models.tierN.model` references) to its
 * download artifacts, hardware floor, and parameter size. `hayven doctor`
 * reports presence (§18.5); `hayven models pull <id>` (this slice) downloads +
 * sha256-verifies each artifact into the model's per-model directory.
 *
 * MODEL LAYOUT CONTRACT (must match the native `infer` + the LlmOracle agents):
 *   A model id's artifacts live in a per-model DIRECTORY:
 *       <.hayven>/models/<dirname>/
 *   where `dirname` = the id with ':' and '/' replaced by '_'
 *   (e.g. "gemma4:e2b" → "gemma4_e2b"). The directory contains `model.gguf` —
 *   the single declared (downloadable) artifact and the only file presence is
 *   keyed on (see TOKENIZER note).
 *
 * REAL COORDINATES: the `url`/`sha256` below point at concrete, currently-
 * available Gemma GGUF artifacts on Hugging Face. The sha256 values are the
 * **published LFS oids** read from the HF tree API for each blob, so `pull`
 * can verify without us ever downloading the multi-GB weights here. Each oid
 * was re-verified (BL-18) against the HF `paths-info` API (`POST
 * /api/models/<repo>/paths-info/main` → `lfs.oid`); the values below are those
 * published oids, never invented.
 *
 * TOKENIZER (BL-14 resolved): the native `infer` builds the tokenizer directly
 * from the GGUF's embedded metadata, so a sidecar `tokenizer.json` is OPTIONAL
 * — a model is fully present and usable with ONLY `model.gguf`. (A sidecar
 * `tokenizer.json`, if a user drops one in, is honored by `hayven-native` as an
 * override, but the daemon does not require or fetch it.) Presence therefore
 * gates solely on the declared `entry.artifacts`, which lets a `hayven models
 * pull` that landed only `model.gguf` correctly flip the model to "present" and
 * let `selectOracle` activate the LlmOracle.
 *
 * ID ALIASING: the registry ids (`gemma4:e2b` etc.) are kept STABLE for config
 * compatibility (`DEFAULT_CONFIG.models.tier3.model` references them, and
 * `hardware/detect.ts` recommends by id). The aspirational PRD §8 "gemma4:*"
 * names are aliased onto the real published Gemma builds:
 *   gemma4:e2b → bartowski/google_gemma-4-E2B-it-GGUF (Q4_K_M)
 *   gemma4:e4b → bartowski/google_gemma-4-E4B-it-GGUF (Q4_K_M)
 *   gemma4:26b → bartowski/gemma-2-27b-it-GGUF       (Q4_K_M)
 *
 * CANDLE-LOADABLE e2e TARGET (BL-18, empirically determined): candle-
 * transformers 0.10.2 has no `quantized_gemma4` module, so the Gemma-4 E-series
 * (`gemma4:e2b`/`e4b`) CANNOT be loaded by the current native. Its only Gemma
 * loader is `quantized_gemma3`, which expects the Gemma-3 tensor layout —
 * VERIFIED by a real pull+load here:
 *   - `gemma2:2b` (real Gemma 2 build) loads its arch + GGUF tokenizer but FAILS
 *     weight load: `cannot find tensor info for blk.0.attn_q_norm.weight`
 *     (Gemma 2 lacks the per-layer q/k-norm tensors `quantized_gemma3` wants).
 *   - `gemma3:1b` (real Gemma 3 build) loads fully and runs inference.
 * So `gemma3:1b` is the SMALLEST registry model the current native can actually
 * load end-to-end, and it is the DEFAULT local oracle / reflex model.
 *
 * DEFAULT ORACLE = the UNGATED, verified bartowski Q4_K_M `gemma3:1b` (the only
 * model pulled + loaded + run end-to-end here). Google ALSO ships official
 * Quantization-Aware-Training (QAT) q4_0 Gemma-3 GGUFs
 * (`google/gemma-3-{1b,4b}-it-qat-q4_0-gguf`) that recover most of the IFEval
 * quality naive Q4 costs a small model — BUT those repos are HF "gated" (manual
 * license acceptance + token), so `pull` 401s without auth. A gated default would
 * break the zero-config pull, so QAT is documented as an OPT-IN (a user who has
 * accepted the license + set an HF token can point `conflict.oracle`'s model URL
 * at the QAT repo). For our single-shot YES/NO oracle the Q4_K_M is already ample
 * (Gemma-3 saturates IFEval ~90), so the marginal QAT gain doesn't justify gating.
 *
 * `loadable` marks whether candle 0.10.2 can run an entry: `gemma3:*` = true;
 * `gemma4:*` = false (no `quantized_gemma4` loader); `gemma2:2b` = false (the
 * `attn_q_norm` layout gap above). `recommendTier3Model` (`hardware/detect.ts`)
 * recommends only loadable entries, so `doctor` never suggests a dead model. The
 * `gemma4:*`/`gemma2:2b` entries are kept (real builds + real hashes) for the day
 * a loader lands. The `gemma4:*` sha256 below are real published HF LFS oids.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The canonical filename of a model's primary weights inside its model dir. */
export const GGUF_FILENAME = "model.gguf";

export interface ModelArtifact {
  /** Filename inside the per-model directory, e.g. "model.gguf". */
  readonly filename: string;
  /** Download URL (HTTPS) for the artifact's bytes. */
  readonly url: string;
  /**
   * Expected lowercase-hex sha256 of the downloaded bytes. Empty string means
   * "unverified — no published hash"; `pull` warns loudly and skips verification
   * for that artifact rather than inventing a hash.
   */
  readonly sha256: string;
}

export interface ModelEntry {
  /** Stable id; equals the `config.models.tierN.model` string. */
  readonly id: string;
  /** Strata tier (PRD §8). Tier-3 is the reflex tier the Layer C oracle uses. */
  readonly tier: 2 | 3;
  /** Human-facing parameter size, e.g. "2B". */
  readonly params: string;
  /** RAM floor (MB) to load it comfortably. Used by tier recommendation. */
  readonly minRamMb: number;
  /**
   * Whether candle-transformers 0.10.2 can actually LOAD + run this entry today.
   * `gemma3:*` = true; `gemma4:*` = false (no `quantized_gemma4` loader);
   * `gemma2:2b` = false (the `attn_q_norm` layout gap). `recommendTier3Model`
   * only recommends loadable entries so `doctor` never suggests a dead model.
   */
  readonly loadable: boolean;
  /**
   * Artifacts that make up the model on disk. The first artifact whose filename
   * is `model.gguf` is the weights; presence is keyed on it (see isModelPresent).
   */
  readonly artifacts: readonly ModelArtifact[];
}

/**
 * Keyed by the config model string so a configured `models.tier3.model` looks
 * up directly. Ids mirror the PRD §8 naming (`gemma4:e2b` etc.), aliased onto
 * the real Gemma builds documented in the module header.
 */
export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  "gemma4:e2b": {
    id: "gemma4:e2b",
    tier: 3,
    params: "2B (effective)",
    minRamMb: 3072,
    loadable: false, // no quantized_gemma4 loader in candle 0.10.2
    artifacts: [
      {
        filename: GGUF_FILENAME,
        url: "https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_K_M.gguf",
        sha256: "b5310340b3a23d31655d7119d100d5df1b2d8ee17b3ca8b0a23ad7e9eb5fa705",
      },
    ],
  },
  "gemma4:e4b": {
    id: "gemma4:e4b",
    tier: 3,
    params: "4B (effective)",
    minRamMb: 6144,
    loadable: false, // no quantized_gemma4 loader in candle 0.10.2
    artifacts: [
      {
        filename: GGUF_FILENAME,
        url: "https://huggingface.co/bartowski/google_gemma-4-E4B-it-GGUF/resolve/main/google_gemma-4-E4B-it-Q4_K_M.gguf",
        sha256: "51865750adafd22de56994a343d5a887cc1a589b9bae41d62b748c8bd0ca9c76",
      },
    ],
  },
  "gemma4:26b": {
    id: "gemma4:26b",
    tier: 2,
    params: "27B",
    minRamMb: 24576,
    loadable: false, // aliased to gemma-2-27b; candle's quantized_gemma3 can't load Gemma-2 (q_norm gap)
    artifacts: [
      {
        filename: GGUF_FILENAME,
        url: "https://huggingface.co/bartowski/gemma-2-27b-it-GGUF/resolve/main/gemma-2-27b-it-Q4_K_M.gguf",
        sha256: "503a87ab47c9e7fb27545ec8592b4dc4493538bd47b397ceb3197e10a0370d23",
      },
    ],
  },
  // DEFAULT local oracle / reflex model (tier-3). Ungated bartowski Q4_K_M Gemma 3
  // (1B) build (~806 MB) — the ONLY registry model pulled + loaded + run
  // end-to-end here (BL-18): candle 0.10.2 `quantized_gemma3` loads it and the
  // LlmOracle returns real YES/NO verdicts. Ungated, so `pull` works with no auth.
  // (Google's QAT q4_0 1B is higher quality but HF-gated — see the module header
  // for the opt-in; not the default, to keep the pull zero-config.)
  "gemma3:1b": {
    id: "gemma3:1b",
    tier: 3,
    params: "1B",
    minRamMb: 2048,
    loadable: true,
    artifacts: [
      {
        filename: GGUF_FILENAME,
        url: "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf",
        sha256: "12bf0fff8815d5f73a3c9b586bd8fee8e7b248c935de70dec367679873d0f29d",
      },
    ],
  },
  // Gemma-3 "workhorse" (tier-2): ungated bartowski Q4_K_M Gemma 3 (4B) build
  // (~3.3 GB). Same Gemma-3 arch as gemma3:1b, so `quantized_gemma3` loads it;
  // higher quality for the heavier local jobs (summaries / query expansion) when a
  // user has the RAM. Ungated (no auth). sha256 is the real, pinned + verified hash
  // (computed by a full local download-to-compute of the GGUF bytes), so `pull`
  // verifies the artifact like every other entry.
  "gemma3:4b": {
    id: "gemma3:4b",
    tier: 2,
    params: "4B",
    minRamMb: 6144,
    loadable: true,
    artifacts: [
      {
        filename: GGUF_FILENAME,
        url: "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf",
        sha256: "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94",
      },
    ],
  },
  // A real Gemma 2 (2B) Q4_K_M build (~1.7 GB). sha256-verified, but candle
  // 0.10.2's `quantized_gemma3` CANNOT load it (missing `attn_q_norm` tensors —
  // see the module header). Kept as a real entry documenting that layout gap; it
  // will load once candle ships a Gemma-2 quantized loader. Tier-2 (no effect on
  // tier-3 recommendation).
  "gemma2:2b": {
    id: "gemma2:2b",
    tier: 2,
    params: "2B",
    minRamMb: 3072,
    loadable: false, // candle's quantized_gemma3 can't load Gemma-2 (attn_q_norm gap)
    artifacts: [
      {
        filename: GGUF_FILENAME,
        url: "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF/resolve/main/gemma-2-2b-it-Q4_K_M.gguf",
        sha256: "e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787",
      },
    ],
  },
};

/** The `.hayven/models/` directory for a given `.hayven` home. */
export function modelsDir(hayvenDir: string): string {
  return join(hayvenDir, "models");
}

/**
 * Per-model directory NAME (not a path): the id with the two structural
 * separators `:` and `/` replaced by `_` so it is a single safe path segment.
 * e.g. "gemma4:e2b" → "gemma4_e2b".
 */
export function modelDirName(id: string): string {
  return id.replace(/[:/]/g, "_");
}

/**
 * The per-model directory for an id, or null for an unknown id.
 * `<.hayven>/models/<dirname>/` per the model-layout contract.
 */
export function modelDir(hayvenDir: string, id: string): string | null {
  const entry = MODEL_REGISTRY[id];
  return entry ? join(modelsDir(hayvenDir), modelDirName(id)) : null;
}

/**
 * Absolute path to the model id's primary weights (`<dir>/model.gguf`), or null
 * for an unknown id. Kept for `hayven doctor`'s "expected at" message.
 */
export function modelPath(hayvenDir: string, id: string): string | null {
  const dir = modelDir(hayvenDir, id);
  return dir ? join(dir, GGUF_FILENAME) : null;
}

/**
 * Whether the model is fully present AND loadable on disk — true iff EVERY
 * declared artifact (i.e. `model.gguf`) exists in the model's per-model
 * directory.
 *
 * Presence keys solely on the declared (downloadable) artifacts: the native
 * `infer` builds the tokenizer from the GGUF's embedded metadata (BL-14
 * resolved), so no sidecar `tokenizer.json` is needed for a model to be usable.
 * A `hayven models pull` that landed only `model.gguf` is therefore correctly
 * reported present, which lets `selectOracle` activate the LlmOracle. See the
 * module header's TOKENIZER note.
 */
export function isModelPresent(hayvenDir: string, id: string): boolean {
  const dir = modelDir(hayvenDir, id);
  const entry = MODEL_REGISTRY[id];
  if (dir === null || entry === undefined) return false;
  return entry.artifacts.every((a) => existsSync(join(dir, a.filename)));
}
