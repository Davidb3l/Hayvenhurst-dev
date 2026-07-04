//! Integration tests for the weak-signature languages of the contract-diff
//! oracle's extractor (`native/src/parse/signature.rs`).
//!
//! These assert the contract the daemon's `contract_diff_oracle.ts` actually
//! diffs: a `Signature` (params + return + visibility) that changes IFF the real
//! contract changes and is byte-stable across a benign body edit. They focus on
//! the historically weak cases: TS optional/rest/union/generic/`unknown` params,
//! Rust restricted (`pub(crate)`/`pub(super)`/`pub(in …)`) visibility, Go
//! multi-return + variadic, and JS arrow-fns.

use hayven_native::parse::language::Language;
use hayven_native::parse::signature::{extract_signature, Signature, Visibility};
use tree_sitter::{Node, Parser, Query, QueryCursor, StreamingIterator};

fn text<'a>(node: Node, source: &'a [u8]) -> &'a str {
    std::str::from_utf8(&source[node.start_byte()..node.end_byte()]).unwrap_or("")
}

/// Parse `source`, run the language query, and return the signature of the FIRST
/// definition whose name matches `want_name`. Mirrors the in-file unit helper
/// and `extract.rs`'s arrow/pair `value` unwrapping.
fn sig_of(source: &str, language: Language, want_name: &str) -> Option<Signature> {
    let ts_lang = language.tree_sitter_language();
    let mut parser = Parser::new();
    parser.set_language(&ts_lang).unwrap();
    let tree = parser.parse(source.as_bytes(), None).unwrap();
    let query_src = match language {
        Language::Python => include_str!("../src/parse/queries/python.scm"),
        Language::TypeScript | Language::Tsx | Language::Astro => {
            include_str!("../src/parse/queries/typescript.scm")
        }
        Language::JavaScript => include_str!("../src/parse/queries/javascript.scm"),
        Language::Rust => include_str!("../src/parse/queries/rust.scm"),
        Language::Go => include_str!("../src/parse/queries/go.scm"),
    };
    let query = Query::new(&ts_lang, query_src).unwrap();
    let mut name_idx = None;
    let mut def_idxs = Vec::new();
    for (i, n) in query.capture_names().iter().enumerate() {
        match *n {
            "name.definition" => name_idx = Some(i as u32),
            "definition.function" | "definition.method" | "definition.class"
            | "definition.arrow" | "definition.pair" | "definition.field" => {
                def_idxs.push(i as u32)
            }
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

// ── Rust restricted visibility ──────────────────────────────────────────────

#[test]
fn rust_pub_crate_refactor_is_not_a_public_change() {
    // An in-crate-only refactor (`pub(crate)` → `pub(crate)`, body rewritten)
    // must NOT look like a cross-crate public-API change: the visibility is
    // Restricted (wire `unknown`), distinct from plain `pub` (Public), so the
    // oracle gates it as "could break an in-crate caller" — never as a public
    // contract break, and never as the no-op it would be if it were private.
    let before = sig_of(
        "pub(crate) fn helper(x: i32) -> i32 { x }\n",
        Language::Rust,
        "helper",
    )
    .unwrap();
    let after = sig_of(
        "pub(crate) fn helper(x: i32) -> i32 { let y = x; y }\n",
        Language::Rust,
        "helper",
    )
    .unwrap();
    assert_eq!(before, after, "body-only edit must not move the signature");
    assert_eq!(before.visibility, Visibility::Restricted);
    assert_eq!(before.visibility.as_str(), "unknown");
}

#[test]
fn rust_visibility_levels_are_all_distinct() {
    let public = sig_of("pub fn a() {}\n", Language::Rust, "a").unwrap();
    let krate = sig_of("pub(crate) fn b() {}\n", Language::Rust, "b").unwrap();
    let sup = sig_of("pub(super) fn c() {}\n", Language::Rust, "c").unwrap();
    let in_path = sig_of("pub(in crate::m) fn d() {}\n", Language::Rust, "d").unwrap();
    let private = sig_of("fn e() {}\n", Language::Rust, "e").unwrap();

    assert_eq!(public.visibility, Visibility::Public);
    assert_eq!(krate.visibility, Visibility::Restricted);
    assert_eq!(sup.visibility, Visibility::Restricted);
    assert_eq!(in_path.visibility, Visibility::Restricted);
    assert_eq!(private.visibility, Visibility::Private);

    // A `pub`→`pub(crate)` drop IS a contract change the oracle must see
    // (cross-crate callers lose access), so Public and Restricted differ.
    assert_ne!(public.visibility, krate.visibility);
}

// ── TS `unknown` / union / generic / optional types ──────────────────────────

#[test]
fn ts_unknown_union_generic_optional_types_extracted() {
    let s = sig_of(
        "export function f<T>(a: unknown, b?: string, c: A | B, d: Array<T>): T | null {\n  return null as T | null;\n}\n",
        Language::TypeScript,
        "f",
    )
    .unwrap();
    assert_eq!(s.arity, 4);
    assert_eq!(s.params, vec!["unknown", "string?", "A | B", "Array<T>"]);
    assert_eq!(s.return_type.as_deref(), Some("T | null"));
    assert_eq!(s.visibility, Visibility::Public);
}

#[test]
fn ts_unknown_to_any_is_a_contract_change() {
    // Widening/narrowing a param type (`unknown` → `string`) is a real contract
    // change the diff must catch.
    let before = sig_of("export function f(a: unknown): void {}\n", Language::TypeScript, "f").unwrap();
    let after = sig_of("export function f(a: string): void {}\n", Language::TypeScript, "f").unwrap();
    assert_ne!(before.params, after.params);
    assert_eq!(before.params, vec!["unknown"]);
    assert_eq!(after.params, vec!["string"]);
}

// ── JS arrow-fns (async, object-method, bare single param) ────────────────────

#[test]
fn ts_rest_param_stable_across_body_edit() {
    // Mirrors `ts_optional_param_stable_across_body_edit`: a body-only rewrite of
    // a rest-param fn (`...args: T[]`) leaves the signature byte-identical, so
    // the contract-diff oracle won't over-block a benign body change.
    let before = sig_of(
        "export function f(a: string, ...args: number[]): boolean {\n  return true;\n}\n",
        Language::TypeScript,
        "f",
    )
    .unwrap();
    let after = sig_of(
        "export function f(a: string, ...args: number[]): boolean {\n  const n = args.length;\n  return n >= 0;\n}\n",
        Language::TypeScript,
        "f",
    )
    .unwrap();
    assert_eq!(before, after, "body-only edit must not move the signature");
    assert_eq!(before.params, vec!["string", "...number[]"]);
}

#[test]
fn js_async_arrow_const_arity_and_export() {
    let s = sig_of("export const f = async (a, b) => a;\n", Language::JavaScript, "f").unwrap();
    assert_eq!(s.arity, 2);
    assert_eq!(s.params, vec!["a", "b"]);
    assert_eq!(s.return_type, None);
    assert_eq!(s.visibility, Visibility::Public);
}

#[test]
fn js_object_method_async_arrow() {
    let s = sig_of(
        "export const api = { run: async (x) => x };\n",
        Language::JavaScript,
        "run",
    )
    .unwrap();
    assert_eq!(s.arity, 1);
    assert_eq!(s.params, vec!["x"]);
    assert_eq!(s.visibility, Visibility::Public);
}

#[test]
fn js_arrow_arity_stable_across_body_edit() {
    let before = sig_of("export const f = (a, b) => a + b;\n", Language::JavaScript, "f").unwrap();
    let after = sig_of(
        "export const f = (a, b) => {\n  const s = a + b;\n  return s;\n};\n",
        Language::JavaScript,
        "f",
    )
    .unwrap();
    assert_eq!(before, after, "body-only edit must not move the arrow signature");
}

// ── Go multi-return + variadic ────────────────────────────────────────────────

#[test]
fn go_multi_return_and_variadic_combined() {
    let s = sig_of(
        "func Read(paths ...string) (int, error) {\n\treturn 0, nil\n}\n",
        Language::Go,
        "Read",
    )
    .unwrap();
    assert_eq!(s.params, vec!["...string"]);
    assert_eq!(s.return_type.as_deref(), Some("int, error"));
    assert_eq!(s.visibility, Visibility::Public);
}

#[test]
fn go_adding_a_return_is_a_contract_change() {
    let before = sig_of("func F() int {\n\treturn 0\n}\n", Language::Go, "F").unwrap();
    let after = sig_of("func F() (int, error) {\n\treturn 0, nil\n}\n", Language::Go, "F").unwrap();
    assert_ne!(before.return_type, after.return_type);
    assert_eq!(before.return_type.as_deref(), Some("int"));
    assert_eq!(after.return_type.as_deref(), Some("int, error"));
}
