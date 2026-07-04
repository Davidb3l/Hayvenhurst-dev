/**
 * `selectRungForBudget` — fitting the escalation ladder to a token budget.
 * Pure selector over a built {@link EscalationResult}: richest rung that fits,
 * else the cheapest rung flagged `fits:false`.
 */
import { describe, expect, it } from "bun:test";
import {
  selectRungForBudget,
  type ContextRung,
  type EscalationResult,
} from "../src/db/context_escalation.ts";

function rung(level: ContextRung["level"], estTokens: number): ContextRung {
  return { level, slices: [], files: [], estTokens };
}

function result(rungs: ContextRung[]): EscalationResult {
  return { symbol: "x", resolved: null, rungs, recommended: rungs[0]!, notes: [] };
}

describe("selectRungForBudget", () => {
  const r = result([rung("pack", 100), rung("pack-2hop", 300), rung("whole-file", 900)]);

  it("picks the RICHEST rung that fits the budget", () => {
    expect(selectRungForBudget(r, 500).rung.level).toBe("pack-2hop");
    expect(selectRungForBudget(r, 500).fits).toBe(true);
  });

  it("takes the whole-file rung when the budget is ample", () => {
    const b = selectRungForBudget(r, 1000);
    expect(b.rung.level).toBe("whole-file");
    expect(b.fits).toBe(true);
  });

  it("treats an exact match as fitting", () => {
    expect(selectRungForBudget(r, 100).rung.level).toBe("pack");
    expect(selectRungForBudget(r, 300).rung.level).toBe("pack-2hop");
  });

  it("falls back to the cheapest rung (fits:false) when nothing fits", () => {
    const b = selectRungForBudget(r, 50);
    expect(b.rung.level).toBe("pack");
    expect(b.fits).toBe(false);
    expect(b.budget).toBe(50);
  });
});
