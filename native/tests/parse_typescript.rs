//! Integration test: parse a TypeScript fixture and assert the NDJSON
//! output contains the expected definitions, calls, and imports.

mod common;
use common::{run_parse, ParseSummary};

use std::path::Path;

use assert_cmd::Command;

#[test]
fn extracts_functions_classes_and_calls() {
    let summary: ParseSummary = run_parse(
        "tests/fixtures/sample.ts",
        "sample.ts",
        &["--langs", "typescript"],
    );

    assert!(
        summary.has_node("greet", "function"),
        "missing greet/function: {:#?}",
        summary.nodes
    );
    assert!(
        summary.has_node("Greeter", "class"),
        "missing Greeter/class"
    );
    assert!(summary.has_node("hello", "method"), "missing hello/method");
    assert!(summary.has_node("shout", "method"), "missing shout/method");
    assert!(
        summary.has_node("main", "function"),
        "missing main/function"
    );

    // Qualified names for class methods include the class.
    assert!(
        summary
            .nodes
            .iter()
            .any(|n| n.qualified_name == "Greeter.hello"),
        "no Greeter.hello qualified node"
    );

    // Calls.
    assert!(
        summary.has_edge_to("greet", "static_call"),
        "no static_call to greet"
    );
    assert!(
        summary.has_edge_to("Greeter", "static_call"),
        "no static_call to Greeter (new expression)"
    );

    // Imports — node:fs/promises is the import source.
    assert!(summary.has_edge_kind("import"), "no import edges emitted");

    // Module node: every file gets a synthetic `module` node so the
    // daemon can anchor file-level import edges.
    assert!(
        summary.has_node("sample", "module"),
        "missing sample/module node: {:#?}",
        summary.nodes
    );
}

/// Run `parse` over the `sample.ts` fixture and return every NDJSON line as a
/// parsed `serde_json::Value`. Mirrors `common::run_parse`'s invocation but
/// keeps the raw JSON so the optional `line`/`col` fields (which the typed
/// `ParsedEdge` view intentionally drops) are inspectable here.
fn parse_sample_ts_values() -> Vec<serde_json::Value> {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.ts");
    let dst = tmp.path().join("sample.ts");
    std::fs::copy(&src, &dst).expect("copy fixture");

    let mut cmd = Command::cargo_bin("hayven-native").expect("locate built binary");
    cmd.arg("parse")
        .arg("--root")
        .arg(tmp.path())
        .arg("--jobs")
        .arg("1")
        .arg("--langs")
        .arg("typescript");
    let output = cmd.output().expect("invoke hayven-native");
    assert!(
        output.status.success(),
        "parse failed: status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    let stdout = String::from_utf8(output.stdout).expect("stdout is utf-8");
    stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str::<serde_json::Value>(l).expect("valid JSON line"))
        .collect()
}

#[test]
fn static_call_edges_carry_line_precise_call_site() {
    // In `tests/fixtures/sample.ts`, the bare call `greet(name)` is on line 11
    // (1-based), inside `Greeter.hello`'s body `    return greet(name);`. The
    // `greet` identifier is the call/callee node whose `start_position()` drives
    // the edge's (line, col), so the edge must report line 11 and the 1-based
    // column of `greet` (4-space indent + "return " = byte col 11 → 1-based 12).
    let values = parse_sample_ts_values();

    let greet_call = values
        .iter()
        .find(|v| {
            v["type"] == "edge" && v["kind"] == "static_call" && v["dst_name"] == "greet"
        })
        .expect("a static_call edge to greet must exist");

    assert_eq!(
        greet_call["line"].as_u64(),
        Some(11),
        "greet() call site must be on 1-based line 11: {greet_call}"
    );
    assert_eq!(
        greet_call["col"].as_u64(),
        Some(12),
        "greet() call site must be at 1-based column 12: {greet_call}"
    );

    // EVERY static_call edge must carry a positive 1-based line/col (no call
    // edge should emit a 0 or omit the fields when a position is known).
    for v in &values {
        if v["type"] == "edge" && v["kind"] == "static_call" {
            let line = v["line"].as_u64().expect("static_call edge has a line");
            let col = v["col"].as_u64().expect("static_call edge has a col");
            assert!(line >= 1, "1-based line must be >= 1: {v}");
            assert!(col >= 1, "1-based col must be >= 1: {v}");
        }
    }

    // Import edges carry NO site info — `line`/`col` are omitted entirely from
    // the wire (the `skip_serializing_if` path), so the JSON keys are absent.
    let import_edge = values
        .iter()
        .find(|v| v["type"] == "edge" && v["kind"] == "import")
        .expect("an import edge must exist");
    assert!(
        import_edge.get("line").is_none(),
        "import edge must omit `line`: {import_edge}"
    );
    assert!(
        import_edge.get("col").is_none(),
        "import edge must omit `col`: {import_edge}"
    );
}
