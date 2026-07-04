//! `parse` subcommand: walk the tree, extract each file in parallel,
//! and stream NDJSON records to stdout.
//!
//! Line atomicity is the hard requirement: the daemon parses our stdout
//! line-by-line and any interleaved bytes would corrupt the stream.
//! We satisfy that by fully serializing each `Record` on the producing
//! worker thread (into a complete `Vec<u8>` ending in `\n`) and pushing
//! the buffer through an mpsc channel to a single writer thread.

pub mod extract;
pub mod hash;
pub mod language;
pub mod signature;
pub mod walker;

use std::collections::HashSet;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use rayon::prelude::*;

use crate::proto::Record;
use crate::{version_record, VERSION};
use language::Language;
use walker::{Candidate, WalkOptions};

/// CLI-facing options for `hayven-native parse`.
#[derive(Debug, Clone)]
pub struct ParseOptions {
    /// Root directory to walk.
    pub root: PathBuf,
    /// Languages to include. Empty == all supported.
    pub languages: HashSet<Language>,
    /// Worker thread count. `None` defers to rayon's default.
    pub jobs: Option<usize>,
    /// Skip files larger than this many bytes.
    pub max_file_size: u64,
    /// Incremental ingest: when `Some`, parse only these repo-relative
    /// files instead of running the gitignore-aware walker. Used by the
    /// watcher's debounced re-ingest (§16.3). Files with unsupported
    /// extensions or that don't exist are silently dropped — the daemon
    /// has already decided which files matter.
    pub explicit_files: Option<Vec<String>>,
    /// OPT-IN (`parse --signatures`): additionally emit one `Record::Signature`
    /// per callable/typed definition, carrying the real tree-sitter-derived
    /// contract (arity / param types / return type / visibility). Default
    /// `false` — when unset the stream is byte-for-byte the legacy Node/Edge
    /// output. Additive only: the contract-diff conflict oracle consumes these.
    pub emit_signatures: bool,
    /// Index dependency-source dirs (`vendor/`, `Godeps/`, `third_party/`) too.
    /// Default false (first-party only). Ignored on the explicit-files path.
    pub include_vendored: bool,
    /// Index test-fixture / example / benchmark dirs (`test/fixtures/`,
    /// `examples/`, `benchmark(s)/`) too. Default false — fixture apps are
    /// throwaway scaffolds (27.6% of astro's index) that dilute search.
    /// Ignored on the explicit-files path.
    pub include_fixtures: bool,
}

/// Emit one progress record every N files. Small enough that the daemon
/// gets responsive UI updates, large enough that we don't drown the
/// pipe on big repos.
const PROGRESS_INTERVAL: usize = 100;

