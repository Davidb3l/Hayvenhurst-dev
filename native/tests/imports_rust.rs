//! Integration test for Issue 2: Rust grouped `use` statements must
//! expand to one edge per imported leaf, with fully-qualified
//! `dst_name`s anchored on the synthetic module node.

mod common;
use common::run_parse;

/// Helper: assert every `dst_name` in `expected` appears as an
/// `import` edge anchored on the `imports` module. Doesn't check edge
/// count — there are other unrelated edges in the fixture.
fn assert_module_imports(summary: &common::ParseSummary, expected: &[&str]) {
    for dst in expected {
        let found = summary
            .edges
            .iter()
            .any(|e| e.kind == "import" && e.dst_name == *dst && e.src_name == "imports");
        assert!(
            found,
            "missing expected import edge (src=imports, dst={}): {:#?}",
            dst, summary.edges
        );
    }
}

#[test]
fn grouped_use_statements_expand_to_one_edge_per_leaf() {
    let summary = run_parse(
        "tests/fixtures/imports.rs",
        "imports.rs",
        &["--langs", "rust"],
    );

    // Module node must be present (file stem).
    assert!(
        summary.has_node("imports", "module"),
        "missing imports/module node: {:#?}",
        summary.nodes
    );

    // Plain `use std::io;` — single edge.
    assert_module_imports(&summary, &["std::io"]);

    // `use std::collections::{HashMap, HashSet};` — two edges.
    assert_module_imports(
        &summary,
        &["std::collections::HashMap", "std::collections::HashSet"],
    );

    // `use std::sync::{Arc, atomic::AtomicUsize};` — two edges with
    // the second expanding through a nested scoped path.
    assert_module_imports(
        &summary,
        &["std::sync::Arc", "std::sync::atomic::AtomicUsize"],
    );

    // `use std::path::{self, PathBuf};` — `self` resolves to the parent.
    assert_module_imports(&summary, &["std::path", "std::path::PathBuf"]);

    // `use std::fs as filesystem;` — alias dropped, just the path.
    assert_module_imports(&summary, &["std::fs"]);

    // `use std::env::*;` — wildcard preserved as a `*` segment.
    assert_module_imports(&summary, &["std::env::*"]);

    // `use std::process::{Command, Stdio, exit};` — three siblings.
    assert_module_imports(
        &summary,
        &[
            "std::process::Command",
            "std::process::Stdio",
            "std::process::exit",
        ],
    );

    // Sanity: we should NOT see the raw grouped text as a single edge.
    let raw_grouped: Vec<_> = summary
        .edges
        .iter()
        .filter(|e| e.kind == "import" && e.dst_name.contains('{'))
        .collect();
    assert!(
        raw_grouped.is_empty(),
        "grouped `use` was not expanded — found raw edges: {:#?}",
        raw_grouped
    );
}

#[test]
fn grouped_use_edge_count_matches_leaf_count() {
    let summary = run_parse(
        "tests/fixtures/imports.rs",
        "imports.rs",
        &["--langs", "rust"],
    );

    // Count leaves per fixture statement: 1 + 2 + 2 + 2 + 1 + 1 + 3 = 12.
    let import_edges: Vec<_> = summary
        .edges
        .iter()
        .filter(|e| e.kind == "import")
        .collect();
    assert_eq!(
        import_edges.len(),
        12,
        "expected 12 expanded import edges, got {}: {:#?}",
        import_edges.len(),
        import_edges
    );
}
