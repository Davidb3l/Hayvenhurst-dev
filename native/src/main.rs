//! `hayven-native` binary entry point. Parses CLI args and dispatches
//! to the appropriate subcommand module.
//!
//! Exit codes:
//!   0  — success
//!   1  — fatal error (a `Fatal` NDJSON record was written first)
//!   64 — subcommand not yet implemented (stubs)
//!   2  — clap argument-parsing error (clap's own default)

use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use clap::{Parser, Subcommand};

use hayven_native::infer::{self, InferOptions, DEFAULT_MAX_TOKENS, DEFAULT_TEMP};
use hayven_native::parse::language::Language;
use hayven_native::parse::ParseOptions;
use hayven_native::proto::Record;
use hayven_native::{parse, serialize, watch, VERSION};

/// Native performance companion for the Hayvenhurst daemon. Wraps
/// Tree-sitter parsing, OS-level file watching, and CRDT wire
/// serialization. Talks NDJSON on stdout.
#[derive(Debug, Parser)]
#[command(name = "hayven-native", version = VERSION, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Walk a project root and emit NDJSON `Node`/`Edge` records on stdout.
    Parse {
        /// Project root to walk.
        #[arg(long)]
        root: PathBuf,

        /// Comma-separated list of languages to include. Default: all
        /// supported languages. Accepts names or short aliases:
        /// python, py, typescript, ts, tsx, javascript, js, rust, rs,
        /// go, golang.
        #[arg(long, value_delimiter = ',')]
        langs: Vec<String>,

        /// Worker thread count. Default: one per logical CPU.
        #[arg(long)]
        jobs: Option<usize>,

        /// Skip files larger than this many bytes. Default: 2 MiB.
        #[arg(long, default_value_t = 2 * 1024 * 1024)]
        max_file_size: u64,

        /// Read the incremental file list from stdin instead of walking the
        /// repo. Each line is one repo-relative file path (newline-delimited);
        /// a trailing '\r' and surrounding whitespace are trimmed and empty
        /// lines are skipped. When set, the gitignore-aware walker is bypassed
        /// and only these files are parsed, with the same semantics as the
        /// walker (unknown extensions / missing / oversized files are dropped;
        /// root containment is enforced). Used by the watcher's debounced
        /// re-ingest path (ARCHITECTURE.md §16.3).
        ///
        /// Newline-delimited stdin (not a comma-delimited CLI arg) is the
        /// transport precisely so paths may contain commas — a path may
        /// contain any byte except '\n'.
        #[arg(long)]
        files_stdin: bool,

        /// ADDITIVE opt-in: also emit one `signature` NDJSON record per
        /// callable/typed definition, carrying the real tree-sitter-derived
        /// contract (arity, per-param types, return type, visibility). The
        /// existing node/edge stream is UNCHANGED — signature lines are extra
        /// interleaved records that legacy readers ignore. Consumed by the
        /// daemon's deterministic contract-diff conflict oracle.
        #[arg(long)]
        signatures: bool,
    },

    /// Watch a project root for changes. Streams §16.2 NDJSON change
    /// events on stdout for the daemon's incremental re-ingest path.
    Watch {
        /// Project root to watch (absolute path).
        #[arg(long)]
        root: PathBuf,

        /// Accepted for forward-compat with §16.1; debouncing actually
        /// happens on the daemon side because that's where the ingest
        /// context lives. Honored as a no-op today.
        #[arg(long)]
        debounce_ms: Option<u64>,

        /// Accepted for forward-compat with §16.1. The watcher's CPU
        /// budget is enforced by the OS event source, not a rate cap;
        /// honored as a no-op today.
        #[arg(long)]
        max_event_rate: Option<u64>,
    },

    /// Encode/decode CRDT wire records (the daemon's subprocess transport
    /// when the Bun FFI path is inactive). Subcommands: `encode` (JSON op
    /// batch → §13 binary wire frame), `decode` (inverse), and the BL-11
    /// `decode-segment` (many length-prefixed frames in, one NDJSON
    /// `Decoded` record per frame — a whole oplog segment in one spawn).
    Serialize {
        /// Subcommand passed through to the serialize router:
        /// `encode` | `decode` | `decode-segment`.
        subcmd: Option<String>,
    },

    /// Generate a completion from a local quantized GGUF Gemma model
    /// (candle, pure Rust). ARCHITECTURE.md §18. The prompt is read from
    /// stdin to EOF; the completion is written to stdout (UTF-8 only);
    /// diagnostics go to stderr.
    Infer {
        /// Model DIRECTORY (not a file). Loads `model.gguf` and
        /// `tokenizer.json` from it.
        #[arg(long)]
        model: PathBuf,

        /// Maximum number of new tokens to generate.
        #[arg(long, default_value_t = DEFAULT_MAX_TOKENS)]
        max_tokens: usize,

        /// Sampling temperature. `0.0` ⇒ greedy/deterministic decoding.
        #[arg(long, default_value_t = DEFAULT_TEMP)]
        temp: f64,
    },

    /// Print diagnostics: version, supported languages, hardware.
    Doctor,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Parse {
            root,
            langs,
            jobs,
            max_file_size,
            files_stdin,
            signatures,
        } => match run_parse(root, langs, jobs, max_file_size, files_stdin, signatures) {
            Ok(code) => ExitCode::from(code as u8),
            Err(err) => {
                // Fatal: write a single Fatal record on stdout, then
                // exit non-zero. The daemon parses this and surfaces
                // it to the user.
                emit_fatal(format!("{:#}", err));
                ExitCode::from(1)
            }
        },
        Cmd::Watch {
            root,
            debounce_ms: _,
            max_event_rate: _,
        } => ExitCode::from(watch::run(root) as u8),
        Cmd::Serialize { subcmd } => ExitCode::from(serialize::run(subcmd) as u8),
        Cmd::Infer {
            model,
            max_tokens,
            temp,
        } => ExitCode::from(infer::run(InferOptions {
            model_dir: model,
            max_tokens,
            temp,
        }) as u8),
        Cmd::Doctor => {
            run_doctor();
            ExitCode::from(0)
        }
    }
}

