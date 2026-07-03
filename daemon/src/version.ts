/** Daemon + CLI version. Kept in its own module to avoid circular imports. */
export const VERSION = "0.0.5";

/**
 * Major version of `hayven-native` the daemon expects to talk to.
 *
 * ARCHITECTURE.md §16.4 (Q5 resolved): every native subprocess invocation
 * emits a `version` NDJSON record as its first line on stdout. The daemon
 * refuses to proceed if the major differs from this constant. Mismatched
 * minors are tolerated and logged at debug level — minor bumps are the
 * tool we use for additive, backwards-compatible record fields.
 *
 * Bump this constant in the same commit that introduces an incompatible
 * native protocol change, and only then.
 */
export const EXPECTED_NATIVE_MAJOR = 0;

/**
 * NDJSON protocol-shape version. Mirrors `PROTOCOL_VERSION` in
 * `native/src/lib.rs`. Locked at 2 by ARCHITECTURE.md §16.2.
 */
export const EXPECTED_NATIVE_PROTOCOL = 2;
