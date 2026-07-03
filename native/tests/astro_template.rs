//! Adversarial integration tests for the `.astro` TEMPLATE component scan
//! (`native/src/parse/extract.rs`, `astro_template_components`).
//!
//! The textual `<`-scan must distinguish a real JSX/Astro component open tag
//! from a `<` operator (`a < B`) or a generic (`List<String>`). A naive scan
//! emits PHANTOM `static_call` edges (e.g. dst=`Threshold`, dst=`String`) that
//! pollute the graph and mis-resolve to same-named imports. These tests pin the
//! tightened heuristic: NO phantom edges from comparisons / generics / `{…}`
//! expressions / `<script>` bodies, while real `<Stats/>` and `<Foo.Bar/>`
//! component tags STILL produce edges, and `<Foo.Bar.Baz/>`'s receiver chain
//! EXCLUDES the trailing member (mirroring member-call chains).

use hayven_native::parse::extract::extract_file;
use hayven_native::parse::language::Language;
use hayven_native::proto::Record;

/// Extract a `.astro` file and return every `static_call` edge as
/// `(dst_name, receiver, receiver_chain)`.
fn static_calls(src: &[u8]) -> Vec<(String, Option<String>, Option<Vec<String>>)> {
    let out = extract_file("page.astro", src, Language::Astro).expect("extract astro");
    out.records
        .into_iter()
        .filter_map(|r| match r {
            Record::Edge {
                kind,
                dst_name,
                receiver,
                receiver_chain,
                ..
            } if kind == "static_call" => Some((dst_name, receiver, receiver_chain)),
            _ => None,
        })
        .collect()
}

fn dsts(src: &[u8]) -> Vec<String> {
    static_calls(src).into_iter().map(|(d, _, _)| d).collect()
}

// ── Phantom-edge rejection (FINDING 1) ───────────────────────────────────────

#[test]
fn astro_comparison_in_expression_is_not_an_edge() {
    // `{count<Threshold?…}` — a `<` comparison inside a JSX expression block.
    // `Threshold` is a common identifier that must NOT become a phantom edge.
    let src = b"---\nconst x = 1;\n---\n<div>{count<Threshold?\"a\":\"b\"}</div>\n";
    let d = dsts(src);
    assert!(
        !d.contains(&"Threshold".to_string()),
        "comparison `count<Threshold` must not emit a phantom edge: {d:?}"
    );
}

#[test]
fn astro_generic_type_is_not_an_edge() {
    // `List<String>` — a generic. Neither `String` nor `List` is a component.
    let src = b"---\nconst x = 1;\n---\n<p>List<String> here</p>\n";
    let d = dsts(src);
    assert!(
        !d.contains(&"String".to_string()) && !d.contains(&"List".to_string()),
        "generic `List<String>` must not emit a phantom edge: {d:?}"
    );
}

#[test]
fn astro_bare_comparison_with_and_without_spaces_is_not_an_edge() {
    // `x<Y` (no spaces) and `x < Y` (spaces) — both comparisons, not tags.
    let nospace = b"---\nconst x = 1;\n---\n<div>x<Y</div>\n";
    let spaced = b"---\nconst x = 1;\n---\n<div>x < Y</div>\n";
    assert!(
        !dsts(nospace).contains(&"Y".to_string()),
        "`x<Y` must not emit a phantom edge: {:?}",
        dsts(nospace)
    );
    assert!(
        !dsts(spaced).contains(&"Y".to_string()),
        "`x < Y` must not emit a phantom edge: {:?}",
        dsts(spaced)
    );
}

#[test]
fn astro_component_inside_expression_block_is_skipped() {
    // A real component tag INSIDE `{…}` is not scanned (the block is skipped
    // wholesale). `<Inner/>` here must NOT emit an edge.
    let src = b"---\nconst x = 1;\n---\n<div>{ ok ? <Inner/> : null }</div>\n";
    let d = dsts(src);
    assert!(
        !d.contains(&"Inner".to_string()),
        "component inside `{{…}}` must be skipped: {d:?}"
    );
}

#[test]
fn astro_script_content_is_not_scanned() {
    // `<script>` body is JS, where `a < B` is a comparison and `<Foo>` would be
    // a syntax oddity — neither must emit an edge.
    let src =
        b"---\nconst x = 1;\n---\n<script>const a = 1; if (a < Big) {} const b = <Phantom></script>\n";
    let d = dsts(src);
    assert!(
        !d.contains(&"Big".to_string()) && !d.contains(&"Phantom".to_string()),
        "`<script>` content must not emit edges: {d:?}"
    );
}

#[test]
fn astro_adversarial_file_only_real_component_survives() {
    // The CONFIRMED reproduction from the review: only `<Stats/>` is a real
    // edge; `Threshold` and `String` are phantoms that must be gone.
    let src = b"---\nconst x = 1;\n---\n<div>{count<Threshold?\"a\":\"b\"}</div>\n<p>List<String> here</p>\n<Stats/>\n";
    let d = dsts(src);
    assert!(
        d.contains(&"Stats".to_string()),
        "real `<Stats/>` must survive: {d:?}"
    );
    assert!(
        !d.contains(&"Threshold".to_string()) && !d.contains(&"String".to_string()),
        "phantom `Threshold`/`String` edges must be gone: {d:?}"
    );
    assert_eq!(d.len(), 1, "exactly one real edge (Stats): {d:?}");
}

