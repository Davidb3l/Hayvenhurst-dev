//! CRDT wire serializer. ARCHITECTURE.md §13.
//!
//! Two consumers:
//!   1. Bun FFI (preferred path) — see `ffi.rs`.
//!   2. The `hayven-native serialize` CLI (subprocess fallback when the
//!      cdylib is not loadable). Reads JSON on stdin, writes binary or
//!      JSON on stdout depending on the subcommand.

use std::io::{Read, Write};

pub mod ffi;
pub mod wire;

pub use ffi::{
    hayven_crdt_abi_major, hayven_crdt_decode_batch, hayven_crdt_decode_segment,
    hayven_crdt_encode_batch, hayven_crdt_free,
};
pub use wire::{decode_batch, decode_segment, encode_batch, HlcWire, OpRecord, WireError};

use crate::version_record;

const EXIT_OK: i32 = 0;
const EXIT_FATAL: i32 = 1;
const EXIT_BAD_USAGE: i32 = 2;

/// CLI dispatch. `subcmd` is the user-supplied token from `hayven-native
/// serialize <subcmd>`. Recognized values:
///   `encode`         — read JSON ops on stdin, write one binary envelope on stdout.
///   `decode`         — read one binary envelope on stdin, write JSON ops on stdout.
///   `decode-segment` — read a whole length-prefixed §14.2 segment on stdin
///                      (a concatenation of framed §13 batches), decode every
///                      batch, write the flattened JSON op list on stdout in
///                      ONE shot. Lets the daemon spend one subprocess spawn
///                      per segment instead of one per batch (BL-11).
///
/// §16.4 handshake: emit the `version` NDJSON record on stderr (not
/// stdout) because stdout is reserved for the binary or JSON payload.
/// The daemon's subprocess fallback path (§13.5) parses stderr line-by-
/// line and ignores non-NDJSON noise, so this is safe.
pub fn run(subcmd: Option<String>) -> i32 {
    emit_version_on_stderr();
    let action = subcmd.as_deref().unwrap_or("");
    match action {
        "encode" => run_encode(),
        "decode" => run_decode(),
        "decode-segment" => run_decode_segment(),
        other => {
            eprintln!(
                "hayven-native serialize: unknown subcommand {other:?}; expected encode|decode|decode-segment"
            );
            EXIT_BAD_USAGE
        }
    }
}

fn emit_version_on_stderr() {
    if let Ok(mut buf) = serde_json::to_vec(&version_record()) {
        buf.push(b'\n');
        let _ = std::io::stderr().write_all(&buf);
    }
}

fn run_encode() -> i32 {
    let mut input = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut input) {
        eprintln!("hayven-native serialize encode: read stdin failed: {e}");
        return EXIT_FATAL;
    }
    let ops: Vec<OpRecord> = match serde_json::from_slice(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("hayven-native serialize encode: bad JSON: {e}");
            return EXIT_BAD_USAGE;
        }
    };
    let bytes = match encode_batch(&ops) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("hayven-native serialize encode: {e}");
            return EXIT_FATAL;
        }
    };
    if let Err(e) = std::io::stdout().write_all(&bytes) {
        eprintln!("hayven-native serialize encode: write stdout failed: {e}");
        return EXIT_FATAL;
    }
    EXIT_OK
}

fn run_decode() -> i32 {
    let mut input = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut input) {
        eprintln!("hayven-native serialize decode: read stdin failed: {e}");
        return EXIT_FATAL;
    }
    let ops = match decode_batch(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("hayven-native serialize decode: {e}");
            return EXIT_FATAL;
        }
    };
    let json = match serde_json::to_vec(&ops) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("hayven-native serialize decode: {e}");
            return EXIT_FATAL;
        }
    };
    if let Err(e) = std::io::stdout().write_all(&json) {
        eprintln!("hayven-native serialize decode: write stdout failed: {e}");
        return EXIT_FATAL;
    }
    EXIT_OK
}

/// BL-11: decode a whole §14.2 segment (a concatenation of length-prefixed
/// §13 batches) read from stdin, and write every op as one JSON array on
/// stdout. The daemon's `merkle.ts` hot path previously spawned this binary
/// once per batch; with this subcommand it spawns once per segment.
///
/// The output shape is identical to `decode` (a flat `[OpRecord]` JSON
/// array) — it is simply the concatenation, in file order, of what
/// repeated `decode` calls over each framed batch would have produced. A
/// torn trailing batch is tolerated (stops cleanly), matching the daemon's
/// `OpLog.hydrate` / `segmentCompositeKeys` readers; a cleanly-framed but
/// byte-corrupt batch is a hard error.
fn run_decode_segment() -> i32 {
    let mut input = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut input) {
        eprintln!("hayven-native serialize decode-segment: read stdin failed: {e}");
        return EXIT_FATAL;
    }
    let ops = match decode_segment(&input) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("hayven-native serialize decode-segment: {e}");
            return EXIT_FATAL;
        }
    };
    let json = match serde_json::to_vec(&ops) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("hayven-native serialize decode-segment: {e}");
            return EXIT_FATAL;
        }
    };
    if let Err(e) = std::io::stdout().write_all(&json) {
        eprintln!("hayven-native serialize decode-segment: write stdout failed: {e}");
        return EXIT_FATAL;
    }
    EXIT_OK
}
