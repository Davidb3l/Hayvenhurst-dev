//! NDJSON wire records emitted on stdout.
//!
//! Every record is a single JSON object on its own line, UTF-8 encoded.
//! The records form a strict per-run sequence:
//!
//! 1. Exactly one `Start` record.
//! 2. Zero or more interleaved `Node`, `Edge`, `Progress`, and `Warn`
//!    records. All `Node` and `Edge` records for a single file are
//!    serialized together (nodes precede edges within that file).
//! 3. Exactly one `Done` record OR exactly one `Fatal` record at the end.
//!
//! The daemon parses this stream line-by-line. To guarantee line atomicity
//! across `rayon` worker threads, each record is fully serialized on its
//! producing thread and then handed to a single writer task via an mpsc
//! channel (see `parse::mod`).

use serde::{Deserialize, Serialize};

/// Internally tagged enum: `serde_json` produces `{"type":"...", ...}` on
/// the wire. `rename_all = "snake_case"` matches the spec in the PRD.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Record {
    /// ARCHITECTURE.md §16.4 version handshake. MUST be the first NDJSON
    /// record on every long-lived subprocess invocation (parse, watch).
    /// The daemon refuses to proceed if `major` differs from its own
    /// expectation.
    Version {
        major: u32,
        minor: u32,
        patch: u32,
        /// Protocol-level version distinct from the crate semver. Bumped
        /// when the NDJSON record shape changes incompatibly. `2` is the
        /// shape locked in by ARCHITECTURE.md §16.2.
        protocol: u32,
    },

    /// Emitted exactly once at the start of a run.
    Start {
        /// Total number of candidate files discovered by the walker.
        files_total: usize,
        /// `hayven-native` crate version string.
        version: String,
    },

    /// A code-entity node extracted from a single file.
    Node {
        /// Path relative to the parse root (forward-slash separated).
        file: String,
        /// The bare identifier (function name, class name, etc.).
        name: String,
        /// Coarse kind: `function`, `method`, `class`, `struct`, `enum`,
        /// `trait`, `type`. Daemons may add more — be liberal in what
        /// they accept.
        kind: String,
        /// Fully qualified name using the language's natural separator
        /// (`.` for Python/JS/TS, `::` for Rust).
        qualified_name: String,
        /// Language identifier — see `parse::language::Language::as_str`.
        language: String,
        /// `[start_line, end_line]`, 1-indexed inclusive.
        range: [usize; 2],
        /// Blake3 hex digest of the raw source bytes of this node's span.
        /// No prefix — the daemon adds one if it wants to.
        ast_hash: String,
    },

    /// The real, tree-sitter-derived contract SIGNATURE of one definition.
    ///
    /// OPT-IN: emitted only when `parse --signatures` is set, and only for
    /// callable/typed definitions (function, method, and — where the language
    /// allows a constructor-like contract — class/struct). Adding this record is
    /// strictly additive: the daemon's existing line-based parse stream (Node /
    /// Edge / Progress / Warn / Done) is unchanged, and a reader that does not
    /// recognize `type:"signature"` simply ignores the line.
    ///
    /// Every field is BEST-EFFORT per language and derived from the AST, not a
    /// line regex:
    ///   - `arity` counts declared formal parameters (Python `self`/`cls` and the
    ///     Rust `self` receiver are excluded, matching what a cross-file caller
    ///     actually passes).
    ///   - `params` are the per-parameter type annotations when the language
    ///     carries them (`name: T` → `T`, Rust/Go positional types, etc.), or the
    ///     parameter's own text when it has no annotation. The element ORDER is
    ///     significant (positional contract).
    ///   - `return_type` is the declared return-type text, or `null` when the
    ///     language/decl has none (e.g. a JS function, a Python def with no `->`).
    ///   - `visibility` is the coarse cross-file-reachability class:
    ///     `public` | `private` | `unknown` (see the per-language notes in
    ///     `native/docs/TREE_SITTER_NOTES.md`). `unknown` is treated by callers as
    ///     "could be public" so we never UNDER-report a breakable contract.
    Signature {
        /// Source file (relative to parse root, forward-slash separated).
        file: String,
        /// Bare identifier of the definition this signature belongs to.
        name: String,
        /// Fully qualified name (same value as the matching `Node` record), so
        /// the daemon can join a signature to its node unambiguously.
        qualified_name: String,
        /// Coarse kind: `function` | `method` | `class` (matches the `Node`).
        kind: String,
        /// Language identifier — see `parse::language::Language::as_str`.
        language: String,
        /// Declared formal-parameter count (receiver excluded).
        arity: usize,
        /// Per-parameter type (or raw param text when unannotated), in order.
        params: Vec<String>,
        /// Declared return type text, or `null` when the decl carries none.
        return_type: Option<String>,
        /// `public` | `private` | `unknown` cross-file reachability class.
        visibility: String,
    },

    /// A directed relationship between two code entities.
    Edge {
        /// Source file (relative to parse root).
        src_file: String,
        /// Source entity name (bare identifier). For top-level call
        /// sites that are not inside a definition the value is the
        /// file path; the daemon resolves these to module-level edges.
        src_name: String,
        /// Destination entity name as written in source — daemon
        /// performs final resolution against its own index.
        dst_name: String,
        /// Edge category. Today: `static_call` or `import`.
        kind: String,
        /// OPTIONAL. For a member-access `static_call` (`recv.method(...)`),
        /// the receiver identifier text (`recv`) so the daemon can resolve
        /// the call against the binding `recv` refers to (e.g. an imported
        /// `local` name). Absent for bare-identifier calls (`foo()`) and for
        /// every non-call edge. Skipped from the wire when `None` so legacy
        /// readers and existing records are byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receiver: Option<String>,
        /// OPTIONAL. For a member-access `static_call` with a MULTI-segment
        /// receiver chain (`api.client.search(...)`), the full segment list from
        /// the chain ROOT to the immediate object — e.g. `["api","client"]` for
        /// `api.client.search()`. Lets the daemon bind the chain ROOT to an
        /// import `local` and walk the intermediate segments to the member.
        /// Absent for single-segment receivers (`api.search()` carries only
        /// `receiver:"api"`, no chain) so the common case stays byte-identical;
        /// also absent for every non-member-chain edge. A legacy reader that
        /// ignores this field still resolves the immediate-object `receiver`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        receiver_chain: Option<Vec<String>>,
        /// OPTIONAL. For an `import` edge, the local binding name(s) the
        /// import introduces into the importing module's scope
        /// (`import { api, qk } from "x"` → `["api","qk"]`; the LOCAL alias
        /// for `import { a as b }` → `["b"]`; `import Foo` → `["Foo"]`;
        /// `import * as ns` → `["ns"]`). Absent for side-effect imports
        /// (`import "x"`) and for every non-import edge. Skipped from the
        /// wire when `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        local: Option<Vec<String>>,
        /// OPTIONAL. For an `import` edge that contains ALIASED bindings
        /// (`import { checkAccess as ca } from "x"`, `import { a as b, c }`),
        /// the `{local, imported}` pairs whose `local` differs from the
        /// originally-exported `imported` name. The daemon's resolver maps a
        /// call to the local alias (`ca()`) back to the real exported symbol
        /// (`checkAccess`) so `<module>/checkAccess` resolves. ONLY genuine
        /// aliases are listed (where `local != imported`); a non-aliased
        /// binding (`import { foo }`, default `import Foo`, namespace
        /// `import * as ns`) is already recoverable from `local` alone and is
        /// NOT duplicated here. Absent when an import introduces no aliases,
        /// so legacy payloads and the common case stay byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        import_aliases: Option<Vec<ImportAlias>>,
        /// OPTIONAL. For a `static_call` edge, the 1-based LINE of the call
        /// site in `src_file` — `cap.node.start_position().row + 1` (plus the
        /// Astro frontmatter `line_offset` so it maps to the real file), where
        /// `cap.node` is the SAME call/callee node from which `dst_name` was
        /// derived. One edge record == one call occurrence, and this is that
        /// occurrence's position, letting the daemon offer line-precise
        /// `refs --sites`. `None` (omitted from the wire) for `import` edges,
        /// Astro template-component usages, and any call whose position is
        /// unknown — a record without it means "no site info." Paired with
        /// `col`; both come from the same node's `start_position()`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<usize>,
        /// OPTIONAL. For a `static_call` edge, the 1-based COLUMN of the call
        /// site in `src_file` — `cap.node.start_position().column + 1` (same
        /// call/callee `cap.node` as `line`/`dst_name`). `None` (omitted from
        /// the wire) for `import` edges and Astro template-component usages, so
        /// legacy payloads and non-call edges stay byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        col: Option<usize>,
    },

    /// Periodic progress heartbeat. Emitted every N files; the daemon
    /// uses these to drive a UI progress bar.
    Progress { files_done: usize },

    /// Non-fatal per-file warning. Parsing continues for other files.
    Warn { file: String, message: String },

    /// Emitted exactly once at the end of a successful run.
    Done {
        files_done: usize,
        nodes: usize,
        edges: usize,
        elapsed_ms: u64,
    },

    /// Emitted exactly once at the end of a failed run. The process
    /// exits non-zero immediately after writing this record.
    Fatal { message: String },
}

/// A single aliased import binding: the LOCAL name introduced into the
/// importing module's scope and the ORIGINALLY-exported `imported` name it
/// refers to. Emitted only for genuine aliases (`import { a as b }` →
/// `{ local: "b", imported: "a" }`); non-aliased bindings are omitted (see
/// `Record::Edge.import_aliases`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportAlias {
    pub local: String,
    pub imported: String,
}