// ── Real component tags still produce edges ──────────────────────────────────

#[test]
fn astro_real_component_still_emits_edge() {
    let src = b"---\nimport Stats from \"~/components/Stats.tsx\";\n---\n<Stats/>\n";
    let calls = static_calls(src);
    assert!(
        calls
            .iter()
            .any(|(d, r, _)| d == "Stats" && r.as_deref() == Some("Stats")),
        "`<Stats/>` must emit dst=Stats receiver=Stats: {calls:?}"
    );
}

#[test]
fn astro_dotted_component_still_emits_edge() {
    // `<Foo.Bar/>` → dst Bar, receiver Foo, chain None — a single-segment chain
    // collapses to just the immediate-object receiver, mirroring `api.search()`
    // (FINDING 2). The trailing member is excluded; only the root remains, which
    // is already carried by `receiver`.
    let src = b"---\nimport Foo from \"~/components/Foo.tsx\";\n---\n<Foo.Bar/>\n";
    let calls = static_calls(src);
    assert!(
        calls
            .iter()
            .any(|(d, r, c)| d == "Bar" && r.as_deref() == Some("Foo") && c.is_none()),
        "`<Foo.Bar/>` must emit dst=Bar receiver=Foo chain=None: {calls:?}"
    );
}

// ── Dotted-chain duplicated-tail fix (FINDING 2) ─────────────────────────────

#[test]
fn astro_three_segment_dotted_chain_excludes_member() {
    // `<Foo.Bar.Baz/>` → dst Baz, receiver Foo, chain ["Foo","Bar"] — the chain
    // EXCLUDES the trailing member `Baz`, mirroring member-call chains
    // (`api.client.search()` → chain ["api","client"], dst search). Including
    // the tail produced a duplicated-tail candidate the daemon never matched.
    let src = b"---\nimport Foo from \"~/components/Foo.tsx\";\n---\n<Foo.Bar.Baz/>\n";
    let calls = static_calls(src);
    let baz: Vec<_> = calls.iter().filter(|(d, _, _)| d == "Baz").collect();
    assert_eq!(baz.len(), 1, "one edge for `<Foo.Bar.Baz/>`: {calls:?}");
    let (dst, recv, chain) = baz[0];
    assert_eq!(dst, "Baz", "dst is the trailing member");
    assert_eq!(recv.as_deref(), Some("Foo"), "receiver is the root");
    assert_eq!(
        chain.as_deref(),
        Some(&["Foo".to_string(), "Bar".to_string()][..]),
        "chain EXCLUDES the trailing member `Baz`: {calls:?}"
    );
}

// ── Kept-correct behaviors ───────────────────────────────────────────────────

#[test]
fn astro_lowercase_html_tags_are_not_edges() {
    let src = b"---\nconst x = 1;\n---\n<div><p>hi</p><span/></div>\n";
    let d = dsts(src);
    assert!(
        d.iter().all(|s| s != "div" && s != "p" && s != "span"),
        "lowercase HTML tags must not be edges: {d:?}"
    );
}

#[test]
fn astro_duplicate_component_usage_dedupes_to_one_edge() {
    let src =
        b"---\nimport Stats from \"~/components/Stats.tsx\";\n---\n<Stats/><Stats/><Stats/>\n";
    let stats: Vec<_> = dsts(src).into_iter().filter(|d| d == "Stats").collect();
    assert_eq!(stats.len(), 1, "repeated `<Stats/>` dedupes to one edge");
}

// ── HTML-comment skip (residual phantom, now fixed) ──────────────────────────

#[test]
fn astro_component_inside_html_comment_is_not_an_edge() {
    // `<!-- <Stats/> -->` — a component name inside an HTML comment is NOT a
    // usage. The old `<!`-only skip kept scanning inside the comment and emitted
    // a phantom edge that could resolve to the real `Stats` node.
    let src = b"---\nconst x = 1;\n---\n<!-- <Stats/> commented out -->\n<div>hi</div>\n";
    let d = dsts(src);
    assert!(
        d.is_empty(),
        "no edge from a component inside a comment: {d:?}"
    );
}

#[test]
fn astro_comment_then_real_component_emits_only_the_real_one() {
    // The comment is skipped wholesale; a real `<Stats/>` AFTER the comment
    // still emits exactly one edge (the scan resumes past `-->`).
    let src =
        b"---\nimport Stats from \"~/components/Stats.tsx\";\n---\n<!-- <Ghost/> -->\n<Stats/>\n";
    let d = dsts(src);
    assert_eq!(
        d,
        vec!["Stats".to_string()],
        "only the real post-comment component: {d:?}"
    );
}

#[test]
fn astro_unterminated_html_comment_skips_to_eof_without_phantom() {
    // An unterminated `<!--` must not panic and must not emit phantoms.
    let src = b"---\nconst x = 1;\n---\n<!-- <Stats/> never closed\n";
    let d = dsts(src);
    assert!(d.is_empty(), "unterminated comment yields no edges: {d:?}");
}
