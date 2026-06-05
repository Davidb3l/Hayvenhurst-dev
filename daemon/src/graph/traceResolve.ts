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
 *      unrelated entity (e.g. `routes/ws/close`). In that case, filter the
 *      ambiguous candidate set to those whose ENTITY ID path aligns with a hint
 *      segment (e.g. hint `queries` ⊂ `db/queries/Db.close`). Resolve only if
 *      EXACTLY ONE candidate aligns; otherwise stay unresolved.
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

  constructor(nodes: Iterable<IndexedNode>) {
    for (const n of nodes) {
      this.index(this.byQualified, n.qualified_name, n.id);
      this.index(this.byName, n.name, n.id);
      this.addCandidate(n.name, n.id);
    }
  }

  private index(map: Map<string, string | typeof AMBIGUOUS>, key: string, id: string): void {
    if (!key) return;
    const existing = map.get(key);
    if (existing === undefined) map.set(key, id);
    else if (existing !== id) map.set(key, AMBIGUOUS);
  }

  /** Record a distinct id under a bare `name` for the hint pass. */
  private addCandidate(name: string, id: string): void {
    if (!name) return;
    const list = this.candidatesByName.get(name);
    if (list === undefined) this.candidatesByName.set(name, [id]);
    else if (!list.includes(id)) list.push(id);
  }

  /** A non-ambiguous hit in `map` for `key`, else null. */
  private hit(map: Map<string, string | typeof AMBIGUOUS>, key: string): string | null {
    const v = map.get(key);
    return typeof v === "string" && v !== AMBIGUOUS ? v : null;
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
   * yields {db, queries, Db, close} and the hint `queries` matches. Bare,
   * collector-noise segments (e.g. `<module>`) simply fail to align and are
   * harmless. Returns null unless precisely one candidate is selected — an
   * empty hint, a tie, or no alignment all stay UNRESOLVED.
   */
  private resolveByHint(candidates: readonly string[], hint: string[]): string | null {
    if (hint.length === 0) return null;

    const hintSet = new Set(hint);
    const aligned = candidates.filter((id) =>
      normalizeRuntimeName(id).some((seg) => hintSet.has(seg)),
    );
    return aligned.length === 1 ? aligned[0]! : null;
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

    // 1. Last 2 segments joined with `.` (e.g. `Session.refresh`, `Store.GetUser`).
    if (segs.length >= 2) {
      const two = `${segs[segs.length - 2]}.${segs[segs.length - 1]}`;
      const hit = this.hit(this.byQualified, two);
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
