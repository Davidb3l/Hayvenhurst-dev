; Python query — extracts definitions, calls, and imports.
;
; Capture conventions used by `extract.rs`:
;   @definition.<kind>  → the full definition node (used for the source
;                         span / hash). `<kind>` is one of: function,
;                         method, class.
;   @name.definition    → the identifier sub-node used for `name` and
;                         `qualified_name`.
;   @call               → a call_expression-like node whose target is
;                         resolvable to a bare identifier or attribute.
;   @import             → an import statement; the captured node is the
;                         full statement and `extract.rs` walks its
;                         children to enumerate imported symbols.

; Function definitions (top-level and nested are both captured; the
; extractor distinguishes them based on the enclosing class context).
(function_definition
  name: (identifier) @name.definition) @definition.function

; Class definitions.
(class_definition
  name: (identifier) @name.definition) @definition.class

; Call expressions. Whole call captured; extractor walks the `function`
; child to figure out the destination identifier.
(call) @call

; Import statements — both `import x` and `from x import y` forms.
(import_statement) @import
(import_from_statement) @import
