//! `check-ignored` subcommand: a BATCH "would the walker exclude this path?"
//! oracle, spoken as NDJSON request/response over stdin/stdout.
//!
//! WHY THIS EXISTS. The daemon's context PACKER reads raw files off disk and
//! puts them in a model prompt. Its gate (`daemon/src/db/context_pack.ts`)
//! mirrored the walker's hidden-path, always-pruned-dir and extension rules by
//! hand, but it could not evaluate `.gitignore` — so a gitignored file that is
//! non-hidden, outside every pruned directory, and carries a source extension
//! (a generated `src/gen/keys.ts`, a committed-then-ignored
//! `src/config.local.ts`) was readable by name even though the Rust walker keeps
//! it out of the graph entirely. The packer was strictly MORE permissive than
//! the indexer on the one path that feeds a prompt.
//!
//! Hand-rolling gitignore semantics in TypeScript is where the subtle bugs live
//! (negations, `**`, directory-only rules, nested ignore files,
//! `.git/info/exclude`, `core.excludesFile`, and `require_git`). We already have
//! the correct answer here: [`ScopeFilter`] is the shared decision the
//! incremental ingest path and the watcher use, built to agree with
//! `walker::discover` and pinned by parity tests in `parse::scope`. This module
//! is a thin transport over it — it adds NO rules of its own, which is what
//! keeps the packer and the indexer from drifting apart again.
//!
//! ## Wire
//!
//! One request per stdin line, one response per line on stdout, in order, until
//! EOF. Requests are independent; the process exits 0 at EOF.
//!
//! ```text
//! → {"op":"check_ignored","root":"/abs/repo","paths":["src/a.ts","src/gen/k.ts"]}
//! ← {"ignored":[false,true],"dirs":{"src":{"a.ts":false},"src/gen":{"k.ts":true}}}
//! ```
//!
//! `ignored[i]` corresponds to `paths[i]`. `dirs` is an ADDITIVE convenience
//! (suppressed by `"with_siblings":false`): for each requested path's parent
//! directory it carries the verdict for every regular file directly inside it.
//! A synchronous caller cannot afford one subprocess round-trip per file, and
//! files asked about cluster by directory, so answering the whole directory in
//! the same spawn turns "one spawn per file" into "one spawn per directory".
//! Computing it is nearly free: `ScopeFilter` caches the compiled matchers per
//! directory, so the sibling verdicts reuse the work the requested path already
//! paid for.
//!
//! ## What `ignored` means
//!
//! `true` == "`walker::discover` would not yield this path", covering the
//! ignore-file verdict (`.gitignore` / `.ignore` / `.git/info/exclude` / global,
//! deepest-matcher-wins, negations honoured), the hidden-name rule, and the
//! UNCONDITIONAL build/VCS/cache prunes (`node_modules/`, `dist/`, …).
//!
//! The CONDITIONAL prunes are deliberately disabled here (the filter is built
//! with `include_vendored`/`include_fixtures` ON): `vendor/`, `examples/` and
//! `test/fixtures/` are index-SCOPE policy, not ignore semantics, and
//! `--include-vendored` / `--include-fixtures` make those files real indexed
//! nodes. Reporting them as "ignored" would make the packer refuse files the
//! graph actually contains — over-blocking, which for a shipped release is as
//! real a bug as under-blocking.
//!
//! Language and size filters are likewise NOT applied: the caller mirrors those
//! exactly already (`SOURCE_EXTENSIONS`, `MAX_PACK_FILE_BYTES`) and folding them
//! in here would only blur what a `true` means.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::parse::scope::ScopeFilter;
use crate::parse::walker::WalkOptions;

/// The only `op` this subcommand understands. Sent explicitly so the same
/// stdin transport can carry more ops later without a new subcommand.
const OP_CHECK_IGNORED: &str = "check_ignored";

/// Upper bound on regular files reported per directory in `dirs`. A directory
/// with more entries than this simply reports none of them (the requested
/// paths' own verdicts are always present) — the sibling map is an
/// optimisation, and an unbounded one would let a 200k-entry directory turn a
/// small request into a huge response.
const MAX_SIBLINGS_PER_DIR: usize = 4096;

#[derive(Debug, Deserialize)]
struct Request {
    op: String,
    root: String,
    paths: Vec<String>,
    /// Include the per-directory sibling verdicts. Default `true`.
    #[serde(default = "yes")]
    with_siblings: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Serialize)]
struct Response {
    /// One verdict per requested path, in request order. On ANY error this is
    /// all-`true` — a reader that ignores `error` still fails CLOSED.
    ignored: Vec<bool>,
    /// Repo-relative directory → (file name → verdict). Absent when
    /// `with_siblings` was false, when nothing could be listed, or on error.
    #[serde(skip_serializing_if = "Option::is_none")]
    dirs: Option<BTreeMap<String, BTreeMap<String, bool>>>,
    /// Human-readable failure reason. Absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Response {
    /// Fail CLOSED: every requested path reports as excluded. Used for a
    /// malformed request, an unknown op, and an unresolvable root — the caller
    /// must never read a file we could not adjudicate.
    fn refuse(n: usize, error: String) -> Self {
        Self {
            ignored: vec![true; n],
            dirs: None,
            error: Some(error),
        }
    }
}

