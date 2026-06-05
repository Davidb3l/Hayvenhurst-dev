; Rust query — see python.scm for capture conventions.

; Free functions and `impl` block methods both surface as `function_item`
; in Tree-sitter; we tag them all `function` here and let the extractor
; promote impl-block items to qualified `Type::method` names based on
; their enclosing `impl_item`.
(function_item
  name: (identifier) @name.definition) @definition.function

; Type definitions.
(struct_item
  name: (type_identifier) @name.definition) @definition.class

(enum_item
  name: (type_identifier) @name.definition) @definition.class

(trait_item
  name: (type_identifier) @name.definition) @definition.class

(type_item
  name: (type_identifier) @name.definition) @definition.class

; Calls. In tree-sitter-rust 0.24, method calls are also
; `call_expression` nodes (with a `field_expression` as the function
; child) — there is no separate `method_call_expression` kind.
(call_expression) @call

; Imports.
(use_declaration) @import
