# hayven-native

Native performance companion for the Hayvenhurst daemon. Single binary
crate, three responsibilities:

| Module      | Status (week 1) | Eventual job                                       |
|-------------|-----------------|----------------------------------------------------|
| `parse`     | implemented     | Tree-sitter ingestion, parallelized with rayon     |
| `watch`     | stub (exit 64)  | OS-native file watcher (inotify/FSEvents/RDCW)     |
| `serialize` | stub (exit 64)  | CRDT wire encoder/decoder                          |

The daemon is the only intended caller. The protocol is NDJSON on
stdout — one JSON record per line, UTF-8, internally-tagged variants
defined in [`src/proto.rs`](src/proto.rs).

## Build

```sh
cargo build --release
```

Produces `target/release/hayven-native`. The binary has no runtime
dependencies on the host.

## Test

```sh
cargo test
cargo clippy -- -D warnings
cargo fmt --check
```

## Run

```sh
./target/release/hayven-native --version
./target/release/hayven-native doctor
./target/release/hayven-native parse --root /path/to/repo --langs python,typescript --jobs 8
```

The `parse` subcommand emits one `{"type":"start", ...}` record, then a
stream of `node`, `edge`, `progress`, and `warn` records, then a final
`done` record. Non-zero exit indicates a `{"type":"fatal", ...}` record
was written before the process exited.

## Supported languages

Python, TypeScript, TSX, JavaScript, Rust, Go. Bundled at compile time
via the respective `tree-sitter-*` crates. Adding a language requires
adding the crate, a `.scm` query file under
[`src/parse/queries/`](src/parse/queries/), and a `Language` variant.
