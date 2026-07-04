; JavaScript query — see python.scm for capture conventions.

; Function declarations.
(function_declaration
  name: (identifier) @name.definition) @definition.function

; Class declarations and their methods.
(class_declaration
  name: (identifier) @name.definition) @definition.class

; `name` also matches ES `#private` methods (`#dispatch(...) {…}`) — the
; grammar spells the name as `private_property_identifier` and the leading
; `#` is part of its text, so the emitted entity is `Hono.#dispatch`.
(method_definition
  name: [(property_identifier) (private_property_identifier)] @name.definition) @definition.method

; CLASS-FIELD arrow/function-expression methods
; (`class Context { get = (key) => {…} }`). The JS grammar spells these as a
; `field_definition` with a `property:` field (the TS grammar's equivalent is
; `public_field_definition` with `name:` — see typescript.scm), NOT a
; `method_definition`, so the pattern above misses them. Only CALLABLE-valued
; fields are captured (plain data fields stay unindexed). `extract.rs`
; promotes these to `method` nodes qualified by the enclosing class.
(field_definition
  property: [(property_identifier) (private_property_identifier)] @name.definition
  value: [(arrow_function) (function_expression)]) @definition.field

; Arrow / function-expression definitions ASSIGNED to a const/let/var. These
; are real named callables agents search for (`const foo = (x) => ...`,
; `const bar = function () {}`) but tree-sitter spells them as a plain
; `lexical_declaration`/`variable_declaration`, NOT a `function_declaration`,
; so the declaration patterns above miss them. We capture the *declarator* and
; let `extract.rs` reach into its `value` for the params/return signature. Both
; module-level and nested-in-a-body declarators match — the extractor's
; qualified-name walk encodes the enclosing function so they don't collide.
(variable_declarator
  name: (identifier) @name.definition
  value: [(arrow_function) (function_expression)]) @definition.arrow

; Arrow / function-expression VALUES of an object-literal property whose object
; is itself assigned to a const (`export const api = { search: (q) => ... }`).
; These name the public method surface agents look for (`api.search`). We
; capture the `pair`; the extractor qualifies it as `obj/method`. We do NOT
; match bare object literals that aren't bound to a name (anonymous config
; blobs) — the `variable_declarator > object` ancestor requirement lives in
; `extract.rs`, which only promotes a pair when its object is so bound.
(pair
  key: (property_identifier) @name.definition
  value: [(arrow_function) (function_expression)]) @definition.pair

; CommonJS EXPORT-ASSIGNED callables (`exports.foo = function(){}`,
; `module.exports.foo = (x) => …`). These name a CJS module's public callable
; surface exactly like an `export function foo`, but tree-sitter spells them as
; a plain `assignment_expression`, so every pattern above misses them — on
; express this hides the entire lib/utils API (`normalizeType`, `compileETag`,
; …) and require-bound calls to it can't resolve. Only CALLABLE-valued
; assignments are captured (a data export `exports.methods = […]` or a
; call-valued `exports.etag = mkGen()` stays unindexed, mirroring the
; arrow/pair/field policy). The "object is exactly `exports` or
; `module.exports`" guard lives in `extract.rs::cjs_export_target` — an
; arbitrary `obj.foo = fn` mutation (prototype patching, test monkey-patching)
; is NOT an export and is skipped there.
(assignment_expression
  left: (member_expression
    property: (property_identifier) @name.definition)
  right: [(arrow_function) (function_expression)]) @definition.cjs_export

; Calls — regular and `new Foo(...)`.
(call_expression) @call
(new_expression) @call

; ES module imports. CommonJS `require("…")` imports are NOT a query pattern:
; they're recognized inside the `@call` handling in `extract.rs`
; (`require_specifier`/`require_bindings`), since `(call_expression) @call`
; already matches every require call.
(import_statement) @import
