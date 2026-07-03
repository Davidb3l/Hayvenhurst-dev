//! `hayven-native` — native performance companion for the Hayvenhurst daemon.
//!
//! Library exports are kept minimal: they exist so integration tests can
//! reach into the proto types and parse helpers without going through the
//! binary. The supported public surface for callers (the daemon) is the
//! NDJSON stdout protocol emitted by the binary, not this Rust API.

pub mod infer;
pub mod parse;
pub mod proto;
pub mod serialize;
pub mod watch;

/// Crate version string sourced from `Cargo.toml`. Embedded into protocol
/// records so the daemon can detect mismatches with its own bundled
/// expectations.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// NDJSON protocol version. Distinct from the crate semver — bumped only
/// when the record shape itself changes incompatibly. Locked at 2 by
/// ARCHITECTURE.md §16.2.
pub const PROTOCOL_VERSION: u32 = 2;

/// Build the §16.4 version handshake record from the compile-time crate
/// version. Returns the `Record::Version` variant; callers serialize it
/// like any other NDJSON record.
pub fn version_record() -> proto::Record {
    let (major, minor, patch) = parse_semver(VERSION);
    proto::Record::Version {
        major,
        minor,
        patch,
        protocol: PROTOCOL_VERSION,
    }
}

/// Parse `"X.Y.Z"` into three `u32`s. Anything malformed maps to `(0, 0, 0)`
/// so a broken Cargo.toml does not panic the binary; the daemon will catch
/// the zero-major mismatch in its own check.
pub(crate) fn parse_semver(s: &str) -> (u32, u32, u32) {
    let mut parts = s
        .split('.')
        .map(|p| p.split(['-', '+']).next().unwrap_or(p));
    let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}
