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

/// Dependency-SOURCE directories. Skipped BY DEFAULT — an agent navigating a
/// repo almost always wants first-party code, and vendored deps both inflate
/// the index and dilute search relevance (a query for `Reconciler` shouldn't
/// surface a vendored copy). Set `include_vendored` to index them too (for the
/// rarer case of navigating into a dependency). Kept SEPARATE from
/// `ALWAYS_SKIP_DIRS` (build/VCS/cache artifacts that are never worth indexing).
const VENDORED_DIRS: &[&str] = &["vendor", "Godeps", "third_party"];

/// Fixture-LIKE directories: throwaway example apps and benchmark drivers.
/// Skipped BY DEFAULT (name-only match at any depth, exactly like
/// `VENDORED_DIRS`) — they are code *about* the project, not the project
/// itself, and they inflate the index and feed ID/search noise. Measured on
/// withastro/astro: `examples/` (93 files) + `benchmark/` (39 files) on top of
/// the 27.6% of the index that was fixture apps. Set `include_fixtures` to
/// index them anyway.
const FIXTURE_LIKE_DIRS: &[&str] = &["examples", "benchmark", "benchmarks"];

/// ANCESTOR directory names under which a `fixtures/` dir is a TEST fixture
/// and skipped by default — `pkg/test/fixtures/…` but also the NESTED layouts
/// real repos use (`pkg/test/functions/fixtures/…`, netlify's shape on
/// withastro/astro, which a parent-only check missed: 89 fixture files leaked
/// back into the index). The ancestor check is what keeps a first-party
/// `src/fixtures/` module indexed (no test-dir ancestor): on astro,
/// `*/test/fixtures` fixture apps alone were 27.6% of the index — throwaway
/// scaffolds that drown search and blow up entity IDs.
const FIXTURE_ANCESTOR_DIRS: &[&str] = &["test", "tests", "e2e", "__tests__"];

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
    /// Files larger than this many bytes are skipped. The 8 MiB default
    /// accommodates large HAND-WRITTEN source (e.g. TypeScript's checker.ts at
    /// ~3 MB / 54K lines — a 2 MiB cap silently dropped it at scale, P2 finding)
    /// while still rejecting minified bundles, vendored data dumps, and the like
    /// (which are almost always well past 8 MiB). tree-sitter parses 8 MiB in
    /// well under a second, so the larger cap costs little.
    pub max_file_size: u64,
    /// Index dependency-source dirs (`vendor/`, `Godeps/`, `third_party/`) too.
    /// Default false — first-party code only (leaner index + sharper search).
    pub include_vendored: bool,
    /// Index test-fixture / example / benchmark dirs (`test/fixtures/`,
    /// `examples/`, `benchmark(s)/`) too. Default false — fixture apps are
    /// throwaway scaffolds that inflate the index (27.6% of astro's index) and
    /// dilute search. Vendored handling is independent (`include_vendored`).
    pub include_fixtures: bool,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            languages: HashSet::new(),
            max_file_size: 8 * 1024 * 1024,
            include_vendored: false,
            include_fixtures: false,
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
        // user's real ignore rules. `include_vendored` / `include_fixtures`
        // are captured so those prunes are conditional (default on).
        .filter_entry({
            let include_vendored = opts.include_vendored;
            let include_fixtures = opts.include_fixtures;
            // The walk root is captured so fixture-ancestor checks stay INSIDE
            // the repo — a repo that happens to live under a directory named
            // `test` on the user's disk must not have its `fixtures/` skipped.
            let root = root.to_path_buf();
            move |entry| !is_skipped_dir(entry, &root, include_vendored, include_fixtures)
        });

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

/// True iff this entry is a directory the walker must not descend into:
/// always a build/VCS/cache artifact (`ALWAYS_SKIP_DIRS`); unless
/// `include_vendored`, a dependency-source dir (`VENDORED_DIRS`); and unless
/// `include_fixtures`, a fixture-like dir (`FIXTURE_LIKE_DIRS`) or a
/// `fixtures/` dir with a test-dir ancestor (`FIXTURE_ANCESTOR_DIRS`).
fn is_skipped_dir(
    entry: &DirEntry,
    root: &Path,
    include_vendored: bool,
    include_fixtures: bool,
) -> bool {
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
        return false;
    }
    let name = match entry.file_name().to_str() {
        Some(n) => n,
        None => return false,
    };
    ALWAYS_SKIP_DIRS.contains(&name)
        || (!include_vendored && VENDORED_DIRS.contains(&name))
        || (!include_fixtures && is_fixture_dir(entry, root, name))
}

/// True iff this directory is fixture-like: NAMED `examples`/`benchmark(s)`
/// (any depth), or NAMED `fixtures` with ANY ancestor path component in
/// `FIXTURE_ANCESTOR_DIRS`. The ancestor walk needs the entry's full path — a
/// bare `src/fixtures/` (first-party module, no test-dir ancestor) must NOT be
/// skipped, while `pkg/test/fixtures/` and the nested
/// `pkg/test/functions/fixtures/` both must.
fn is_fixture_dir(entry: &DirEntry, root: &Path, name: &str) -> bool {
    if FIXTURE_LIKE_DIRS.contains(&name) {
        return true;
    }
    if name != "fixtures" {
        return false;
    }
    // Only REPO-RELATIVE ancestors count (never the path above the walk root).
    let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
    rel.ancestors().skip(1).any(|a| {
        a.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|seg| FIXTURE_ANCESTOR_DIRS.contains(&seg))
    })
}
