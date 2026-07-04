//! Tree-sitter-derived contract SIGNATURES for the deterministic contract-diff
//! conflict oracle (Blocker A, candidate (b)).
//!
//! The daemon's heuristic conflict oracle over-blocks adjacent-benign concurrent
//! claims because token overlap cannot tell a CONTRACT change (a new parameter, a
//! changed return type, a visibility drop — breaks callers) from an INTERNAL one
//! (a body rewrite whose public surface is untouched). The fix is to diff the
//! REAL signature of the claimed entity. This module produces that signature from
//! the parsed AST — NOT a line/regex parse — for the five supported languages.
//!
//! It is OPT-IN: only invoked when `parse --signatures` is set, and it only ever
//! ADDS `Record::Signature` lines to the existing stream (see `proto.rs`). The
//! Node/Edge output other code depends on is byte-for-byte unchanged.
//!
//! Per-language fidelity is documented in `native/docs/TREE_SITTER_NOTES.md`
//! ("Signature extraction (`parse --signatures`)").

use tree_sitter::Node;

use super::language::Language;

/// A structural signature extracted from a definition node. Mirrors the daemon's
/// `Signature` TS interface (`daemon/src/conflict/contract_diff_oracle.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    /// Declared formal-parameter count (receiver `self`/`cls` excluded).
    pub arity: usize,
    /// Per-parameter type text when annotated, else the raw parameter text.
    /// Order is significant (positional contract).
    pub params: Vec<String>,
    /// Declared return-type text, or `None` when the decl carries none.
    pub return_type: Option<String>,
    /// `public` | `private` | `unknown` cross-file reachability class.
    pub visibility: Visibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visibility {
    Public,
    Private,
    Unknown,
    /// Rust `pub(crate)` / `pub(super)` / `pub(in path)` — a RESTRICTED public
    /// surface: visible beyond the defining module but NOT a cross-crate
    /// contract. Distinct from plain `Public` (which we previously over-reported
    /// it as) so a `pub(crate)`-internal refactor isn't mistaken for a
    /// cross-crate public change. On the wire it serializes to `"unknown"` —
    /// the daemon's `Signature` type is `public|private|unknown` and treats
    /// `unknown` as "module-private but possibly reachable" (`couldBePublic =
    /// visibility !== "private"`), which is exactly the right safety posture for
    /// a restricted-visibility symbol: it COULD break an in-crate caller, so we
    /// must not under-report it, but it is NOT the cross-crate `public` contract.
    Restricted,
}

impl Visibility {
    /// Wire representation. NOTE: `Restricted` deliberately maps to `"unknown"`
    /// because the daemon's consuming `Signature` interface
    /// (`daemon/src/conflict/native_signatures.ts`) only accepts
    /// `public|private|unknown`. Keep this in sync if that enum ever grows a
    /// `crate`/`restricted` member.
    pub fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Private => "private",
            Visibility::Unknown | Visibility::Restricted => "unknown",
        }
    }
}

/// Extract a contract signature from a definition node, per language. `def_node`
/// is the full definition node captured by the query (a `function_definition`,
/// `function_item`, `method_declaration`, `class_definition`, etc.). `name` is
/// the bare identifier. Returns `None` when the node carries no callable/typed
/// contract worth diffing (e.g. a bare Python/TS class with no constructor — its
/// surface is its methods, which are emitted as their own definitions).
pub fn extract_signature(
    def_node: Node,
    name: &str,
    language: Language,
    source: &[u8],
) -> Option<Signature> {
    match language {
        Language::Python => python_signature(def_node, name, source),
        // Astro frontmatter is TypeScript; same signature extractor.
        Language::TypeScript | Language::Tsx | Language::Astro => {
            ts_signature(def_node, name, source)
        }
        Language::JavaScript => js_signature(def_node, name, source),
        Language::Rust => rust_signature(def_node, name, source),
        Language::Go => go_signature(def_node, source),
    }
}

/// Text of a node, lossily; empty string on failure.
fn text<'a>(node: Node, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.start_byte()..node.end_byte()]).unwrap_or("")
}

/* ── Python ────────────────────────────────────────────────────────────────
 * `function_definition`:
 *   name: identifier
 *   parameters: (parameters ...)            # may include typed_parameter,
 *                                           # default_parameter, typed_default_parameter,
 *                                           # list_splat_pattern, dictionary_splat_pattern
 *   return_type: type                       # the `-> T` annotation, optional
 *
 * Visibility: Python has no access modifier. We use the PEP 8 convention: a
 * leading underscore (not a dunder) marks a name as private-by-convention; a
 * dunder (`__x__`) is protocol/public-ish. Anything else is public.
 */
