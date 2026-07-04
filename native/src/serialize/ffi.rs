//! C ABI for the CRDT wire encoder/decoder. ARCHITECTURE.md §13.5.
//!
//! Exported symbols:
//!
//!   hayven_crdt_encode_batch(in_ptr, in_len, out_ptr_out, out_len_out) -> i32
//!   hayven_crdt_decode_batch(in_ptr, in_len, out_ptr_out, out_len_out) -> i32
//!   hayven_crdt_decode_segment(in_ptr, in_len, out_ptr_out, out_len_out) -> i32
//!   hayven_crdt_free(ptr, len)
//!   hayven_crdt_abi_major() -> u32
//!
//! `hayven_crdt_decode_segment` is the FFI twin of the `serialize
//! decode-segment` subcommand (BL-11): one call decodes a whole §14.2 segment
//! (a concatenation of length-prefixed §13 batches) into a flat JSON op array,
//! with the same torn-trailing-batch tolerance. It exists so the Bun FFI
//! transport can serve `decodeSegment` without falling back to a subprocess.
//!
//! `hayven_crdt_abi_major` returns the crate major version as a `u32`. The
//! daemon's FFI bridge calls it once at dlopen time and refuses a cdylib whose
//! major differs from `EXPECTED_NATIVE_MAJOR` — the FFI-path equivalent of the
//! subprocess transport's `version` NDJSON handshake (§16.4). A mismatch makes
//! `tryOpenFfi()` return null, so the daemon silently uses the subprocess path.
//!
//! The encode/decode functions take a `(ptr, len)` JSON input (UTF-8) and
//! write a freshly-allocated `(ptr, len)` output pair into the caller-
//! provided out-pointers. Return values:
//!
//!   0 = success
//!   1 = input parse error
//!   2 = wire encode/decode error
//!
//! The caller MUST free the output buffer with `hayven_crdt_free` exactly
//! once. The format-of-the-bytes:
//!
//!   encode input  : JSON `[ OpRecord, ... ]`
//!   encode output : binary envelope (see wire.rs)
//!   decode input  : binary envelope
//!   decode output : JSON `[ OpRecord, ... ]`
//!
//! All three functions are stateless — no global mutable state on the Rust
//! side. The JS runtime can call them from any thread.

use std::os::raw::c_int;
use std::ptr;

use std::panic::{catch_unwind, AssertUnwindSafe};

use super::wire::{decode_batch, decode_segment, encode_batch, OpRecord};

const OK: c_int = 0;
const ERR_PARSE: c_int = 1;
const ERR_WIRE: c_int = 2;
/// A panic was caught at the boundary. Returned instead of unwinding across
/// the C ABI, which is undefined behavior. Should never happen in practice;
/// if it does it's a bug in the wire codec, not the caller's input.
const ERR_PANIC: c_int = 3;