/// Entry point for `hayven-native check-ignored`. Reads NDJSON requests from
/// stdin until EOF, writing one NDJSON response per request. Always exits 0:
/// per-request failures are reported IN the response (fail-closed verdicts), so
/// the caller never has to distinguish "process died" from "path is ignored".
pub fn run() -> i32 {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let resp = handle_line(line);
        // A serialization failure here is not reachable (every field is a
        // plain JSON scalar), but dropping the line would desynchronize the
        // request/response pairing, so emit a hand-built fail-closed line.
        let buf = serde_json::to_vec(&resp)
            .unwrap_or_else(|_| br#"{"ignored":[true],"error":"serialize"}"#.to_vec());
        if out.write_all(&buf).is_err() || out.write_all(b"\n").is_err() {
            return 1;
        }
        if out.flush().is_err() {
            return 1;
        }
    }
    0
}

/// Adjudicate one request line. Never panics; every failure path yields a
/// fail-closed [`Response`].
fn handle_line(line: &str) -> Response {
    let req: Request = match serde_json::from_str(line) {
        Ok(r) => r,
        // We cannot know how many paths were meant, so report one refusal.
        // The caller treats a length mismatch as "refuse everything" anyway.
        Err(err) => return Response::refuse(1, format!("malformed request: {err}")),
    };
    if req.op != OP_CHECK_IGNORED {
        return Response::refuse(req.paths.len(), format!("unknown op: {:?}", req.op));
    }
    check(&req)
}

fn check(req: &Request) -> Response {
    // `ScopeFilter::accepts` compares every path against its root with
    // `strip_prefix`, so a non-canonical root silently rejects everything.
    let root = match std::fs::canonicalize(&req.root) {
        Ok(r) => r,
        Err(err) => {
            return Response::refuse(req.paths.len(), format!("root {:?}: {err}", req.root))
        }
    };

    // See the module note: the CONDITIONAL prunes are index-scope policy, not
    // ignore semantics, and mirroring them here would refuse files that
    // `--include-vendored` / `--include-fixtures` make real indexed nodes.
    let opts = WalkOptions {
        include_vendored: true,
        include_fixtures: true,
        ..WalkOptions::default()
    };
    let filter = ScopeFilter::new(&root, &opts);

    let mut ignored = Vec::with_capacity(req.paths.len());
    let mut dirs: BTreeMap<String, BTreeMap<String, bool>> = BTreeMap::new();
    for rel in &req.paths {
        let Some(abs) = join_contained(&root, rel) else {
            // A path we cannot place under the root (absolute, `..`-escaping,
            // empty) is refused rather than adjudicated.
            ignored.push(true);
            continue;
        };
        ignored.push(!filter.accepts(&abs, abs.is_dir()));

        if req.with_siblings {
            if let Some(parent) = abs.parent() {
                let key = rel_key(&root, parent);
                if let Some(key) = key {
                    dirs.entry(key).or_insert_with(|| list_dir(&filter, parent));
                }
            }
        }
    }

    Response {
        ignored,
        dirs: if dirs.is_empty() { None } else { Some(dirs) },
        error: None,
    }
}

/// Join a repo-relative path onto `root`, refusing anything that is absolute,
/// contains a `..`/root component, or is empty. Purely lexical on purpose: the
/// caller has already resolved symlinks and proven containment, and re-deriving
/// that here would be a second, divergent containment implementation.
fn join_contained(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() {
        return None;
    }
    let p = Path::new(rel);
    for comp in p.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return None,
        }
    }
    Some(root.join(p))
}

