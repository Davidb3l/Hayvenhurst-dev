; TypeScript query — extracts definitions, calls, and imports.
; Capture conventions match `python.scm` (see header there).

; Plain function declarations.
(function_declaration
  name: (identifier) @name.definition) @definition.function

; Class declarations and their methods.
(class_declaration
  name: (type_identifier) @name.definition) @definition.class

; `name` also matches ES `#private` methods (`#dispatch(...) {…}`) — the
; grammar spells the name as `private_property_identifier` and the leading
; `#` is part of its text, so the emitted entity is `Hono.#dispatch`.
(method_definition
  name: [(property_identifier) (private_property_identifier)] @name.definition) @definition.method

; CLASS-FIELD arrow/function-expression methods
; (`class Context { get = (key) => {…} }`). The grammar spells these as a
; `public_field_definition` (the node name says "public" but covers `#private`
; and `private`-modifier fields too), NOT a `method_definition`, so the pattern
; above misses them — hono's entire Context API is written this way. Only
; CALLABLE-valued fields are captured (plain data fields `#var = new Map()`
; stay unindexed). `extract.rs` promotes these to `method` nodes qualified by
; the enclosing class (`Context.get`), exactly like `method_definition`.
(public_field_definition
  name: [(property_identifier) (private_property_identifier)] @name.definition
  value: [(arrow_function) (function_expression)]) @definition.field

; Interface and type alias declarations.
(interface_declaration
  name: (type_identifier) @name.definition) @definition.class

(type_alias_declaration
  name: (type_identifier) @name.definition) @definition.class

; Arrow / function-expression definitions ASSIGNED to a const/let/var
; (`export const add = (a: number) => ...`). Tree-sitter spells these as a
; `lexical_declaration` whose `variable_declarator.value` is an
; `arrow_function`/`function_expression`, so the `function_declaration` pattern
; above misses them entirely. We capture the declarator; `extract.rs` reaches
; into its `value` for the real arity/param-type/return signature, and the
; qualified-name walk encodes any enclosing function so nested arrows don't
; collide with module-level ones.
(variable_declarator
  name: (identifier) @name.definition
  value: [(arrow_function) (function_expression)]) @definition.arrow

; Arrow / function-expression VALUES of an object-literal property, where the
; object is bound to a const (`export const api = { search: (q) => ... }`).
; This names the public method surface (`api.search`) agents search for. The
; "object is bound to a name" guard lives in `extract.rs` (it only promotes a
; pair whose nearest enclosing declarator binds the object), so anonymous inline
; config objects are NOT exploded into entities.
(pair
  key: (property_identifier) @name.definition
  value: [(arrow_function) (function_expression)]) @definition.pair

; Calls — both regular call_expression and `new Foo(...)`.
; CommonJS EXPORT-ASSIGNED callables (`exports.foo = function(){}`,
; `module.exports.foo = (x) => …`) — same capture as javascript.scm (the TS
; grammar spells the assignment identically); the `exports`/`module.exports`
; object guard lives in `extract.rs::cjs_export_target`.
(assignment_expression
  left: (member_expression
    property: (property_identifier) @name.definition)
  right: [(arrow_function) (function_expression)]) @definition.cjs_export

(call_expression) @call
(new_expression) @call

; Imports. CommonJS `require("…")` imports are NOT a query pattern: they're
; recognized inside the `@call` handling in `extract.rs`
; (`require_specifier`/`require_bindings`), since `(call_expression) @call`
; already matches every require call. TS `import foo = require("…")` IS an
; `import_statement` (with an `import_require_clause`) and resolves here.
(import_statement) @import
