//! Integration test: parse a Rust fixture and assert the NDJSON output
//! contains the expected definitions, calls, and (no) imports — the
//! fixture deliberately has no `use` statements.

mod common;
use common::{run_parse, ParseSummary};

#[test]
fn extracts_functions_structs_and_methods() {
    let summary: ParseSummary = run_parse(
        "tests/fixtures/sample.rs",
        "sample.rs",
        &["--langs", "rust"],
    );

    assert!(
        summary.has_node("Greeter", "class"),
        "missing Greeter/class (struct): {:#?}",
        summary.nodes
    );
    assert!(
        summary.has_node("greet", "function"),
        "missing greet/function"
    );
    assert!(summary.has_node("run", "function"), "missing run/function");
    assert!(summary.has_node("new", "method"), "missing new/method");
    assert!(summary.has_node("hello", "method"), "missing hello/method");
    assert!(summary.has_node("shout", "method"), "missing shout/method");

    // Rust uses `::` as the separator — methods inside `impl Greeter`
    // should report `Greeter::hello`.
    assert!(
        summary
            .nodes
            .iter()
            .any(|n| n.qualified_name == "Greeter::hello"),
        "no Greeter::hello qualified node: {:#?}",
        summary
            .nodes
            .iter()
            .map(|n| &n.qualified_name)
            .collect::<Vec<_>>()
    );

    // Calls: at minimum, `new`, `shout`, `hello`, `to_uppercase`,
    // `to_string`, `format!`-as-call show up. We assert on a couple
    // that are robust across grammar versions.
    assert!(
        summary.has_edge_to("new", "static_call"),
        "no static_call to new"
    );
    assert!(
        summary.has_edge_to("shout", "static_call"),
        "no static_call to shout"
    );

    // Module node: every file gets a synthetic `module` node, named
    // after the file stem (or parent dir for mod.rs/lib.rs/main.rs).
    assert!(
        summary.has_node("sample", "module"),
        "missing sample/module node: {:#?}",
        summary.nodes
    );
}
