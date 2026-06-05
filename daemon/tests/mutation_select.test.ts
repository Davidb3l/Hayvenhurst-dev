/**
 * Unit tests for the PURE mutant generator (`db/mutation_select.ts`).
 *
 * Each operator gets BOTH a positive case (it produces the expected mutant) and
 * a GUARD case (it does NOT mis-mutate — a `<` inside a string, a comment line,
 * a `def`/`function` signature line). Plus determinism, the `applyMutant`
 * round-trip, and the `maxMutants` cap. These assertions are the proof that the
 * candidate generator is deterministic and conservative — the property the bench
 * relies on (a mutant it cannot reproduce is a mutant it cannot trust).
 */
import { describe, expect, it } from "bun:test";

import {
  ALL_OPS,
  applyMutant,
  generateMutants,
  type Mutant,
  type MutationOp,
} from "../src/db/mutation_select.ts";

/** Find the first mutant of a given op, or undefined. */
function first(ms: Mutant[], op: MutationOp): Mutant | undefined {
  return ms.find((m) => m.op === op);
}

/** Generate restricted to a single op (keeps positive cases isolated). */
function gen(body: string, op: MutationOp, language?: string): Mutant[] {
  return generateMutants(body, { ops: [op], language });
}

describe("boolean-flip", () => {
  it("flips a `true` literal", () => {
    const m = first(gen("  x = true", "boolean-flip"), "boolean-flip");
    expect(m).toBeDefined();
    expect(m!.mutated).toBe("  x = false");
  });

  it("flips `&&` to `||`", () => {
    const m = first(gen("  return a && b", "boolean-flip"), "boolean-flip");
    expect(m!.mutated).toBe("  return a || b");
  });

  it("flips python `and` to `or`", () => {
    const m = first(gen("    keep = a and b", "boolean-flip", "python"), "boolean-flip");
    expect(m!.mutated).toBe("    keep = a or b");
  });

  it("GUARD: does not flip `true` inside a string literal", () => {
    expect(gen('  msg = "set to true"', "boolean-flip")).toEqual([]);
  });
});

describe("comparison-swap", () => {
  it("swaps `==` to `!=`", () => {
    const m = first(gen("  if (n == 3) {", "comparison-swap"), "comparison-swap");
    expect(m!.mutated).toBe("  if (n != 3) {");
  });

  it("swaps `<=` to `>=` (multi-char before single)", () => {
    const m = first(gen("  ok = i <= len", "comparison-swap"), "comparison-swap");
    expect(m!.mutated).toBe("  ok = i >= len");
  });

  it("swaps a bare `<` to `>`", () => {
    const m = first(gen("  while i < n:", "comparison-swap", "python"), "comparison-swap");
    expect(m!.mutated).toBe("  while i > n:");
  });

  it("GUARD: leaves JS strict `===` untouched", () => {
    expect(gen("  if (a === b) {", "comparison-swap")).toEqual([]);
  });

  it("GUARD: does not swap `<` inside a string literal", () => {
    expect(gen('  label = "a < b"', "comparison-swap")).toEqual([]);
  });
});

describe("arithmetic-swap", () => {
  it("swaps `+` to `-`", () => {
    const m = first(gen("  total = a + b", "arithmetic-swap"), "arithmetic-swap");
    expect(m!.mutated).toBe("  total = a - b");
  });

  it("swaps `*` to `/`", () => {
    const m = first(gen("  area = w * h", "arithmetic-swap"), "arithmetic-swap");
    expect(m!.mutated).toBe("  area = w / h");
  });

  it("GUARD: does not touch `++` increment", () => {
    expect(gen("  i++", "arithmetic-swap")).toEqual([]);
  });

  it("GUARD: does not touch `+=` compound assignment", () => {
    expect(gen("  total += step", "arithmetic-swap")).toEqual([]);
  });
});

describe("return-empty", () => {
  it("replaces `return X` with `return null` (TS default)", () => {
    const m = first(gen("  return compute(x)", "return-empty"), "return-empty");
    expect(m!.mutated).toBe("  return null");
  });

  it("replaces `return X` with `return None` for python", () => {
    const m = first(gen("    return compute(x)", "return-empty", "python"), "return-empty");
    expect(m!.mutated).toBe("    return None");
  });

  it("preserves a trailing semicolon", () => {
    const m = first(gen("  return value;", "return-empty"), "return-empty");
    expect(m!.mutated).toBe("  return null;");
  });

  it("GUARD: a bare `return` (already neutral) is not mutated", () => {
    expect(gen("  return", "return-empty")).toEqual([]);
  });
});