fn python_signature(def_node: Node, name: &str, source: &[u8]) -> Option<Signature> {
    let params_node = def_node.child_by_field_name("parameters");
    let mut params = Vec::new();
    if let Some(pn) = params_node {
        let mut cursor = pn.walk();
        for child in pn.named_children(&mut cursor) {
            // Skip the receiver — a cross-file caller never passes self/cls.
            let param_text = python_param_text(child, source);
            if let Some(t) = param_text {
                params.push(t);
            }
        }
    }

    let return_type = def_node
        .child_by_field_name("return_type")
        .map(|n| text(n, source).trim().to_string())
        .filter(|s| !s.is_empty());

    let is_dunder = name.starts_with("__") && name.ends_with("__");
    let visibility = if !is_dunder && name.starts_with('_') {
        Visibility::Private
    } else {
        Visibility::Public
    };

    Some(Signature {
        arity: params.len(),
        params,
        return_type,
        visibility,
    })
}

/// Returns the type annotation of a Python parameter (preferred), or its raw
/// text. Returns `None` for the `self`/`cls` receiver so it's excluded from the
/// contract a caller sees.
fn python_param_text(child: Node, source: &[u8]) -> Option<String> {
    match child.kind() {
        // `self` / `cls` plain identifier receiver.
        "identifier" => {
            let t = text(child, source);
            if t == "self" || t == "cls" {
                None
            } else {
                Some(t.to_string())
            }
        }
        // `x: T` and `x: T = default` — emit the annotation type.
        "typed_parameter" | "typed_default_parameter" => {
            if let Some(ty) = child.child_by_field_name("type") {
                Some(text(ty, source).trim().to_string())
            } else {
                Some(text(child, source).trim().to_string())
            }
        }
        // `x = default` — no annotation, emit the param name.
        "default_parameter" => child
            .child_by_field_name("name")
            .map(|n| text(n, source).to_string())
            .or_else(|| Some(text(child, source).trim().to_string())),
        // `*args` / `**kwargs` and other patterns — emit raw text.
        "list_splat_pattern" | "dictionary_splat_pattern" => {
            Some(text(child, source).trim().to_string())
        }
        // A bare `,` or `(` would not be a named child; anything else we keep
        // raw so a novel pattern still counts toward arity.
        _ => Some(text(child, source).trim().to_string()),
    }
}

/* ── TypeScript / TSX ────────────────────────────────────────────────────────
 * `function_declaration` / `method_definition`:
 *   parameters: (formal_parameters (required_parameter pattern: ... type: (type_annotation))
 *                                  (optional_parameter ...) ...)
 *   return_type: (type_annotation)
 * Visibility: a top-level `export` keyword (or `export default`) makes it public;
 * a `private`/`protected` accessibility modifier or a `#name` private field marks
 * it private; otherwise `unknown` (module-private but could still be re-exported).
 */
fn ts_signature(def_node: Node, name: &str, source: &[u8]) -> Option<Signature> {
    let (params, return_type) = ts_params_and_return(def_node, source);
    let visibility = ts_visibility(def_node, name, source);
    Some(Signature {
        arity: params.len(),
        params,
        return_type,
        visibility,
    })
}

fn js_signature(def_node: Node, _name: &str, source: &[u8]) -> Option<Signature> {
    // JS has no type annotations or visibility keywords. We still report arity +
    // raw param text + export-based visibility; types are `null`-equivalent
    // (the raw param name, since there is no annotation to extract).
    let (params, _ret) = ts_params_and_return(def_node, source);
    let visibility = ts_visibility(def_node, _name, source);
    Some(Signature {
        arity: params.len(),
        params,
        return_type: None,
        visibility,
    })
}

/// Shared TS/JS param + return extraction (TS grammar is a superset of JS here).
fn ts_params_and_return(def_node: Node, source: &[u8]) -> (Vec<String>, Option<String>) {
    let mut params = Vec::new();
    // A single-parameter arrow written WITHOUT parens (`x => x + 1`) carries its
    // param under the singular `parameter` field, not the `parameters`
    // (`formal_parameters`) list — so the loop below misses it and reports
    // arity 0. Pick it up explicitly. (`(x) => …` and `x => …` then agree.)
    if def_node.child_by_field_name("parameters").is_none() {
        if let Some(single) = def_node.child_by_field_name("parameter") {
            return (vec![text(single, source).trim().to_string()], None);
        }
    }
    if let Some(pn) = def_node.child_by_field_name("parameters") {
        let mut cursor = pn.walk();
        for child in pn.named_children(&mut cursor) {
            match child.kind() {
                "required_parameter" | "optional_parameter" => {
                    params.push(ts_param_token(child, source));
                }
                // Plain JS identifier / pattern parameter (no wrapper node).
                "identifier" | "object_pattern" | "array_pattern" | "rest_pattern"
                | "assignment_pattern" => {
                    params.push(text(child, source).trim().to_string());
                }
                _ => {
                    let t = text(child, source).trim();
                    if !t.is_empty() {
                        params.push(t.to_string());
                    }
                }
            }
        }
    }
    let return_type = def_node
        .child_by_field_name("return_type")
        .map(|n| text(n, source).trim_start_matches(':').trim().to_string())
        .filter(|s| !s.is_empty());
    (params, return_type)
}

