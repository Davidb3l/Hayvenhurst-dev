// LlmOracle — Layer C upgrade (ARCHITECTURE.md §18.4, PRD §7.3).
//
// Coverage, all with a MOCKED infer fn (no native binary, no model weights):
//   - YES → conflict:true with the model's confidence + reason;
//   - NO  → conflict:false;
//   - timeout/infer-failure → falls back to the HeuristicOracle's verdict;
//   - garbage/unparseable output → falls back to the HeuristicOracle's verdict;
//   - the prompt carries the §7.3 question + both claims' intent.
import { describe, expect, test } from "bun:test";

import {
  buildPrompt,
  LlmOracle,
  parseVerdict,
  type InferFn,
} from "../src/conflict/llm_oracle.ts";
import { HeuristicOracle, type ClaimContext } from "../src/conflict/oracle.ts";
import type { InferResult } from "../src/native/infer.ts";

const ID = "gemma4:e2b";

/** An infer fn that always returns the given result. */
function infer(result: InferResult): InferFn {
  return async () => result;
}

// Two contexts that the HEURISTIC would call a conflict (shared neighbor +
// shared identifier tokens) — so a fallback verdict is distinguishable by its
// `oracle` provenance, not just its boolean.
const incoming: ClaimContext = {
  scope: ["auth/login/handler"],
  intent: "Refactor the session token validation in login",
  neighbors: ["auth/session/token"],
};
const adjacent: ClaimContext = {
  scope: ["auth/session/token"],
  intent: "Change the token validation contract",
  neighbors: ["auth/login/handler"],
};

function newOracle(result: InferResult): LlmOracle {
  return new LlmOracle({ id: ID, fallback: new HeuristicOracle(), infer: infer(result) });
}

describe("LlmOracle.assess", () => {
  test("YES → conflict:true, model confidence + reason, oracle provenance", async () => {
    const oracle = newOracle({
      ok: true,
      completion: "YES, both edits change the token validation contract.",
    });
    const v = await oracle.assess(incoming, adjacent);
    expect(v.conflict).toBe(true);
    expect(v.oracle).toBe(ID);
    expect(v.confidence).toBe(0.9);
    expect(v.reason.toLowerCase()).toContain("token");
  });

  test("NO → conflict:false from the model", async () => {
    const oracle = newOracle({
      ok: true,
      completion: "NO, the changes are internal and independent.",
    });
    const v = await oracle.assess(incoming, adjacent);
    expect(v.conflict).toBe(false);
    expect(v.oracle).toBe(ID);
    expect(v.confidence).toBe(0.9);
  });

  test("timeout / infer failure → falls back to HeuristicOracle verdict", async () => {
    const oracle = newOracle({ ok: false, completion: "", error: "infer timed out after 2000ms" });
    const v = await oracle.assess(incoming, adjacent);
    // The heuristic flags THIS pair as a conflict, and names itself.
    expect(v.oracle).toBe("heuristic-v1");
    expect(v.conflict).toBe(true);
    // Identical to calling the heuristic directly.
    const direct = await new HeuristicOracle().assess(incoming, adjacent);
    expect(v).toEqual(direct);
  });

  test("garbage / unparseable output → falls back to HeuristicOracle verdict", async () => {
    const oracle = newOracle({ ok: true, completion: "¯\\_(ツ)_/¯ maybe?" });
    const v = await oracle.assess(incoming, adjacent);
    expect(v.oracle).toBe("heuristic-v1");
    const direct = await new HeuristicOracle().assess(incoming, adjacent);
    expect(v).toEqual(direct);
  });

  test("an infer fn that THROWS is caught and falls back (never throws into the claim path)", async () => {
    const oracle = new LlmOracle({
      id: ID,
      fallback: new HeuristicOracle(),
      infer: async () => {
        throw new Error("boom");
      },
    });
    const v = await oracle.assess(incoming, adjacent);
    expect(v.oracle).toBe("heuristic-v1");
  });
});

describe("buildPrompt", () => {
  test("contains the §7.3 question and both claims' intent + scope", () => {
    const p = buildPrompt(incoming, adjacent);
    expect(p).toContain("break each other's assumptions");
    expect(p).toContain("Begin your reply with the single word YES or NO");
    expect(p).toContain(incoming.intent);
    expect(p).toContain(adjacent.intent);
    expect(p).toContain("auth/session/token");
  });
});

describe("parseVerdict", () => {
  test("clear YES with a reason → conflict:true, 0.9", () => {
    const v = parseVerdict("YES, they collide on the schema.", ID);
    expect(v).not.toBeNull();
    expect(v!.conflict).toBe(true);
    expect(v!.confidence).toBe(0.9);
    expect(v!.reason).toBe("they collide on the schema.");
  });

  test("bare NO with no reason → conflict:false, lower confidence 0.6", () => {
    const v = parseVerdict("NO", ID);
    expect(v!.conflict).toBe(false);
    expect(v!.confidence).toBe(0.6);
  });

  test("first YES/NO wins even if the other word appears later in prose", () => {
    const v = parseVerdict("NO. There is no way these conflict, yes I'm sure.", ID);
    expect(v!.conflict).toBe(false);
  });

  test("no recognizable YES/NO → null (caller falls back)", () => {
    expect(parseVerdict("perhaps, it depends", ID)).toBeNull();
    expect(parseVerdict("", ID)).toBeNull();
  });

  test("whitespace-only completion → null (caller falls back)", () => {
    expect(parseVerdict("   \n\t  ", ID)).toBeNull();
  });

  test("word-boundary: 'no' false-friends ('not'/'none'/'nope') don't read as NO", () => {
    // The verdict token is matched at word boundaries, so a leading "Not"/
    // "None"/"Nope" must NOT be parsed as a bare NO. Here the real verdict is
    // the later YES, which must win.
    const v = parseVerdict("Not certain at a glance, but YES they overlap.", ID);
    expect(v).not.toBeNull();
    expect(v!.conflict).toBe(true);
    // A completion that is ONLY false-friends and no real verdict → null.
    expect(parseVerdict("None of this is nope nonsense.", ID)).toBeNull();
  });
});
