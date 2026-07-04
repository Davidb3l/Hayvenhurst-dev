# Tree-sitter grammar notes

Quirks of the specific grammar versions `hayven-native` pins, captured here so the next person to bump a grammar isn't surprised at runtime. Update this file whenever you change a `tree-sitter-*` dependency.

## Pinned versions (as of 0.0.1)

| Crate                       | Version |
|-----------------------------|---------|
| `tree-sitter`               | `0.25`  |
| `tree-sitter-python`        | `0.25`  |
| `tree-sitter-typescript`    | `0.23`  |
| `tree-sitter-javascript`    | `0.25`  |
| `tree-sitter-rust`          | `0.24`  |
| `tree-sitter-go`            | `0.25`  |

`tree-sitter` itself is pinned at `0.25` because `tree-sitter-typescript 0.23` does not yet support `0.26`. When the TS grammar catches up we can move the runtime too.

## Rust (`tree-sitter-rust 0.24`)

### Method calls have no `method_call_expression` node
Method calls are spelled as `call_expression` with a `field_expression` as the function child. Earlier grammar versions had a dedicated `method_call_expression` node — that's gone. The extractor's `target_identifier` handler already covers the `field_expression` case; do not regress to looking for the old node name.

### `impl_item` blocks are not query-captured — a coverage Node is synthesized
The query tags `function_item` (methods) and the type defs (`struct`/`enum`/`trait`/`type`), but NOT `impl_item`. So an `impl Foo { … }` block's methods become `Foo::method` entities while the block's `impl …{` opener + closing `}` belong to no node range. That leaks them as fragments into the context packer's module-skeleton header. `collect_rust_impl_nodes` walks the tree post-extraction and emits one coverage `Record::Node` per `impl_item` spanning the whole block, kind **`other`** (deliberately not `class`/`module` — see `rust_impl_name`), named `impl Foo` / `impl Trait for Foo` (distinct from the type's bare-`Foo` qn so derived ids never collide; the `impl ` prefix is load-bearing). The block is NOT added to `definitions`, so call-edge `src_name` attribution is unchanged. Trait blocks need no such handling — `trait_item` IS captured (a full-span `@definition.class` node already covers its wrapper). The `type:` field carries the Self type; an optional `trait:` field carries the implemented trait; generic params (`impl<T> …`) live in a separate child, not `type:`.

### `use_list` has no `path` field
The path lives on the parent `scoped_use_list`. When walking grouped imports you need to look at the parent to know the prefix you're inside.

### `use_wildcard` is overloaded
It can appear either as a standalone child of a `use_list` (representing `*` inside `use a::{b, *};` — meaning "everything else under the parent prefix") or as a child of a `scoped_use_list` carrying its own path (`a::*`). Both are valid.

### `self` inside a `use_list` means the parent prefix
`use a::{self, b};` should expand to two edges with `dst_name = "a"` and `"a::b"`. Do not emit `dst_name = "self"` — it's not a real symbol, it's a grammar device that says "the parent itself."

### Bare `use_list` (no scope) is legal
`use {a, b};` is technically allowed by the grammar even though no one writes it in practice. The expander handles this case so we don't panic on a real-world repo that did write it.

### Grouped imports must be expanded at extraction time
The daemon's edge resolver cannot un-spell `dst_name = "common::{run_parse, ParseSummary}"`. Native owns the expansion: `use a::{b, c::d}` produces two `edge` records with fully-qualified `dst_name`s (`a::b`, `a::c::d`).

## Python (`tree-sitter-python 0.25`)

### Module-vs-function-scope detection for imports
A file-level `import foo` belongs to the module. A `def bar(): import foo` belongs to `bar`. The extractor's `enclosing_definition` walk gets this right — but it's worth knowing the distinction matters for edge anchoring (see §2 of `ARCHITECTURE.md`).

### `__init__.py` module-name rule
For `src/util/__init__.py`, the module name is `util` (the parent directory), not `__init__`. Encoded in `module_name_for()`.

