/**
 * Runtime-trace name → graph-entity-id resolution (PRD §7).
 *
 * The trace collector records call edges as RUNTIME names (`myapp.auth:loginHandler`,
 * `github.com/me/app/auth.(*Session).refresh`, …). Those names are the
 * collector's ground truth and stay VERBATIM in the G-Set / CRDT op log and the
 * `observations` read cache — we never mutate the wire or CRDT state (ARCHITECTURE.md
 * §4: raw observations are the source of truth, resolution is a DERIVED concern).
 *
 * This module is that derived layer: given the current node index, it maps a
 * runtime name to an indexed entity id CONSERVATIVELY. A wrong resolution invents
 * a false call edge, which is worse than an orphan — so anything that doesn't
 * match UNAMBIGUOUSLY is left unresolved (the raw name is kept). No data is lost
 * either way; an unresolved edge is simply flagged.
 *
 * The resolution contract (also documented in the collector READMEs — keep these
 * in sync):
 *   1. NORMALIZE the runtime name into qualified-name segments: split on
 *      `::`, `.`, `:`, and `/`; strip Go receiver wrapping `(*Type)`/`(Type)`
 *      → `Type`; strip Rust generic params `<...>`; drop empty segments.
 *      The collectors emit `<module>:<functionName>` (Python `pkg.mod:fn`, Go
 *      `import/path.(*T).method`, …). The segments BEFORE the function name are
 *      the MODULE HINT; the LAST segment is the function name.
 *   2. Try progressively SHORTER trailing joins against the node index:
 *        - last 2 segments joined with `.` (e.g. `Session.refresh`, `Store.GetUser`)
 *          → look up in `byQualified`;
 *        - last 1 segment (e.g. `refresh`, `GetUser`) → `byQualified`, then `byName`.
 *      The first UNAMBIGUOUS hit wins.
 *   3. MODULE-HINT DISAMBIGUATION. When the trailing name is AMBIGUOUS across the
 *      index (several entities share a bare `name` in different modules), the
 *      trailing match alone cannot pick one — but the module hint usually can.
 *      V8 (and some collectors) sometimes drop the class qualifier, emitting a
 *      method as a BARE function name (`queries:close` for `Db.close`), so the
 *      2-seg `Type.method` join is unavailable and the bare name collides with an
 *      unrelated entity (e.g. `routes/ws/close`). In that case, score each
 *      ambiguous candidate against the hint — PRIMARILY by the longest PATH
 *      SUFFIX of the hint that appears contiguously in the candidate's entity-id
 *      path (`router/reg-exp-router/router` beats a bare `router`), then by how
 *      many hint segments the id shares at all. Resolve only on a STRICTLY
 *      UNIQUE best candidate; any tie stays unresolved.
 *   4. If nothing matches unambiguously and the hint does not yield a single
 *      aligned candidate, leave it UNRESOLVED. NEVER guess — a wrong resolution
 *      invents a false call edge, worse than an orphan.
 *
 * Mirrors the unambiguous-only index discipline of {@link resolveEdges} in
 * ingest.ts (the static-parser edge resolver).
 */
import type { Db } from "../db/queries.ts";

/**
 * Sentinel marking a name that maps to more than one distinct entity id in an
 * index. Resolving to an arbitrary one of several candidates would invent a
 * false call edge, so an ambiguous name is treated as UNRESOLVED. Kept as a
 * NUL-prefixed literal so a real entity id can never collide with it (mirrors
 * the `AMBIGUOUS` sentinel in ingest.ts).
 */
const AMBIGUOUS = "\0ambiguous" as const;

/** A single node's identity fields, all the resolver needs to index it. */
export interface IndexedNode {
  id: string;
  name: string;
  qualified_name: string;
}

/**
 * File-extension tokens a PATH-SHAPED module hint can carry. A collector that
 * hints with a repo-relative file path (`router/reg-exp-router/router.ts`)
 * yields a trailing `ts` segment after {@link normalizeRuntimeName} splits on
 * `.` — a token that can never match an entity-id path segment (ids carry no
 * extensions), which would zero out any suffix match. We DROP these tokens from
 * the hint before scoring. Cost of a false drop (a directory literally named
 * `ts`/`go`): a slightly weaker score, never a false resolution — conservative
 * by construction.
 */
const HINT_EXTENSION_SEGMENTS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "py", "rs", "go",
]);

