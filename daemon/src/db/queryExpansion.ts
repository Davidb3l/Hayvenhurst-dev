/**
 * Model-free query expansion floor for code-identifier search.
 *
 * Context (ARCHITECTURE.md §9): on the zero-config path with no LLM pulled,
 * search is pure FTS5 with the *trigram* tokenizer (substrings already match).
 * What's missing without a model is *semantic / identifier* expansion, so
 * code-identifier search has a sharp quality step at "pulled a model." This
 * module is a cheap, MODEL-FREE, dependency-free expansion floor that turns
 * that step into a slope, via two ADDITIVE mechanisms only:
 *
 *   1. Identifier tokenization — split each query term on camelCase,
 *      snake_case, kebab-case, and digit boundaries and add the lowercased
 *      subtokens as additional match terms (`getUserById` → get, user, by, id;
 *      `auth_session` → auth, session; `parse-tree` → parse, tree).
 *   2. A small static abbreviation/synonym table — hand-curated common code
 *      abbreviations, expanded BOTH directions (auth↔authentication, db↔database…).
 *
 * Design contract (why this can't regress FTS5 ranking):
 *   - The ORIGINAL term is ALWAYS the first member of its expansion set, so it
 *     still matches exactly as before.
 *   - Expansion terms are OR-ed *within* a query term's group (see
 *     `buildFtsMatch` in `fts.ts`), never AND-ed across terms — so they only
 *     ever ADD candidate rows, never constrain the original match away.
 *   - We add NO column/term weights: BM25 already ranks a row that matches the
 *     full, rarer original token above a row that matches only a short common
 *     subtoken, so exact/original hits stay on top for free.
 *   - To keep precision (avoid flooding results with noise) the expansion set
 *     per query term is CAPPED (`MAX_EXPANSIONS_PER_TERM`), and the original is
 *     never dropped to make room.
 *
 * Pure & deterministic: `expandTerm` / `expandQuery` take strings and return
 * string arrays with no I/O, so they're trivially unit-testable.
 */

/**
 * Max number of expansion terms ADDED per original query term (the original
 * itself does not count against this cap). Kept small to favor precision over
 * recall — a handful of subtokens + abbrev partners is plenty; more just
 * invites noise. Obviously extensible by bumping this constant.
 */
export const MAX_EXPANSIONS_PER_TERM = 6;

/** Subtokens shorter than this are dropped: they're noise and, with the
 *  trigram tokenizer, anything < 3 chars can't form a trigram anyway so it
 *  could never match a row on its own. */
const MIN_SUBTOKEN_LENGTH = 2;

/**
 * Hand-curated, model-free abbreviation / synonym table for common code
 * vocabulary. Each row lists equivalent forms; expansion is BOTH directions
 * (querying any member suggests the others). Keep this SMALL, well-commented,
 * and obviously extensible — add a row, that's it. This is intentionally not a
 * thesaurus: only high-precision code abbreviations that rarely mean anything
 * else in source.
 */
const ABBREVIATION_GROUPS: readonly (readonly string[])[] = [
  ["auth", "authentication"],
  ["authn", "authentication"],
  ["authz", "authorization"],
  ["db", "database"],
  ["cfg", "config", "configuration"],
  ["msg", "message"],
  ["btn", "button"],
  ["idx", "index"],
  ["req", "request"],
  ["res", "resp", "response"],
  ["err", "error"],
  ["init", "initialize"],
  ["util", "utility"],
  ["repo", "repository"],
  ["ctx", "context"],
  ["fn", "func", "function"],
  ["val", "value"],
  ["arg", "argument"],
  ["impl", "implementation"],
  ["dir", "directory"],
  ["doc", "document"],
];

/**
 * Lowercased term → its abbreviation/synonym partners (excluding itself),
 * derived once from `ABBREVIATION_GROUPS`. A term may appear in multiple groups
 * (e.g. nothing today, but the structure supports it) — partners accumulate.
 */
const ABBREVIATION_MAP: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of ABBREVIATION_GROUPS) {
    for (const member of group) {
      const key = member.toLowerCase();
      let set = map.get(key);
      if (!set) {
        set = new Set<string>();
        map.set(key, set);
      }
      for (const other of group) {
        const partner = other.toLowerCase();
        if (partner !== key) set.add(partner);
      }
    }
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [k, v] of map) frozen.set(k, [...v]);
  return frozen;
})();