## TypeScript / JavaScript (`tree-sitter-typescript 0.23`, `tree-sitter-javascript 0.25`)

### Arrow functions assigned to `const`/`let` ARE extracted as functions
`export const foo = (x) => x + 1` is a `lexical_declaration` whose
`variable_declarator.value` is an `arrow_function` (or `function_expression`),
NOT a `function_declaration` — so the `function_declaration` query pattern alone
misses it. The `.scm` now also captures `(variable_declarator name: (identifier)
value: [(arrow_function) (function_expression)]) @definition.arrow`, and
`extract.rs` emits a `function` node for it. The node's span is the *declarator*;
its **signature** is read from the declarator's `value` (the arrow/function-expr
node has the `parameters`/`return_type` fields, the declarator does not — see
`extract.rs::sig_node` and `signature.rs::sig_of`).

### Bound object-literal methods are extracted as methods
`export const api = { search: (q) => … }` exposes a real `api.search` callable
surface. The `.scm` captures `(pair key: (property_identifier) value:
[(arrow_function) (function_expression)]) @definition.pair`; `extract.rs`
promotes it to a `method` node with id `obj/method` (`api/search`) — BUT only
when the enclosing object literal is **bound to a name** (`bound_object_name`:
the object's parent is a `variable_declarator` or another bound `pair`). An
anonymous inline object passed to a call (`register({ onClick: () => … })`) is
NOT promoted — we don't explode the index with one-off option bags.

### Nested arrow/function-expr ids are qualified by their enclosing definition
A helper defined inside another function (`function outer(){ const inner = () =>
… }`) is emitted as `outer/inner` (`arrow_qualified_name` walks enclosing
`class_declaration`/`function_declaration`/`method_definition`/arrow-const/
class-field-arrow ancestors). The separator is `/` (the project entity-id
separator), not the language `.`/`::`, because these are synthetic nav ids.
WHAT WE STILL SKIP: anonymous one-off callbacks (`arr.map(x => …)`). Class-field
arrows are NO LONGER skipped — see the next section.

### Class-field arrow methods and `#private` methods ARE extracted (2026-07-01)
Two modern class idioms the queries used to miss entirely (found on hono, where
they hid the ENTIRE `Context` API and `Hono.#dispatch` — see
`bench/affected-tests-typescript-RESULTS.md` §5(3)):

- **Class-field arrows** — `class Context { get = (key) => {…} }`. The grammar
  spells these as a field definition, NOT a `method_definition`. Node-name
  gotcha: the TS grammar calls it `public_field_definition` (even for
  `#private`/`private`-modifier fields) with the name under the `name:` field;
  the JS grammar calls it `field_definition` with the name under `property:`.
  Both are captured as `@definition.field` and promoted to **`method`** nodes
  named with the class-method convention (`Context.get`, dot separator, via
  `qualified_name` — NOT the `/`-separated arrow id). Only CALLABLE-valued
  fields match (`value:` is an `arrow_function`/`function_expression`); data
  fields (`#var = new Map()`) stay unindexed. Like arrow/pair, the *signature*
  is read from the `value` node; an accessibility modifier (`private handler =
  …`) lives on the field wrapper, so `ts_visibility` checks the parent too.
- **`#private` methods** — `class Hono { #dispatch(…) {…} }`. A normal
  `method_definition` whose `name:` is a `private_property_identifier`; the
  leading `#` is part of the node text, so the entity is `Hono.#dispatch` and
  visibility is `private`. `target_identifier` also accepts
  `private_property_identifier` so `this.#dispatch(…)` emits a call edge with
  `dst_name:"#dispatch"` (receiver `this`) — both call directions through
  private methods resolve.

Caller-side effect worth knowing: both idioms now appear in `definitions`, so
calls INSIDE their bodies attribute to the method entity (`Hono.#dispatch →
getPath`) instead of leaking to the enclosing class node — this is what repairs
static call chains that previously dead-ended at these members. A nested
`const res = (h) => …` inside a field-arrow body is qualified through the field
(`Context/html/res`), no longer colliding with a same-named real member
(`Context.res`).

### Single-parameter parenthesis-free arrows
`x => x + 1` carries its lone param under the **singular** `parameter` field, not
the `parameters` (`formal_parameters`) list — `ts_params_and_return` checks
`parameter` explicitly so the arity is 1, not 0.

### TSX is the same grammar as TS (`tree-sitter-typescript`)
The crate exposes two language objects (`language_typescript()` and `language_tsx()`). We use `language_tsx()` for `.tsx` files and `language_typescript()` for `.ts`. Both share the same query files since the JSX additions don't change what the function/class extractors see.

### Export wrapping
`export function foo() {}` is an `export_statement` whose `declaration` is the `function_declaration`. Always descend through the export wrapper when matching; don't anchor queries on the outer `export_statement` node.

### Member-access call edges carry a `receiver` (TS/JS/TSX/Astro)
A call `recv.method(...)` is a `call_expression` whose `function` is a
`member_expression`. The extractor emits the existing `static_call` edge with
`dst_name` = the member name (the `member_expression`'s `property`, e.g.
`"search"`) AND a new OPTIONAL `"receiver"` field with the receiver identifier
text (`extract.rs::call_receiver_name`). This lets the daemon bind the call to
whatever `recv` refers to (typically an imported `local` name — see below) and
resolve cross-file method calls like `api.search` → `~/api/client`'s `search`.

**Receiver = the IMMEDIATE object of the called member**, not the leftmost root:
- `api.search(x)`     → `dst_name:"search"`, `receiver:"api"`
- `a.b.c()`           → `dst_name:"c"`, `receiver:"b"` (the `member_expression`'s
  object is `a.b`; we take its rightmost `property` `b`)
- `this.x()`          → `receiver:"this"` (also `super`)
- `foo()`             → NO `receiver` (bare call — byte-identical to legacy)

We only emit a `receiver` we can attribute to a name. When the immediate object
is NOT a plain identifier we omit it (return `None`):
- `arr[i].run()`      — object is a `subscript_expression` → no receiver
- `getThing().run()`  — object is a `call_expression` → no receiver
- a regex/string/`new` object (`/re/.test(x)`, `new URLSearchParams().get()`)
  → no receiver

The field is serialized with `skip_serializing_if = "Option::is_none"`, so a
bare-call edge is byte-for-byte identical to the pre-change wire. Other grammars
(Python/Rust/Go) always emit `None` — `receiver` is an OPTIONAL, TS/JS-priority
field. `dst_name` itself is UNCHANGED from before for every call shape (the
rightmost identifier); `receiver` is purely additive context.

### Import edges carry the `local` binding name(s) (TS/JS/TSX/Astro)
Each `import` edge gains an OPTIONAL `"local":[...]` listing the local binding
name(s) the statement introduces (`extract.rs::import_local_bindings` walking the
`import_clause`):
- `import { api, qk } from "x"`    → `local:["api","qk"]`
- `import { a as b } from "x"`     → `local:["b"]` (the LOCAL alias, not `a`)
- `import Foo from "x"`            → `local:["Foo"]` (default `identifier` child)
- `import * as ns from "x"`        → `local:["ns"]` (`namespace_import`)
- `import Foo, { a } from "x"`     → `local:["Foo","a"]`
- `import type { T } from "x"`     → `local:["T"]` (same clause shape)
- `import "x"`                     → NO `local` (side-effect import, no binding)

`import_specifier` exposes the local name under its `alias` field for `a as b`,
else the `name` field is itself the local binding. The `local` value is computed
once per statement and shared by every `dst_name` the statement emits (JS emits
one edge per source module, so in practice one). `local` is also skipped on the
wire when `None`, so side-effect imports and non-JS langs are byte-identical to
before. Pairing `receiver` (call site) with `local` (import site) is what lets
the daemon resolve `api.search()` → the `search` member of whatever `~/api/client`
binds to `api`.

### CommonJS `require()` IS an import edge (2026-07-02) — recognized in the `@call` arm, not a query pattern
Plain-JS CommonJS produced ZERO import edges (measured on express: every
`require` collapsed to one `?:require` static_call and refs/impact were blind).
Now a `require("<string literal>")` call in any JS-family grammar
(JS/TS/TSX/Astro frontmatter — covers `.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts`)
is emitted as an **`import` edge** with the string literal as `dst_name`, the
exact ESM wire shape (daemon's SpecifierResolver needs no changes).

Grammar/implementation notes:
- **No query change for require** — `(call_expression) @call` already matches
  every require call, so `extract.rs` intercepts inside the `@call` handling
  (`require_specifier`) BEFORE the static_call path and `continue`s. One source
  construct → one edge: a recognized require does NOT also emit a call (mirrors
  ESM `import` statements). Only the bare identifier `require` with EXACTLY one
  plain `string` argument matches; `require(expr)`, `require("./" + x)`,
  template strings (even substitution-free — the grammar spells them
  `template_string`, and we conservatively skip them), extra args,
  `require.resolve(…)`, and `ctx.require(…)` all keep the legacy
  unresolved-CALL behavior — never invent an edge.
- **Binding forms → `local`/`import_aliases`** (`require_bindings`), mirroring
  the ESM fields so Tier-2 member-call resolution works identically:
  `const x = require('./y')` → `local:["x"]`; destructuring
  `const {a, b: c} = require('./y')` → `local:["a","c"]` +
  `import_aliases:[{local:"c",imported:"b"}]` (pattern kinds:
  `shorthand_property_identifier_pattern`, `pair_pattern`,
  `object_assignment_pattern` for `{a = 1}` — recurse on `left`,
  `rest_pattern` for `{...rest}` — treated as a namespace-ish local); member
  pick `const z = require('./y').thing` → `local:["z"]` +
  `{local:"z",imported:"thing"}` (≙ `import { thing as z }`); bare
  `require('./y')` and `module.exports = require('./y')` → no local;
  `require('debug')('express')` binds the CALL result, not the module → no
  local (conservative).
- **TS `import foo = require("./bar")`** is an `import_statement` whose
  specifier lives on the `import_require_clause` child's `source:` field, NOT
  on the statement — `js_imports` falls through to the clause. The binding is
  the clause's bare `(identifier)` child (the grammar exposes NO `name:` field
  on it). The require call INSIDE the clause is also matched by `@call`;
  `require_specifier` skips it (parent kind check) or the import would be
  emitted twice.
- **`exports.foo = function(){}` / `module.exports.foo = (x) => …`** are
  indexed as `function` definitions (`@definition.cjs_export` in the queries;
  the whole `assignment_expression` is the span so body calls attribute to the
  entity). The query matches ANY `<member>.<prop> = <callable literal>`;
  `extract.rs::cjs_export_target` promotes ONLY objects spelled exactly
  `exports` or `module.exports` — prototype patching (`Foo.prototype.bar =
  fn`), test monkey-patching (`res.end = fn`), and `this.handler = fn` are NOT
  exports and are skipped (indexing them would poison package-scoped name
  resolution). Non-callable exports (`exports.methods = […]`) and call-valued
  exports (`exports.etag = mkGen()`) stay unindexed, mirroring the
  arrow/pair/field callable-only policy.
- **Known residuals** (verified on express, 2026-07-02):
  `require('..')`/`require('../')` (package-root import, 68 edges on express)
  emits a correct raw-specifier edge but the DAEMON's `probeModule` can't
  resolve an empty joined path — a daemon fix, out of native's scope. The
  `module.exports = res; res.send = fn` aliased-surface idiom is not indexed
  (needs data-flow the extractor deliberately does not do). `module.exports =
  { foo: fn }` object-literal pairs are not promoted (the object is bound to
  `module.exports`, not a declarator — `bound_object_name` returns None).

## Astro (`.astro` — NO Astro grammar; frontmatter parsed as TypeScript)

### There is no `tree-sitter-astro` dependency
`.astro` is handled by the **light path**: an `.astro` file is a `---…---`
**frontmatter** block (which is TypeScript — imports, `interface Props`,
`const { … } = Astro.props`, server logic) followed by an HTML+JSX-ish
**template**. We slice out ONLY the frontmatter and parse it with the existing
`tree_sitter_typescript::LANGUAGE_TYPESCRIPT` grammar + the existing
`queries/typescript.scm`. The template below the closing fence is **not indexed**
(low code-intelligence value; would also require a different grammar). This adds
**zero** new dependency and **no** binary-size cost (release binary stays ~12 MB,
well under the 25 MB §9 budget), so adding `tree-sitter-astro` was not justified.

`Language::Astro` therefore maps to the TS grammar in `language.rs`
(`tree_sitter_language()`), the TS query in `extract.rs` and `signature.rs`, and
the JS/TS import/qualified-name arms.

### Frontmatter slicing + line offset (`extract.rs::astro_frontmatter`)
The slicer finds the first line whose trimmed text is exactly `---` (only leading
blank lines may precede it — Astro requires the frontmatter to lead the file) and
the next such line, returning the byte slice between them PLUS a `line_offset`
(the 0-based line index where the frontmatter content begins). Tree-sitter parses
the slice, so its node byte offsets index into the slice; every emitted node line
range has `line_offset` added back so ranges map to the **real** `.astro` file.
(For every other language `line_offset` is 0 and the parse source IS the whole
file — the Astro path is the only one that diverges.)

The synthetic **module node** always represents the WHOLE file (range +
`ast_hash` over the entire source, not just the frontmatter), so an edit to the
template still changes the module's `ast_hash`.

### What we capture vs. skip (honest caveats)
- **Captured:** frontmatter imports (as `import` edges from the module),
  `interface Props` / classes, top-level `function`/`const`-arrow/object-method
  definitions, and their `--signatures` contracts — the parts an agent navigates.
- **Skipped:** the entire HTML+JSX template (component usage like `<Stats />`,
  `client:*` directives, slots, inline `<script>`/`<style>`). A page that is
  template-only (no `---` block) still emits its module node so the page remains
  a navigable entity, but yields no symbols.
- A `<Stats />` reference in the template is NOT an edge — only the frontmatter
  `import Stats from "…"` is. Component-usage edges would need template parsing.

### `--langs` filter
The daemon's ingest filter (`DEFAULT_CONFIG.parse_languages`) must include
`"astro"` or `.astro` files are dropped before they reach the parser — the same
filter omission that hid `.tsx` until 2026-06.

## Go (`tree-sitter-go 0.25`)

### `method_declaration` vs `function_declaration`
Methods (functions with a receiver) are `method_declaration`, plain functions are `function_declaration`. The qualified name for a method should be `ReceiverType.MethodName` to match the PRD's "language's natural separator" rule.

### Type declarations as nodes
We extract `type_declaration` (struct, interface, alias) as a node kind. This matches the PRD's intent that "entity" includes types, not just callables.

## Signature extraction (`parse --signatures`)

`hayven-native parse --signatures` is an ADDITIVE opt-in: it emits one extra
`{"type":"signature", ...}` NDJSON record after each definition `node`, carrying
the contract derived from the real tree-sitter AST (NOT a line regex). The
existing `node`/`edge`/`done` stream is byte-for-byte unchanged with or without
the flag (verified: `diff <(parse ...) <(parse --signatures ... | grep -v
signature)` is empty modulo rayon record ordering). The daemon's deterministic
contract-diff conflict oracle (`daemon/src/conflict/contract_diff_oracle.ts` via
`native_signatures.ts`) consumes these. Implementation: `native/src/parse/signature.rs`.

Each record has `arity` (formal params, **receiver excluded**), `params` (the
per-parameter TYPE text when annotated, else the raw param text, in positional
order), `return_type` (or `null`), and `visibility` (`public` | `private` |
`unknown`, where `unknown` means "module-private but possibly re-exported" and is
treated by callers as possibly-public so a breakable contract is never
under-reported).

Per-language fidelity — what each language CAN and CANNOT express:

- **Python** — strongest for arity/visibility: `self`/`cls` excluded; `-> T`
  return read off the `return_type` field; param TYPES read from
  `typed_parameter`/`typed_default_parameter` (`x: T` → `T`); untyped params emit
  the name. Visibility is the PEP 8 convention (leading `_` = private, `__x__`
  dunder = public). WEAK: Python has no enforced visibility, and `*args`/`**kwargs`
  emit raw text (counted toward arity).
- **TypeScript / TSX** — strongest for types: param types and `: T` return are
  read from `type_annotation`; visibility from `export` (public),
  `private`/`protected`/`#name` (private), else `unknown`. WEAK: `unknown` covers
  both genuinely-module-local AND re-exported symbols (we cannot resolve
  `export { x } from` re-exports without the project index).
- **JavaScript / JSX** — arity + export-visibility only. No type annotations
  exist, so `params` is the raw pattern text and `return_type` is always `null`.
  WEAKEST on the type axis (by language design). NOW COVERS arrow / function-expr
  consts and bound object-literal methods (`const f = (a,b) => …`,
  `const api = { run: (x) => … }`) including single-bare-param arrows
  (`x => …` ⇒ arity 1). STILL WEAK: untyped params mean a param-rename at fixed
  arity is invisible (no type to diff).
- **Rust** — strong: `self`/`&self`/`&mut self` receiver excluded; param types
  read from each `parameter`'s `type` field; `-> T` from `return_type`.
  Visibility now distinguishes plain `pub` (→ `public`, the cross-crate contract)
  from `pub(crate)`/`pub(super)`/`pub(in …)` (→ internal `Visibility::Restricted`,
  which serializes to **`unknown`** on the wire — NOT `public`) and `pub(self)`/
  no-modifier (→ `private`). The daemon's `Signature` enum only has
  `public|private|unknown`, so `Restricted` rides on `unknown` ("module-private
  but possibly reachable" — `couldBePublic = visibility !== "private"`), which is
  the correct safety posture: a `pub(crate)` symbol can break an in-crate caller
  (so don't under-report it) but is not the cross-crate `public` contract (so a
  `pub(crate)`→`pub(crate)` refactor is no longer a false visibility-drop).
- **Go** — arity + return + convention-visibility. Grouped params (`a, b int`)
  expand to one positional slot **per name** so arity matches the real call
  shape; visibility is the uppercase-initial export convention. The `result`
  field is now **split**: a `(T, error)` multi-return becomes the canonical
  type-list `"int, error"` (not one opaque blob), and a **named** return
  (`(n int, err error)`) drops the name so a body-only return-name rename is not
  mistaken for a return-type change (it reads identically to `(int, error)`). A
  single return stays bare (`int`).

Residual FALSE-NEGATIVE classes the signature signal cannot see (documented so
the next maintainer doesn't mistake them for bugs): anonymous one-off callbacks
are still not captured; dynamic dispatch, decorators / HOFs that re-wrap a
callable, cross-language FFI references, and re-exports remain invisible to a
pure-signature diff. (Arrow-function / `const f = () =>` consts, bound object
methods, AND — as of 2026-07-01 — **class-field arrows** (`class C { handler =
() => {} }`) and `#private` methods are NO LONGER in this list — they are now
extracted with full signatures, `#`-named members reading as `private`.)

## How to add a new language

1. Add the `tree-sitter-<lang>` crate to `native/Cargo.toml` (must be MIT, Apache-2.0, or BSD-equivalent).
2. Register it in `native/src/parse/language.rs` (enum + file-extension mapping).
3. Write `native/src/parse/queries/<lang>.scm` for function/class/method/call/import patterns.
4. Add fixture(s) under `native/tests/fixtures/` and a corresponding integration test.
5. Document any grammar quirks here in this file before they bite the next maintainer.
6. Bump the binary size budget in `ARCHITECTURE.md` if you blow past 25 MB.
