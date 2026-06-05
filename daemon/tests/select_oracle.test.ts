// selectOracle — Layer C oracle selection (ARCHITECTURE.md §17.3 / §18.4).
//
// The heuristic stays the zero-config default; an LlmOracle is returned ONLY
// when the configured oracle id names a PRESENT model AND a native binary is
// locatable. Presence + binary location are injected — no model, no binary.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { selectOracle } from "../src/conflict/oracle.ts";
import { LlmOracle } from "../src/conflict/llm_oracle.ts";
import { modelDir, modelPath } from "../src/models/registry.ts";

const MODEL = "gemma4:e2b";
const env = (over: {
  present: boolean;
  binary: string | null;
}) => ({
  hayvenDir: "/home/.hayven",
  isModelPresent: (_dir: string, _id: string) => over.present,
  modelDir: (_dir: string, _id: string) => "/home/.hayven/models/gemma4_e2b",
  locateBinary: () => over.binary,
});

describe("selectOracle — LLM-vs-heuristic decision", () => {
  test("returns LlmOracle when the model is present AND a binary is locatable", () => {
    const o = selectOracle({ conflict: { oracle: MODEL } }, env({ present: true, binary: "/bin/hayven-native" }));
    expect(o).toBeInstanceOf(LlmOracle);
    expect(o.id).toBe(MODEL);
  });

  test("falls back to heuristic when the model is NOT present", () => {
    const o = selectOracle({ conflict: { oracle: MODEL } }, env({ present: false, binary: "/bin/hayven-native" }));
    expect(o.id).toBe("heuristic-v1");
  });

  test("falls back to heuristic when no native binary is locatable", () => {
    const o = selectOracle({ conflict: { oracle: MODEL } }, env({ present: true, binary: null }));
    expect(o.id).toBe("heuristic-v1");
  });

  test("a model id with no env (legacy caller) degrades to heuristic", () => {
    expect(selectOracle({ conflict: { oracle: MODEL } }).id).toBe("heuristic-v1");
  });

  test("heuristic-v1 / unknown / unset keys stay heuristic even with a present model env", () => {
    expect(selectOracle({ conflict: { oracle: "heuristic-v1" } }, env({ present: true, binary: "/b" })).id)
      .toBe("heuristic-v1");
    expect(selectOracle().id).toBe("heuristic-v1");
  });
});

describe("selectOracle — BL-14: real presence activates the LlmOracle on a gguf-only dir", () => {
  // End-to-end guard using the REAL isModelPresent/modelDir (not the injected
  // fakes above). BL-14 resolved: `hayven-native infer` builds the tokenizer
  // from the GGUF's embedded metadata, so a `hayven models pull` that landed
  // only model.gguf is fully usable and MUST activate the LlmOracle (given a
  // locatable binary). No sidecar tokenizer.json is required.
  test("a gguf-only model dir activates the LlmOracle when a binary is locatable", () => {
    const dir = mkdtempSync(join(tmpdir(), "hayven-oracle-bl14-"));
    const hayvenDir = join(dir, ".hayven");
    const MODEL = "gemma4:e2b";
    try {
      const md = modelDir(hayvenDir, MODEL)!;
      mkdirSync(md, { recursive: true });
      writeFileSync(modelPath(hayvenDir, MODEL)!, "weights"); // model.gguf only

      // Real presence check + a locatable binary: model.gguf alone is enough now
      // that the tokenizer is built from the GGUF.
      const ggufOnly = selectOracle(
        { conflict: { oracle: MODEL } },
        { hayvenDir, locateBinary: () => "/bin/hayven-native" },
      );
      expect(ggufOnly).toBeInstanceOf(LlmOracle);
      expect(ggufOnly.id).toBe(MODEL);

      // Removing the weights → not present → falls back to the heuristic.
      rmSync(modelPath(hayvenDir, MODEL)!);
      const gone = selectOracle(
        { conflict: { oracle: MODEL } },
        { hayvenDir, locateBinary: () => "/bin/hayven-native" },
      );
      expect(gone).not.toBeInstanceOf(LlmOracle);
      expect(gone.id).toBe("heuristic-v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
