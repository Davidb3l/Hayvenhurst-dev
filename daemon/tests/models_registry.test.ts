// Model registry helpers — ARCHITECTURE.md §18.2 + the per-model-dir layout.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GGUF_FILENAME,
  MODEL_REGISTRY,
  isModelPresent,
  modelDir,
  modelDirName,
  modelPath,
  modelsDir,
} from "../src/models/registry.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";

describe("model registry", () => {
  test("config MODEL defaults resolve to LOADABLE registry entries", () => {
    // Every MODEL id the DEFAULT_CONFIG points at must exist AND be candle-loadable
    // — defaults must never point at a dead model (e.g. the gemma4:* entries).
    // NB: `conflict.oracle` is NO LONGER a model id — the measured default is the
    // deterministic `contract-diff` oracle (config/defaults.ts header), which is
    // NOT in MODEL_REGISTRY and must not be checked as a model.
    const ids = [
      DEFAULT_CONFIG.models.tier3.model,
      DEFAULT_CONFIG.models.tier2.model,
    ];
    for (const id of ids) {
      const e = MODEL_REGISTRY[id];
      expect(e, `${id} is a known model`).toBeDefined();
      expect(e!.loadable, `${id} is candle-loadable`).toBe(true);
    }
    expect(MODEL_REGISTRY[DEFAULT_CONFIG.models.tier3.model]!.tier).toBe(3);
    // The conflict oracle default is the deterministic contract-diff lever, not a
    // pulled model (it degrades to heuristic-v1 without a native binary).
    expect(DEFAULT_CONFIG.conflict!.oracle!).toBe("contract-diff");
    expect(MODEL_REGISTRY["contract-diff"]).toBeUndefined();
  });

  test("every entry declares a model.gguf artifact with a real https HF url + parseable coords", () => {
    for (const e of Object.values(MODEL_REGISTRY)) {
      const gguf = e.artifacts.find((a) => a.filename === GGUF_FILENAME);
      expect(gguf, `${e.id} has a model.gguf artifact`).toBeDefined();
      expect(gguf!.url).toMatch(/^https:\/\//);
      // The url must parse to a HF `resolve/main/<file>.gguf` coordinate so the
      // (repo id, filename) the registry references is well-formed against HF.
      const m = gguf!.url.match(
        /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/([^/?#]+\.gguf)$/,
      );
      expect(m, `${e.id} url parses to <repo>/resolve/main/<file>.gguf`).not.toBeNull();
      // Hashes are either empty (unverified, allowed) or 64 lowercase-hex chars.
      expect(gguf!.sha256 === "" || /^[0-9a-f]{64}$/.test(gguf!.sha256)).toBe(true);
    }
  });

  test("every artifact hash is either a well-formed 64-hex sha256 or the verify-skip sentinel", () => {
    // Hashes must NEVER be invented. EVERY entry now pins a real 64-lowercase-hex
    // sha256 (published HF LFS oids, or a locally-computed download-to-compute hash
    // for gemma3:4b) — no "" verify-skip sentinels remain, so `pull` verifies every
    // artifact. The empty set keeps the guard in place: any future "" hash fails.
    const sentinelAllowed = new Set<string>([]);
    for (const e of Object.values(MODEL_REGISTRY)) {
      for (const a of e.artifacts) {
        if (a.sha256 === "") {
          expect(
            sentinelAllowed.has(e.id),
            `${e.id}/${a.filename} empty hash is an expected verify-skip`,
          ).toBe(true);
          continue;
        }
        expect(
          /^[0-9a-f]{64}$/.test(a.sha256),
          `${e.id}/${a.filename} hash is 64 lowercase-hex`,
        ).toBe(true);
      }
    }
  });

  test("the default tier-3 model gemma3:1b is the verified ungated bartowski Q4_K_M (loadable)", () => {
    // BL-18: the registry model candle 0.10.2 loads end-to-end (Gemma-3 arch via
    // quantized_gemma3) — the default LOCAL tier-3 model, ungated bartowski Q4_K_M
    // with a real pinned sha256 (Google's QAT q4_0 is higher quality but HF-gated →
    // opt-in). NB: gemma3:1b is no longer the conflict-ORACLE default — that is the
    // deterministic `contract-diff` lever now (see config/defaults.ts header) — but
    // it remains the default tier-3 model for reflex/summary use.
    const e = MODEL_REGISTRY["gemma3:1b"];
    expect(e, "gemma3:1b is registered").toBeDefined();
    expect(e!.tier).toBe(3); // default reflex/oracle tier
    expect(e!.params).toBe("1B");
    expect(e!.loadable).toBe(true);
    expect(e!.artifacts[0]!.url).toBe(
      "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf",
    );
    expect(/^[0-9a-f]{64}$/.test(e!.artifacts[0]!.sha256)).toBe(true);
  });

  test("gemma3:4b is the ungated bartowski Q4_K_M workhorse (tier-2, Gemma-3 arch, loadable)", () => {
    const e = MODEL_REGISTRY["gemma3:4b"];
    expect(e, "gemma3:4b is registered").toBeDefined();
    expect(e!.tier).toBe(2);
    expect(e!.params).toBe("4B");
    expect(e!.loadable).toBe(true);
    expect(e!.artifacts[0]!.url).toBe(
      "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/main/google_gemma-3-4b-it-Q4_K_M.gguf",
    );
    const h = e!.artifacts[0]!.sha256;
    expect(h === "" || /^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  test("loadable flags: gemma3:* loadable, gemma4:*/gemma2:2b not (candle 0.10.2)", () => {
    expect(MODEL_REGISTRY["gemma3:1b"]!.loadable).toBe(true);
    expect(MODEL_REGISTRY["gemma3:4b"]!.loadable).toBe(true);
    expect(MODEL_REGISTRY["gemma4:e2b"]!.loadable).toBe(false);
    expect(MODEL_REGISTRY["gemma4:e4b"]!.loadable).toBe(false);
    expect(MODEL_REGISTRY["gemma4:26b"]!.loadable).toBe(false);
    expect(MODEL_REGISTRY["gemma2:2b"]!.loadable).toBe(false);
  });

  test("gemma2:2b is a real, sha256-pinned Gemma-2 tier-2 entry (candle layout caveat)", () => {
    const e = MODEL_REGISTRY["gemma2:2b"];
    expect(e, "gemma2:2b is registered").toBeDefined();
    expect(e!.tier).toBe(2);
    expect(e!.artifacts[0]!.url).toContain("bartowski/gemma-2-2b-it-GGUF");
    expect(e!.artifacts[0]!.sha256).toBe(
      "e0aee85060f168f0f2d8473d7ea41ce2f3230c1bc1374847505ea599288a7787",
    );
  });

  test("modelDirName replaces ':' and '/' with '_'", () => {
    expect(modelDirName("gemma4:e2b")).toBe("gemma4_e2b");
    expect(modelDirName("ns/model:tag")).toBe("ns_model_tag");
  });

  test("modelDir is <hayvenDir>/models/<dirname>; null for unknown", () => {
    expect(modelDir("/home/x/.hayven", "gemma4:e2b")).toBe(
      join(modelsDir("/home/x/.hayven"), "gemma4_e2b"),
    );
    expect(modelDir("/home/x/.hayven", "nope:0b")).toBeNull();
  });

  test("modelPath points at model.gguf inside the model dir", () => {
    expect(modelPath("/home/x/.hayven", "gemma4:e2b")).toBe(
      join(modelsDir("/home/x/.hayven"), "gemma4_e2b", GGUF_FILENAME),
    );
  });

  test("unknown id → null path, not present", () => {
    expect(modelPath("/x/.hayven", "nope:0b")).toBeNull();
    expect(isModelPresent("/x/.hayven", "nope:0b")).toBe(false);
  });

  test("isModelPresent gates on the declared model.gguf artifact alone (BL-14)", () => {
    // BL-14 resolved: `hayven-native infer` builds the tokenizer from the GGUF's
    // embedded metadata, so a sidecar tokenizer.json is optional. A model is
    // fully present and usable with ONLY model.gguf — presence keys on the
    // declared artifacts, which is exactly what `hayven models pull` fetches.
    const dir = mkdtempSync(join(tmpdir(), "hayven-models-"));
    const hayvenDir = join(dir, ".hayven");
    try {
      const md = modelDir(hayvenDir, "gemma4:e2b")!;
      expect(isModelPresent(hayvenDir, "gemma4:e2b")).toBe(false); // nothing on disk

      mkdirSync(md, { recursive: true });
      writeFileSync(modelPath(hayvenDir, "gemma4:e2b")!, "stub-weights");
      // model.gguf alone → present (no tokenizer sidecar needed).
      expect(isModelPresent(hayvenDir, "gemma4:e2b")).toBe(true);

      // Removing the weights flips it back to not-present.
      rmSync(modelPath(hayvenDir, "gemma4:e2b")!);
      expect(isModelPresent(hayvenDir, "gemma4:e2b")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
