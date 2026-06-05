//! Integration test: parse a known Python fixture and assert the
//! emitted NDJSON contains the expected nodes and edges.

mod common;
use common::{run_parse, ParseSummary};

#[test]
fn extracts_functions_classes_and_calls() {
    let summary: ParseSummary = run_parse(
        "tests/fixtures/sample.py",
        "sample.py",
        &["--langs", "python"],
    );

    // Definitions: greet (function), Greeter (class), hello (method),
    // shout (method), main (function).
    assert!(
        summary.has_node("greet", "function"),
        "missing greet/function in nodes: {:#?}",
        summary.nodes
    );
    assert!(
        summary.has_node("Greeter", "class"),
        "missing Greeter/class in nodes: {:#?}",
        summary.nodes
    );
    assert!(
        summary.has_node("hello", "method"),
        "missing hello/method in nodes: {:#?}",
        summary.nodes
    );
    assert!(
        summary.has_node("shout", "method"),
        "missing shout/method in nodes: {:#?}",
        summary.nodes
    );
    assert!(
        summary.has_node("main", "function"),
        "missing main/function in nodes: {:#?}",
        summary.nodes
    );

    // Qualified names for methods should be Greeter.hello / Greeter.shout.
    assert!(
        summary
            .nodes
            .iter()
            .any(|n| n.qualified_name == "Greeter.hello"),
        "no Greeter.hello qualified node"
    );

    // Calls: greet, hello, upper, Greeter (constructor) all should appear
    // somewhere among the static_call edges.
    assert!(
        summary.has_edge_to("greet", "static_call"),
        "no static_call to greet"
    );
    assert!(
        summary.has_edge_to("hello", "static_call"),
        "no static_call to hello"
    );
    assert!(
        summary.has_edge_to("Greeter", "static_call"),
        "no static_call to Greeter"
    );

    // Imports: at least `os` and one from-import target should be present.
    assert!(summary.has_edge_kind("import"), "no import edges emitted");

    // Module node: one synthetic `module` node per file, named after
    // the file stem. File-level import edges anchor against it.
    assert!(
        summary.has_node("sample", "module"),
        "missing sample/module node: {:#?}",
        summary.nodes
    );
}
