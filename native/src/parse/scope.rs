//! Single source of truth for "does this path belong in the graph?".
//!
//! WHY THIS EXISTS (F5). Three code paths used to answer that question, and
//! they answered it differently:
//!
//!   * the full walk (`walker::discover`) — gitignore-aware, hidden-aware, and
//!     pruning `vendor/`, `examples/`, `test/fixtures/`, build dirs, …
//!   * the incremental `parse --files-stdin` path — language + size filters
//!     ONLY. No prune list, no gitignore, no hidden check.
//!   * the watcher (`watch::translate`) — a hand-copied subset of the prune
//!     list that omitted `vendor`, `Godeps`, `third_party`, `examples`,
//!     `benchmark(s)`, `fixtures`, and never looked at `.gitignore`.
//!
//! Measured on a repo with `src/`, `vendor/`, `examples/` and a gitignored
//! `out/`, the full walk indexed `app, firstParty` while the incremental path
//! indexed `bundle, demo, exampleFn, generatedFn, lib, vendored`. So any build
//! writing into a gitignored output directory that is not on the hard skip
//! list (`.output/`, `.svelte-kit/`, `coverage/`, `htmlcov/`, `bin/`,
//! `storybook-static/`, `__generated__/`, …) fires watch events, each burst
//! queues an incremental ingest, and generated artifacts get written
//! permanently into the graph — silently, and unboundedly.
//!
//! The underlying defect is duplication, not any one missing list, so the fix
//! is this type: ONE decision function that the walker's prune, the
//! explicit-files path, and the watcher all consult. Adding a rule here
//! changes all three at once, which is the only way they stay in agreement.
//!
//! GITIGNORE PARITY. `discover` delegates gitignore handling to the `ignore`
//! crate's walker. The other two paths get single-path answers, which the
//! crate does not do for a walk, so we assemble the same stack of matchers by
//! hand: for each directory from the file's parent upward we consult that
//! directory's `.gitignore` / `.ignore` (plus `.git/info/exclude` at the REPO
//! root) and take the FIRST definitive answer — deepest matcher wins, which is
//! git's own precedence rule and is what makes a nested `!negation` work. The
//! user's global gitignore is consulted last, matching `git_global(true)`.
//! Matchers are cached per directory and rebuilt when the underlying ignore
//! file's mtime changes, so a long-lived watcher picks up an edited
//! `.gitignore` instead of serving a stale decision forever.
//!
//! One subtlety the parity test caught: `WalkBuilder::require_git` defaults to
//! TRUE, so the full walk applies `.gitignore` / `.git/info/exclude` / the
//! global gitignore ONLY inside a git repository — a stray `.gitignore` in a
//! non-repo directory is inert there. `.ignore` files are honored either way
//! (`ignore(true)` is not a git-related rule). We reproduce both behaviours;
//! without that, this filter would be STRICTER than the walk it is supposed to
//! agree with, and the incremental path would silently drop real source.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;

use super::walker::{is_pruned_dir_name, WalkOptions};

/// Ignore-file name read from every directory regardless of git. Mirrors
/// `WalkBuilder::ignore(true)`, which is not a git-gated rule.
const PLAIN_IGNORE_FILE: &str = ".ignore";

/// Git-gated ignore-file name read from every directory. Only consulted when
/// the walk root is inside a git repository, matching `require_git(true)`.
const GIT_IGNORE_FILE: &str = ".gitignore";

/// Upper bound on cached per-directory ignore matchers. Reaching it clears the
/// cache rather than evicting one entry: the map is pure derived state, and a
/// wholesale rebuild is far cheaper than tracking LRU order for something this
/// cold. Chosen well above any real repo's directory count so a normal project
/// never rebuilds.
const MAX_CACHED_DIRS: usize = 8192;

/// A directory's compiled ignore rules plus the mtimes they were built from.
struct DirIgnore {
    gi: Gitignore,
    /// One entry per source file we tried to read, in `sources()` order.
    /// `None` = the file did not exist when we built.
    stamps: Vec<Option<SystemTime>>,
}

