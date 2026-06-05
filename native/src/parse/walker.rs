//! Gitignore-aware file walker.
//!
//! Wraps `ignore::WalkBuilder` with:
//! - The default gitignore + hidden-file behaviour.
//! - An additional hard skip list for directories that are almost never
//!   what the user wants parsed (build artifacts, virtualenvs, etc.).
//! - A whitelist of allowed languages, derived from `--langs` (or all
//!   supported languages when the flag is omitted).
//! - A max-file-size guard, applied at metadata-read time so we never
//!   stream a multi-megabyte minified bundle into Tree-sitter.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use ignore::{DirEntry, WalkBuilder};

use super::language::Language;

/// Directories whose contents are never useful to parse. Matched on the
/// directory's filename only, so depth doesn't matter.
const ALWAYS_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".hayven",
    ".git",
    ".next",
    ".turbo",
    ".cache",
];

/// A single candidate file discovered by the walker, along with the
/// language we will parse it as.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub language: Language,
}

/// Options for `discover`. Cheap to clone; passed by value to keep the
/// call site readable.
#[derive(Debug, Clone)]
pub struct WalkOptions {
    /// Languages we will accept. Empty == accept all known languages.
    pub languages: HashSet<Language>,
    /// Files larger than this many bytes are skipped silently. The
    /// 2 MB default comfortably accommodates real source files while
    /// rejecting minified bundles, vendored data dumps, and the like.
    pub max_file_size: u64,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            languages: HashSet::new(),
            max_file_size: 2 * 1024 * 1024,
        }
    }
}

/// Walk `root` and return every file that matches the language filter,
/// is under the size limit, and is not in an excluded directory. The
/// result is collected eagerly because rayon needs a `Vec` to bridge
/// into a parallel iterator cleanly.
pub fn discover(root: &Path, opts: &WalkOptions) -> Vec<Candidate> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        // Apply our directory skip-list via a custom filter rather than
        // a synthetic `.gitignore` so it composes cleanly with the
        // user's real ignore rules.
        .filter_entry(|entry| !is_skipped_dir(entry));

    let mut out = Vec::new();
    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            // Walker-level errors (permission denied, broken symlink)
            // are silently skipped. They surface as a missing file in
            // the daemon's index, which is the correct behavior.
            Err(_) => continue,
        };

        // Filter to regular files.
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }

        let path = entry.path();

        // Language filter — drop unknown extensions early.
        let Some(language) = Language::from_path(path) else {
            continue;
        };
        if !opts.languages.is_empty() && !opts.languages.contains(&language) {
            continue;
        }

        // Size filter. We use the metadata that `ignore` already
        // stat'd to avoid a second syscall.
        if let Ok(meta) = entry.metadata() {
            if meta.len() > opts.max_file_size {
                continue;
            }
        }

        out.push(Candidate {
            path: path.to_path_buf(),
            language,
        });
    }
    out
}

/// True iff this entry is a directory whose name appears in
/// `ALWAYS_SKIP_DIRS`. Used as a `filter_entry` predicate so the
/// walker never descends into it.
fn is_skipped_dir(entry: &DirEntry) -> bool {
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
        return false;
    }
    let name = match entry.file_name().to_str() {
        Some(n) => n,
        None => return false,
    };
    ALWAYS_SKIP_DIRS.contains(&name)
}
