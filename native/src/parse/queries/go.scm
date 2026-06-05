; Go query — see python.scm for capture conventions.

(function_declaration
  name: (identifier) @name.definition) @definition.function

(method_declaration
  name: (field_identifier) @name.definition) @definition.method

(type_declaration
  (type_spec
    name: (type_identifier) @name.definition)) @definition.class

; Calls.
(call_expression) @call

; Imports — Go bundles them in a single `import_declaration`; the
; extractor walks the children to enumerate paths.
(import_declaration) @import
