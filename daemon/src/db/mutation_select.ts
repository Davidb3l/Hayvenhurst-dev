/**
 * MUTATION-GUIDED CONFIDENCE — the pure mutant generator (Lane D).
 *
 * WHY this exists: `affected-tests` selects a test set for a change, but "these
 * tests cover the code" does NOT prove they would CATCH a bug in it. Mutation
 * testing is the gold standard answer: introduce a small, SEMANTIC change (a
 * "mutant") into the changed symbol's body, then check that the selected test
 * set FAILS — i.e. KILLS the mutant. The fraction of mutants killed (the
 * MUTATION SCORE of the selection) is the verification OF the verification: hard
 * proof the selected tests actually guard the code, which model intelligence
 * provably cannot self-supply.
 *
 * This module is the PURE, deterministic core: given a function/method BODY (a
 * string), produce candidate source mutants and apply them. It is intentionally
 * SIMPLE and LANGUAGE-AWARE-but-shallow — it operates per LINE with conservative
 * token/regex matches, never an AST. That keeps it dependency-free, fast, and
 * trivially deterministic (same input → same output, same order, no randomness),
 * which is exactly what a measurement harness needs: a mutant that the bench
 * cannot reproduce byte-for-byte is a mutant the bench cannot trust.
 *
 * PURITY CONTRACT: no I/O, no clock, no RNG, no `Db` — just string in, mutants
 * out. The bench (`bench/mutation-confidence.ts`) is the ONLY place that touches
 * the filesystem / runs tests; this helper must stay importable and testable in
 * isolation. It deliberately does NOT depend on `affected_tests.ts` (the bench
 * wires the two together; the generator knows nothing about selection).
 *
 * HONEST LIMITATIONS (documented, not hidden — see DESIGN_LESSONS "false
 * confidence"):
 *   - We operate on TEXT per line. A "not inside a string/quote" guard prevents
 *     the obvious false mutation (flipping a `<` that lives inside `"a < b"`),
 *     but it is a heuristic: it counts unescaped quotes to the LEFT of a match
 *     on the same line. It does NOT understand multi-line strings, here-docs,
 *     template-literal interpolation, or regex literals. A match inside such a
 *     construct could still be mutated. That is acceptable for a CANDIDATE
 *     generator: a syntactically-broken or semantically-noop mutant simply does
 *     not get killed (or fails to compile and is killed for the wrong reason) —
 *     the bench measures real test outcomes, so a bad candidate costs signal,
 *     not correctness. We bias toward conservatism (skip when unsure) so the
 *     candidates we DO emit are clean.
 *   - We pick the FIRST applicable transform per op per line. We never emit two
 *     mutants of the same op on the same line. This bounds output and pins
 *     order, at the cost of not exhaustively enumerating every token.
 *   - Comment lines, blank lines, and definition/signature lines (`def `,
 *     `function `, `class `, etc.) are SKIPPED entirely: mutating a signature
 *     tends to produce a different symbol rather than a behavioural bug, and
 *     mutating a comment is a noop.
 *
 * Style: heavy JSDoc-the-WHY, `.ts` import extensions, 2-space indent — house
 * style (CLAUDE.md §"Style discipline").
 */

/**
 * The catalogue of mutation operators. Each is a small, well-understood SEMANTIC
 * perturbation whose survival (the selected tests still pass) is evidence of a
 * test gap:
 *   - `boolean-flip`     — `true`↔`false`, and the logical connectives `&&`↔`||`
 *                          / Python `and`↔`or` (inverts a decision).
 *   - `comparison-swap`  — `<`↔`>`, `<=`↔`>=`, `==`↔`!=` (off-by-a-relation).
 *   - `arithmetic-swap`  — `+`↔`-`, `*`↔`/` (wrong arithmetic).
 *   - `return-empty`     — replace `return X` with a neutral value (return of the
 *                          wrong, "empty" result: `null`/`None`/`""`/`0`).
 *   - `remove-call`      — comment out a statement line that is a BARE call,
 *                          deleting a side effect.
 *   - `off-by-one`       — `n`→`n+1` on an integer literal (the classic bug).
 */