/**
 * The length of the LONGEST SUFFIX of `hint` that appears as a CONTIGUOUS run
 * anywhere in `segs`, or 0 when even the last hint segment is absent.
 *
 * This is the path-suffix discriminator for module hints: a hint is a module
 * PATH, so its most specific evidence is its tail — `regexp/router` appearing
 * intact in a candidate's id is far stronger than the basename `router` alone
 * (which, in an idiomatic TS repo, appears in five different `router.ts`
 * modules and every `index.ts` import chain). We anchor on suffixes of the HINT
 * (not of the id) because the id may continue past the module with class /
 * function segments (`…/router/RegExpRouter.match`), and may be rooted deeper
 * (`src/…`) than the hint — a contiguous run anywhere tolerates both.
 */
function longestHintSuffixRun(
  hint: readonly string[],
  segs: readonly string[],
): number {
  for (let len = hint.length; len >= 1; len--) {
    const start = hint.length - len;
    outer: for (let i = 0; i + len <= segs.length; i++) {
      for (let j = 0; j < len; j++) {
        if (segs[i + j] !== hint[start + j]) continue outer;
      }
      return len;
    }
  }
  return 0;
}

/**
 * Normalize a runtime trace name into qualified-name segments.
 *
 * Handles:
 *   - Rust paths       `myapp::auth::Session::refresh`            → [myapp, auth, Session, refresh]
 *   - Rust generics    `Vec<T>::push` / `Store<K,V>::get`        → strips `<...>`
 *   - Python paths     `myapp.auth:loginHandler`                 → [myapp, auth, loginHandler]
 *   - Go receivers     `github.com/me/app/auth.(*Session).refresh` → [github, com, me, app, auth, Session, refresh]
 *   - JS/TS dotted     `auth.login.loginHandler`                 → [auth, login, loginHandler]
 *
 * Separators recognized: `::`, `.`, `:`, `/`. Go receiver wrappers `(*Type)` and
 * `(Type)` are unwrapped to `Type` BEFORE splitting (the wrapping parens would
 * otherwise survive into a segment). Generic params `<...>` are stripped. Empty
 * segments (from consecutive separators, e.g. `a..b` or a trailing `:`) drop out.
 *
 * NOT handled (deliberately — these are rarer and risk false splits): function
 * call arglists `foo(a, b)` other than the Go receiver form, lambda/closure
 * suffixes like Rust's `{{closure}}`, and array/slice notation. They pass through
 * as literal segment text and simply fail to match (→ unresolved), which is the
 * safe outcome.
 */
