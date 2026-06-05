//! Integration test for Issue 1 in TypeScript: file-level imports
//! anchor on the synthetic module node.

mod common;
use common::run_parse;

#[test]
fn file_level_imports_anchor_on_module_node() {
    let summary = run_parse(
        "tests/fixtures/imports.ts",
        "imports.ts",
        &["--langs", "typescript"],
    );

    assert!(
        summary.has_node("imports", "module"),
        "missing imports/module node: {:#?}",
        summary.nodes
    );

    // TS imports surface the *source* string (the thing after `from`)
    // as the dst_name. Both file-level imports in the fixture should
    // anchor on the module.
    let module_anchored: Vec<_> = summary
        .edges
        .iter()
        .filter(|e| e.kind == "import")
        .collect();
    assert!(
        !module_anchored.is_empty(),
        "no import edges emitted: {:#?}",
        summary.edges
    );
    for e in &module_anchored {
        assert_eq!(
            e.src_name, "imports",
            "file-level TS import should anchor on the module, got edge {:?}",
            e
        );
    }

    // Both import sources should be present.
    assert!(
        module_anchored
            .iter()
            .any(|e| e.dst_name == "node:fs/promises"),
        "missing dst_name node:fs/promises: {:#?}",
        module_anchored
    );
    assert!(
        module_anchored.iter().any(|e| e.dst_name == "node:path"),
        "missing dst_name node:path: {:#?}",
        module_anchored
    );
}