export type MutationOp =
  | "boolean-flip"
  | "comparison-swap"
  | "arithmetic-swap"
  | "return-empty"
  | "remove-call"
  | "off-by-one";

/** The canonical op order — also the DETERMINISTIC tie order when several ops
 *  apply to the same line (we emit at most one mutant per op per line, in this
 *  order). Exposed as the default for {@link MutateOpts.ops}. */
export const ALL_OPS: readonly MutationOp[] = [
  "boolean-flip",
  "comparison-swap",
  "arithmetic-swap",
  "return-empty",
  "remove-call",
  "off-by-one",
];

/** A single candidate mutant: one line replaced by a perturbed version. */
export interface Mutant {
  /** Which operator produced this mutant. */
  op: MutationOp;
  /** 1-based line within the body where the mutation applies. */
  line: number;
  /** The original line text (verbatim, no trailing newline). */
  original: string;
  /** The mutated line text. */
  mutated: string;
  /** Short human description, e.g. "flip `==` to `!=` at line 4". */
  description: string;
}

/** Options for {@link generateMutants}. */
export interface MutateOpts {
  /**
   * Source language: `"python"` | `"typescript"` | `"javascript"` | … Affects
   * two things only: the comment syntax for `remove-call` (`#` for Python, `//`
   * otherwise) and the neutral value for `return-empty` (`None` for Python,
   * `null` for everything else). Unknown / omitted → the non-Python defaults.
   */
  language?: string;
  /** Restrict generation to these ops. Default: {@link ALL_OPS}. */
  ops?: MutationOp[];
  /** Hard cap on the number of mutants. We take the FIRST N in (line, op-order)
   *  order, so the cap is deterministic. Default 25. */
  maxMutants?: number;
}

const DEFAULT_MAX_MUTANTS = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Line classification — what we never mutate.
// ─────────────────────────────────────────────────────────────────────────────

/** True for a line that is blank or whose first non-space char starts a comment
 *  (`#`, `//`, `*` for a JSDoc continuation). We do not mutate comments — it is
 *  a noop that would only waste a bench run. */
function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  return t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/** True for a definition/signature line we deliberately skip. Mutating a `def`/
 *  `function`/`class`/`interface`/`type` header changes the SYMBOL, not its
 *  behaviour, and a mutated arrow-fn header (`const f = (a) =>`) risks an
 *  invalid candidate — so we leave headers alone and mutate only the BODY
 *  statements. Matched on the leading keyword to stay conservative. */