/// Convert raw CLI args into `ParseOptions` and run the pipeline.
/// Anything that fails before we start emitting records (unknown
/// language token, missing root) is surfaced as a `Fatal` record.
fn run_parse(
    root: PathBuf,
    langs: Vec<String>,
    jobs: Option<usize>,
    max_file_size: u64,
    files_stdin: bool,
    emit_signatures: bool,
) -> anyhow::Result<i32> {
    let mut languages = HashSet::new();
    for token in &langs {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        match Language::parse_user_token(token) {
            Some(lang) => {
                languages.insert(lang);
            }
            None => {
                anyhow::bail!("unknown --langs value: {token:?}");
            }
        }
    }

    // Incremental ingest transport (BL-2): the daemon hands us the file list
    // newline-delimited on stdin rather than as a comma-delimited CLI arg, so
    // that repo-relative paths containing a comma survive intact.
    let explicit_files = if files_stdin {
        let mut raw = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw)
            .context("read --files-stdin list from stdin")?;
        let files = parse_files_stdin(&raw);
        if files.is_empty() {
            None
        } else {
            Some(files)
        }
    } else {
        None
    };

    parse::run(ParseOptions {
        root,
        languages,
        jobs,
        max_file_size,
        explicit_files,
        emit_signatures,
    })
}

/// Parse the newline-delimited `--files-stdin` payload into one repo-relative
/// path per line. Splits on '\n', trims a trailing '\r' (CRLF tolerance) plus
/// surrounding whitespace, and drops empty lines. A path may contain any byte
/// except '\n' — commas included.
fn parse_files_stdin(raw: &str) -> Vec<String> {
    raw.split('\n')
        .map(|line| line.trim_end_matches('\r').trim())
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// Write a single `Fatal` NDJSON record to stdout. Best-effort: if
/// even this fails (e.g. broken pipe) we drop it and rely on the
/// non-zero exit code.
fn emit_fatal(message: String) {
    let rec = Record::Fatal { message };
    if let Ok(mut buf) = serde_json::to_vec(&rec) {
        buf.push(b'\n');
        let _ = std::io::stdout().write_all(&buf);
        let _ = std::io::stdout().flush();
    }
}

/// `doctor` output. Plain text on stdout — this subcommand is for
/// humans, not the daemon's NDJSON parser.
fn run_doctor() {
    println!("hayven-native {VERSION}");
    println!("supported languages:");
    for lang in Language::all() {
        println!("  - {}", lang.as_str());
    }
    println!("hardware:");
    println!("  logical cpus: {}", num_cpus::get());
    println!("  physical cpus: {}", num_cpus::get_physical());
    println!("  target triple: {}", std::env::consts::ARCH);
    println!("  os: {}", std::env::consts::OS);
}

#[cfg(test)]
mod tests {
    use super::parse_files_stdin;

    /// BL-2: the incremental file list is newline-delimited on stdin. Each
    /// line is one path; trailing '\r' and surrounding whitespace are trimmed
    /// and blank lines are dropped.
    #[test]
    fn files_stdin_splits_on_newline_and_trims() {
        let raw = "a.py\n  b/c.ts  \r\n\n\td.rs\n";
        assert_eq!(
            parse_files_stdin(raw),
            vec!["a.py".to_string(), "b/c.ts".to_string(), "d.rs".to_string()],
        );
    }

    /// BL-2 regression: a path containing a comma must survive as ONE path,
    /// not be split into two tokens the way the old comma-delimited `--files`
    /// arg did. This is the whole reason the transport moved to stdin.
    #[test]
    fn files_stdin_preserves_commas_in_paths() {
        let raw = "a,b.py\nsub/has,comma,too.ts\n";
        assert_eq!(
            parse_files_stdin(raw),
            vec!["a,b.py".to_string(), "sub/has,comma,too.ts".to_string()],
        );
    }

    /// Empty / whitespace-only input yields no paths (caller maps this to
    /// `explicit_files = None`).
    #[test]
    fn files_stdin_empty_yields_nothing() {
        assert!(parse_files_stdin("").is_empty());
        assert!(parse_files_stdin("\n  \n\r\n").is_empty());
    }
}
