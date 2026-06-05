//! Shared helpers for the parse_* integration tests.
//!
//! Each test wants the same pipeline: copy a fixture into a temp dir,
//! invoke `hayven-native parse --root <tmpdir> --langs <lang>`, parse
//! the resulting NDJSON, and assert on the contents.

// Not every integration test uses every helper here; rustc treats each
// test binary as a separate crate so it warns about cross-test
// unused-ness. Silencing is correct: the helpers are deliberately
// general-purpose.
#![allow(dead_code)]

use std::path::Path;

use assert_cmd::Command;

use hayven_native::proto::Record;

/// Lightweight view of a parsed NDJSON record stream — only the fields
/// the integration tests need to inspect.
#[derive(Debug)]
pub struct ParsedNode {
    pub name: String,
    pub kind: String,
    pub qualified_name: String,
}

#[derive(Debug)]
pub struct ParsedEdge {
    pub src_name: String,
    pub dst_name: String,
    pub kind: String,
}

#[derive(Debug)]
pub struct ParseSummary {
    pub nodes: Vec<ParsedNode>,
    pub edges: Vec<ParsedEdge>,
    pub had_done: bool,
}

impl ParseSummary {
    pub fn has_node(&self, name: &str, kind: &str) -> bool {
        self.nodes.iter().any(|n| n.name == name && n.kind == kind)
    }
    pub fn has_edge_to(&self, dst: &str, kind: &str) -> bool {
        self.edges
            .iter()
            .any(|e| e.dst_name == dst && e.kind == kind)
    }
    pub fn has_edge_kind(&self, kind: &str) -> bool {
        self.edges.iter().any(|e| e.kind == kind)
    }
}

/// Copy a single fixture file into a fresh temp dir, run the parse
/// subcommand against that root, parse NDJSON, return the summary.
///
/// `fixture_path` is relative to the crate root (e.g.
/// `tests/fixtures/sample.py`). `dest_filename` is the name the file
/// will be given inside the temp dir.
pub fn run_parse(fixture_path: &str, dest_filename: &str, extra_args: &[&str]) -> ParseSummary {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join(fixture_path);
    let dst = tmp.path().join(dest_filename);
    std::fs::copy(&src, &dst)
        .unwrap_or_else(|e| panic!("copy fixture {} -> {}: {}", src.display(), dst.display(), e));

    let mut cmd = Command::cargo_bin("hayven-native").expect("locate built binary");
    cmd.arg("parse")
        .arg("--root")
        .arg(tmp.path())
        .arg("--jobs")
        .arg("1");
    for a in extra_args {
        cmd.arg(a);
    }

    let output = cmd.output().expect("invoke hayven-native");
    assert!(
        output.status.success(),
        "hayven-native parse failed: status={:?} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );

    let stdout = String::from_utf8(output.stdout).expect("stdout is utf-8");
    parse_ndjson(&stdout)
}

fn parse_ndjson(stdout: &str) -> ParseSummary {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut had_done = false;

    for (i, line) in stdout.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let rec: Record = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("line {i} is not a valid Record: {e}\nline: {line}"));
        match rec {
            Record::Node {
                name,
                kind,
                qualified_name,
                ..
            } => nodes.push(ParsedNode {
                name,
                kind,
                qualified_name,
            }),
            Record::Edge {
                src_name,
                dst_name,
                kind,
                ..
            } => edges.push(ParsedEdge {
                src_name,
                dst_name,
                kind,
            }),
            Record::Done { .. } => had_done = true,
            _ => {}
        }
    }

    assert!(had_done, "stream did not end with a Done record");
    ParseSummary {
        nodes,
        edges,
        had_done,
    }
}
