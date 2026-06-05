; TypeScript query — extracts definitions, calls, and imports.
; Capture conventions match `python.scm` (see header there).

; Plain function declarations.
(function_declaration
  name: (identifier) @name.definition) @definition.function

; Class declarations and their methods.
(class_declaration
  name: (type_identifier) @name.definition) @definition.class

(method_definition
  name: (property_identifier) @name.definition) @definition.method

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
(call_expression) @call
(new_expression) @call

; Imports.
(import_statement) @import