export function normalizeRuntimeName(raw: string): string[] {
  // 1. Strip Go receiver wrapping: `(*Session)` / `(Session)` → `Session`.
  //    Done before splitting so the parens never leak into a segment.
  let s = raw.replace(/\((\*?)([^()]*)\)/g, "$2");
  // 2. Strip generic params `<...>` (Rust/TS). Non-greedy, repeated, and we also
  //    drop any unbalanced trailing `<`/`>` defensively.
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^<>]*>/g, "");
  } while (s !== prev);
  s = s.replace(/[<>]/g, "");
  // 3. Split on any of `::`, `.`, `:`, `/`; drop empty segments and trim.
  return s
    .split(/::|[.:/]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/**
 * A resolver over a snapshot of the node index. Build it once, then call
 * {@link resolve} per runtime name. The indexes are unambiguous-only: a name
 * mapping to >1 distinct id is recorded as {@link AMBIGUOUS} and never resolves.
 */
export class TraceNameResolver {
  private readonly byQualified = new Map<string, string | typeof AMBIGUOUS>();
  private readonly byName = new Map<string, string | typeof AMBIGUOUS>();
  /**
   * Full candidate set per bare `name`, RETAINED even when ambiguous (unlike
   * {@link byName}, which collapses to {@link AMBIGUOUS}). The module-hint pass
   * needs the actual ids to filter by id-path alignment. Distinct ids only;
   * insertion order preserved.
   */
  private readonly candidatesByName = new Map<string, string[]>();
  /**
   * Full candidate set per `qualified_name`, retained even when ambiguous —
   * the qualified-join hint pass (see {@link resolveQualifiedJoin}) needs the
   * actual ids. Motivating case: 44 vitest suites all carry the dotted stem
   * `index.test` as their qualified name; the trailing 2-segment join is
   * AMBIGUOUS, but the path segments before the stem disambiguate every one.
   */
  private readonly candidatesByQualified = new Map<string, string[]>();

  constructor(nodes: Iterable<IndexedNode>) {
    for (const n of nodes) {
      this.index(this.byQualified, n.qualified_name, n.id);
      this.index(this.byName, n.name, n.id);
      this.addCandidate(this.candidatesByName, n.name, n.id);
      this.addCandidate(this.candidatesByQualified, n.qualified_name, n.id);
    }
  }

  private index(map: Map<string, string | typeof AMBIGUOUS>, key: string, id: string): void {
    if (!key) return;
    const existing = map.get(key);
    if (existing === undefined) map.set(key, id);
    else if (existing !== id) map.set(key, AMBIGUOUS);
  }

  /** Record a distinct id under `key` in a candidate map for a hint pass. */
  private addCandidate(map: Map<string, string[]>, key: string, id: string): void {
    if (!key) return;
    const list = map.get(key);
    if (list === undefined) map.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  }

  /** A non-ambiguous hit in `map` for `key`, else null. */
  private hit(map: Map<string, string | typeof AMBIGUOUS>, key: string): string | null {
    const v = map.get(key);
    return typeof v === "string" && v !== AMBIGUOUS ? v : null;
  }

  /**
   * Resolve via the trailing `n`-segment qualified join: an exact unique
   * `byQualified` hit wins; when the join is AMBIGUOUS (>1 id shares the
   * stem — the `index.test` ×44 case), the SAME hint scoring as the bare-name
   * pass runs over the retained candidates, with the segments before the join
   * as the hint. Strict-unique-best only; a tie stays unresolved.
   */
  private resolveQualifiedJoin(segs: string[], n: number): string | null {
    if (segs.length < n) return null;
    const key = segs.slice(segs.length - n).join(".");
    const hit = this.hit(this.byQualified, key);
    if (hit) return hit;
    const candidates = this.candidatesByQualified.get(key);
    if (candidates && candidates.length >= 2) {
      return this.resolveByHint(candidates, segs.slice(0, segs.length - n));
    }
    return null;
  }

  /**
   * Module-hint disambiguation (contract §3). Given an ambiguous `candidates`
   * set (the distinct ids sharing a bare function name) and the `hint` segments
   * preceding the function name (the module path the collector emitted), narrow
   * to those whose ENTITY ID aligns with the hint, and resolve only if EXACTLY
   * ONE candidate aligns.
   *
   * "Aligns" = a normalized hint segment appears as a path segment of the
   * candidate id (ids are `module/path/Type.method`). We split the id on the
   * same separators we normalize runtime names with, so `db/queries/Db.close`
   * yields {db, queries, Db, close} and the hint `queries` matches.
   *
   * We SCORE each candidate on TWO axes and resolve only on a STRICTLY UNIQUE
   * best, compared lexicographically:
   *
   *   PRIMARY — {@link longestHintSuffixRun}: the longest suffix of the hint
   *   appearing as a contiguous run in the candidate's id segments. The hint is
   *   a module PATH, so its tail is its most specific evidence: a path-qualified
   *   hint `router/reg-exp-router/router` matches the `reg-exp-router` module's
   *   id with run 3 while the four other same-basename `router` modules score 1
   *   — longest-suffix-wins. A BASENAME-ONLY hint (`router` alone, useless in a
   *   TS repo where `router.ts` appears 5× and `index.ts` everywhere — the
   *   measured 69-ambiguity hono failure mode) still ties every candidate at 1
   *   and stays unresolved, exactly as before: the fix is discriminating power
   *   for RICHER hints, never a license to guess on poor ones.
   *
   *   SECONDARY — how many of the candidate's id segments the hint CONTAINS
   *   (the original set-overlap score), which keeps the unordered-dotted-path
   *   wins the suffix rule alone can't see. Measured origin of that rule:
   *   `click.decorators:command` (hint {click, decorators}) must beat the method
   *   `click/core/Group.command` (shares only the generic top package `click`)
   *   rather than tie it — a recall hole across 104 ambiguous bare names when
   *   any-single-segment alignment manufactured the tie.
   *
   * DETERMINISTIC TIEBREAK: candidates are compared by (suffixRun, sharedCount)
   * with strict `>`; an EQUAL pair marks a tie and the name stays UNRESOLVED.
   * The outcome is therefore independent of candidate insertion order (the §7
   * ambiguous-stays-unresolved discipline — we never invent an edge the old
   * rule already refused). Extension tokens a path-shaped hint may carry
   * (`router.ts` → `ts`) are dropped first ({@link HINT_EXTENSION_SEGMENTS}) so
   * a file-path hint scores as its module path.
   */
  private resolveByHint(candidates: readonly string[], hint: string[]): string | null {
    const cleaned = hint.filter((seg) => !HINT_EXTENSION_SEGMENTS.has(seg));
    if (cleaned.length === 0) return null;

    const hintSet = new Set(cleaned);
    let best: string | null = null;
    let bestSuffix = 0;
    let bestShared = 0;
    let tie = false;
    for (const id of candidates) {
      const segs = normalizeRuntimeName(id);
      const suffix = longestHintSuffixRun(cleaned, segs);
      let shared = 0;
      for (const seg of segs) if (hintSet.has(seg)) shared++;
      if (suffix === 0 && shared === 0) continue; // shares nothing — never selectable
      if (suffix > bestSuffix || (suffix === bestSuffix && shared > bestShared)) {
        bestSuffix = suffix;
        bestShared = shared;
        best = id;
        tie = false;
      } else if (suffix === bestSuffix && shared === bestShared) {
        tie = true;
      }
    }
    return best !== null && !tie ? best : null;
  }

  /**
   * Resolve a runtime name to an entity id, or null if it can't be matched
   * UNAMBIGUOUSLY.
   *
   * Order of precedence:
   *   1. The last-2-segment `Class.method` qualified join — highest confidence,
   *      because it carries an EXPLICIT class qualifier. Wins outright.
   *   2. MODULE-HINT disambiguation (contract §3) — applied BEFORE the
   *      single-segment trailing lookups whenever the bare function name maps to
   *      more than one entity. This is load-bearing for the `queries:close` bug:
   *      the unrelated `routes/ws/close` carries the bare qualified-name `close`,
   *      so a single-segment `byQualified` lookup would mis-grab it. When a hint
   *      is present and the name is ambiguous, the hint is the MORE reliable
   *      signal than an arbitrary single-segment trailing match, so it goes first.
   *   3. The single-segment trailing lookups — bare qualified-name, then bare
   *      name — used when the function name is unique (no ambiguity for the hint
   *      to resolve) or when no hint disambiguates.
   *
   * Anything that doesn't yield a confident single id stays UNRESOLVED.
   */
  resolve(raw: string): string | null {
    const segs = normalizeRuntimeName(raw);
    if (segs.length === 0) return null;

    // 1. Trailing qualified joins (e.g. `Session.refresh`, `Store.GetUser`,
    //    dotted test-file stems `index.test` / `common.case.test`). An exact
    //    unique hit wins outright; an AMBIGUOUS stem falls to the same hint
    //    scoring as step 2, using the segments BEFORE the join as the hint
    //    (the path-qualified names collectors emit make this decisive: 44
    //    `index.test` suites each resolve by their `src/jsx/dom/…` prefix).
    //    Joins are tried shortest-first so the long-standing 2-segment
    //    precedence is unchanged; the 3-segment join only sees multi-dot stems
    //    the 2-segment pass couldn't answer.
    for (const n of [2, 3]) {
      const hit = this.resolveQualifiedJoin(segs, n);
      if (hit) return hit;
    }

    const one = segs[segs.length - 1]!;
    const hint = segs.slice(0, segs.length - 1);

    // 2. When the bare function name is AMBIGUOUS (>1 entity shares it), the only
    //    trustworthy signal left is the module hint. A single-segment trailing
    //    lookup here would arbitrarily favor whichever same-named entity happened
    //    to carry a bare qualified-name (the `queries:close` mis-resolution), so
    //    we DON'T fall through to step 3 — the hint resolves it or it stays
    //    unresolved (mirrors the §7 ambiguous-stays-unresolved discipline).
    const candidates = this.candidatesByName.get(one);
    if (candidates && candidates.length >= 2) {
      return this.resolveByHint(candidates, hint);
    }

    // 3. Unique function name: the single-segment trailing lookups are safe.
    //    Bare qualified-name, then bare name.
    return this.hit(this.byQualified, one) ?? this.hit(this.byName, one);
  }
}

/** A trace edge with its raw runtime endpoints and their resolved ids (or null). */
export interface ResolvedTraceEdge {
  /** Raw runtime caller name, verbatim from the collector / observation cache. */
  rawSrc: string;
  /** Raw runtime callee name, verbatim. */
  rawDst: string;
  /** Resolved caller entity id, or null when unresolved (kept the raw name). */
  resolvedSrc: string | null;
  /** Resolved callee entity id, or null when unresolved. */
  resolvedDst: string | null;
  /** Summed raw sample count across the observation rows for this (src,dst). */
  observed: number;
  /** Summed scaled invocation estimate (`weight`) across the rows. */
  weight: number;
  /** Number of contributing observation rows. */
  samples: number;
}

/**
 * Build a {@link TraceNameResolver} over every node currently in the SQL index
 * (the CRDT-derived but authoritative read cache).
 */
export function buildTraceResolver(db: Db): TraceNameResolver {
  const nodes = db.handle
    .query<IndexedNode, []>("SELECT id, name, qualified_name FROM nodes")
    .all();
  return new TraceNameResolver(nodes);
}
