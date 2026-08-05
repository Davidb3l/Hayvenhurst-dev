/**
 * THE SHARED NEIGHBOR PASSES: §3 callee neighbors and §4 referenced entities,
 * plus the small node predicates they are written against.
 *
 * Carved out of `context_pack.ts` verbatim. Both single-target and multi-root
 * builders run these identical passes over a `NeighborPassState`; keeping them
 * in one module (as they already were in one region of the old file) is what
 * stops the two entry points from drifting apart again.
 */
// The test-file predicate is SHARED with the fts scaffold-ranking penalty (both
// are generated from one pattern list) so the packer's neighbor filter and
// search ranking can no longer disagree about what a test file is. It covers
// every indexed language; the JS/TS-only regex that used to live in the packer
// let Python/Go/Rust tests through as if they were real source.
import { isTestFile } from "../util/test_files.ts";
import { IMPORT_KIND, isCallKind } from "./graph_walk.ts";
import { sliceNode } from "./pack_slicing.ts";
import type { ContextSlice } from "./pack_types.ts";
import type { Db, NodeRow } from "./queries.ts";

/** A referenced entity (a type/class named in the target) is only inlined when
 *  its body is at most this many lines. A small interface/type alias is useful
 *  context; a 500-line class used merely as a parameter type would dominate the
 *  pack and defeat the slicing — the import line in the header already names it. */
const MAX_REF_LINES = 40;

/** Whether a node is a whole-file "module" entity whose body is the entire file
 *  — we never inline these as neighbors (that defeats the slicing). */
export function isModuleNode(node: NodeRow): boolean {
  return node.kind === "module";
}

/** Whether a node KIND is a "type-like" declaration — a class/interface/struct/
 *  enum/type-alias, all of which the parser emits as `kind:"class"` across the
 *  supported languages. These are the only entities the REFERENCED-entity pass
 *  (§4) should inline: the pass exists to surface a TYPE named in the target's
 *  signature whose body is neither a callee nor an import line. Methods and
 *  free functions are excluded — admitting them matched any same-file symbol
 *  that merely shared a common name with the target (sibling `convert`/`from`/
 *  `is` methods), which is noise, not a referenced type. */
function isTypeLikeKind(kind: string): boolean {
  return kind === "class";
}

/** Whether `n`'s line range overlaps `target`'s in the SAME file — i.e. `n` is
 *  nested inside (or straddles) the target body, so its text is already in the
 *  target slice and must not be added again as a neighbor. */
export function overlapsTarget(n: NodeRow, target: NodeRow): boolean {
  return (
    n.file === target.file &&
    n.range_start <= target.range_end &&
    n.range_end >= target.range_start
  );
}

/** True when `name` appears as a whole identifier in `text` (so `Foo` does not
 *  match `Foobar`/`barFoo`). Identifier-boundary lookaround rather than `\b` so
 *  `$`-containing identifiers behave; `name` is regex-escaped defensively. */
