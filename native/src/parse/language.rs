//! Language detection and the per-language Tree-sitter binding glue.
//!
//! The set of languages is intentionally closed at compile time — each
//! one drags in a generated C parser, and we want to keep release
//! binary size under 25 MB. Adding a language is a deliberate change.

use std::path::Path;

/// All languages `hayven-native` knows how to parse. Order is not
/// significant; the discriminants are arbitrary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    Python,
    TypeScript,
    Tsx,
    JavaScript,
    Rust,
    Go,
    /// Astro single-file components. There is NO Astro tree-sitter grammar
    /// dependency: we parse only the `---…---` frontmatter block (which is
    /// TypeScript — imports, `Props`, server logic) using the existing
    /// TypeScript grammar, and skip the HTML+JSX template below it. See
    /// `extract.rs::astro_frontmatter` and TREE_SITTER_NOTES.md "Astro".
    Astro,
}

impl Language {
    /// Detect a language from a path's extension. Returns `None` for
    /// any file we don't intend to parse — callers should skip them
    /// before doing real work.
    pub fn from_path(path: &Path) -> Option<Self> {
        let ext = path
            .extension()
            .and_then(|s| s.to_str())?
            .to_ascii_lowercase();
        Self::from_extension(&ext)
    }

    /// Lowercase extension (without the leading dot) → `Language`.
    /// Centralized so the walker filter and the parser stay in sync.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "py" => Some(Self::Python),
            "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            "rs" => Some(Self::Rust),
            "go" => Some(Self::Go),
            "astro" => Some(Self::Astro),
            _ => None,
        }
    }

    /// Wire identifier — appears in NDJSON `language` fields. Stable;
    /// changing these is a protocol break.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Python => "python",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::JavaScript => "javascript",
            Self::Rust => "rust",
            Self::Go => "go",
            Self::Astro => "astro",
        }
    }

    /// User-supplied `--langs` token → `Language`. Accepts the wire
    /// names plus a few common aliases.
    pub fn parse_user_token(token: &str) -> Option<Self> {
        match token.trim().to_ascii_lowercase().as_str() {
            "python" | "py" => Some(Self::Python),
            "typescript" | "ts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "javascript" | "js" => Some(Self::JavaScript),
            "rust" | "rs" => Some(Self::Rust),
            "go" | "golang" => Some(Self::Go),
            "astro" => Some(Self::Astro),
            _ => None,
        }
    }

    /// Underlying Tree-sitter `LANGUAGE` constant for this language.
    /// Calls into the language crate's generated C bindings.
    pub fn tree_sitter_language(self) -> tree_sitter::Language {
        match self {
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            // The Astro frontmatter is plain TypeScript; we reuse the TS
            // grammar (and the `typescript.scm` query) rather than add an
            // Astro grammar dependency. The template below the frontmatter
            // is sliced off before parsing — see `extract.rs`.
            Self::Astro => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        }
    }

    /// Separator used when constructing `qualified_name`. Picks the
    /// idiom of the language so the daemon's display stays natural.
    pub fn qualified_separator(self) -> &'static str {
        match self {
            Self::Rust => "::",
            _ => ".",
        }
    }

    /// All languages, in a stable order suitable for `--help` output.
    pub fn all() -> &'static [Self] {
        &[
            Self::Python,
            Self::TypeScript,
            Self::Tsx,
            Self::JavaScript,
            Self::Rust,
            Self::Go,
            Self::Astro,
        ]
    }
}
