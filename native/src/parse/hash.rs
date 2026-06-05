//! Blake3 AST hashing.
//!
//! We hash the raw source bytes of a node's span rather than a serialized
//! AST. That keeps hashing cheap (a single linear pass per node) while
//! still giving the daemon a stable identifier that changes any time
//! the textual definition of an entity changes. Reformatting will
//! produce a new hash — that is the intended behavior; the daemon
//! decides whether to re-summarize.

/// Hex-encoded Blake3 digest of `bytes`. No prefix, lowercase.
pub fn hash_span(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