function referencesName(text: string, name: string): boolean {
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`).test(text);
}

/**
 * The state the two NEIGHBOR passes (§3 callees, §4 referenced entities) share.
 *
 * Both {@link buildContextPack} (one target) and {@link buildContextPackForSymbols}
 * (N roots) run the identical passes; they used to be two near-verbatim copies,
 * so a fix to one had to be mirrored by hand into the other. Every guard is
 * written against the ROOT SET, which degenerates exactly to the single-target
 * behavior at length 1 — that is what makes one implementation serve both.
 *
 * `slices`, `notes` and `addedIds` are MUTATED by the passes; the caller owns
 * them and reads them back after.
 */
export interface NeighborPassState {
  db: Db;
  read: (file: string) => string[] | null;
  slices: ContextSlice[];
  notes: string[];
  /** The pack's target(s), in emission order. */
  roots: NodeRow[];
  /** Ids of `roots`, for the "an edge pointing back at a root is not a
   *  neighbor" guard. */
  rootIds: ReadonlySet<string>;
  /** Every id already emitted as a slice (roots + whatever the passes add).
   *  Header slices have `id:null` and never appear here. */
  addedIds: Set<string>;
  maxNeighbors: number;
}

/** Whether ANY root is itself a test file. When one is, test neighbors are
 *  legitimate (a test really does depend on other test helpers) and the
 *  mis-resolution filter must not fire. */
function anyRootIsTest(st: NeighborPassState): boolean {
  return st.roots.some((r) => isTestFile(r.file));
}

/** Whether `n` overlaps ANY root's line range in that root's file — i.e. its
 *  text is already inside a target slice. */
function overlapsAnyRoot(st: NeighborPassState, n: NodeRow): boolean {
  return st.roots.some((r) => overlapsTarget(n, r));
}

/**
 * §3 NEIGHBORS — 1-hop callee dependencies (outgoing call edges) across ALL
 * roots, weight-summed, ranked weight-desc then id-asc, deduped, sharing ONE
 * `maxNeighbors` cap. A callee in another file arrives as its own line-exact
 * body — the cross-file slice.
 *
 * `omitReasonSuffix` is the only genuine difference between the two entry
 * points: the single-target pack's omission note reads "unresolved/module" and
 * the multi-root one reads "unresolved/module/dup". Passing it keeps both packs
 * byte-identical to their pre-extraction output rather than flattening one note
 * into the other.
 *
 * Import edges are deliberately NOT inlined here: the header already carries the
 * import statements textually, so inlining the imported module's body would
 * defeat the slicing.
 */
export function addCalleeNeighbors(st: NeighborPassState, omitReasonSuffix: string): void {
  const rootIsTest = anyRootIsTest(st);
  const byCallee = new Map<string, number>();
  for (const root of st.roots) {
    for (const e of st.db.outgoing(root.id)) {
      if (!isCallKind(e.kind) || st.rootIds.has(e.dst)) continue;
      byCallee.set(e.dst, (byCallee.get(e.dst) ?? 0) + e.weight);
    }
  }
  const ranked = [...byCallee.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  let added = 0;
  for (const [calleeId, weight] of ranked) {
    if (added >= st.maxNeighbors) break;
    if (st.addedIds.has(calleeId)) continue;
    const callee = st.db.getNode(calleeId);
    // Skip danglers (edge to an unresolved id), whole-file modules, and call
    // edges that mis-resolved into a test file (not a real dependency).
    if (!callee || isModuleNode(callee)) continue;
    if (isTestFile(callee.file) && !rootIsTest) continue;
    if (overlapsAnyRoot(st, callee)) continue; // nested in a root → already shown
    const slice = sliceNode(callee, "neighbor", st.read);
    if (!slice) continue;
    slice.via = "call";
    slice.weight = weight;
    st.slices.push(slice);
    st.addedIds.add(calleeId);
    added++;
  }
  if (ranked.length > added) {
    st.notes.push(
      `${ranked.length - added} more callee(s) omitted (cap ${st.maxNeighbors}, or ${omitReasonSuffix})`,
    );
  }
}

/**
 * §4 REFERENCED ENTITIES — indexed type-like entities NAMED in a root body but
 * not already included as callees.
 *
 * Types aren't call edges and the header skeleton subtracts entity bodies, so a
 * target whose signature uses a type (a same-file `ServeStaticOptions` OR an
 * imported `MiddlewareHandler`) would otherwise lack its definition. Same-file
 * refs run first (over `rootFiles`, in the caller's order), then cross-file refs
 * resolved via each root file's module-import edges. Refs get their OWN
 * `maxNeighbors` budget, separate from the callee pass's.
 */
export function addRefNeighbors(
  st: NeighborPassState,
  opts: {
    /** The text searched for referenced names: the target body, or the
     *  concatenation of all root bodies in the multi-root case. */
    rootText: string;
    /** Root files in same-file-scan order. Also the exclusion set for the
     *  cross-file scan (a "cross-file" ref must not be in a root file). */
    rootFiles: string[];
    maxRefSliceLines: number;
  },
): void {
  const { rootText, rootFiles, maxRefSliceLines } = opts;
  const rootIsTest = anyRootIsTest(st);
  const rootFileSet = new Set(rootFiles);
  let refAdded = 0;

  /** Try to add one entity row as a `via:"ref"` neighbor; returns true if added. */
  const tryAddRef = (r: { id: string; name: string; kind: string }): boolean => {
    if (st.rootIds.has(r.id) || r.kind === "module") return false;
    // ONLY type-like entities (classes/interfaces/structs/enums/type-aliases —
    // all `kind:"class"` in this schema) are valid refs. The ref pass exists to
    // surface a TYPE named in a root's signature/body whose definition is
    // neither a callee nor an import-statement line. Admitting `method`/
    // `function` entities here matched any same-file symbol that merely SHARES
    // a common name with the target (e.g. nine sibling `convert` methods for a
    // target also named `convert`, or `from`/`is`/`drop` in Rust) — pure noise,
    // since real calls already arrive via the callee pass. (Measured: this
    // dropped 8–10 junk ref slices per pack on click/anyhow.)
    if (!isTypeLikeKind(r.kind)) return false;
    if (st.addedIds.has(r.id)) return false;
    if (!referencesName(rootText, r.name)) return false;
    const node = st.db.getNode(r.id);
    if (!node) return false;
    if (overlapsAnyRoot(st, node)) return false; // nested in a root → already shown
    if (isTestFile(node.file) && !rootIsTest) return false;
    // Skip huge entities (a big class used only as a type) — they'd dominate
    // the pack; the header's import line already names them.
    if (node.range_end - node.range_start + 1 > MAX_REF_LINES) return false;
    const slice = sliceNode(node, "neighbor", st.read);
    if (!slice) return false;
    slice.via = "ref";
    // Leaner ref slices: a referenced type contributes its declaration +
    // opening shape (interface fields / member signatures), not deep method
    // bodies. Cap to the FIRST N lines of the entity, LINE-EXACT — the slice
    // text stays the real file lines [startLine .. startLine+N-1]; the
    // truncation is recorded in notes + on the slice, never inside text.
    // (Never applies to callee/target slices; composes with the MAX_REF_LINES
    // skip-entirely gate above — only refs that ARE included are capped.)
    const fullEnd = slice.endLine;
    const sliceLen = slice.endLine - slice.startLine + 1;
    if (sliceLen > maxRefSliceLines) {
      const newEnd = slice.startLine + maxRefSliceLines - 1;
      const lines = st.read(node.file ?? "");
      if (lines) {
        slice.endLine = newEnd;
        slice.text = lines.slice(slice.startLine - 1, newEnd).join("\n");
        slice.truncatedFromEndLine = fullEnd;
        st.notes.push(
          `ref \`${r.id}\` truncated to first ${maxRefSliceLines} of ${sliceLen} lines`,
        );
      }
    }
    st.slices.push(slice);
    st.addedIds.add(r.id);
    refAdded++;
    return true;
  };

  const entitiesIn = (file: string) =>
    st.db.handle
      .query<{ id: string; name: string; kind: string }, [string]>(
        "SELECT id, name, kind FROM nodes WHERE file = ?",
      )
      .all(file)
      .sort((a, b) => a.id.localeCompare(b.id));

  // 4a. Same-file referenced entities.
  for (const file of rootFiles) {
    if (refAdded >= st.maxNeighbors) break;
    for (const r of entitiesIn(file)) {
      if (refAdded >= st.maxNeighbors) break;
      tryAddRef(r);
    }
  }

  // 4b. Cross-file referenced entities: resolve each root file's module node,
  //     follow its import edges to imported module files, and inline any entity
  //     therein named in a root body (e.g. an imported type used in the
  //     signature). Each imported entity comes in as its own line-exact body.
  if (refAdded >= st.maxNeighbors) return;
  const importedFiles = new Set<string>();
  for (const file of rootFiles) {
    const moduleNode = st.db.handle
      .query<{ id: string }, [string]>(
        "SELECT id FROM nodes WHERE file = ? AND kind = 'module' LIMIT 1",
      )
      .get(file);
    if (!moduleNode) continue;
    for (const e of st.db.outgoing(moduleNode.id)) {
      if (e.kind !== IMPORT_KIND) continue;
      const imp = st.db.getNode(e.dst);
      if (imp?.file && !rootFileSet.has(imp.file)) importedFiles.add(imp.file);
    }
  }
  for (const f of [...importedFiles].sort()) {
    if (refAdded >= st.maxNeighbors) break;
    for (const r of entitiesIn(f)) {
      if (refAdded >= st.maxNeighbors) break;
      tryAddRef(r);
    }
  }
}
