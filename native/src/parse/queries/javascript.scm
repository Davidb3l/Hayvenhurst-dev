; JavaScript query — see python.scm for capture conventions.

; Function declarations.
(function_declaration
  name: (identifier) @name.definition) @definition.function

; Class declarations and their methods.
(class_declaration
  name: (identifier) @name.definition) @definition.class

(method_definition
  name: (property_identifier) @name.definition) @definition.method

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

; Calls — regular and `new Foo(...)`.
(call_expression) @call
(new_expression) @call

; ES module imports.
(import_statement) @import