/// Shared scope decision for one walk root. Cheap to construct; the gitignore
/// matchers inside are built lazily and cached.
pub struct ScopeFilter {
    root: PathBuf,
    include_vendored: bool,
    include_fixtures: bool,
    cache: Mutex<HashMap<PathBuf, DirIgnore>>,
    global: Gitignore,
    /// Whether git-sourced ignore rules apply at all. See the module note on
    /// `require_git`.
    git: bool,
    /// The directory holding `.git`, when there is one. `git_exclude(true)`
    /// resolves `.git/info/exclude` from the REPO root, which may be above the
    /// walk root — reading it only at the walk root missed it for any ingest of
    /// a subdirectory.
    repo_root: Option<PathBuf>,
}

impl ScopeFilter {
    /// Build a filter for `root`. `root` should already be canonicalized by
    /// the caller — every path handed to [`ScopeFilter::accepts`] is compared
    /// against it with `strip_prefix`, so a non-canonical root silently
    /// rejects everything.
    pub fn new(root: &Path, opts: &WalkOptions) -> Self {
        // `Gitignore::global` returns a partial matcher plus an optional
        // error; a malformed global gitignore must not stop us indexing, so we
        // keep whatever parsed and drop the error (same posture as the
        // `ignore` crate's own walker).
        let repo_root = find_repo_root(root);
        let git = repo_root.is_some();
        let (global, _err) = if git {
            Gitignore::global()
        } else {
            (Gitignore::empty(), None)
        };
        Self {
            root: root.to_path_buf(),
            include_vendored: opts.include_vendored,
            include_fixtures: opts.include_fixtures,
            cache: Mutex::new(HashMap::new()),
            global,
            git,
            repo_root,
        }
    }

    /// The walk root this filter is anchored to.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// True iff `path` belongs in the graph. `path` must be absolute and under
    /// the root; anything else is rejected (a path we cannot place relative to
    /// the repo is not something we should be indexing).
    ///
    /// ORDER MATTERS, and it is the walker's order, not the obvious one:
    ///
    ///   1. root containment,
    ///   2. the directory prune lists — unconditional, because they come from
    ///      `WalkBuilder::filter_entry`, which the `ignore` crate applies
    ///      independently of any ignore rule (no `!negation` can drag
    ///      `node_modules/` back in),
    ///   3. the ignore verdict,
    ///   4. hidden names — LAST, and skipped when step 3 said "whitelisted".
    ///
    /// Step 4's placement was a real bug found in review. `hidden(true)` lives
    /// in the same matcher chain as the ignore rules inside the `ignore` crate,
    /// and a whitelist wins over it: verified empirically that a repo with
    /// `!.env.ts` / `!.hidden/` in `.gitignore` has `discover` return
    /// `.env.ts` and `.hidden/h.ts`. Checking hidden first made this filter
    /// STRICTER than the walk, which would have silently dropped real source
    /// from the incremental path — the same failure class, pointing the other
    /// way.
    ///
    /// Language and size filters are deliberately NOT here: both callers apply
    /// those identically already, and they need file metadata this avoids.
    pub fn accepts(&self, path: &Path, is_dir: bool) -> bool {
        let Ok(rel) = path.strip_prefix(&self.root) else {
            return false;
        };
        let comps: Vec<&std::ffi::OsStr> = rel.iter().collect();
        if comps.is_empty() {
            return true; // the root itself
        }
        // Every component but the last names a directory the walker would have
        // had to descend into; the last is the entry itself.
        let last = comps.len() - 1;
        let mut prefix = PathBuf::new();
        for (i, comp) in comps.iter().enumerate() {
            // A non-UTF-8 component can never equal a prune-list entry, and
            // `walker::is_skipped_dir` returns false (NOT pruned) for exactly
            // that reason. Mirror it rather than refusing the path outright.
            let Some(name) = comp.to_str() else {
                prefix.push(comp);
                continue;
            };
            prefix.push(name);
            if (i < last || is_dir)
                && is_pruned_dir_name(name, &prefix, self.include_vendored, self.include_fixtures)
            {
                return false;
            }
        }

        match self.ignore_verdict(path, is_dir) {
            Some(true) => false, // ignored
            Some(false) => true, // explicitly whitelisted — beats hidden
            None => !comps.iter().any(is_hidden_component),
        }
    }