/// Canonical TS/JS positional-parameter token for a `required_parameter` /
/// `optional_parameter` wrapper. The token is the declared TYPE (else the bare
/// pattern text), PLUS two structural markers a caller depends on but that the
/// raw `type` field drops:
///
/// - a trailing `?` for an `optional_parameter` — `b?: string` ⇒ `"string?"`,
///   so it is NOT byte-identical to the required `b: string` ⇒ `"string"`.
///   Flipping a param required↔optional is a real caller-visible contract
///   change (a previously-mandatory arg becomes droppable, or vice-versa);
///   without the marker the signature diff was BLIND to it (an escape).
/// - a leading `...` for a REST parameter (`...args: number[]`) — the `...`
///   lives on the wrapper, not in the `type_annotation`, so `rest(...args:
///   number[])` used to read identically to `norest(args: number[])`. A rest
///   param accepts 0..N trailing args; a fixed one accepts exactly one — a
///   different call shape, so we prepend `...`.
///
/// Both markers are DETERMINISTIC functions of the declaration, so a body-only
/// edit leaves the token byte-identical; only a real required/optional/rest or
/// type change moves it.
fn ts_param_token(param: Node, source: &[u8]) -> String {
    let is_optional = param.kind() == "optional_parameter";
    // A rest param is a `required_parameter`/`optional_parameter` whose pattern
    // is a `rest_pattern` (`...args`). The grammar keeps the `...` on the
    // wrapper text but NOT inside the `type` field, so detect it structurally.
    let is_rest = param
        .child_by_field_name("pattern")
        .map(|p| p.kind() == "rest_pattern")
        .unwrap_or(false);

    let base = if let Some(ty) = param.child_by_field_name("type") {
        // type_annotation wraps the type after the `:`. Strip a leading `:` if
        // the grammar included it.
        text(ty, source).trim_start_matches(':').trim().to_string()
    } else if let Some(pat) = param.child_by_field_name("pattern") {
        // Untyped (JS-style) param — the pattern text already carries `...` for
        // a rest pattern, so don't double-prefix in that branch.
        return text(pat, source).trim().to_string();
    } else {
        return text(param, source).trim().to_string();
    };

    let mut token = base;
    if is_optional {
        token.push('?');
    }
    if is_rest {
        token.insert_str(0, "...");
    }
    token
}

/// TS/JS visibility: export keyword → public; `private`/`protected`/`#` → private;
/// else unknown. We look at the definition node and (for top-level functions) its
/// parent `export_statement`.
fn ts_visibility(def_node: Node, name: &str, source: &[u8]) -> Visibility {
    if name.starts_with('#') {
        return Visibility::Private;
    }
    // An accessibility_modifier child marks a class member private/protected.
    if let Some(modifier) = first_child_of_kind(def_node, "accessibility_modifier", source) {
        if modifier == "private" || modifier == "protected" {
            return Visibility::Private;
        }
        if modifier == "public" {
            return Visibility::Public;
        }
    }
    // A CLASS-FIELD arrow method (`private handler = () => {}`): `def_node` is
    // the arrow/function-expression VALUE, but the accessibility modifier lives
    // on the enclosing field definition (`public_field_definition` in the TS
    // grammar / `field_definition` in JS), so check the parent wrapper too.
    if let Some(p) = def_node.parent() {
        if matches!(p.kind(), "public_field_definition" | "field_definition") {
            if let Some(modifier) = first_child_of_kind(p, "accessibility_modifier", source) {
                if modifier == "private" || modifier == "protected" {
                    return Visibility::Private;
                }
                if modifier == "public" {
                    return Visibility::Public;
                }
            }
        }
    }
    // Top-level `export function` / `export default function` — the parent of the
    // function_declaration is an export_statement.
    let mut cur = def_node.parent();
    while let Some(p) = cur {
        match p.kind() {
            "export_statement" => return Visibility::Public,
            // Stop climbing at a body/class boundary; an inner function isn't a
            // module export just because the file exports something else.
            "statement_block" | "class_body" | "program" => break,
            _ => {}
        }
        cur = p.parent();
    }
    Visibility::Unknown
}

/// First direct child whose kind matches, returned as trimmed text.
fn first_child_of_kind(node: Node, kind: &str, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == kind {
            return Some(text(child, source).trim().to_string());
        }
    }
    None
}

/* ── Rust ────────────────────────────────────────────────────────────────────
 * `function_item`:
 *   (visibility_modifier)?  fn  name: identifier
 *   parameters: (parameters (self_parameter)? (parameter pattern: ... type: ...) ...)
 *   return_type: (... after `->`)
 * Visibility: a `pub` (visibility_modifier) child → public; else private (Rust
 * defaults to module-private — a real cross-crate contract requires `pub`).
 */
