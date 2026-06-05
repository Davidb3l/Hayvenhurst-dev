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

        assert_eq!(out.len(), 1, "only the in-root file should survive: {out:#?}");
        assert!(
            out[0].path.starts_with(&root),
            "surviving candidate must be under root: {:?}",
            out[0].path
        );
        assert!(out[0].path.ends_with("inside.py"));
    }
}