/// Encode a JSON array of `OpRecord`s into the binary wire format.
///
/// On any non-OK return the out-pointers are set to `(null, 0)`, so a caller
/// may unconditionally treat `len == 0` as "nothing to free."
///
/// # Safety
///
/// - `in_ptr` must either be null or point to `in_len` consecutive,
///   initialized bytes that stay valid and unmutated for the duration of the
///   call. A null `in_ptr` returns `ERR_PARSE`. `in_len == 0` is allowed (the
///   input slice is then empty).
/// - `out_ptr_out` and `out_len_out` must each be non-null and point to a
///   writable, properly aligned `*mut u8` / `usize` respectively; passing null
///   for either returns `ERR_PARSE` and writes nothing. Their previous contents
///   are overwritten and not read.
/// - On `OK` the caller takes ownership of the `(*out_ptr_out, *out_len_out)`
///   buffer and MUST free it exactly once with `hayven_crdt_free`, passing back
///   the same pointer and length. On any non-OK return the out-pair is set to
///   `(null, 0)` and there is nothing to free.
/// - The function holds no global state and may be called concurrently from
///   multiple threads, provided each call's pointers refer to disjoint memory.
#[no_mangle]
pub unsafe extern "C" fn hayven_crdt_encode_batch(
    in_ptr: *const u8,
    in_len: usize,
    out_ptr_out: *mut *mut u8,
    out_len_out: *mut usize,
) -> c_int {
    if out_ptr_out.is_null() || out_len_out.is_null() {
        return ERR_PARSE;
    }
    // Define the output as empty up front so every error path leaves the
    // caller with (null, 0) rather than an untouched/dangling pointer.
    *out_ptr_out = ptr::null_mut();
    *out_len_out = 0;
    if in_ptr.is_null() {
        return ERR_PARSE;
    }
    let input = std::slice::from_raw_parts(in_ptr, in_len);
    catch_unwind(AssertUnwindSafe(|| {
        let ops: Vec<OpRecord> = match serde_json::from_slice(input) {
            Ok(v) => v,
            Err(_) => return ERR_PARSE,
        };
        let bytes = match encode_batch(&ops) {
            Ok(b) => b,
            Err(_) => return ERR_WIRE,
        };
        install_output(bytes, out_ptr_out, out_len_out);
        OK
    }))
    .unwrap_or(ERR_PANIC)
}

/// Decode a binary envelope into a JSON array of `OpRecord`s. Same out-pointer
/// and panic-containment contract as `hayven_crdt_encode_batch`.
///
/// # Safety
///
/// - `in_ptr` must either be null or point to `in_len` consecutive,
///   initialized bytes that stay valid and unmutated for the duration of the
///   call. A null `in_ptr` returns `ERR_PARSE`. `in_len == 0` is allowed.
/// - `out_ptr_out` and `out_len_out` must each be non-null and point to a
///   writable, properly aligned `*mut u8` / `usize`; passing null for either
///   returns `ERR_PARSE` and writes nothing. Their previous contents are
///   overwritten and not read.
/// - On `OK` the caller takes ownership of the `(*out_ptr_out, *out_len_out)`
///   buffer and MUST free it exactly once with `hayven_crdt_free`. On any
///   non-OK return the out-pair is set to `(null, 0)`.
/// - Holds no global state; safe to call concurrently across threads as long
///   as each call's pointers refer to disjoint memory.
#[no_mangle]
pub unsafe extern "C" fn hayven_crdt_decode_batch(
    in_ptr: *const u8,
    in_len: usize,
    out_ptr_out: *mut *mut u8,
    out_len_out: *mut usize,
) -> c_int {
    if out_ptr_out.is_null() || out_len_out.is_null() {
        return ERR_PARSE;
    }
    *out_ptr_out = ptr::null_mut();
    *out_len_out = 0;
    if in_ptr.is_null() {
        return ERR_PARSE;
    }
    let input = std::slice::from_raw_parts(in_ptr, in_len);
    catch_unwind(AssertUnwindSafe(|| {
        let ops = match decode_batch(input) {
            Ok(v) => v,
            Err(_) => return ERR_WIRE,
        };
        let json = match serde_json::to_vec(&ops) {
            Ok(j) => j,
            Err(_) => return ERR_WIRE,
        };
        install_output(json, out_ptr_out, out_len_out);
        OK
    }))
    .unwrap_or(ERR_PANIC)
}