function isDefinitionLine(line: string): boolean {
  const t = line.trim();
  return (
    /^(export\s+)?(async\s+)?(def|function|class|interface|type|enum|struct|impl|trait|fn|func)\b/.test(t) ||
    // an arrow-function or method header ending in `=> {` / `) {` is a signature,
    // not a body statement — mutating its tokens (e.g. a default-arg comparison)
    // would perturb the contract rather than the logic.
    /=>\s*\{?\s*$/.test(t)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// "Not inside a quote" guard.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heuristic: is the character at index `idx` of `line` INSIDE a string literal?
 * We scan left-to-right tracking the open-quote state, honouring a backslash
 * escape, across `'`, `"` and backtick. Used to refuse mutating an operator that
 * lives inside a string (the documented `"a < b"` false-positive).
 *
 * LIMITATION (see file header): single-line only; no awareness of template
 * interpolation, regex literals, or multi-line strings. Conservative by design —
 * when the simple scan says "inside a quote", we skip.
 */
function isInsideQuote(line: string, idx: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < idx; i++) {
    const c = line[i]!;
    if (c === "\\") {
      i++; // skip the escaped char
      continue;
    }
    if (quote === null) {
      if (c === '"' || c === "'" || c === "`") quote = c;
    } else if (c === quote) {
      quote = null;
    }
  }
  return quote !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-op, per-line transforms. Each returns the mutated line + a fragment for
// the description, or null when the op does not apply to this line. Each picks
// the FIRST applicable token so the result is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

interface OpHit {
  mutated: string;
  /** Description tail, e.g. "flip `==` to `!=`". */
  desc: string;
}

/**
 * Replace the FIRST occurrence of `token` in `line` (as a standalone match per
 * `re`) that is NOT inside a quote, with `repl`. Returns the new line + the
 * match index, or null if no eligible occurrence exists. `re` MUST be a global
 * regex; we iterate its matches so we can quote-guard each one.
 */
function replaceFirstUnquoted(
  line: string,
  re: RegExp,
  repl: (m: string) => string,
): { line: string; matched: string } | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const at = m.index;
    if (isInsideQuote(line, at)) {
      // Skip this one; keep scanning. Guard against zero-width loops.
      if (re.lastIndex === at) re.lastIndex++;
      continue;
    }
    const matched = m[0];
    const before = line.slice(0, at);
    const after = line.slice(at + matched.length);
    return { line: before + repl(matched) + after, matched };
  }
  return null;
}

/** `boolean-flip`: `true`↔`false`, `&&`↔`||`, Python `and`↔`or`. First wins. */
function opBooleanFlip(line: string): OpHit | null {
  // Word-boolean first (most semantically meaningful), then connectives.
  const trueFalse = replaceFirstUnquoted(line, /\b(true|false)\b/g, (m) =>
    m === "true" ? "false" : "true",
  );
  if (trueFalse) {
    const flipped = trueFalse.matched === "true" ? "false" : "true";
    return { mutated: trueFalse.line, desc: `flip \`${trueFalse.matched}\` to \`${flipped}\`` };
  }
  const andor = replaceFirstUnquoted(line, /&&|\|\|/g, (m) => (m === "&&" ? "||" : "&&"));
  if (andor) {
    const flipped = andor.matched === "&&" ? "||" : "&&";
    return { mutated: andor.line, desc: `flip \`${andor.matched}\` to \`${flipped}\`` };
  }
  const pyAndor = replaceFirstUnquoted(line, /\b(and|or)\b/g, (m) => (m === "and" ? "or" : "and"));
  if (pyAndor) {
    const flipped = pyAndor.matched === "and" ? "or" : "and";
    return { mutated: pyAndor.line, desc: `flip \`${pyAndor.matched}\` to \`${flipped}\`` };
  }
  return null;
}

/** `comparison-swap`: `==`↔`!=`, `<=`↔`>=`, `<`↔`>`. Multi-char operators are
 *  tried BEFORE single-char ones so `<=` is never half-matched as `<`. */
function opComparisonSwap(line: string): OpHit | null {
  // `==` ↔ `!=` (but never touch `===`/`!==` — JS strict eq; require no third `=`).
  const eq = replaceFirstUnquoted(line, /(?<![=!<>])(==|!=)(?!=)/g, (m) =>
    m === "==" ? "!=" : "==",
  );
  if (eq) {
    const flipped = eq.matched === "==" ? "!=" : "==";
    return { mutated: eq.line, desc: `swap \`${eq.matched}\` to \`${flipped}\`` };
  }
  // `<=` ↔ `>=`.
  const le = replaceFirstUnquoted(line, /<=|>=/g, (m) => (m === "<=" ? ">=" : "<="));
  if (le) {
    const flipped = le.matched === "<=" ? ">=" : "<=";
    return { mutated: le.line, desc: `swap \`${le.matched}\` to \`${flipped}\`` };
  }
  // bare `<` ↔ `>` — but NOT part of `<=`/`>=`/`<<`/`>>`/`=>`/`->`, and not the
  // generic/JSX/arrow contexts we can't safely tell apart. Require the char on
  // each side to not be another angle/equals/dash.
  const lt = replaceFirstUnquoted(line, /(?<![<>=\-])[<>](?![<>=])/g, (m) =>
    m === "<" ? ">" : "<",
  );
  if (lt) {
    const flipped = lt.matched === "<" ? ">" : "<";
    return { mutated: lt.line, desc: `swap \`${lt.matched}\` to \`${flipped}\`` };
  }
  return null;
}

/** `arithmetic-swap`: `+`↔`-`, `*`↔`/`. Excludes `++`/`--`, `+=`/`-=`, `**`,
 *  `//` (Python floor-div / a comment is already filtered), and unary signs is
 *  left as a known limitation (we only swap a binary-looking operator with a
 *  non-operator char on each side). */
function opArithmeticSwap(line: string): OpHit | null {
  // `+` ↔ `-`: not `++ -- += -= -> =>` and not at the very start (unary).
  const addsub = replaceFirstUnquoted(line, /(?<=[\w)\]\s])[+\-](?=[\w(\s])(?![+\-=>])/g, (m) =>
    m === "+" ? "-" : "+",
  );
  if (addsub) {
    const flipped = addsub.matched === "+" ? "-" : "+";
    return { mutated: addsub.line, desc: `swap \`${addsub.matched}\` to \`${flipped}\`` };
  }
  // `*` ↔ `/`: not `**` (pow/glob), `*=`, `/=`, `//`, `/*`, `*/`.
  const muldiv = replaceFirstUnquoted(line, /(?<![*/])[*/](?![*/=])/g, (m) =>
    m === "*" ? "/" : "*",
  );
  if (muldiv) {
    const flipped = muldiv.matched === "*" ? "/" : "*";
    return { mutated: muldiv.line, desc: `swap \`${muldiv.matched}\` to \`${flipped}\`` };
  }
  return null;
}