fn rust_signature(def_node: Node, _name: &str, source: &[u8]) -> Option<Signature> {
    let mut params = Vec::new();
    if let Some(pn) = def_node.child_by_field_name("parameters") {
        let mut cursor = pn.walk();
        for child in pn.named_children(&mut cursor) {
            match child.kind() {
                // `self` / `&self` / `&mut self` receiver — excluded from arity.
                "self_parameter" => {}
                "parameter" => {
                    if let Some(ty) = child.child_by_field_name("type") {
                        params.push(text(ty, source).trim().to_string());
                    } else {
                        params.push(text(child, source).trim().to_string());
                    }
                }
                // variadic / other patterns
                _ => {
                    let t = text(child, source).trim();
                    if !t.is_empty() {
                        params.push(t.to_string());
                    }
                }
            }
        }
    }

    let return_type = def_node
        .child_by_field_name("return_type")
        .map(|n| text(n, source).trim().to_string())
        .filter(|s| !s.is_empty());

    let visibility = rust_visibility(def_node, source);

    Some(Signature {
        arity: params.len(),
        params,
        return_type,
        visibility,
    })
}

/// Classify a Rust item's visibility from its leading `visibility_modifier`.
///
/// tree-sitter-rust 0.24 spells the modifier as a single `visibility_modifier`
/// node whose text is one of `pub`, `pub(crate)`, `pub(super)`, `pub(self)`, or
/// `pub(in some::path)`. We distinguish:
/// - plain `pub`            → `Public`   (the real cross-crate contract)
/// - `pub(crate)`/`(super)`/`(in …)` → `Restricted` (in-crate only — NOT a
///   cross-crate public surface; previously mis-reported as `Public`)
/// - `pub(self)`            → `Private`  (equivalent to no modifier)
/// - no modifier            → `Private`  (Rust default is module-private)
fn rust_visibility(def_node: Node, source: &[u8]) -> Visibility {
    // The modifier must be a direct leading child to apply to THIS item (a
    // `pub` deeper in the subtree belongs to a nested item, not us).
    let modifier = def_node
        .child(0)
        .filter(|c| c.kind() == "visibility_modifier");
    let Some(modifier) = modifier else {
        return Visibility::Private;
    };
    let raw = text(modifier, source).trim();
    if raw == "pub" {
        Visibility::Public
    } else if raw.contains("self") {
        // `pub(self)` == private to this module.
        Visibility::Private
    } else {
        // `pub(crate)`, `pub(super)`, `pub(in path)` — restricted public.
        Visibility::Restricted
    }
}

/* ── Go ──────────────────────────────────────────────────────────────────────
 * `function_declaration` / `method_declaration`:
 *   name: (identifier|field_identifier)
 *   parameters: (parameter_list (parameter_declaration name: ... type: ...) ...)
 *   result: (type | parameter_list)         # optional return(s)
 * Visibility: Go is convention-based — an exported identifier starts with an
 * uppercase letter. The `name` field already encodes this.
 */
fn go_signature(def_node: Node, source: &[u8]) -> Option<Signature> {
    let name = def_node
        .child_by_field_name("name")
        .map(|n| text(n, source).to_string())
        .unwrap_or_default();

    let mut params = Vec::new();
    if let Some(pn) = def_node.child_by_field_name("parameters") {
        let mut cursor = pn.walk();
        for child in pn.named_children(&mut cursor) {
            if child.kind() == "parameter_declaration"
                || child.kind() == "variadic_parameter_declaration"
            {
                // A Go declaration can name several params of one type
                // (`a, b int`); each becomes one positional contract slot.
                let mut ty = child
                    .child_by_field_name("type")
                    .map(|n| text(n, source).trim().to_string())
                    .unwrap_or_default();
                // A variadic param (`a ...int`) accepts 0..N trailing args — a
                // DIFFERENT call shape from a fixed `a int`. The `...` lives on
                // the declaration, not in the `type` field, so prepend it: a
                // fixed→variadic change is then a real, visible contract diff
                // (`"int"` vs `"...int"`) instead of an invisible no-op.
                if child.kind() == "variadic_parameter_declaration" && !ty.is_empty() {
                    ty.insert_str(0, "...");
                }
                let name_count = {
                    let mut c = child.walk();
                    let n = child
                        .children_by_field_name("name", &mut c)
                        .count();
                    n.max(1)
                };
                for _ in 0..name_count {
                    params.push(ty.clone());
                }
            }
        }
    }

    let return_type = def_node
        .child_by_field_name("result")
        .and_then(|n| go_result_type(n, source))
        .filter(|s| !s.is_empty());

    let visibility = if name.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) {
        Visibility::Public
    } else {
        Visibility::Private
    };

    Some(Signature {
        arity: params.len(),
        params,
        return_type,
        visibility,
    })
}