/// Decode a whole §14.2 segment (a concatenation of length-prefixed §13
/// batches) into a JSON array of `OpRecord`s, flattened in file order. The FFI
/// twin of the `serialize decode-segment` subcommand (BL-11): same output shape
/// as `hayven_crdt_decode_batch`, same torn-trailing-batch tolerance, one call
/// per segment instead of one per batch.
///
/// Same out-pointer and panic-containment contract as the other two codecs: on
/// `OK` the caller owns `(*out_ptr_out, *out_len_out)` and MUST free it once
/// with `hayven_crdt_free`; on any non-OK return the out-pair is `(null, 0)`.
///
/// # Safety
///
/// - `in_ptr` must either be null or point to `in_len` consecutive,
///   initialized bytes valid and unmutated for the call. Null `in_ptr` returns
///   `ERR_PARSE`. `in_len == 0` is allowed (decodes to an empty op array).
/// - `out_ptr_out` and `out_len_out` must each be non-null and point to a
///   writable, properly aligned `*mut u8` / `usize`; null for either returns
///   `ERR_PARSE`. Their previous contents are overwritten and not read.
/// - Holds no global state; safe to call concurrently across threads as long as
///   each call's pointers refer to disjoint memory.
#[no_mangle]
pub unsafe extern "C" fn hayven_crdt_decode_segment(
    in_ptr: *const u8,
    in_len: usize,
    out_ptr_out: *mut *mut u8,
    out_len_out: *mut usize,
) -> c_int {
    if out_ptr_out.is_null() || out_len_out.is_null() {
        return ERR_PARSE;
    }
    *out_ptr_out = ptr::null_mut();
    *out_len_out = 0;
    if in_ptr.is_null() {
        return ERR_PARSE;
    }
    let input = std::slice::from_raw_parts(in_ptr, in_len);
    catch_unwind(AssertUnwindSafe(|| {
        let ops = match decode_segment(input) {
            Ok(v) => v,
            Err(_) => return ERR_WIRE,
        };
        let json = match serde_json::to_vec(&ops) {
            Ok(j) => j,
            Err(_) => return ERR_WIRE,
        };
        install_output(json, out_ptr_out, out_len_out);
        OK
    }))
    .unwrap_or(ERR_PANIC)
}

/// Free a buffer previously returned by `hayven_crdt_encode_batch`,
/// `hayven_crdt_decode_batch`, or `hayven_crdt_decode_segment`.
///
/// # Safety
///
/// - `(ptr, len)` must be exactly a pair previously written by one of the
///   encode/decode functions on an `OK` return, and must not have been freed
///   already. Reusing a pointer (double free) or passing a length that differs
///   from the one returned is undefined behavior — the buffer was allocated as
///   a boxed slice of that exact length and is reconstituted as such here.
/// - `ptr == null` or `len == 0` is a safe no-op, matching the `(null, 0)`
///   sentinel returned on the non-OK / empty-output paths.
/// - Must not be called concurrently with another free of the same buffer.
#[no_mangle]
pub unsafe extern "C" fn hayven_crdt_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let _ = Vec::from_raw_parts(ptr, len, len);
}

/// Return the crate major version as a `u32`. The daemon's FFI bridge calls
/// this once at dlopen time and refuses a cdylib whose major differs from the
/// `EXPECTED_NATIVE_MAJOR` it was built against — the FFI-path equivalent of
/// the subprocess transport's `version` NDJSON handshake (§16.4). On a
/// mismatch the bridge returns null and the daemon falls back to the
/// subprocess transport. Pure, stateless, thread-safe.
#[no_mangle]
pub extern "C" fn hayven_crdt_abi_major() -> u32 {
    let (major, _, _) = crate::parse_semver(crate::VERSION);
    major
}