/// Run the parse pipeline. Returns the exit code the process should
/// use: `0` on success, `1` on fatal error (after a `Fatal` record has
/// been written).
pub fn run(opts: ParseOptions) -> Result<i32> {
    let start = Instant::now();

    // Resolve and validate the root.
    let root = opts
        .root
        .canonicalize()
        .with_context(|| format!("canonicalize {}", opts.root.display()))?;

    let walk_opts = WalkOptions {
        languages: opts.languages.clone(),
        max_file_size: opts.max_file_size,
        include_vendored: opts.include_vendored,
        include_fixtures: opts.include_fixtures,
    };

    let candidates: Vec<Candidate> = if let Some(files) = &opts.explicit_files {
        candidates_from_explicit_files(&root, files, &walk_opts)
    } else {
        walker::discover(&root, &walk_opts)
    };
    let files_total = candidates.len();

    // Build a dedicated rayon thread pool if the user asked for a
    // specific job count. We don't mutate the global pool — that's
    // global state and our crate is also linkable as a library.
    let pool = if let Some(n) = opts.jobs {
        Some(
            rayon::ThreadPoolBuilder::new()
                .num_threads(n.max(1))
                .build()
                .context("build rayon pool")?,
        )
    } else {
        None
    };

    // Wire up the ordered writer: workers send fully-encoded byte
    // buffers, the writer thread flushes them in receive order.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let writer_handle = std::thread::spawn(move || -> io::Result<()> {
        let stdout = io::stdout();
        let mut out = BufWriter::new(stdout.lock());
        for buf in rx {
            out.write_all(&buf)?;
        }
        out.flush()
    });

    // §16.4 version handshake: always the first NDJSON record on stdout.
    send_record(&tx, &version_record());

    // Start record. Emit before kicking off workers so the daemon can
    // wire up its sink before the firehose opens.
    send_record(
        &tx,
        &Record::Start {
            files_total,
            version: VERSION.to_string(),
        },
    );

    // Shared counters for the Done summary and progress heartbeats.
    let files_done = Arc::new(AtomicUsize::new(0));
    let nodes_total = Arc::new(AtomicUsize::new(0));
    let edges_total = Arc::new(AtomicUsize::new(0));

    let emit_signatures = opts.emit_signatures;
    let process_file = |c: &Candidate| {
        let result = extract::extract_path(&root, &c.path, c.language, emit_signatures);

        let mut local_nodes = 0usize;
        let mut local_edges = 0usize;

        match result {
            Ok(extraction) => {
                // Serialize each record on this worker thread to avoid
                // any cross-thread JSON contention on the writer side.
                for rec in &extraction.records {
                    match rec {
                        Record::Node { .. } => local_nodes += 1,
                        Record::Edge { .. } => local_edges += 1,
                        _ => {}
                    }
                    send_record(&tx, rec);
                }
            }
            Err(err) => {
                send_record(
                    &tx,
                    &Record::Warn {
                        file: c
                            .path
                            .strip_prefix(&root)
                            .unwrap_or(&c.path)
                            .to_string_lossy()
                            .to_string(),
                        message: format!("{:#}", err),
                    },
                );
            }
        }

        nodes_total.fetch_add(local_nodes, Ordering::Relaxed);
        edges_total.fetch_add(local_edges, Ordering::Relaxed);

        let done = files_done.fetch_add(1, Ordering::Relaxed) + 1;
        if done.is_multiple_of(PROGRESS_INTERVAL) {
            send_record(&tx, &Record::Progress { files_done: done });
        }
    };

    if let Some(pool) = pool {
        pool.install(|| candidates.par_iter().for_each(process_file));
    } else {
        candidates.par_iter().for_each(process_file);
    }

    // Final progress + done record. Drop the sender to unblock the
    // writer thread.
    let final_done = files_done.load(Ordering::Relaxed);
    let final_nodes = nodes_total.load(Ordering::Relaxed);
    let final_edges = edges_total.load(Ordering::Relaxed);

    send_record(
        &tx,
        &Record::Done {
            files_done: final_done,
            nodes: final_nodes,
            edges: final_edges,
            elapsed_ms: u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        },
    );

    drop(tx);
    writer_handle
        .join()
        .map_err(|_| anyhow::anyhow!("writer thread panicked"))?
        .context("writer thread I/O")?;

    Ok(0)
}

/// Serialize one record to a `\n`-terminated byte buffer and ship it to
/// the writer thread. JSON serialization failure is unrecoverable here
/// (it would only happen for non-finite floats, which we never emit),
/// but we still degrade safely by skipping the record.
fn send_record(tx: &mpsc::Sender<Vec<u8>>, rec: &Record) {
    let Ok(mut buf) = serde_json::to_vec(rec) else {
        return;
    };
    buf.push(b'\n');
    // If the writer has hung up there's nothing useful we can do.
    let _ = tx.send(buf);
}