/**
 * Split an identifier-like term into lowercased subtokens on camelCase,
 * snake_case, kebab-case, and digit boundaries. Returns subtokens that are
 * meaningfully different from the input (i.e. it actually split).
 *
 * Examples:
 *   getUserById   → ["get", "user", "by", "id"]
 *   auth_session  → ["auth", "session"]
 *   parse-tree    → ["parse", "tree"]
 *   HTTPServer    → ["http", "server"]   (acronym-then-word boundary)
 *   v12Migration  → ["12", "migration"]  (sub-MIN_SUBTOKEN_LENGTH bits dropped)
 */
export function tokenizeIdentifier(term: string): string[] {
  if (!term) return [];
  const withBoundaries = term
    // snake_case / kebab-case / any non-alphanumeric → boundary
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    // lower/digit → Upper  (userId → user Id)
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    // ACRONYM then Word  (HTTPServer → HTTP Server)
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    // letter↔digit boundaries  (v2 → v 2, utf8Encode → utf 8 Encode)
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2");

  return withBoundaries
    .split(/\s+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= MIN_SUBTOKEN_LENGTH);
}

/**
 * Expand a SINGLE already-sanitized query term (no whitespace, no FTS
 * metachars) into an ordered, de-duplicated list of match terms.
 *
 * Invariants:
 *   - result[0] is ALWAYS the original term (lowercased), so the original
 *     match is preserved and — via BM25 — keeps ranking at least as well.
 *   - identifier subtokens come next, then abbreviation/synonym partners
 *     (of both the whole term and each subtoken).
 *   - total ADDED terms (everything after result[0]) is capped at
 *     `MAX_EXPANSIONS_PER_TERM`.
 */
export function expandTerm(term: string): string[] {
  if (term.length === 0) return [];
  const original = term.toLowerCase();

  const seen = new Set<string>([original]);
  const additions: string[] = [];

  const add = (t: string) => {
    if (additions.length >= MAX_EXPANSIONS_PER_TERM) return;
    if (t.length < MIN_SUBTOKEN_LENGTH) return;
    if (seen.has(t)) return;
    seen.add(t);
    additions.push(t);
  };

  // 1. identifier subtokens (camel/snake/kebab/digit).
  //    NB: tokenize the ORIGINAL-case term — lowercasing first would erase the
  //    camelCase boundaries we split on. `tokenizeIdentifier` lowercases the
  //    subtokens it returns.
  const subtokens = tokenizeIdentifier(term);
  for (const sub of subtokens) add(sub);

  // 2. abbreviation/synonym partners — of the whole term and of each subtoken
  for (const partner of ABBREVIATION_MAP.get(original) ?? []) add(partner);
  for (const sub of subtokens) {
    for (const partner of ABBREVIATION_MAP.get(sub) ?? []) add(partner);
  }

  return [original, ...additions];
}

/**
 * Expand a list of already-sanitized query terms into per-term expansion
 * groups, preserving order. Each inner array is one term's expansion set
 * (original first); the caller OR-s within a group and AND-s across groups.
 *
 * `[]` in → `[]` out (so empty / whitespace / punctuation-only queries stay
 * empty and never reach a MATCH).
 */
export function expandQuery(terms: readonly string[]): string[][] {
  return terms.map((t) => expandTerm(t)).filter((g) => g.length > 0);
}