unsafe fn install_output(buf: Vec<u8>, out_ptr_out: *mut *mut u8, out_len_out: *mut usize) {
    let len = buf.len();
    if len == 0 {
        *out_ptr_out = ptr::null_mut();
        *out_len_out = 0;
        std::mem::forget(buf);
        return;
    }
    let mut boxed = buf.into_boxed_slice();
    let raw = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    *out_ptr_out = raw;
    *out_len_out = len;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serialize::wire::{HlcWire, OpRecord};

    fn run_round_trip(ops: &[OpRecord]) -> Vec<OpRecord> {
        let json = serde_json::to_vec(ops).unwrap();
        let mut enc_ptr: *mut u8 = ptr::null_mut();
        let mut enc_len: usize = 0;
        unsafe {
            let rc = hayven_crdt_encode_batch(
                json.as_ptr(),
                json.len(),
                &mut enc_ptr,
                &mut enc_len,
            );
            assert_eq!(rc, OK);
        }
        let bytes = unsafe { std::slice::from_raw_parts(enc_ptr, enc_len).to_vec() };
        unsafe { hayven_crdt_free(enc_ptr, enc_len) };

        let mut dec_ptr: *mut u8 = ptr::null_mut();
        let mut dec_len: usize = 0;
        unsafe {
            let rc = hayven_crdt_decode_batch(
                bytes.as_ptr(),
                bytes.len(),
                &mut dec_ptr,
                &mut dec_len,
            );
            assert_eq!(rc, OK);
        }
        let json2 = unsafe { std::slice::from_raw_parts(dec_ptr, dec_len).to_vec() };
        unsafe { hayven_crdt_free(dec_ptr, dec_len) };
        serde_json::from_slice(&json2).unwrap()
    }

    #[test]
    fn ffi_round_trip_matches_input() {
        let ops = vec![
            OpRecord::GsetObserve {
                src: "a".into(),
                dst: "b".into(),
                ts_bucket: 0,
                observed: 1,
                weight: 100,
                hlc: HlcWire { wall_ms: 1, counter: 0 },
                writer: vec![1; 16],
            },
            OpRecord::Lww {
                entity_id: "auth/login".into(),
                content_hash: vec![2; 32],
                body: b"hello".to_vec(),
                hlc: HlcWire { wall_ms: 2, counter: 0 },
                writer: vec![1; 16],
            },
        ];
        assert_eq!(run_round_trip(&ops), ops);
    }

    #[test]
    fn ffi_decode_segment_matches_per_batch() {
        use crate::serialize::wire::encode_batch;
        // Two distinct batches framed §14.2-style (varint len prefix + bytes).
        let batch1 = vec![OpRecord::GsetObserve {
            src: "a".into(),
            dst: "b".into(),
            ts_bucket: 0,
            observed: 1,
            weight: 1,
            hlc: HlcWire { wall_ms: 1, counter: 0 },
            writer: vec![1; 16],
        }];
        let batch2 = vec![OpRecord::Lww {
            entity_id: "x".into(),
            content_hash: vec![3; 32],
            body: b"hi".to_vec(),
            hlc: HlcWire { wall_ms: 2, counter: 0 },
            writer: vec![1; 16],
        }];
        let mut segment = Vec::new();
        for b in [&batch1, &batch2] {
            let bytes = encode_batch(b).unwrap();
            // varint length prefix (small, single-byte for these sizes)
            let mut len = bytes.len();
            loop {
                let byte = (len & 0x7f) as u8;
                len >>= 7;
                if len == 0 {
                    segment.push(byte);
                    break;
                }
                segment.push(byte | 0x80);
            }
            segment.extend_from_slice(&bytes);
        }

        let mut p: *mut u8 = ptr::null_mut();
        let mut l: usize = 0;
        let rc = unsafe {
            hayven_crdt_decode_segment(segment.as_ptr(), segment.len(), &mut p, &mut l)
        };
        assert_eq!(rc, OK);
        let json = unsafe { std::slice::from_raw_parts(p, l).to_vec() };
        unsafe { hayven_crdt_free(p, l) };
        let decoded: Vec<OpRecord> = serde_json::from_slice(&json).unwrap();
        let mut expected = batch1.clone();
        expected.extend(batch2.clone());
        assert_eq!(decoded, expected);
    }

    #[test]
    fn ffi_abi_major_matches_crate_major() {
        let (major, _, _) = crate::parse_semver(crate::VERSION);
        assert_eq!(hayven_crdt_abi_major(), major);
    }

    #[test]
    fn ffi_rejects_malformed_json() {
        let bad = b"not json";
        let mut p: *mut u8 = ptr::null_mut();
        let mut l: usize = 0;
        let rc = unsafe {
            hayven_crdt_encode_batch(bad.as_ptr(), bad.len(), &mut p, &mut l)
        };
        assert_eq!(rc, ERR_PARSE);
    }
}