    /// Ignore-rule verdict, deepest-matcher-wins (git's own precedence).
    /// `Some(true)` = ignored, `Some(false)` = explicitly whitelisted,
    /// `None` = no rule had anything to say.
    fn ignore_verdict(&self, path: &Path, is_dir: bool) -> Option<bool> {
        let mut dir = path.parent();
        while let Some(d) = dir {
            if let Some(verdict) = self.matched_in(d, path, is_dir) {
                return Some(verdict);
            }
            dir = d.parent();
        }
        match guarded_match(&self.global, path, is_dir)? {
            Match::Ignore(_) => Some(true),
            Match::Whitelist(_) => Some(false),
            Match::None => None,
        }
    }

    /// `Some(true)` = ignored here, `Some(false)` = explicitly whitelisted
    /// here, `None` = this directory's rules say nothing.
    fn matched_in(&self, dir: &Path, path: &Path, is_dir: bool) -> Option<bool> {
        let is_repo_root = Some(dir) == self.repo_root.as_deref();
        // Recover from poisoning instead of propagating it. A poisoned mutex
        // here would make `lock().ok()?` return None forever, i.e. "no ignore
        // rules at all" — a long-lived watcher would silently start re-admitting
        // every gitignored build artifact and nothing would say so.
        let mut cache = match self.cache.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Bound the cache. A watcher over a tree that keeps minting fresh
        // directory names (`tmp/run-<uuid>/…`) would otherwise grow this for
        // the process lifetime. Dropping it wholesale is fine: entries are
        // pure derived state and rebuild on demand.
        if cache.len() > MAX_CACHED_DIRS {
            cache.clear();
        }
        let stale = match cache.get(dir) {
            Some(entry) => entry.stamps != stamps_for(dir, is_repo_root, self.git),
            None => true,
        };
        if stale {
            cache.insert(
                dir.to_path_buf(),
                DirIgnore {
                    gi: build_dir_ignore(dir, is_repo_root, self.git),
                    stamps: stamps_for(dir, is_repo_root, self.git),
                },
            );
        }
        let entry = cache.get(dir)?;
        if entry.gi.is_empty() {
            return None;
        }
        match guarded_match(&entry.gi, path, is_dir)? {
            Match::Ignore(_) => Some(true),
            Match::Whitelist(_) => Some(false),
            Match::None => None,
        }
    }
}

/// `matched_path_or_any_parents` panics when handed a path outside the
/// matcher's root, so every call goes through this guard.
fn guarded_match<'a>(
    gi: &'a Gitignore,
    path: &Path,
    is_dir: bool,
) -> Option<Match<&'a ignore::gitignore::Glob>> {
    if !path.starts_with(gi.path()) {
        return None;
    }
    Some(gi.matched_path_or_any_parents(path, is_dir))
}

/// The ignore-source paths for a directory. `.ignore` always; `.gitignore`
/// (and, at the REPO root, `.git/info/exclude`) only when git rules apply.
fn ignore_sources(dir: &Path, is_repo_root: bool, git: bool) -> Vec<PathBuf> {
    let mut out = vec![dir.join(PLAIN_IGNORE_FILE)];
    if git {
        out.push(dir.join(GIT_IGNORE_FILE));
        if is_repo_root {
            out.push(dir.join(".git").join("info").join("exclude"));
        }
    }
    out
}

fn stamps_for(dir: &Path, is_repo_root: bool, git: bool) -> Vec<Option<SystemTime>> {
    ignore_sources(dir, is_repo_root, git)
        .into_iter()
        .map(|p| std::fs::metadata(&p).and_then(|m| m.modified()).ok())
        .collect()
}

