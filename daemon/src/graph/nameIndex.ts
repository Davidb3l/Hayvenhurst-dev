/**
 * Package-scoped name resolution, the shared index behind both edge-resolution
 * paths. Extracted verbatim from `ingest.ts`; no behavior changes.
 */
/**
 * Sentinel marking a `dst_name` that maps to more than one distinct entity id
 * in the global qualified-name / name indexes. Resolving an edge to an
 * arbitrary one of several candidates would invent a false call edge, so an
 * ambiguous dst is treated as UNRESOLVED (`?:<name>`) instead. Kept as a unique
 * symbol-like literal so a real entity id can never collide with it.
 */
const AMBIGUOUS = "\0ambiguous" as const;

/**
 * The minimum a node must carry to be indexed by name. Both callers below hand
 * over different row shapes (a full `GraphNode` during ingest, a four-column
 * SQLite projection during re-resolution), so the index accepts the structural
 * intersection and reads nothing else.
 */
interface NameIndexNode {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
}

/**
 * The ONE implementation of package-scoped name resolution, shared by
 * {@link EdgeResolver} (which indexes EVERY node in the graph) and
 * {@link reresolveAllEdges} (which indexes only the candidate subset matching
 * the unresolved names). It deliberately assumes NEITHER: it is a pure
 * accumulator over whatever nodes it is handed, and the correctness of the
 * AMBIGUOUS verdict is the caller's obligation: every node carrying a name
 * that will later be looked up must have been offered to {@link add}.
 *
 * Keys are `<pkg>\0<name>` so uniqueness (and the AMBIGUOUS sentinel) is judged
 * WITHIN a package, never across packages. Two benefits on a monorepo: a name
 * duplicated across packages no longer poisons every package's lookup into
 * AMBIGUOUS (false-negative fix), and a name can never resolve into a foreign
 * package without an import witness (false-positive fix). Non-workspace repos
 * have one package ("") and the maps degenerate to exactly the old global maps.
 */
export class PackageScopedNameIndex {
  /** `<pkg>\0<qualified_name>` → id, or AMBIGUOUS. */
  private readonly byQualified = new Map<string, string | typeof AMBIGUOUS>();
  /** `<pkg>\0<name>` → id, or AMBIGUOUS. */
  private readonly byName = new Map<string, string | typeof AMBIGUOUS>();

  /** The package-scoped key format. Single definition on purpose: the ingest
   *  and re-resolve paths must agree byte-for-byte or a warm graph would
   *  resolve differently from a cold one. */
  static key(pkg: string, name: string): string {
    return `${pkg}\0${name}`;
  }

  /**
   * Index one node under `pkg`. Returns `false` when the node was skipped
   * because it is a module (callers that also maintain non-name indexes can
   * ignore the result; it exists so the exclusion is observable in tests).
   *
   * A `module` node is resolved as an IMPORT target via the SpecifierResolver,
   * never as a call/reference `dst` by NAME (you import a module; you call a
   * symbol). Excluding modules from the by-name indexes prevents a module from
   * colliding with a same-named callable, e.g. a function named after its own
   * file (`def sympify` in `sympify.py`, module qn `sympify`, function qn
   * `sympify`). With the module included, that name went AMBIGUOUS and every
   * call `sympify(...)` fell through to `?:sympify` (unresolved), so `refs` on
   * the function found zero callers. Modules remain valid entries in the
   * caller's OWN indexes (same-file lookup, id set, import targets); only these
   * by-NAME call-resolution indexes skip them.
   */
  add(pkg: string, n: NameIndexNode): boolean {
    if (n.kind === "module") return false;
    // First writer wins; a SECOND DISTINCT id poisons the key to AMBIGUOUS.
    // Re-adding the SAME id must be tolerated and must NOT poison the key,
    // because a re-ingest replays nodes that are already indexed. (The
    // reresolveAllEdges caller additionally dedupes its candidate rows by id
    // before calling here, so on that path a repeat cannot even arrive; this
    // tolerance is load-bearing only for the replay case.)
    const qnKey = PackageScopedNameIndex.key(pkg, n.qualified_name);
    const existingQn = this.byQualified.get(qnKey);
    if (existingQn === undefined) this.byQualified.set(qnKey, n.id);
    else if (existingQn !== n.id) this.byQualified.set(qnKey, AMBIGUOUS);

    const nameKey = PackageScopedNameIndex.key(pkg, n.name);
    const existing = this.byName.get(nameKey);
    if (existing === undefined) this.byName.set(nameKey, n.id);
    else if (existing !== n.id) this.byName.set(nameKey, AMBIGUOUS);
    return true;
  }

  /**
   * Qualified-name first, then bare name, WITHIN one package. An AMBIGUOUS hit
   * on either map is a miss for that map, not a resolution: resolving to an
   * arbitrary one of several candidates would invent a false edge. Note the
   * sentinel is a literal string, so it must be excluded explicitly or it would
   * be returned as a bogus entity id.
   *
   * The qn map is consulted first, but a MISS there (including an ambiguous
   * one) falls through to the bare-name map for the same key, exactly as both
   * hand-written copies did. Only when both maps miss or are ambiguous is the
   * name unresolvable.
   */
  lookup(pkg: string, name: string): string | null {
    const qn = this.byQualified.get(PackageScopedNameIndex.key(pkg, name));
    if (typeof qn === "string" && qn !== AMBIGUOUS) return qn;
    const named = this.byName.get(PackageScopedNameIndex.key(pkg, name));
    if (typeof named === "string" && named !== AMBIGUOUS) return named;
    return null;
  }
}