/// `dir` expressed relative to `root`, forward-slash separated. `None` when
/// `dir` is not under `root`. The root itself maps to `""`.
fn rel_key(root: &Path, dir: &Path) -> Option<String> {
    let rel = dir.strip_prefix(root).ok()?;
    Some(
        rel.components()
            .filter_map(|c| c.as_os_str().to_str())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Verdicts for every regular file directly inside `dir`. Directories are
/// omitted: the caller only ever asks about files, and a directory's verdict
/// carries different semantics (`accepts(.., is_dir=true)`).
fn list_dir(filter: &ScopeFilter, dir: &Path) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_SIBLINGS_PER_DIR {
            // Bounded response: drop the whole map rather than serve a
            // truncated one the caller would read as "these are all the files".
            return BTreeMap::new();
        }
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_file {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        out.insert(name, !filter.accepts(&entry.path(), false));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `require_git(true)` means `.gitignore` is inert outside a git repo, so a
    /// fixture without this tests the wrong branch entirely.
    fn make_repo(root: &Path) {
        std::fs::create_dir_all(root.join(".git")).expect("mkdir .git");
        std::fs::write(root.join(".git/HEAD"), b"ref: refs/heads/main\n").expect("HEAD");
    }

    fn request(root: &Path, paths: &[&str]) -> String {
        serde_json::to_string(&serde_json::json!({
            "op": "check_ignored",
            "root": root.to_str().unwrap(),
            "paths": paths,
        }))
        .unwrap()
    }

    fn verdicts(root: &Path, paths: &[&str]) -> Vec<bool> {
        let resp = handle_line(&request(root, paths));
        assert_eq!(resp.error, None, "unexpected error");
        resp.ignored
    }

    /// THE bug: a gitignored file with a source extension, non-hidden and
    /// outside every pruned directory. The walker keeps it out of the graph;
    /// this op must say so, while first-party source stays admitted.
    #[test]
    fn gitignored_source_file_is_reported_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::write(root.join(".gitignore"), b"src/gen/\nconfig.local.ts\n").expect("gitignore");
        std::fs::create_dir_all(root.join("src/gen")).expect("mkdir");
        std::fs::write(root.join("src/a.ts"), b"export const a = 1;\n").expect("a");
        std::fs::write(root.join("src/gen/keys.ts"), b"export const k = 1;\n").expect("k");
        std::fs::write(root.join("src/config.local.ts"), b"export const c = 1;\n").expect("c");

        assert_eq!(
            verdicts(
                &root,
                &["src/a.ts", "src/gen/keys.ts", "src/config.local.ts"]
            ),
            vec![false, true, true],
        );
    }

    /// A nested negation must re-admit the file, exactly as git resolves it.
    /// This is the class of semantics the TypeScript side must never re-derive.
    #[test]
    fn nested_negation_re_admits() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::write(root.join(".gitignore"), b"*.gen.ts\n").expect("gitignore");
        std::fs::create_dir_all(root.join("src/keep")).expect("mkdir");
        std::fs::write(root.join("src/a.gen.ts"), b"x\n").expect("a");
        std::fs::write(root.join("src/keep/.gitignore"), b"!*.gen.ts\n").expect("nested");
        std::fs::write(root.join("src/keep/b.gen.ts"), b"x\n").expect("b");

        assert_eq!(
            verdicts(&root, &["src/a.gen.ts", "src/keep/b.gen.ts"]),
            vec![true, false],
        );
    }

    /// The conditional prunes must NOT show up as "ignored": `--include-vendored`
    /// / `--include-fixtures` make those files real indexed nodes, and refusing
    /// to pack a node the graph contains is over-blocking. The UNCONDITIONAL
    /// build/VCS prunes still report ignored.
    #[test]
    fn conditional_prunes_are_not_reported_ignored() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        for sub in [
            "vendor/dep",
            "test/fixtures/app",
            "examples",
            "node_modules/p",
        ] {
            std::fs::create_dir_all(root.join(sub)).expect("mkdir");
        }
        std::fs::write(root.join("vendor/dep/v.ts"), b"x\n").expect("v");
        std::fs::write(root.join("test/fixtures/app/i.ts"), b"x\n").expect("i");
        std::fs::write(root.join("examples/d.ts"), b"x\n").expect("d");
        std::fs::write(root.join("node_modules/p/i.ts"), b"x\n").expect("nm");

        assert_eq!(
            verdicts(
                &root,
                &[
                    "vendor/dep/v.ts",
                    "test/fixtures/app/i.ts",
                    "examples/d.ts",
                    "node_modules/p/i.ts",
                ],
            ),
            vec![false, false, false, true],
        );
    }

    /// The sibling map answers a whole directory in one spawn — the thing that
    /// keeps a synchronous caller from paying a round-trip per file.
    #[test]
    fn siblings_carry_the_whole_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::write(root.join(".gitignore"), b"src/b.ts\n").expect("gitignore");
        std::fs::create_dir_all(root.join("src")).expect("mkdir");
        std::fs::write(root.join("src/a.ts"), b"x\n").expect("a");
        std::fs::write(root.join("src/b.ts"), b"x\n").expect("b");

        let resp = handle_line(&request(&root, &["src/a.ts"]));
        let dirs = resp.dirs.expect("dirs present");
        let src = dirs.get("src").expect("src listed");
        assert_eq!(src.get("a.ts"), Some(&false));
        assert_eq!(
            src.get("b.ts"),
            Some(&true),
            "sibling verdict without a second request"
        );
    }

    /// Every failure path must fail CLOSED: a malformed line, an unknown op, an
    /// unresolvable root, and a `..`-escaping path all report "ignored".
    #[test]
    fn failures_fail_closed() {
        assert_eq!(handle_line("not json").ignored, vec![true]);

        let bad_op = serde_json::json!({"op":"nope","root":"/","paths":["a","b"]}).to_string();
        assert_eq!(handle_line(&bad_op).ignored, vec![true, true]);

        let missing = serde_json::json!({
            "op":"check_ignored","root":"/no/such/root/at/all","paths":["a.ts"]
        })
        .to_string();
        let resp = handle_line(&missing);
        assert_eq!(resp.ignored, vec![true]);
        assert!(resp.error.is_some());

        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        assert_eq!(
            verdicts(&root, &["../outside.ts", "/etc/passwd", ""]),
            vec![true, true, true],
        );
    }
}