/// Normalize a Go function `result` into a canonical, type-only return contract.
///
/// The `result` field is one of:
/// - a single bare `type` node (`func f() int`)            → `"int"`
/// - a `parameter_list` of one-or-more returns, each maybe
///   named (`func f() (int, error)` / `func f() (n int, err error)`).
///
/// Previously the whole `result` was emitted as ONE text blob, so a `(T, error)`
/// multi-return was a single opaque string AND a body-only rename of a *named*
/// return (`(n int)` → `(result int)`) looked like a return-type change. We now:
/// - SPLIT a multi-return `parameter_list` into its component TYPES, and
/// - DROP the optional return-value name (only the type is the caller contract),
///
/// joining them as `"T1, T2"`. A single return stays bare (`"int"`). The result
/// is the structural return contract a caller actually depends on, with the
/// multi-return blob split into its parts and named-return noise removed.
fn go_result_type(result: Node, source: &[u8]) -> Option<String> {
    if result.kind() == "parameter_list" {
        let mut types: Vec<String> = Vec::new();
        let mut cursor = result.walk();
        for child in result.named_children(&mut cursor) {
            if child.kind() == "parameter_declaration"
                || child.kind() == "variadic_parameter_declaration"
            {
                let ty = child
                    .child_by_field_name("type")
                    .map(|n| text(n, source).trim().to_string())
                    .unwrap_or_default();
                // A bare `(int, error)` parses as parameter_declarations with
                // only a `type` and no `name`; a named `(n int)` has both — we
                // keep only the type either way. One slot per declared name
                // (`(a, b int)` as a return is legal-but-rare → two `int`s).
                let name_count = {
                    let mut c = child.walk();
                    child.children_by_field_name("name", &mut c).count().max(1)
                };
                for _ in 0..name_count {
                    if !ty.is_empty() {
                        types.push(ty.clone());
                    }
                }
            }
        }
        if types.is_empty() {
            // Fallback: unrecognized shape — keep the raw text rather than
            // silently dropping a real return contract.
            let raw = text(result, source).trim().to_string();
            return if raw.is_empty() { None } else { Some(raw) };
        }
        Some(types.join(", "))
    } else {
        // Single bare return type.
        let raw = text(result, source).trim().to_string();
        if raw.is_empty() {
            None
        } else {
            Some(raw)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

    /// Parse `source`, run the language query, and return the signature of the
    /// FIRST definition whose name matches `want_name`.
    fn sig_of(source: &str, language: Language, want_name: &str) -> Option<Signature> {
        let ts_lang = language.tree_sitter_language();
        let mut parser = Parser::new();
        parser.set_language(&ts_lang).unwrap();
        let tree = parser.parse(source.as_bytes(), None).unwrap();
        let query_src = match language {
            Language::Python => include_str!("queries/python.scm"),
            Language::TypeScript | Language::Tsx | Language::Astro => {
                include_str!("queries/typescript.scm")
            }
            Language::JavaScript => include_str!("queries/javascript.scm"),
            Language::Rust => include_str!("queries/rust.scm"),
            Language::Go => include_str!("queries/go.scm"),
        };
        let query = Query::new(&ts_lang, query_src).unwrap();
        let mut name_idx = None;
        let mut def_idxs = Vec::new();
        for (i, n) in query.capture_names().iter().enumerate() {
            match *n {
                "name.definition" => name_idx = Some(i as u32),
                "definition.function"
                | "definition.method"
                | "definition.class"
                | "definition.arrow"
                | "definition.pair"
                | "definition.field" => def_idxs.push(i as u32),
                _ => {}
            }
        }
        let src = source.as_bytes();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(&query, tree.root_node(), src);
        while let Some(m) = matches.next() {
            let name_node = m
                .captures
                .iter()
                .find(|c| Some(c.index) == name_idx)
                .map(|c| c.node);
            let def_node = m
                .captures
                .iter()
                .find(|c| def_idxs.contains(&c.index))
                .map(|c| c.node);
            if let (Some(nn), Some(dn)) = (name_node, def_node) {
                let nm = text(nn, src);
                if nm == want_name {
                    // Arrow/pair/class-field captures wrap the callable in a
                    // declarator/pair/field wrapper; the contract lives on the
                    // `value` (arrow_function / function_expression),
                    // mirroring `extract.rs`.
                    let sig_node = if matches!(
                        dn.kind(),
                        "variable_declarator" | "pair" | "public_field_definition"
                            | "field_definition"
                    ) {
                        dn.child_by_field_name("value").unwrap_or(dn)
                    } else {
                        dn
                    };
                    return extract_signature(sig_node, nm, language, src);
                }
            }
        }
        None
    }

    #[test]
    fn python_arity_excludes_self_and_reads_return_type() {
        let s = sig_of(
            "class C:\n    def greet(self, name: str, times: int = 1) -> bool:\n        return True\n",
            Language::Python,
            "greet",
        )
        .expect("sig");
        assert_eq!(s.arity, 2, "self excluded: {:?}", s.params);
        assert_eq!(s.params, vec!["str", "int"]);
        assert_eq!(s.return_type.as_deref(), Some("bool"));
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn python_leading_underscore_is_private() {
        let s = sig_of("def _helper(x):\n    return x\n", Language::Python, "_helper").unwrap();
        assert_eq!(s.visibility, Visibility::Private);
        assert_eq!(s.arity, 1);
    }

    #[test]
    fn python_dunder_is_public() {
        let s = sig_of(
            "class C:\n    def __init__(self, a):\n        self.a = a\n",
            Language::Python,
            "__init__",
        )
        .unwrap();
        assert_eq!(s.visibility, Visibility::Public);
        assert_eq!(s.arity, 1);
    }

    #[test]
    fn typescript_exported_function_params_and_return() {
        let s = sig_of(
            "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
            Language::TypeScript,
            "add",
        )
        .unwrap();
        assert_eq!(s.arity, 2);
        assert_eq!(s.params, vec!["number", "number"]);
        assert_eq!(s.return_type.as_deref(), Some("number"));
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn typescript_non_exported_is_unknown() {
        let s = sig_of(
            "function helper(x: string): void {\n  console.log(x);\n}\n",
            Language::TypeScript,
            "helper",
        )
        .unwrap();
        assert_eq!(s.visibility, Visibility::Unknown);
    }

    #[test]
    fn typescript_private_method_is_private() {
        let s = sig_of(
            "class C {\n  private secret(a: number): void {}\n}\n",
            Language::TypeScript,
            "secret",
        )
        .unwrap();
        assert_eq!(s.visibility, Visibility::Private);
    }

    #[test]
    fn javascript_has_arity_no_types() {
        let s = sig_of(
            "export function f(a, b, c) { return a; }\n",
            Language::JavaScript,
            "f",
        )
        .unwrap();
        assert_eq!(s.arity, 3);
        assert_eq!(s.return_type, None);
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn rust_pub_fn_excludes_self_reads_types_and_return() {
        let s = sig_of(
            "impl T {\n    pub fn scale(&self, factor: u32, label: &str) -> u64 {\n        0\n    }\n}\n",
            Language::Rust,
            "scale",
        )
        .unwrap();
        assert_eq!(s.arity, 2, "self excluded: {:?}", s.params);
        assert_eq!(s.params, vec!["u32", "&str"]);
        assert_eq!(s.return_type.as_deref(), Some("u64"));
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn rust_private_fn_is_private() {
        let s = sig_of("fn helper(x: i32) -> i32 { x }\n", Language::Rust, "helper").unwrap();
        assert_eq!(s.visibility, Visibility::Private);
        assert_eq!(s.arity, 1);
    }

    #[test]
    fn go_exported_func_grouped_params_and_result() {
        let s = sig_of(
            "func Add(a, b int, label string) int {\n\treturn a + b\n}\n",
            Language::Go,
            "Add",
        )
        .unwrap();
        // `a, b int` → two positional int slots; `label string` → one.
        assert_eq!(s.arity, 3, "grouped params expand: {:?}", s.params);
        assert_eq!(s.params, vec!["int", "int", "string"]);
        assert_eq!(s.return_type.as_deref(), Some("int"));
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn go_lowercase_func_is_private() {
        let s = sig_of("func helper(x int) {\n}\n", Language::Go, "helper").unwrap();
        assert_eq!(s.visibility, Visibility::Private);
        assert_eq!(s.arity, 1);
    }

    // ── New: weak-signature-language hardening ──────────────────────────────

    #[test]
    fn ts_arrow_const_has_params_return_and_export_visibility() {
        let s = sig_of(
            "export const add = (a: number, b: number): number => a + b;\n",
            Language::TypeScript,
            "add",
        )
        .expect("arrow const should now yield a signature");
        assert_eq!(s.arity, 2);
        assert_eq!(s.params, vec!["number", "number"]);
        assert_eq!(s.return_type.as_deref(), Some("number"));
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn js_arrow_const_arity_no_types() {
        let s = sig_of(
            "export const f = (a, b, c) => a;\n",
            Language::JavaScript,
            "f",
        )
        .expect("js arrow const should yield a signature");
        assert_eq!(s.arity, 3);
        assert_eq!(s.params, vec!["a", "b", "c"]);
        assert_eq!(s.return_type, None);
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn js_single_bare_param_arrow_has_arity_one() {
        // `x => x + 1` carries its param under the singular `parameter` field,
        // not `parameters` — used to report arity 0.
        let s = sig_of("const g = x => x + 1;\n", Language::JavaScript, "g").unwrap();
        assert_eq!(s.arity, 1, "bare single-param arrow: {:?}", s.params);
        assert_eq!(s.params, vec!["x"]);
    }

    #[test]
    fn ts_object_method_arrow_signature() {
        let s = sig_of(
            "export const api = {\n  search: (q: string): void => {},\n};\n",
            Language::TypeScript,
            "search",
        )
        .expect("object-literal arrow method should yield a signature");
        assert_eq!(s.arity, 1);
        assert_eq!(s.params, vec!["string"]);
        assert_eq!(s.return_type.as_deref(), Some("void"));
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn ts_class_field_arrow_signature() {
        // Class-field arrow methods (`class Context { get = (key: string):
        // unknown => … }`) were an explicit residual false-negative of the
        // contract-diff oracle — now extracted like any other arrow, with the
        // same param/return tokens.
        let s = sig_of(
            "export class Context {\n  get = (key: string): unknown => {\n    return key;\n  };\n}\n",
            Language::TypeScript,
            "get",
        )
        .expect("class-field arrow should yield a signature");
        assert_eq!(s.arity, 1);
        assert_eq!(s.params, vec!["string"]);
        assert_eq!(s.return_type.as_deref(), Some("unknown"));
        // No accessibility modifier + not `#`-named → unknown (module-private
        // but possibly reachable), same posture as a plain class method.
        assert_eq!(s.visibility, Visibility::Unknown);
    }

    #[test]
    fn ts_private_modifier_class_field_arrow_is_private() {
        // The accessibility modifier lives on the FIELD wrapper, not the arrow
        // value the signature is read from — must still be seen.
        let s = sig_of(
            "class C {\n  private handler = (x: number): void => {};\n}\n",
            Language::TypeScript,
            "handler",
        )
        .unwrap();
        assert_eq!(s.visibility, Visibility::Private);
        assert_eq!(s.params, vec!["number"]);
    }

    #[test]
    fn ts_hash_private_method_and_field_arrow_are_private() {
        let method = sig_of(
            "class Hono {\n  #dispatch(request: Request): Response {\n    return request as unknown as Response;\n  }\n}\n",
            Language::TypeScript,
            "#dispatch",
        )
        .expect("#private method should yield a signature");
        assert_eq!(method.arity, 1);
        assert_eq!(method.params, vec!["Request"]);
        assert_eq!(method.return_type.as_deref(), Some("Response"));
        assert_eq!(method.visibility, Visibility::Private);

        let field = sig_of(
            "class C {\n  #log = (msg: string): void => {};\n}\n",
            Language::TypeScript,
            "#log",
        )
        .expect("#private field arrow should yield a signature");
        assert_eq!(field.params, vec!["string"]);
        assert_eq!(field.visibility, Visibility::Private);
    }

    #[test]
    fn js_class_field_arrow_signature_arity_only() {
        // Plain JS `field_definition` (grammar field `property:`) — arity + raw
        // param text, no types, consistent with the other JS arrow shapes.
        let s = sig_of(
            "class Store {\n  get = (key, fallback) => fallback;\n}\n",
            Language::JavaScript,
            "get",
        )
        .expect("JS class-field arrow should yield a signature");
        assert_eq!(s.arity, 2);
        assert_eq!(s.params, vec!["key", "fallback"]);
        assert_eq!(s.return_type, None);
        assert_eq!(s.visibility, Visibility::Unknown);
    }

    #[test]
    fn rust_pub_crate_is_restricted_not_public() {
        let s = sig_of(
            "pub(crate) fn helper(x: i32) -> i32 { x }\n",
            Language::Rust,
            "helper",
        )
        .unwrap();
        assert_eq!(
            s.visibility,
            Visibility::Restricted,
            "pub(crate) must NOT read as plain public"
        );
        // Wire mapping: restricted serializes to `unknown` (daemon-compatible),
        // NOT `public`.
        assert_eq!(s.visibility.as_str(), "unknown");
    }

    #[test]
    fn rust_pub_super_is_restricted() {
        let s = sig_of(
            "pub(super) fn helper() {}\n",
            Language::Rust,
            "helper",
        )
        .unwrap();
        assert_eq!(s.visibility, Visibility::Restricted);
    }

    #[test]
    fn rust_plain_pub_is_public_pub_self_is_private() {
        let pub_s = sig_of("pub fn a() {}\n", Language::Rust, "a").unwrap();
        assert_eq!(pub_s.visibility, Visibility::Public);
        assert_eq!(pub_s.visibility.as_str(), "public");
        let self_s = sig_of("pub(self) fn b() {}\n", Language::Rust, "b").unwrap();
        assert_eq!(self_s.visibility, Visibility::Private);
    }

    #[test]
    fn go_multi_return_is_split_into_types() {
        let s = sig_of(
            "func Read() (int, error) {\n\treturn 0, nil\n}\n",
            Language::Go,
            "Read",
        )
        .unwrap();
        // The `(int, error)` blob is split into its component types.
        assert_eq!(s.return_type.as_deref(), Some("int, error"));
    }

    #[test]
    fn go_named_multi_return_drops_names_keeps_types() {
        // A named return `(n int, err error)` must read the SAME contract as the
        // unnamed `(int, error)` — a body-only rename of `n`/`err` is not a
        // caller-visible change.
        let named = sig_of(
            "func F() (n int, err error) {\n\treturn\n}\n",
            Language::Go,
            "F",
        )
        .unwrap();
        let unnamed = sig_of(
            "func F() (int, error) {\n\treturn 0, nil\n}\n",
            Language::Go,
            "F",
        )
        .unwrap();
        assert_eq!(named.return_type.as_deref(), Some("int, error"));
        assert_eq!(named.return_type, unnamed.return_type);
    }

    #[test]
    fn go_single_return_stays_bare() {
        let s = sig_of("func F() int {\n\treturn 0\n}\n", Language::Go, "F").unwrap();
        assert_eq!(s.return_type.as_deref(), Some("int"));
    }

    // ── New: precision fixes for weak-signature param shapes ────────────────
    //
    // Each pair below proves the SAME thing the contract-diff oracle needs:
    // (1) two structurally-different contracts no longer collide to the same
    //     `params` token (the escape we are closing), and
    // (2) a benign body-only edit leaves the signature byte-identical (so the
    //     `--signatures` stream stays stable and the oracle does not over-block).

    #[test]
    fn ts_optional_param_is_distinct_from_required() {
        // `b?: string` must NOT read identically to `b: string` — flipping a
        // param required↔optional is a real caller-visible contract change that
        // the bare-type extraction was blind to (a false-negative / escape).
        let optional = sig_of(
            "export function f(a: string, b?: string): void {}\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        let required = sig_of(
            "export function f(a: string, b: string): void {}\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        assert_eq!(optional.params, vec!["string", "string?"]);
        assert_eq!(required.params, vec!["string", "string"]);
        assert_ne!(
            optional.params, required.params,
            "required↔optional flip must change the signature"
        );
    }

    #[test]
    fn ts_optional_param_stable_across_body_edit() {
        // A body-only rewrite of an optional-param fn leaves the signature
        // byte-identical, so the contract-diff oracle won't over-block it.
        let before = sig_of(
            "export function f(a: string, b?: number): boolean {\n  return true;\n}\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        let after = sig_of(
            "export function f(a: string, b?: number): boolean {\n  const x = a.length;\n  return x > 0;\n}\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        assert_eq!(before, after, "body-only edit must not move the signature");
        assert_eq!(before.params, vec!["string", "number?"]);
    }

    #[test]
    fn ts_arrow_optional_param_marker() {
        // The optional marker also applies to arrow-const callables.
        let s = sig_of(
            "export const f = (a: number, b?: number): void => {};\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        assert_eq!(s.params, vec!["number", "number?"]);
        assert_eq!(s.visibility, Visibility::Public);
    }

    #[test]
    fn ts_rest_param_is_distinct_from_fixed() {
        // `...args: number[]` (0..N trailing args) must NOT read identically to
        // a single fixed `args: number[]` — a different call shape.
        let rest = sig_of(
            "export function f(...args: number[]): void {}\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        let fixed = sig_of(
            "export function f(args: number[]): void {}\n",
            Language::TypeScript,
            "f",
        )
        .unwrap();
        assert_eq!(rest.params, vec!["...number[]"]);
        assert_eq!(fixed.params, vec!["number[]"]);
        assert_ne!(rest.params, fixed.params);
    }

    #[test]
    fn js_untyped_rest_param_keeps_single_ellipsis() {
        // A JS rest param has no type; the `...` comes from the pattern text and
        // must NOT be double-prefixed.
        let s = sig_of(
            "export const f = (...xs) => xs;\n",
            Language::JavaScript,
            "f",
        )
        .unwrap();
        assert_eq!(s.params, vec!["...xs"]);
    }

    #[test]
    fn go_variadic_param_is_distinct_from_fixed() {
        // `a ...int` (variadic) must NOT collide with a fixed `a int`.
        let variadic = sig_of("func F(a ...int) {}\n", Language::Go, "F").unwrap();
        let fixed = sig_of("func F(a int) {}\n", Language::Go, "F").unwrap();
        assert_eq!(variadic.params, vec!["...int"]);
        assert_eq!(fixed.params, vec!["int"]);
        assert_ne!(variadic.params, fixed.params);
    }

    #[test]
    fn go_variadic_param_stable_across_body_edit() {
        let before = sig_of(
            "func Sum(xs ...int) int {\n\treturn 0\n}\n",
            Language::Go,
            "Sum",
        )
        .unwrap();
        let after = sig_of(
            "func Sum(xs ...int) int {\n\ttotal := 0\n\tfor _, x := range xs {\n\t\ttotal += x\n\t}\n\treturn total\n}\n",
            Language::Go,
            "Sum",
        )
        .unwrap();
        assert_eq!(before, after, "body-only edit must not move the signature");
        assert_eq!(before.params, vec!["...int"]);
    }
}