fn build_dir_ignore(dir: &Path, is_repo_root: bool, git: bool) -> Gitignore {
    let mut builder = GitignoreBuilder::new(dir);
    for src in ignore_sources(dir, is_repo_root, git) {
        // `add` returns Some(err) for a missing or malformed file. Both are
        // non-fatal: a directory usually has no ignore file at all.
        let _ = builder.add(src);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

/// The nearest ancestor of `root` (inclusive) holding a `.git` entry, or
/// `None` outside a repository. Presence of a repo is the condition the
/// `ignore` crate's `require_git(true)` checks before applying ANY git-sourced
/// ignore rule. `.git` may be a directory (normal clone) or a FILE (worktree /
/// submodule gitlink), so existence is the test, not file type — note that in
/// the gitlink case `<repo>/.git/info/exclude` does not exist and simply reads
/// as absent, which is correct-but-incomplete (see the lane report).
fn find_repo_root(root: &Path) -> Option<PathBuf> {
    root.ancestors()
        .find(|a| a.join(".git").exists())
        .map(Path::to_path_buf)
}

/// Dot-prefixed names are hidden. `WalkBuilder::hidden(true)` (the full walk's
/// setting) skips them, so the incremental paths must too — otherwise a build
/// into `.output/` or `.svelte-kit/` lands in the graph on the watch path but
/// not on the ingest path.
fn is_hidden_component(comp: &&std::ffi::OsStr) -> bool {
    // Compare on the lossy form: a leading '.' is ASCII, so this is exact even
    // for a non-UTF-8 file name.
    let name = comp.to_string_lossy();
    name.starts_with('.') && name != "." && name != ".."
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Make `dir` look like a git repo. `require_git(true)` means the full
    /// walk ignores `.gitignore` outside one, so a fixture that omits this
    /// would be testing the wrong branch.
    fn make_repo(root: &Path) {
        std::fs::create_dir_all(root.join(".git")).expect("mkdir .git");
        std::fs::write(root.join(".git/HEAD"), b"ref: refs/heads/main\n").expect("write HEAD");
    }

    fn opts() -> WalkOptions {
        WalkOptions {
            languages: HashSet::new(),
            max_file_size: 8 * 1024 * 1024,
            include_vendored: false,
            include_fixtures: false,
        }
    }

    /// The exact divergence from the finding: gitignored output, vendored
    /// deps, and example dirs are out of scope; first-party source is in.
    #[test]
    fn scope_matches_the_full_walk_decisions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::write(root.join(".gitignore"), b"out/\ncoverage/\n").expect("write gitignore");
        for sub in [
            "src",
            "vendor/dep",
            "examples",
            "out",
            "coverage",
            ".svelte-kit",
            "pkg/test/fixtures/app",
        ] {
            std::fs::create_dir_all(root.join(sub)).expect("mkdir");
        }
        let f = |p: &str| root.join(p);
        let sf = ScopeFilter::new(&root, &opts());

        assert!(sf.accepts(&f("src/app.ts"), false), "first-party source");
        assert!(!sf.accepts(&f("vendor/dep/v.ts"), false), "vendor/");
        assert!(!sf.accepts(&f("examples/demo.ts"), false), "examples/");
        assert!(!sf.accepts(&f("out/bundle.js"), false), "gitignored out/");
        assert!(
            !sf.accepts(&f("coverage/c.js"), false),
            "gitignored coverage/"
        );
        assert!(
            !sf.accepts(&f(".svelte-kit/gen.js"), false),
            "hidden build dir"
        );
        assert!(
            !sf.accepts(&f("pkg/test/fixtures/app/x.ts"), false),
            "test fixture app"
        );
        // Outside the root is never in scope.
        assert!(!sf.accepts(Path::new("/etc/passwd"), false));
    }

    /// A nested `.gitignore` negation must win over an ancestor's rule, the
    /// same way git resolves it — otherwise the shared filter would be
    /// stricter than the full walk and silently drop real source.
    #[test]
    fn deeper_gitignore_negation_wins() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::write(root.join(".gitignore"), b"*.gen.ts\n").expect("write root gitignore");
        std::fs::create_dir_all(root.join("src/keep")).expect("mkdir");
        std::fs::write(root.join("src/keep/.gitignore"), b"!*.gen.ts\n").expect("write nested");

        let sf = ScopeFilter::new(&root, &opts());
        assert!(
            !sf.accepts(&root.join("src/a.gen.ts"), false),
            "root rule ignores"
        );
        assert!(
            sf.accepts(&root.join("src/keep/a.gen.ts"), false),
            "nested negation re-includes"
        );
    }

    /// An edited `.gitignore` must change the verdict for a long-lived
    /// watcher, not serve a cached answer forever.
    #[test]
    fn edited_gitignore_invalidates_the_cache() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::create_dir_all(root.join("build_out")).expect("mkdir");
        let target = root.join("build_out/x.ts");

        let sf = ScopeFilter::new(&root, &opts());
        assert!(sf.accepts(&target, false), "no gitignore yet");

        std::fs::write(root.join(".gitignore"), b"build_out/\n").expect("write gitignore");
        // mtime resolution on some filesystems is coarse; make the change
        // unambiguous rather than racing the clock.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(root.join(".gitignore"), b"build_out/\n\n").expect("touch gitignore");

        assert!(
            !sf.accepts(&target, false),
            "gitignore edit must take effect"
        );
    }

    /// Opt-ins reach the shared filter, so `--include-vendored` /
    /// `--include-fixtures` behave the same on the incremental path.
    #[test]
    fn opt_ins_widen_the_shared_filter() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        std::fs::create_dir_all(root.join("vendor/dep")).expect("mkdir");
        std::fs::create_dir_all(root.join("examples")).expect("mkdir");

        let wide = WalkOptions {
            include_vendored: true,
            include_fixtures: true,
            ..opts()
        };
        let sf = ScopeFilter::new(&root, &wide);
        assert!(sf.accepts(&root.join("vendor/dep/v.ts"), false));
        assert!(sf.accepts(&root.join("examples/demo.ts"), false));
    }

    /// `require_git` parity: OUTSIDE a git repo the full walk ignores
    /// `.gitignore` entirely, so this filter must too. Getting this wrong
    /// makes the incremental path STRICTER than the walk, which silently drops
    /// real source instead of adding junk — the same class of bug, inverted.
    #[test]
    fn gitignore_is_inert_outside_a_git_repo() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        std::fs::write(root.join(".gitignore"), b"out/\n").expect("write gitignore");
        std::fs::create_dir_all(root.join("out")).expect("mkdir");

        let sf = ScopeFilter::new(&root, &opts());
        assert!(
            sf.accepts(&root.join("out/bundle.ts"), false),
            "no .git => .gitignore does not apply, matching WalkBuilder::require_git(true)"
        );

        // A plain `.ignore` file is NOT git-gated and still applies.
        std::fs::write(root.join(".ignore"), b"out/\n").expect("write .ignore");
        let sf2 = ScopeFilter::new(&root, &opts());
        assert!(!sf2.accepts(&root.join("out/bundle.ts"), false));
    }

    /// A gitignore WHITELIST re-includes a hidden path, and this filter must
    /// agree. Verified against the real walk: a repo with `!.env.ts` and
    /// `!.hidden/` has `walker::discover` return both. Checking `hidden` before
    /// the ignore verdict made this filter stricter than the walk and would
    /// have silently dropped whitelisted source from the incremental path.
    #[test]
    fn gitignore_whitelist_beats_the_hidden_rule() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().canonicalize().expect("canonicalize");
        make_repo(&root);
        std::fs::write(root.join(".gitignore"), b"!.env.ts\n!.hidden/\n").expect("write gitignore");
        std::fs::create_dir_all(root.join(".hidden")).expect("mkdir");

        let sf = ScopeFilter::new(&root, &opts());
        assert!(
            sf.accepts(&root.join(".env.ts"), false),
            "whitelisted dotfile"
        );
        assert!(
            sf.accepts(&root.join(".hidden/h.ts"), false),
            "file under a whitelisted hidden dir"
        );
        // A hidden path with NO whitelist is still out of scope.
        assert!(!sf.accepts(&root.join(".svelte-kit/gen.ts"), false));
        // And a whitelist cannot drag a hard-pruned dir back in: that prune
        // comes from filter_entry, which the walk applies unconditionally.
        std::fs::write(root.join(".gitignore"), b"!node_modules/\n").expect("rewrite gitignore");
        let sf2 = ScopeFilter::new(&root, &opts());
        assert!(!sf2.accepts(&root.join("node_modules/p/i.ts"), false));
    }

    /// `.git/info/exclude` is resolved from the REPO root, which may be ABOVE
    /// the walk root when only a subdirectory is being ingested.
    #[test]
    fn git_info_exclude_is_read_from_the_repo_root_not_the_walk_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().canonicalize().expect("canonicalize");
        make_repo(&repo);
        std::fs::create_dir_all(repo.join(".git/info")).expect("mkdir info");
        std::fs::write(repo.join(".git/info/exclude"), b"secret.ts\n").expect("write exclude");
        let sub = repo.join("packages/app");
        std::fs::create_dir_all(&sub).expect("mkdir sub");

        // Walk root is the SUBDIRECTORY; the exclude file lives two levels up.
        let sf = ScopeFilter::new(&sub, &opts());
        assert!(!sf.accepts(&sub.join("secret.ts"), false));
        assert!(sf.accepts(&sub.join("ok.ts"), false));
    }
}