/** `return-empty`: a `return <expr>` becomes `return <neutral>` (a wrong empty
 *  result). The neutral value is `None` for Python, `null` elsewhere. A bare
 *  `return` (no expr) is left alone (already neutral). Preserves indentation and
 *  any trailing `;`. */
function opReturnEmpty(line: string, neutral: string): OpHit | null {
  // Capture leading whitespace + `return ` + the expression (+ optional `;`).
  const m = /^(\s*)return\s+(.+?)(;?\s*)$/.exec(line);
  if (!m) return null;
  const [, indent, expr, tail] = m;
  // Skip if the expression is ALREADY the neutral (noop mutant).
  if (expr!.trim() === neutral) return null;
  return {
    mutated: `${indent}return ${neutral}${tail}`,
    desc: `replace \`return ${truncate(expr!.trim())}\` with \`return ${neutral}\``,
  };
}

/** `remove-call`: comment out a line that is a BARE statement call — `foo(...)`
 *  or `obj.method(...)` with nothing assigned, deleting its side effect. We
 *  require the WHOLE trimmed line to look like a call statement so we never
 *  comment out an assignment, a `return`, or a control keyword. */
function opRemoveCall(line: string, comment: string): OpHit | null {
  const t = line.trim();
  // `<ident>(...)` or `<a.b.c>(...)` optionally ending in `;`, and NOT a keyword.
  const isBareCall = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\s*\(.*\)\s*;?$/.test(t);
  if (!isBareCall) return null;
  // Exclude control-flow keywords that can be followed by `(`.
  if (/^(if|for|while|switch|catch|return|with|await|yield|elif|except)\b/.test(t)) return null;
  const indent = line.slice(0, line.length - line.trimStart().length);
  return {
    mutated: `${indent}${comment} ${t}`,
    desc: `comment out bare call \`${truncate(t)}\``,
  };
}

/** `off-by-one`: the FIRST standalone INTEGER literal `n` becomes `(n+1)`. We
 *  require integer digits delimited by a non-word boundary, not part of a float
 *  (`1.5`), identifier (`x1`), or hex (`0x..`). Parenthesised to keep operator
 *  precedence intact so the candidate stays valid. */
function opOffByOne(line: string): OpHit | null {
  // Match an integer NOT preceded by `.` / word char / `x`/`X` (hex) and NOT
  // followed by `.` (float) / word char.
  const re = /(?<![\w.xX])\d+(?![\w.])/g;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (isInsideQuote(line, m.index)) {
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    const lit = m[0]!;
    const at = m.index;
    const replaced = `(${lit}+1)`;
    const mutated = line.slice(0, at) + replaced + line.slice(at + lit.length);
    return { mutated, desc: `off-by-one \`${lit}\` to \`${replaced}\`` };
  }
  return null;
}

