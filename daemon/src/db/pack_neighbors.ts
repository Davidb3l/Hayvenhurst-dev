/**
 * THE SHARED NEIGHBOR PASSES: §3 callee neighbors, §4 referenced entities, §5
 * opt-in callers and §6 opt-in cross-file imported symbols, plus the small node
 * predicates they are written against.
 *
 * Carved out of `context_pack.ts` verbatim. Both single-target and multi-root
 * builders run these identical passes over a `NeighborPassState`; keeping them
 * in one module (as they already were in one region of the old file) is what
 * stops the two entry points from drifting apart again.
 *
 * §5 and §6 arrived here LAST, and for exactly the reason this module exists.
 * They had been written only on the single-target builder, so the multi-root
 * entry point ACCEPTED `maxCallers`/`importedSymbols` in its shared
 * `ContextPackOptions` and silently discarded both: an opted-in caller got an
 * empty result and no note, and `buildContextPackForChange` inherited the same
 * hole by delegation. Generalizing each guard from one target to the ROOT SET
 * (the same move §3/§4 already made) is what makes one implementation serve
 * both, and it degenerates exactly to the previous single-target behavior at
 * root-set size 1.
 */
// The test-file predicate is SHARED with the fts scaffold-ranking penalty (both
// are generated from one pattern list) so the packer's neighbor filter and
// search ranking can no longer disagree about what a test file is. It covers
// every indexed language; the JS/TS-only regex that used to live in the packer
// let Python/Go/Rust tests through as if they were real source.
import { isTestFile } from "../util/test_files.ts";
import { IMPORT_KIND, isCallKind } from "./graph_walk.ts";
import { collectImportedSymbols } from "./imported_symbol.ts";
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

/**
 * The dedupe set §5 and §6 work against: every node id ALREADY emitted as a
 * slice, recomputed from `st.slices` rather than read from `st.addedIds`.
 *
 * This is deliberate and is the shape both passes have always had. `addedIds`
 * is the §3/§4 working set and is not populated when those passes are skipped
 * (`neighbors:false`, or `maxNeighbors:0`), whereas §5/§6 run regardless of
 * that gate. Deriving from the emitted slices is therefore the one source that
 * is correct on every path. Header slices carry `id:null` and drop out, so only
 * target/callee/ref/caller ids can collide.
 */
function emittedIds(st: NeighborPassState): Set<string> {
  return new Set(st.slices.map((s) => s.id).filter((x): x is string => x !== null));
}

/**
 * §5 CALLERS: OPT-IN 1-hop INCOMING-caller neighbors (default OFF). Mirrors the
 * §3 callee pass exactly (same dangler/module/test/overlap guards, same
 * weight-desc-then-id-asc ranking) but over `db.incoming` (symbols that CALL a
 * root), and tagged `via:"caller"`. This recovers the case the callee/ref passes
 * structurally CAN'T: a target whose load-bearing behavior is supplied BY its
 * caller (a higher-order function handed a lambda, a callback wired at the call
 * site).
 *
 * Weights are SUMMED across roots and the cap is shared across the combined
 * caller set, exactly as §3 does for callees, so a multi-root pack stays bounded
 * rather than paying `maxCallers` per root. Skipped entirely when `maxCallers`
 * is 0/undefined, which is what keeps the default pack byte-identical to the
 * pre-caller-hop behavior on both entry points.
 */
export function addCallerNeighbors(st: NeighborPassState, maxCallers: number): void {
  if (maxCallers <= 0) return;
  const rootIsTest = anyRootIsTest(st);
  const addedIds = emittedIds(st);
  const byCaller = new Map<string, number>();
  for (const root of st.roots) {
    for (const e of st.db.incoming(root.id)) {
      // An edge from one root into another is not a neighbor; both bodies are
      // already target slices. At root-set size 1 this is the old
      // `e.src === target.id` test.
      if (!isCallKind(e.kind) || st.rootIds.has(e.src)) continue;
      byCaller.set(e.src, (byCaller.get(e.src) ?? 0) + e.weight);
    }
  }
  const ranked = [...byCaller.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  let added = 0;
  for (const [callerId, weight] of ranked) {
    if (added >= maxCallers) break;
    const caller = st.db.getNode(callerId);
    // Same guards as the callee pass: skip danglers (edge from an unresolved
    // id), whole-file modules, call edges from a test file (not a real
    // dependency when the roots are real source), and any caller already in the
    // slice set (dedupe by id against everything added so far).
    //
    // The test guard reads DIFFERENTLY on this pass and is deliberately kept:
    // real source genuinely IS called by its tests, so dropping test callers can
    // leave the opt-in caller hop empty for a well-tested symbol. It is retained
    // anyway because the pass exists to recover behavior SUPPLIED BY a caller (a
    // lambda handed to a higher-order function), and a test's stub argument is
    // exactly the wrong thing to hand the model as if it were production
    // behavior. Widening `isTestFile` to Python/Go/Rust makes this filter fire in
    // repos where it previously never did.
    if (!caller || isModuleNode(caller)) continue;
    if (isTestFile(caller.file) && !rootIsTest) continue;
    if (overlapsAnyRoot(st, caller)) continue; // straddles a root → already shown
    if (addedIds.has(callerId)) continue; // already a target/callee/ref slice
    const slice = sliceNode(caller, "neighbor", st.read);
    if (!slice) continue;
    slice.via = "caller";
    slice.weight = weight;
    st.slices.push(slice);
    addedIds.add(callerId);
    added++;
  }
  if (ranked.length > added) {
    st.notes.push(
      `${ranked.length - added} more caller(s) omitted (cap ${maxCallers}, or unresolved/module/dup)`,
    );
  }
}

/**
 * §6 IMPORTED SYMBOLS: OPT-IN cross-file non-node definitions (default OFF).
 *
 * The §4 ref pass only inlines indexed type-like NODES; a root that names an
 * imported `const`/object/`type` (a dispatch table, a CONFIG) defined in another
 * file has no node, so it is invisible to every rung. When opted in,
 * `collectImportedSymbols` text-extracts those declarations from each root
 * file's imported source files and returns them as `via:"ref"` slices.
 *
 * Roots are visited in emission order against ONE shared dedupe set and ONE
 * shared budget, so the same imported declaration reached from two roots is
 * added once and the total is capped like every other pass. `rootTexts` is keyed
 * by root id because the scan is over each root's OWN body text, not the
 * concatenation: an identifier only counts as imported-and-used where it is
 * actually named. Skipped entirely when off, so the default pack is unchanged.
 */
export function addImportedSymbolNeighbors(
  st: NeighborPassState,
  opts: {
    repoRoot: string;
    /** Root id → that root's target-slice text. */
    rootTexts: ReadonlyMap<string, string>;
    /** Shared cap across all roots. */
    maxSymbols: number;
  },
): void {
  const { repoRoot, rootTexts, maxSymbols } = opts;
  if (maxSymbols <= 0) return;
  const addedIds = emittedIds(st);
  let added = 0;
  for (const root of st.roots) {
    if (added >= maxSymbols) break;
    if (!root.file) continue;
    const text = rootTexts.get(root.id) ?? "";
    if (!text) continue;
    const extra = collectImportedSymbols(st.db, repoRoot, root, text, addedIds, {
      maxSymbols: maxSymbols - added,
    });
    for (const s of extra) st.slices.push(s);
    added += extra.length;
  }
  if (added > 0) {
    st.notes.push(`+${added} cross-file imported symbol(s) (opt-in)`);
  }
}
