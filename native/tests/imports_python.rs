//! Integration test for Issue 1: file-level imports must anchor against
//! the synthetic module node; function-nested imports must anchor
//! against the enclosing function.

mod common;
use common::run_parse;

#[test]
fn file_level_imports_anchor_on_module_node() {
    let summary = run_parse(
        "tests/fixtures/imports.py",
        "imports.py",
        &["--langs", "python"],
    );

    // The synthetic module node is emitted with name = file stem.
    assert!(
        summary.has_node("imports", "module"),
        "missing imports/module node: {:#?}",
        summary.nodes
    );

    // `import os` at module scope → edge anchored on the module.
    let os_edge = summary
        .edges
        .iter()
        .find(|e| e.kind == "import" && e.dst_name == "os")
        .unwrap_or_else(|| panic!("no import edge for `os`: {:#?}", summary.edges));
    assert_eq!(
        os_edge.src_name, "imports",
        "file-level `import os` should anchor on the module, got src_name={}",
        os_edge.src_name
    );

    // `from typing import List` at module scope → edge anchored on the
    // module, dst_name = `typing.List`.
    let typing_edge = summary
        .edges
        .iter()
        .find(|e| e.kind == "import" && e.dst_name == "typing.List")
        .unwrap_or_else(|| panic!("no import edge for typing.List: {:#?}", summary.edges));
    assert_eq!(typing_edge.src_name, "imports");
}

#[test]
fn function_nested_imports_anchor_on_function() {
    let summary = run_parse(
        "tests/fixtures/imports.py",
        "imports.py",
        &["--langs", "python"],
    );

    // `import json` lives inside `def helper(): ...`. The edge's
    // src_name should be `helper`, not the module name — the function
    // scope is meaningful for the daemon's call-graph resolver.
    let json_edge = summary
        .edges
        .iter()
        .find(|e| e.kind == "import" && e.dst_name == "json")
        .unwrap_or_else(|| panic!("no import edge for json: {:#?}", summary.edges));
    assert_eq!(
        json_edge.src_name, "helper",
        "function-nested import should anchor on the function, got src_name={}",
        json_edge.src_name
    );
}