/** Truncate a fragment for a one-line description. */
function truncate(s: string, max = 24): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Dispatch one op against one line. Centralises the language-dependent inputs
 *  (neutral value, comment token) so {@link generateMutants} stays flat. */
function applyOp(op: MutationOp, line: string, language: string | undefined): OpHit | null {
  const isPython = (language ?? "").toLowerCase() === "python";
  switch (op) {
    case "boolean-flip":
      return opBooleanFlip(line);
    case "comparison-swap":
      return opComparisonSwap(line);
    case "arithmetic-swap":
      return opArithmeticSwap(line);
    case "return-empty":
      return opReturnEmpty(line, isPython ? "None" : "null");
    case "remove-call":
      return opRemoveCall(line, isPython ? "#" : "//");
    case "off-by-one":
      return opOffByOne(line);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce DETERMINISTIC candidate mutants for `body`.
 *
 * Algorithm (deliberately simple, so it is reproducible byte-for-byte):
 *   1. Split `body` into lines (no trailing-newline normalisation — line N maps
 *      to `body.split("\n")[N-1]`).
 *   2. Walk lines in order. Skip blank/comment/definition lines.
 *   3. For each remaining line, try the requested ops in {@link ALL_OPS} order;
 *      emit AT MOST ONE mutant per op per line (the first applicable token).
 *   4. Stop once `maxMutants` mutants have been collected (the cap therefore
 *      takes the first N in (line, op-order) — fully deterministic).
 *
 * PURE: same input → same output, same order, no randomness. Returns `[]` when
 * nothing is mutable.
 */
export function generateMutants(body: string, opts: MutateOpts = {}): Mutant[] {
  const ops = opts.ops && opts.ops.length > 0 ? opts.ops : ALL_OPS;
  // Preserve ALL_OPS order regardless of the caller's `ops` order, so output
  // ordering is a property of THIS module, not the caller — determinism.
  const orderedOps = ALL_OPS.filter((o) => ops.includes(o));
  const cap = opts.maxMutants ?? DEFAULT_MAX_MUTANTS;
  if (cap <= 0) return [];

  const lines = body.split("\n");
  const out: Mutant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i]!;
    if (isCommentOrBlank(original) || isDefinitionLine(original)) continue;
    for (const op of orderedOps) {
      const hit = applyOp(op, original, opts.language);
      if (hit === null) continue;
      // Defensive: never emit a "mutant" that did not change the line.
      if (hit.mutated === original) continue;
      out.push({
        op,
        line: i + 1,
        original,
        mutated: hit.mutated,
        description: `${hit.desc} at line ${i + 1}`,
      });
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/**
 * Apply `m` to the full `body`, returning the mutated body with the single line
 * `m.line` replaced by `m.mutated`. PURE.
 *
 * Defensive contract: if the body's current line `m.line` does NOT equal
 * `m.original` (the body changed since the mutant was generated), we throw — a
 * silent mis-apply would corrupt the source the bench writes back, the exact
 * kind of false-confidence bug DESIGN_LESSONS warns about. The bench generates
 * and applies against the SAME body, so this only fires on misuse.
 */
export function applyMutant(body: string, m: Mutant): string {
  const lines = body.split("\n");
  const idx = m.line - 1;
  if (idx < 0 || idx >= lines.length) {
    throw new RangeError(
      `applyMutant: line ${m.line} out of range (body has ${lines.length} lines)`,
    );
  }
  if (lines[idx] !== m.original) {
    throw new Error(
      `applyMutant: body line ${m.line} does not match the mutant's original ` +
        `(expected ${JSON.stringify(m.original)}, found ${JSON.stringify(lines[idx])}); ` +
        `the body changed since the mutant was generated`,
    );
  }
  lines[idx] = m.mutated;
  return lines.join("\n");
}