describe("remove-call", () => {
  it("comments out a bare call (TS `//`)", () => {
    const m = first(gen("  logger.flush();", "remove-call"), "remove-call");
    expect(m!.mutated).toBe("  // logger.flush();");
  });

  it("comments out a bare call (python `#`)", () => {
    const m = first(gen("    cleanup()", "remove-call", "python"), "remove-call");
    expect(m!.mutated).toBe("    # cleanup()");
  });

  it("GUARD: does not comment out an assignment", () => {
    expect(gen("  x = compute()", "remove-call")).toEqual([]);
  });

  it("GUARD: does not comment out an `if` statement", () => {
    expect(gen("  if (ready()) {", "remove-call")).toEqual([]);
  });
});

describe("off-by-one", () => {
  it("bumps the first integer literal by one", () => {
    const m = first(gen("  limit = 10", "off-by-one"), "off-by-one");
    expect(m!.mutated).toBe("  limit = (10+1)");
  });

  it("GUARD: does not touch a float literal", () => {
    expect(gen("  ratio = 1.5", "off-by-one")).toEqual([]);
  });

  it("GUARD: does not touch a digit inside an identifier", () => {
    expect(gen("  v = x1 + y2", "off-by-one")).toEqual([]);
  });
});

describe("line classification", () => {
  it("skips comment lines", () => {
    expect(generateMutants("  // n == 3 here").length).toBe(0);
    expect(generateMutants("  # n == 3 here").length).toBe(0);
  });

  it("skips a `def`/`function` signature line", () => {
    expect(generateMutants("def f(a == b):").length).toBe(0);
    expect(generateMutants("function g(x < y) {").length).toBe(0);
  });

  it("skips blank lines", () => {
    expect(generateMutants("\n\n   \n").length).toBe(0);
  });
});

describe("determinism + cap + round-trip", () => {
  const body = [
    "function score(n) {", // signature — skipped
    "  if (n == 0) return 0;",
    "  let total = n + 1;",
    "  flush();",
    "  return total > 10 && true;",
    "}",
  ].join("\n");

  it("is deterministic across repeated calls", () => {
    const a = JSON.stringify(generateMutants(body));
    const b = JSON.stringify(generateMutants(body));
    expect(a).toBe(b);
  });

  it("emits mutants only on body statement lines, in line order", () => {
    const ms = generateMutants(body);
    expect(ms.length).toBeGreaterThan(0);
    // No mutant on the signature (line 1) or the closing brace (line 6).
    expect(ms.every((m) => m.line >= 2 && m.line <= 5)).toBe(true);
    // Lines are non-decreasing.
    for (let i = 1; i < ms.length; i++) {
      expect(ms[i]!.line).toBeGreaterThanOrEqual(ms[i - 1]!.line);
    }
  });

  it("respects the maxMutants cap deterministically", () => {
    const full = generateMutants(body);
    expect(full.length).toBeGreaterThan(2);
    const capped = generateMutants(body, { maxMutants: 2 });
    expect(capped.length).toBe(2);
    // The cap takes the FIRST N — identical prefix.
    expect(capped).toEqual(full.slice(0, 2));
  });

  it("maxMutants <= 0 yields no mutants", () => {
    expect(generateMutants(body, { maxMutants: 0 })).toEqual([]);
  });

  it("applyMutant round-trips: applying each mutant reproduces its mutated line", () => {
    for (const m of generateMutants(body)) {
      const mutatedBody = applyMutant(body, m);
      const line = mutatedBody.split("\n")[m.line - 1];
      expect(line).toBe(m.mutated);
      // Every OTHER line is unchanged.
      const orig = body.split("\n");
      mutatedBody.split("\n").forEach((l, i) => {
        if (i !== m.line - 1) expect(l).toBe(orig[i]!);
      });
    }
  });

  it("applyMutant throws if the body line no longer matches the original", () => {
    const m = generateMutants(body)[0]!;
    const drifted = "different first line\n" + body;
    expect(() => applyMutant(drifted, m)).toThrow();
  });

  it("default ops cover the whole catalogue", () => {
    // A body exercising every op should produce at least one mutant per op.
    const rich = [
      "  ok = true",
      "  if (a == b) {",
      "  s = x + y",
      "  return compute();",
      "  notify();",
      "  k = 7",
    ].join("\n");
    const ms = generateMutants(rich);
    const opsSeen = new Set(ms.map((m) => m.op));
    for (const op of ALL_OPS) expect(opsSeen.has(op)).toBe(true);
  });
});