/// Map a `--files` list to the same `Candidate` shape the walker
/// produces. Files that don't exist, lie outside `root`, exceed the
/// size limit, or whose extension doesn't match a language filter are
/// silently dropped — the daemon's debouncer may pass us non-source
/// files (e.g. a stray `.md` edit) and that is not an error.
///
/// Root containment is enforced (BL-1): `root` is already canonicalized
/// by the caller, and each entry is canonicalized and checked to stay
/// under it. Absolute `rel` values are rejected outright — `Path::join`
/// would otherwise discard the base and parse an arbitrary file. This is
/// defense-in-depth: today's only caller (the watcher) passes in-root
/// relative paths, but the function must be safe for any future caller.
fn candidates_from_explicit_files(
    root: &Path,
    rels: &[String],
    opts: &WalkOptions,
) -> Vec<Candidate> {
    let mut out = Vec::with_capacity(rels.len());
    for rel in rels {
        let rel = rel.trim();
        if rel.is_empty() {
            continue;
        }
        // An absolute path would make `root.join(rel)` ignore `root`.
        if Path::new(rel).is_absolute() {
            continue;
        }
        // Canonicalize the joined path so `..` components and symlinks are
        // resolved, then require the result stays under the canonical root.
        // `canonicalize` also fails for non-existent paths, which we'd drop
        // anyway via the metadata check below.
        let Ok(full) = root.join(rel).canonicalize() else {
            continue;
        };
        if !full.starts_with(root) {
            continue;
        }
        let Some(language) = Language::from_path(&full) else {
            continue;
        };
        if !opts.languages.is_empty() && !opts.languages.contains(&language) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if !meta.is_file() || meta.len() > opts.max_file_size {
            continue;
        }
        out.push(Candidate {
            path: full,
            language,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BL-1: `--files` must not escape the root. `../outside` and an
    /// absolute path are dropped; an in-root file in the same list still
    /// parses.
    #[test]
    fn explicit_files_enforces_root_containment() {
        let parent = tempfile::tempdir().expect("tempdir");
        // The root is a subdir; the escape target lives in the parent.
        let root = parent.path().join("root");
        std::fs::create_dir(&root).expect("mkdir root");
        let root = root.canonicalize().expect("canonicalize root");

        std::fs::write(root.join("inside.py"), b"x = 1\n").expect("write inside");
        std::fs::write(parent.path().join("outside.py"), b"y = 2\n").expect("write outside");

        let opts = WalkOptions {
            languages: HashSet::new(),
            max_file_size: 1 << 20,
            include_vendored: false,
            include_fixtures: false,
        };
        let rels = vec![
            "inside.py".to_string(),
            "../outside.py".to_string(),
            parent
                .path()
                .join("outside.py")
                .to_string_lossy()
                .into_owned(),
        ];

        let out = candidates_from_explicit_files(&root, &rels, &opts);

        assert_eq!(
            out.len(),
            1,
            "only the in-root file should survive: {out:#?}"
        );
        assert!(
            out[0].path.starts_with(&root),
            "surviving candidate must be under root: {:?}",
            out[0].path
        );
        assert!(out[0].path.ends_with("inside.py"));
    }

    /// Vendored dependency dirs are skipped by default and included only when
    /// `include_vendored` is set; first-party code is always indexed.
    #[test]
    fn vendored_dirs_skipped_by_default_included_on_opt_in() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::write(root.join("main.go"), b"package main\n").expect("write main");
        std::fs::create_dir_all(root.join("vendor/dep")).expect("mkdir vendor");
        std::fs::write(root.join("vendor/dep/dep.go"), b"package dep\n").expect("write dep");
        std::fs::create_dir_all(root.join("third_party")).expect("mkdir third_party");
        std::fs::write(root.join("third_party/tp.go"), b"package tp\n").expect("write tp");

        let names = |opts: &WalkOptions| -> Vec<String> {
            walker::discover(root, opts)
                .into_iter()
                .map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };

        // Default: vendored dirs pruned, first-party kept.
        let def = names(&WalkOptions {
            include_vendored: false,
            ..WalkOptions::default()
        });
        assert!(
            def.contains(&"main.go".to_string()),
            "first-party must be indexed: {def:?}"
        );
        assert!(
            !def.contains(&"dep.go".to_string()),
            "vendor/ must be skipped by default: {def:?}"
        );
        assert!(
            !def.contains(&"tp.go".to_string()),
            "third_party/ must be skipped by default: {def:?}"
        );

        // Opt-in: vendored dirs now included.
        let inc = names(&WalkOptions {
            include_vendored: true,
            ..WalkOptions::default()
        });
        assert!(inc.contains(&"main.go".to_string()));
        assert!(
            inc.contains(&"dep.go".to_string()),
            "vendor/ must be indexed with include_vendored: {inc:?}"
        );
        assert!(
            inc.contains(&"tp.go".to_string()),
            "third_party/ must be indexed with include_vendored: {inc:?}"
        );
    }

    /// Test-fixture apps (`*/test/fixtures/…`), `examples/`, and
    /// `benchmark(s)/` are skipped by default and included only with
    /// `include_fixtures` — measured 27.6% index bloat on withastro/astro.
    /// A first-party `src/fixtures/` (parent is NOT a test dir) and other
    /// non-fixture test subdirs are ALWAYS indexed.
    #[test]
    fn fixture_dirs_skipped_by_default_included_on_opt_in() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("pkg/test/fixtures/app/src")).expect("mkdir fixture app");
        std::fs::write(
            root.join("pkg/test/fixtures/app/src/x.ts"),
            b"export const x = 1;\n",
        )
        .expect("write x");
        // NESTED fixture layout (netlify's shape on astro): the test dir is an
        // ANCESTOR, not the direct parent — must still be pruned.
        std::fs::create_dir_all(root.join("pkg/test/functions/fixtures/mw/src"))
            .expect("mkdir nested fixture");
        std::fs::write(
            root.join("pkg/test/functions/fixtures/mw/src/n.ts"),
            b"export const n = 1;\n",
        )
        .expect("write n");
        std::fs::create_dir_all(root.join("pkg/examples")).expect("mkdir examples");
        std::fs::write(root.join("pkg/examples/y.ts"), b"export const y = 1;\n").expect("write y");
        std::fs::create_dir_all(root.join("benchmark")).expect("mkdir benchmark");
        std::fs::write(root.join("benchmark/z.ts"), b"export const z = 1;\n").expect("write z");
        // Controls: `fixtures` NOT under a test dir + a non-fixture test subdir.
        std::fs::create_dir_all(root.join("src/fixtures")).expect("mkdir src fixtures");
        std::fs::write(root.join("src/fixtures/keep.ts"), b"export const k = 1;\n")
            .expect("write keep");
        std::fs::create_dir_all(root.join("src/test/other")).expect("mkdir test other");
        std::fs::write(
            root.join("src/test/other/keep2.ts"),
            b"export const k2 = 1;\n",
        )
        .expect("write keep2");

        let names = |opts: &WalkOptions| -> Vec<String> {
            walker::discover(root, opts)
                .into_iter()
                .map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        };

        // Default: fixture-like dirs pruned; the controls survive.
        let def = names(&WalkOptions::default());
        assert!(
            !def.contains(&"x.ts".to_string()),
            "test/fixtures must be skipped by default: {def:?}"
        );
        assert!(
            !def.contains(&"n.ts".to_string()),
            "NESTED test/*/fixtures must be skipped by default: {def:?}"
        );
        assert!(
            !def.contains(&"y.ts".to_string()),
            "examples/ must be skipped by default: {def:?}"
        );
        assert!(
            !def.contains(&"z.ts".to_string()),
            "benchmark/ must be skipped by default: {def:?}"
        );
        assert!(
            def.contains(&"keep.ts".to_string()),
            "src/fixtures (non-test parent) must ALWAYS be indexed: {def:?}"
        );
        assert!(
            def.contains(&"keep2.ts".to_string()),
            "non-fixture test subdirs must ALWAYS be indexed: {def:?}"
        );

        // Opt-in: everything is included.
        let inc = names(&WalkOptions {
            include_fixtures: true,
            ..WalkOptions::default()
        });
        for f in ["x.ts", "n.ts", "y.ts", "z.ts", "keep.ts", "keep2.ts"] {
            assert!(
                inc.contains(&f.to_string()),
                "{f} must be indexed with include_fixtures: {inc:?}"
            );
        }
    }

    /// The fixture-ancestor check is scoped to the WALK ROOT: a repo that
    /// happens to live under a directory named `test` on the user's disk must
    /// not have its first-party `fixtures/` skipped (only repo-relative
    /// ancestors count).
    #[test]
    fn fixture_ancestor_check_is_scoped_to_the_walk_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Repo root deliberately nested under an off-repo dir named `test`.
        let root = dir.path().join("test/repo");
        std::fs::create_dir_all(root.join("fixtures")).expect("mkdir fixtures");
        std::fs::write(root.join("fixtures/rooty.ts"), b"export const r = 1;\n")
            .expect("write rooty");

        let def: Vec<String> = walker::discover(&root, &WalkOptions::default())
            .into_iter()
            .map(|c| c.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(
            def.contains(&"rooty.ts".to_string()),
            "fixtures/ with no IN-REPO test ancestor must be indexed even when the repo lives under an off-repo `test/` dir: {def:?}"
        );
    }
}