/**
 * English stopwords for the RELAXED natural-language fallback ONLY.
 *
 * THIS IS NOT USED ON THE PRECISE SEARCH PATH. `buildFtsMatch` (the primary,
 * AND-of-OR-groups path) never consults this set, so exact-identifier search is
 * completely unaffected. It is only used by `buildRelaxedFtsMatch` in `fts.ts`,
 * which fires solely when the precise AND match returns ZERO rows.
 *
 * The problem it solves: a natural-language query like "how does the daemon
 * converge peers after a partition" sanitizes to many literal words, and the
 * precise path AND-s ALL of them. English glue words ("how", "does", "the",
 * "after", "a") never appear in code, so the AND-of-all matches nothing. The
 * relaxed fallback drops these words, then OR-s the remaining CONTENT tokens so
 * the query surfaces rows that hit the meaningful words.
 *
 * Kept deliberately TIGHT and code-search-appropriate: only words that are pure
 * English glue AND vanishingly unlikely to be a code identifier a user actually
 * wants to find. We do NOT include words like "get"/"set"/"new"/"id" that are
 * extremely common in code — dropping those would hurt, not help. Obviously
 * extensible: add a word, that's it.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // articles / determiners
  "a", "an", "the", "this", "that", "these", "those", "it", "its",
  // question words
  "how", "what", "why", "when", "where", "which", "who", "whom", "whose",
  // auxiliaries / copulas
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done",
  "has", "have", "had",
  "can", "could", "will", "would", "shall", "should", "may", "might", "must",
  // conjunctions
  "and", "or", "but", "nor", "so", "if", "then", "than", "because",
  // prepositions / particles
  "of", "to", "in", "on", "at", "for", "from", "by", "with", "without",
  "into", "onto", "over", "under", "about", "after", "before", "between",
  "through", "during", "as", "up", "down", "out", "off",
  // pronouns
  "we", "us", "our", "you", "your", "they", "them", "their", "i", "me", "my",
  "he", "she", "him", "her",
  // common NL filler in "how do I..." style asks
  "does", "do", "stops", "stop", "happens", "happen", "work", "works",
  "same", "two", "one", "some", "any", "all", "each", "every", "there", "here",
]);

/**
 * Drop stopwords from a sanitized term list for the RELAXED fallback. If EVERY
 * term is a stopword (e.g. a literal search for "the" or "and"), the list is
 * returned UNCHANGED so a deliberate stopword search still works rather than
 * collapsing to nothing. Comparison is case-insensitive against `STOPWORDS`.
 */
export function dropStopwords(terms: readonly string[]): string[] {
  const content = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  return content.length > 0 ? content : [...terms];
}

/* ────────────────────────────────────────────────────────────────────────
 * SEMANTIC (model-gated) query expansion — strictly additive recall.
 *
 * The model-free floor above only ever ADDS code-token variants of words the
 * user already typed. It cannot bridge a NATURAL-LANGUAGE ask ("how do peers
 * converge after a partition?") to the identifiers that implement it
 * (`computeMerkle`, `merkleDiff`, …) — there's no literal token overlap, so a
 * pure-FTS search returns nothing (the SEMANTIC cohort in
 * `bench/agent-nav-eval.ts` is 0/2 without a model).
 *
 * When a local Tier-3 model is present (the same `hayven-native infer` path the
 * conflict oracle uses — `llm_oracle.ts::makeInferFn`), we ask it to map the NL
 * query to a handful of candidate IDENTIFIER terms and fold them in as ONE
 * extra OR-group. This is additive by construction, mirroring the model-free
 * contract:
 *   - it NEVER touches the user's original terms or their model-free groups;
 *   - the suggested terms become a single disjunction (OR-group), so they only
 *     ever ADD candidate rows — they can't AND-narrow the original match away;
 *   - with no model / a spawn error / a timeout / unparseable output, the infer
 *     fn's result is `ok:false` (or throws) and we return the model-free groups
 *     UNCHANGED — the no-model path is byte-identical to `expandQuery`.
 *
 * It is intentionally INJECTABLE (takes an `InferLike`, not a binary path) so
 * it unit-tests with a mock and needs no weights, exactly like the oracle.
 *
 * COST NOTE (why this is opt-in, not on the hot search path by default): on the
 * reference hardware a cold first token is ~3 s (Metal) – ~13 s (CPU) for
 * gemma3:1b (CLAUDE.md "Honesty notes"). That's fine for an explicit "semantic
 * search" affordance but would make every keystroke-search block for seconds,
 * so `searchFts` stays synchronous and model-free; this function is wired for a
 * caller that opts in (and ideally caches per query). See the report.
 * ──────────────────────────────────────────────────────────────────────── */

/** Minimal shape of the injected infer call (matches `llm_oracle.ts::InferFn`
 *  / `InferResult`), narrowed to what expansion needs. */
export interface InferLike {
  (prompt: string): Promise<{ ok: boolean; completion: string }>;
}

/** Max identifier terms we accept from the model. Kept small for the same
 *  precision reason as the model-free cap: a few good identifiers is recall;
 *  a flood is noise that BM25 then has to dig back out of. */
export const MAX_SEMANTIC_TERMS = 8;

/**
 * Build the §-style prompt that asks the model to translate a natural-language
 * code-search query into candidate identifier terms. We ask for a bare,
 * comma-separated list (no prose) to keep parsing trivial and the completion
 * short/fast.
 */
export function buildSemanticExpansionPrompt(query: string): string {
  return (
    "You are helping search a CODE index. Given a natural-language question " +
    "about a codebase, list the most likely CODE IDENTIFIERS (function, class, " +
    "type, or module names — camelCase or snake_case, NOT prose) that would " +
    "implement or relate to it.\n" +
    `Reply with ONLY a comma-separated list of up to ${MAX_SEMANTIC_TERMS} ` +
    "identifiers, no explanation.\n\n" +
    `Question: ${query}\n` +
    "Identifiers:"
  );
}

/**
 * Parse the model's completion into sanitized, de-duplicated identifier terms.
 * Tolerant of prose/markdown noise: splits on commas/newlines/spaces, runs each
 * piece through the same identifier tokenization the model-free floor uses
 * (so `computeMerkle` also contributes `compute`, `merkle`), strips anything
 * that isn't a usable token, and caps the result.
 */
export function parseSemanticTerms(completion: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (t: string) => {
    const k = t.toLowerCase();
    if (k.length < MIN_SUBTOKEN_LENGTH || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  for (const raw of completion.split(/[,\n]/)) {
    // Keep only identifier-ish chunks; drop surrounding prose/punctuation.
    const piece = raw.trim().replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
    if (!piece) continue;
    for (const word of piece.split(/\s+/)) {
      if (out.length >= MAX_SEMANTIC_TERMS) break;
      push(word);
      // also contribute its subtokens (camel/snake) for trigram-friendly recall
      for (const sub of tokenizeIdentifier(word)) {
        if (out.length >= MAX_SEMANTIC_TERMS) break;
        push(sub);
      }
    }
    if (out.length >= MAX_SEMANTIC_TERMS) break;
  }
  return out;
}

/**
 * Result of model-gated expansion. `base` is the model-free `expandQuery`
 * (AND-of-OR-groups over the user's literal terms). `semantic` is a flat,
 * possibly-empty list of model-suggested identifier terms that the caller must
 * OR in at the TOP LEVEL — i.e. the final MATCH is `(base) OR (semantic…)`, NOT
 * `(base) AND (semantic…)`.
 *
 * Why top-level OR, not another AND-group: a natural-language query
 * ("how does the daemon converge after a partition") tokenizes into many
 * literal words that are AND-ed together and match nothing. Appending the
 * model's identifiers as one more AND-fragment would still require all that
 * prose to match → still nothing. ORing the identifiers against the whole base
 * is what gives the NL query any hits at all, while NEVER removing a hit the
 * base query already had (`X OR Y ⊇ X`). Hence strictly additive recall.
 */
export interface ExpandedQuery {
  base: string[][];
  semantic: string[];
}

/**
 * Model-gated semantic expansion. Returns `{ base, semantic }` where `base` is
 * always `expandQuery(terms)` and `semantic` is the model's suggested
 * identifier terms (empty on any no-model / error / timeout / empty path —
 * making the no-model result behave exactly like the model-free `expandQuery`).
 *
 * `rawQuery` is the user's original (pre-sanitize) text — the model reads the
 * natural language, not the code-tokenized terms.
 */
export async function expandQueryWithModel(
  terms: readonly string[],
  rawQuery: string,
  infer: InferLike | undefined,
): Promise<ExpandedQuery> {
  const base = expandQuery(terms);
  if (!infer || !rawQuery.trim()) return { base, semantic: [] };
  try {
    const res = await infer(buildSemanticExpansionPrompt(rawQuery));
    if (!res.ok || !res.completion) return { base, semantic: [] };
    return { base, semantic: parseSemanticTerms(res.completion) };
  } catch {
    // Spawn throw / timeout / anything: clean model-free fallback.
    return { base, semantic: [] };
  }
}
