//! CRDT batch wire format.
//!
//! Single source of truth: `ARCHITECTURE.md §13`. Anything that deviates
//! here is a bug in this file, not in the spec. The TypeScript daemon
//! never reads or writes these bytes directly — it goes through the FFI
//! (see `serialize::ffi`).
//!
//! Layout recap (uncompressed envelope):
//! ```text
//! [magic "HYV1"          : 4 bytes ]
//! [op_count              : varint  ]
//! [string_table_count    : varint  ]
//! [string entries: { len : varint; utf8: bytes } * ]
//! [op records: variable length    * ]
//! ```
//!
//! On-disk records are prefixed with a 1-byte compression marker:
//!   `0x00` = raw envelope, `0x01` = brotli(envelope).
//! Below 128 bytes we always store raw because brotli's window overhead
//! exceeds the payload savings.

use std::collections::BTreeMap;
use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// 4-byte magic at the start of every uncompressed envelope.
pub const MAGIC: &[u8; 4] = b"HYV1";

/// On-disk compression marker.
const RAW: u8 = 0x00;
const BROTLI: u8 = 0x01;
const BROTLI_THRESHOLD: usize = 128;
/// Brotli quality. Matches the "batch sync" guidance in PRD §18 Q2.
const BROTLI_QUALITY: u32 = 6;
const BROTLI_WINDOW: u32 = 22;

#[derive(Debug, Error)]
pub enum WireError {
    #[error("bad magic: expected HYV1, got {0:?}")]
    BadMagic([u8; 4]),
    #[error("unexpected end of buffer at offset {0}")]
    Truncated(usize),
    #[error("varint overflow at offset {0}")]
    VarintOverflow(usize),
    #[error("length/count varint {0} exceeds u32 range at offset {1}")]
    LengthTooLarge(u64, usize),
    #[error("string table index {0} out of range ({1})")]
    StringIndex(u64, usize),
    #[error("unknown op kind: 0x{0:02x}")]
    UnknownOp(u8),
    #[error("invalid utf8 in string table: {0}")]
    Utf8(#[from] std::string::FromUtf8Error),
    #[error("invalid CBOR claim payload: {0}")]
    Cbor(String),
    #[error("brotli error: {0}")]
    Brotli(String),
    #[error("non-zero HLC reserved bytes")]
    HlcReserved,
    #[error("compressed envelope advertised compression marker 0x{0:02x}")]
    BadMarker(u8),
}

// ─── Op model (the on-the-wire view) ────────────────────────────────────────
//
// `OpRecord` is intentionally separate from the daemon's TypeScript op shapes.
// At the FFI boundary the daemon hands us JSON in a known shape (see `ffi.rs`)
// which we convert into `OpRecord` for encoding. Decoding produces the same
// `OpRecord` which we then serialize back as JSON for the daemon.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpRecord {
    Lww {
        entity_id: String,
        #[serde(with = "serde_bytes")]
        content_hash: Vec<u8>,
        #[serde(with = "serde_bytes")]
        body: Vec<u8>,
        hlc: HlcWire,
        #[serde(with = "serde_bytes")]
        writer: Vec<u8>,
    },
    GsetObserve {
        src: String,
        dst: String,
        ts_bucket: u32,
        observed: u16,
        weight: u16,
        hlc: HlcWire,
        #[serde(with = "serde_bytes")]
        writer: Vec<u8>,
    },
    OrAdd {
        claim_id: String,
        agent: String,
        #[serde(with = "serde_bytes")]
        payload_cbor: Vec<u8>,
        hlc: HlcWire,
        #[serde(with = "serde_bytes")]
        writer: Vec<u8>,
    },
    OrRemove {
        claim_id: String,
        #[serde(with = "serde_bytes")]
        observed_tags: Vec<u8>, // concatenated 28-byte tags
        hlc: HlcWire,
        #[serde(with = "serde_bytes")]
        writer: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HlcWire {
    pub wall_ms: u64,
    pub counter: u16,
}

const OP_LWW: u8 = 0x10;
const OP_GSET: u8 = 0x20;
const OP_OR_ADD: u8 = 0x30;
const OP_OR_REMOVE: u8 = 0x31;

const HLC_BYTES: usize = 12;
const WRITER_BYTES: usize = 16;
const TAG_BYTES: usize = HLC_BYTES + WRITER_BYTES;

// ─── Encoder ────────────────────────────────────────────────────────────────

/// Encode a batch of ops into the on-disk wire format. Returns
/// `[marker_byte, ...payload]` where `marker_byte` distinguishes raw vs
/// brotli-compressed payloads.
pub fn encode_batch(ops: &[OpRecord]) -> Result<Vec<u8>, WireError> {
    let mut buf = Vec::with_capacity(256);
    buf.extend_from_slice(MAGIC);
    write_varint(&mut buf, ops.len() as u64);

    // Pass 1: build string table from every string referenced by every op.
    let mut table = StringTable::new();
    for op in ops {
        match op {
            OpRecord::Lww { entity_id, .. } => {
                table.intern(entity_id);
            }
            OpRecord::GsetObserve { src, dst, .. } => {
                table.intern(src);
                table.intern(dst);
            }
            OpRecord::OrAdd {
                claim_id, agent, ..
            } => {
                table.intern(claim_id);
                table.intern(agent);
            }
            OpRecord::OrRemove { claim_id, .. } => {
                table.intern(claim_id);
            }
        }
    }
    write_varint(&mut buf, table.len() as u64);
    for s in table.entries() {
        let bytes = s.as_bytes();
        write_varint(&mut buf, bytes.len() as u64);
        buf.extend_from_slice(bytes);
    }

    // Pass 2: emit each op.
    for op in ops {
        encode_op(op, &table, &mut buf)?;
    }

    // Compress (or not).
    if buf.len() < BROTLI_THRESHOLD {
        let mut out = Vec::with_capacity(buf.len() + 1);
        out.push(RAW);
        out.extend_from_slice(&buf);
        return Ok(out);
    }
    let mut compressed = Vec::with_capacity(buf.len() / 2);
    {
        let mut enc =
            brotli::CompressorWriter::new(&mut compressed, 4096, BROTLI_QUALITY, BROTLI_WINDOW);
        enc.write_all(&buf)
            .map_err(|e| WireError::Brotli(e.to_string()))?;
        enc.flush().map_err(|e| WireError::Brotli(e.to_string()))?;
    }
    // Fall back to raw if compression made it bigger (rare for our shape but
    // possible for adversarial inputs). Both outputs carry the same 1-byte
    // marker prefix, so comparing the payload lengths directly is equivalent
    // to comparing the framed sizes — pick raw whenever brotli didn't shrink.
    if compressed.len() >= buf.len() {
        let mut out = Vec::with_capacity(buf.len() + 1);
        out.push(RAW);
        out.extend_from_slice(&buf);
        return Ok(out);
    }
    let mut out = Vec::with_capacity(compressed.len() + 1);
    out.push(BROTLI);
    out.extend_from_slice(&compressed);
    Ok(out)
}

fn encode_op(op: &OpRecord, table: &StringTable, buf: &mut Vec<u8>) -> Result<(), WireError> {
    let (kind, hlc, writer) = match op {
        OpRecord::Lww { hlc, writer, .. } => (OP_LWW, hlc, writer),
        OpRecord::GsetObserve { hlc, writer, .. } => (OP_GSET, hlc, writer),
        OpRecord::OrAdd { hlc, writer, .. } => (OP_OR_ADD, hlc, writer),
        OpRecord::OrRemove { hlc, writer, .. } => (OP_OR_REMOVE, hlc, writer),
    };
    buf.push(kind);
    encode_hlc(hlc, buf);
    if writer.len() != WRITER_BYTES {
        return Err(WireError::Truncated(writer.len()));
    }
    buf.extend_from_slice(writer);
    match op {
        OpRecord::Lww {
            entity_id,
            content_hash,
            body,
            ..
        } => {
            write_varint(buf, table.lookup(entity_id) as u64);
            if content_hash.len() != 32 {
                return Err(WireError::Truncated(content_hash.len()));
            }
            buf.extend_from_slice(content_hash);
            write_varint(buf, body.len() as u64);
            buf.extend_from_slice(body);
        }
        OpRecord::GsetObserve {
            src,
            dst,
            ts_bucket,
            observed,
            weight,
            ..
        } => {
            write_varint(buf, table.lookup(src) as u64);
            write_varint(buf, table.lookup(dst) as u64);
            buf.extend_from_slice(&ts_bucket.to_be_bytes());
            buf.extend_from_slice(&observed.to_be_bytes());
            buf.extend_from_slice(&weight.to_be_bytes());
        }
        OpRecord::OrAdd {
            claim_id,
            agent,
            payload_cbor,
            ..
        } => {
            write_varint(buf, table.lookup(claim_id) as u64);
            write_varint(buf, table.lookup(agent) as u64);
            write_varint(buf, payload_cbor.len() as u64);
            buf.extend_from_slice(payload_cbor);
        }
        OpRecord::OrRemove {
            claim_id,
            observed_tags,
            ..
        } => {
            write_varint(buf, table.lookup(claim_id) as u64);
            if observed_tags.len() % TAG_BYTES != 0 {
                return Err(WireError::Truncated(observed_tags.len()));
            }
            let count = observed_tags.len() / TAG_BYTES;
            write_varint(buf, count as u64);
            buf.extend_from_slice(observed_tags);
        }
    }
    Ok(())
}

fn encode_hlc(hlc: &HlcWire, buf: &mut Vec<u8>) {
    buf.extend_from_slice(&hlc.wall_ms.to_be_bytes());
    buf.extend_from_slice(&hlc.counter.to_be_bytes());
    buf.extend_from_slice(&[0u8, 0u8]); // reserved
}

// ─── Decoder ────────────────────────────────────────────────────────────────

pub fn decode_batch(input: &[u8]) -> Result<Vec<OpRecord>, WireError> {
    if input.is_empty() {
        return Err(WireError::Truncated(0));
    }
    let marker = input[0];
    let body: Vec<u8> = match marker {
        RAW => input[1..].to_vec(),
        BROTLI => {
            let mut out = Vec::with_capacity(input.len() * 3);
            let mut dec = brotli::Decompressor::new(&input[1..], 4096);
            dec.read_to_end(&mut out)
                .map_err(|e| WireError::Brotli(e.to_string()))?;
            out
        }
        other => return Err(WireError::BadMarker(other)),
    };
    decode_envelope(&body)
}

/// Decode a whole §14.2 segment in one pass.
///
/// A segment file is a concatenation of length-prefixed §13 batches:
/// `[varint batch_len][batch_len bytes]*`. This reads every complete batch,
/// decodes it via [`decode_batch`], and returns the flattened op list in
/// file order (oldest batch first, ops in encode order within a batch).
///
/// **Torn-write tolerance.** A segment may end with a partially-flushed batch
/// (EOF inside the length varint or inside the batch bytes). This matches the
/// daemon's TS readers (`OpLog.hydrate` / `segmentCompositeKeys` in
/// `oplog.ts`), which stop at the first incomplete frame and treat the rest as
/// a torn write. We do the same here so `decode-segment` is byte-for-byte
/// equivalent to looping `decode_batch` over `splitSegmentBatches`: stop
/// cleanly at the first short read, returning everything decoded so far.
///
/// A batch that frames cleanly but whose *bytes* are malformed (bad magic,
/// corrupt varint, etc.) is a real error — we surface it rather than silently
/// dropping ops, since that is data corruption, not a torn tail.
pub fn decode_segment(segment: &[u8]) -> Result<Vec<OpRecord>, WireError> {
    let mut out = Vec::new();
    let mut cur = Cursor::new(segment);
    loop {
        if cur.pos >= segment.len() {
            break; // clean end of segment
        }
        // Read the batch-length prefix. EOF mid-varint = torn write → stop.
        let batch_len = match read_seg_len_varint(&mut cur) {
            Some(Ok(len)) => len as usize,
            Some(Err(e)) => return Err(e), // oversized length/count: real corruption
            None => break,                 // torn write inside the length varint
        };
        // Not enough bytes left for the framed batch = torn write → stop.
        let end = match cur.pos.checked_add(batch_len) {
            Some(end) if end <= segment.len() => end,
            _ => break,
        };
        let batch = &segment[cur.pos..end];
        cur.pos = end;
        // The batch framed cleanly; its bytes must decode. A failure here is
        // corruption, not a torn tail — propagate it.
        out.extend(decode_batch(batch)?);
    }
    Ok(out)
}

/// Read a §14.2 batch-length varint, distinguishing "torn write" (ran off the
/// end of the buffer mid-varint → `None`) from "oversized length/count"
/// (decoded a value past u32 range → `Some(Err)`). Mirrors the TS
/// `readVarint` in `oplog.ts`, which returns `null` on truncation and throws
/// on an over-u32 value. The framing varint shares the §13 u32 length cap.
fn read_seg_len_varint(cur: &mut Cursor<'_>) -> Option<Result<u32, WireError>> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;
    let start = cur.pos;
    loop {
        let byte = match cur.take(1) {
            Ok(b) => b[0],
            Err(_) => return None, // ran off the end mid-varint: torn write
        };
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(
                u32::try_from(result).map_err(|_| WireError::LengthTooLarge(result, start)),
            );
        }
        shift += 7;
        if shift >= 35 {
            // A u32 needs at most 5 varint bytes (35 bits). A 6th continuation
            // byte can only describe a value beyond u32 → reject, matching the
            // TS reader's `shift >= 35` throw.
            return Some(Err(WireError::LengthTooLarge(result, start)));
        }
    }
}

fn decode_envelope(body: &[u8]) -> Result<Vec<OpRecord>, WireError> {
    let mut cur = Cursor::new(body);
    let magic = cur.take(4)?;
    if magic != MAGIC {
        let mut m = [0u8; 4];
        m.copy_from_slice(magic);
        return Err(WireError::BadMagic(m));
    }
    let op_count = read_len_varint(&mut cur)? as usize;
    let st_count = read_len_varint(&mut cur)? as usize;
    let mut strings: Vec<String> = Vec::with_capacity(st_count);
    for _ in 0..st_count {
        let len = read_len_varint(&mut cur)? as usize;
        let bytes = cur.take(len)?;
        strings.push(String::from_utf8(bytes.to_vec())?);
    }
    let mut out = Vec::with_capacity(op_count);
    for _ in 0..op_count {
        out.push(decode_op(&mut cur, &strings)?);
    }
    Ok(out)
}

fn decode_op(cur: &mut Cursor<'_>, strings: &[String]) -> Result<OpRecord, WireError> {
    let kind_byte = cur.take(1)?[0];
    let hlc = decode_hlc(cur.take(HLC_BYTES)?)?;
    let writer = cur.take(WRITER_BYTES)?.to_vec();
    match kind_byte {
        OP_LWW => {
            let idx = read_len_varint(cur)?;
            let entity_id = lookup_string(strings, idx)?;
            let content_hash = cur.take(32)?.to_vec();
            let body_len = read_len_varint(cur)? as usize;
            let body = cur.take(body_len)?.to_vec();
            Ok(OpRecord::Lww {
                entity_id,
                content_hash,
                body,
                hlc,
                writer,
            })
        }
        OP_GSET => {
            let src = lookup_string(strings, read_len_varint(cur)?)?;
            let dst = lookup_string(strings, read_len_varint(cur)?)?;
            let ts_bucket = u32::from_be_bytes(cur.take(4)?.try_into().unwrap());
            let observed = u16::from_be_bytes(cur.take(2)?.try_into().unwrap());
            let weight = u16::from_be_bytes(cur.take(2)?.try_into().unwrap());
            Ok(OpRecord::GsetObserve {
                src,
                dst,
                ts_bucket,
                observed,
                weight,
                hlc,
                writer,
            })
        }
        OP_OR_ADD => {
            let claim_id = lookup_string(strings, read_len_varint(cur)?)?;
            let agent = lookup_string(strings, read_len_varint(cur)?)?;
            let payload_len = read_len_varint(cur)? as usize;
            let payload_cbor = cur.take(payload_len)?.to_vec();
            Ok(OpRecord::OrAdd {
                claim_id,
                agent,
                payload_cbor,
                hlc,
                writer,
            })
        }
        OP_OR_REMOVE => {
            let claim_id = lookup_string(strings, read_len_varint(cur)?)?;
            let tag_count = read_len_varint(cur)? as usize;
            // Untrusted `tag_count` arrives over the sync layer. An unchecked
            // multiply would wrap on overflow and hand `cur.take` a bogus
            // length — a remotely-triggerable panic. checked_mul rejects it
            // cleanly as a truncation error instead.
            let total = tag_count
                .checked_mul(TAG_BYTES)
                .ok_or(WireError::Truncated(cur.pos))?;
            let observed_tags = cur.take(total)?.to_vec();
            Ok(OpRecord::OrRemove {
                claim_id,
                observed_tags,
                hlc,
                writer,
            })
        }
        other => Err(WireError::UnknownOp(other)),
    }
}

fn decode_hlc(bytes: &[u8]) -> Result<HlcWire, WireError> {
    let wall_ms = u64::from_be_bytes(bytes[0..8].try_into().unwrap());
    let counter = u16::from_be_bytes(bytes[8..10].try_into().unwrap());
    let reserved = u16::from_be_bytes(bytes[10..12].try_into().unwrap());
    if reserved != 0 {
        return Err(WireError::HlcReserved);
    }
    Ok(HlcWire { wall_ms, counter })
}

fn lookup_string(strings: &[String], idx: u32) -> Result<String, WireError> {
    strings
        .get(idx as usize)
        .cloned()
        .ok_or(WireError::StringIndex(idx as u64, strings.len()))
}

// ─── Varint (LEB128 unsigned) ───────────────────────────────────────────────

fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        buf.push(((v as u8) & 0x7f) | 0x80);
        v >>= 7;
    }
    buf.push(v as u8);
}

fn read_varint(cur: &mut Cursor<'_>) -> Result<u64, WireError> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;
    let start = cur.pos;
    loop {
        let byte = cur.take(1)?[0];
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err(WireError::VarintOverflow(start));
        }
    }
}

/// Read a varint used as a length, count, or string-table index (BL-7).
///
/// The §13 wire format caps every length/count varint to unsigned 32-bit
/// range (≤ `2^32 − 1`), matching the TS reader which coerces with `>>> 0`.
/// We reject anything larger with a clean `Err` rather than truncating, so a
/// crafted peer can't smuggle a value that means one thing here and another on
/// the JS side. The cap is applied here at the length/count call sites only —
/// the generic `read_varint` stays a full 64-bit reader for any non-length use.
fn read_len_varint(cur: &mut Cursor<'_>) -> Result<u32, WireError> {
    let start = cur.pos;
    let v = read_varint(cur)?;
    u32::try_from(v).map_err(|_| WireError::LengthTooLarge(v, start))
}

// ─── Cursor + StringTable ───────────────────────────────────────────────────

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        // checked_add: `n` derives from an untrusted varint and could be near
        // usize::MAX; `self.pos + n` would wrap and slip past the bounds
        // check, then the slice index would panic. Reject cleanly instead.
        let end = self
            .pos
            .checked_add(n)
            .ok_or(WireError::Truncated(self.pos))?;
        if end > self.bytes.len() {
            return Err(WireError::Truncated(self.pos));
        }
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }
}

/// Insertion-ordered, deduplicating string interner. Lookup is O(log n).
struct StringTable {
    by_key: BTreeMap<String, u32>,
    entries: Vec<String>,
}

impl StringTable {
    fn new() -> Self {
        Self {
            by_key: BTreeMap::new(),
            entries: Vec::new(),
        }
    }
    fn intern(&mut self, s: &str) -> u32 {
        if let Some(&i) = self.by_key.get(s) {
            return i;
        }
        let i = self.entries.len() as u32;
        self.entries.push(s.to_string());
        self.by_key.insert(s.to_string(), i);
        i
    }
    fn lookup(&self, s: &str) -> u32 {
        *self
            .by_key
            .get(s)
            .expect("string was not interned during encode pass 1")
    }
    fn len(&self) -> usize {
        self.entries.len()
    }
    fn entries(&self) -> &[String] {
        &self.entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_writer(n: u8) -> Vec<u8> {
        vec![n; WRITER_BYTES]
    }

    fn round_trip(ops: Vec<OpRecord>) {
        let bytes = encode_batch(&ops).expect("encode ok");
        let decoded = decode_batch(&bytes).expect("decode ok");
        assert_eq!(decoded, ops);
    }

    #[test]
    fn empty_batch_round_trips() {
        round_trip(vec![]);
    }

    #[test]
    fn lww_round_trip() {
        round_trip(vec![OpRecord::Lww {
            entity_id: "auth/login".into(),
            content_hash: vec![1; 32],
            body: b"# auth/login\n\nstub".to_vec(),
            hlc: HlcWire {
                wall_ms: 1_700_000_001_234,
                counter: 7,
            },
            writer: dummy_writer(0xa1),
        }]);
    }

    #[test]
    fn gset_round_trip() {
        round_trip(vec![
            OpRecord::GsetObserve {
                src: "auth/login_handler".into(),
                dst: "auth/validate_session".into(),
                ts_bucket: 1_700_000_000,
                observed: 5,
                weight: 500,
                hlc: HlcWire {
                    wall_ms: 1,
                    counter: 0,
                },
                writer: dummy_writer(0x01),
            },
            OpRecord::GsetObserve {
                src: "auth/login_handler".into(),
                dst: "auth/validate_session".into(),
                ts_bucket: 1_700_000_000,
                observed: 3,
                weight: 300,
                hlc: HlcWire {
                    wall_ms: 2,
                    counter: 0,
                },
                writer: dummy_writer(0x02),
            },
        ]);
    }

    #[test]
    fn or_set_round_trip() {
        let mut tags = Vec::new();
        tags.extend_from_slice(&[0xaa; TAG_BYTES]);
        tags.extend_from_slice(&[0xbb; TAG_BYTES]);
        round_trip(vec![
            OpRecord::OrAdd {
                claim_id: "c1".into(),
                agent: "agent-x".into(),
                payload_cbor: b"\xa1\x66intent\x65work".to_vec(),
                hlc: HlcWire {
                    wall_ms: 10,
                    counter: 0,
                },
                writer: dummy_writer(0x10),
            },
            OpRecord::OrRemove {
                claim_id: "c1".into(),
                observed_tags: tags,
                hlc: HlcWire {
                    wall_ms: 11,
                    counter: 0,
                },
                writer: dummy_writer(0x11),
            },
        ]);
    }

    #[test]
    fn string_table_deduplicates() {
        let ops = (0..50)
            .map(|i| OpRecord::GsetObserve {
                src: "auth/login_handler".into(),
                dst: "auth/validate_session".into(),
                ts_bucket: 1_700_000_000 + i,
                observed: 1,
                weight: 100,
                hlc: HlcWire {
                    wall_ms: i as u64,
                    counter: 0,
                },
                writer: dummy_writer(0x42),
            })
            .collect::<Vec<_>>();
        let bytes = encode_batch(&ops).unwrap();
        // 50 ops referencing 2 distinct strings → string table should have 2.
        // We can't read the field directly without decode, but we can confirm
        // round-trip and verify the encoded size is far below the naive
        // "50 * (src + dst)" baseline.
        let decoded = decode_batch(&bytes).unwrap();
        assert_eq!(decoded.len(), 50);
        let strings_repeated = 50 * ("auth/login_handler".len() + "auth/validate_session".len());
        assert!(
            bytes.len() < strings_repeated,
            "expected dedup to beat naive size {} but got {}",
            strings_repeated,
            bytes.len(),
        );
    }

    #[test]
    fn small_envelope_skips_brotli() {
        let bytes = encode_batch(&[]).unwrap();
        assert_eq!(bytes[0], RAW);
    }

    #[test]
    fn large_envelope_uses_brotli() {
        let ops = (0..200)
            .map(|i| OpRecord::GsetObserve {
                src: format!("module/entity_{i}"),
                dst: format!("module/entity_{}", i + 1),
                ts_bucket: 1_700_000_000,
                observed: 1,
                weight: 100,
                hlc: HlcWire {
                    wall_ms: i as u64,
                    counter: 0,
                },
                writer: dummy_writer(0x77),
            })
            .collect::<Vec<_>>();
        let bytes = encode_batch(&ops).unwrap();
        assert_eq!(bytes[0], BROTLI);
        let decoded = decode_batch(&bytes).unwrap();
        assert_eq!(decoded, ops);
    }

    /// Frame a batch the way `OpLog.appendBatchBytes` does on disk: a varint
    /// length prefix followed by the batch bytes (ARCHITECTURE.md §14.2).
    fn frame_batch(out: &mut Vec<u8>, batch: &[u8]) {
        write_varint(out, batch.len() as u64);
        out.extend_from_slice(batch);
    }

    /// BL-11: `decode_segment` reads a whole length-prefixed multi-batch
    /// segment in one pass and emits ALL ops, in file order, identical to
    /// looping `decode_batch` over each framed batch. This is what lets the
    /// daemon do ONE subprocess spawn per segment instead of one-per-batch.
    #[test]
    fn decode_segment_round_trips_multi_batch() {
        // Batch 1: two G-Set ops. Batch 2: an OR-add + OR-remove. Batch 3: one
        // LWW op. Distinct batches with distinct string tables, exactly like a
        // day's segment that was appended to across several writes.
        let batch1 = vec![
            OpRecord::GsetObserve {
                src: "auth/login_handler".into(),
                dst: "auth/validate_session".into(),
                ts_bucket: 1_700_000_000,
                observed: 5,
                weight: 500,
                hlc: HlcWire {
                    wall_ms: 1,
                    counter: 0,
                },
                writer: dummy_writer(0x01),
            },
            OpRecord::GsetObserve {
                src: "auth/login_handler".into(),
                dst: "auth/refresh_token".into(),
                ts_bucket: 1_700_000_060,
                observed: 2,
                weight: 200,
                hlc: HlcWire {
                    wall_ms: 2,
                    counter: 1,
                },
                writer: dummy_writer(0x02),
            },
        ];
        let mut tags = Vec::new();
        tags.extend_from_slice(&[0xaa; TAG_BYTES]);
        let batch2 = vec![
            OpRecord::OrAdd {
                claim_id: "c-42".into(),
                agent: "agent-x".into(),
                payload_cbor: b"\xa1\x66intent\x65work".to_vec(),
                hlc: HlcWire {
                    wall_ms: 10,
                    counter: 0,
                },
                writer: dummy_writer(0x10),
            },
            OpRecord::OrRemove {
                claim_id: "c-42".into(),
                observed_tags: tags,
                hlc: HlcWire {
                    wall_ms: 11,
                    counter: 0,
                },
                writer: dummy_writer(0x11),
            },
        ];
        let batch3 = vec![OpRecord::Lww {
            entity_id: "auth/login".into(),
            content_hash: vec![7; 32],
            body: b"# auth/login\n\nbody".to_vec(),
            hlc: HlcWire {
                wall_ms: 12,
                counter: 3,
            },
            writer: dummy_writer(0xa1),
        }];

        let mut segment = Vec::new();
        for batch in [&batch1, &batch2, &batch3] {
            let bytes = encode_batch(batch).expect("encode ok");
            frame_batch(&mut segment, &bytes);
        }

        let decoded = decode_segment(&segment).expect("decode_segment ok");

        // Same ops out as in, concatenated in batch/file order. Also confirm it
        // equals the per-batch loop the segment subcommand replaces.
        let mut expected: Vec<OpRecord> = Vec::new();
        expected.extend(batch1);
        expected.extend(batch2);
        expected.extend(batch3);
        assert_eq!(decoded, expected);

        let mut via_loop: Vec<OpRecord> = Vec::new();
        for batch in split_segment_frames(&segment) {
            via_loop.extend(decode_batch(batch).unwrap());
        }
        assert_eq!(decoded, via_loop, "must match per-batch decode");
    }

    /// Test helper mirroring the daemon's `splitSegmentBatches`: yields each
    /// framed batch's bytes. Used only to cross-check `decode_segment`.
    fn split_segment_frames(segment: &[u8]) -> Vec<&[u8]> {
        let mut out = Vec::new();
        let mut pos = 0usize;
        while pos < segment.len() {
            let mut len = 0u64;
            let mut shift = 0u32;
            loop {
                let b = segment[pos];
                pos += 1;
                len |= ((b & 0x7f) as u64) << shift;
                if b & 0x80 == 0 {
                    break;
                }
                shift += 7;
            }
            let len = len as usize;
            out.push(&segment[pos..pos + len]);
            pos += len;
        }
        out
    }

    /// BL-11: a torn trailing batch (a partial final frame, e.g. an
    /// fdatasync that landed mid-write) must not fail the whole segment.
    /// `decode_segment` returns every complete batch and stops cleanly at the
    /// torn tail — exactly the truncation tolerance of `OpLog.hydrate`.
    #[test]
    fn decode_segment_tolerates_torn_trailing_batch() {
        let good = vec![OpRecord::GsetObserve {
            src: "a".into(),
            dst: "b".into(),
            ts_bucket: 0,
            observed: 1,
            weight: 1,
            hlc: HlcWire {
                wall_ms: 1,
                counter: 0,
            },
            writer: dummy_writer(0x01),
        }];
        let good_bytes = encode_batch(&good).unwrap();
        let torn = vec![OpRecord::GsetObserve {
            src: "c".into(),
            dst: "d".into(),
            ts_bucket: 0,
            observed: 1,
            weight: 1,
            hlc: HlcWire {
                wall_ms: 2,
                counter: 0,
            },
            writer: dummy_writer(0x02),
        }];
        let torn_bytes = encode_batch(&torn).unwrap();

        let mut segment = Vec::new();
        frame_batch(&mut segment, &good_bytes);
        // Append a second frame but chop off its last 3 bytes — a torn write.
        frame_batch(&mut segment, &torn_bytes);
        segment.truncate(segment.len() - 3);

        let decoded = decode_segment(&segment).expect("torn tail tolerated");
        assert_eq!(decoded, good, "only the complete batch is returned");
    }

    /// A torn write *inside the length varint* (segment ends with a lone
    /// continuation byte) is also tolerated — stop, don't error.
    #[test]
    fn decode_segment_tolerates_torn_length_prefix() {
        let good = vec![OpRecord::GsetObserve {
            src: "a".into(),
            dst: "b".into(),
            ts_bucket: 0,
            observed: 1,
            weight: 1,
            hlc: HlcWire {
                wall_ms: 1,
                counter: 0,
            },
            writer: dummy_writer(0x01),
        }];
        let mut segment = Vec::new();
        frame_batch(&mut segment, &encode_batch(&good).unwrap());
        segment.push(0x80); // dangling continuation byte: torn length varint
        let decoded = decode_segment(&segment).expect("torn length tolerated");
        assert_eq!(decoded, good);
    }

    /// An empty segment file decodes to zero ops.
    #[test]
    fn decode_segment_empty_yields_nothing() {
        assert_eq!(decode_segment(&[]).unwrap(), Vec::<OpRecord>::new());
    }

    /// A cleanly-framed batch with corrupt *bytes* (bad magic) is real
    /// corruption, not a torn tail — `decode_segment` surfaces the error
    /// rather than silently dropping the ops.
    #[test]
    fn decode_segment_propagates_corrupt_framed_batch() {
        let mut segment = Vec::new();
        // Frame a 6-byte "batch" that is RAW marker + garbage magic.
        let bogus = [RAW, b'X', b'X', b'X', b'X', 0u8];
        frame_batch(&mut segment, &bogus);
        assert!(decode_segment(&segment).is_err());
    }

    #[test]
    fn rejects_truncated_input() {
        let bytes = encode_batch(&[OpRecord::GsetObserve {
            src: "a".into(),
            dst: "b".into(),
            ts_bucket: 0,
            observed: 0,
            weight: 0,
            hlc: HlcWire {
                wall_ms: 0,
                counter: 0,
            },
            writer: dummy_writer(0),
        }])
        .unwrap();
        let truncated = &bytes[..bytes.len() - 2];
        assert!(decode_batch(truncated).is_err());
    }

    #[test]
    fn rejects_crafted_or_remove_tag_count_without_panicking() {
        // Regression: a huge `tag_count` varint used to overflow
        // `tag_count * TAG_BYTES` and panic in `cur.take`. It must now
        // return a clean Err. We hand-build a raw envelope:
        //   marker(RAW) magic op_count=1 st_count=1 [len=1 "c"]
        //   op: kind=OP_OR_REMOVE hlc(12) writer(16) claim_idx=0 tag_count=HUGE
        let mut buf = Vec::new();
        buf.push(RAW);
        buf.extend_from_slice(MAGIC);
        write_varint(&mut buf, 1); // op_count
        write_varint(&mut buf, 1); // string_table_count
        write_varint(&mut buf, 1); // string len
        buf.push(b'c'); // claim_id string
        buf.push(OP_OR_REMOVE);
        buf.extend_from_slice(&[0u8; HLC_BYTES]); // hlc (reserved zero)
        buf.extend_from_slice(&[0u8; WRITER_BYTES]); // writer
        write_varint(&mut buf, 0); // claim_id_idx -> "c"
                                   // tag_count = u64::MAX so tag_count * 28 overflows usize.
        write_varint(&mut buf, u64::MAX);
        // (no tag bytes follow — decode must fail before reading them)

        let result = decode_batch(&buf);
        assert!(
            result.is_err(),
            "crafted tag_count must be rejected, not panic"
        );
    }

    /// BL-7: length/count varints are capped to u32 range. A varint encoding
    /// exactly `2^32 - 1` decodes; one encoding `2^32` errors cleanly with
    /// `LengthTooLarge` (no panic, no silent wrap). Pairs with the TS reader's
    /// `>>> 0` coercion at shift>=35.
    #[test]
    fn len_varint_caps_at_u32_boundary() {
        // Value just under the cap (2^32 - 1) must decode to itself.
        let mut under = Vec::new();
        write_varint(&mut under, u32::MAX as u64);
        let mut cur = Cursor::new(&under);
        assert_eq!(read_len_varint(&mut cur).unwrap(), u32::MAX);

        // Value just over the cap (2^32) must be rejected as LengthTooLarge.
        let mut over = Vec::new();
        write_varint(&mut over, 1u64 << 32);
        let mut cur = Cursor::new(&over);
        let err = read_len_varint(&mut cur).unwrap_err();
        assert!(
            matches!(err, WireError::LengthTooLarge(v, _) if v == 1u64 << 32),
            "expected LengthTooLarge, got {err:?}",
        );
    }

    /// BL-7 end-to-end: a crafted envelope whose string-table count varint
    /// exceeds u32 range is rejected at decode time rather than panicking or
    /// truncating.
    #[test]
    fn decode_rejects_oversized_count_varint() {
        let mut buf = Vec::new();
        buf.push(RAW);
        buf.extend_from_slice(MAGIC);
        write_varint(&mut buf, 0); // op_count = 0
        write_varint(&mut buf, 1u64 << 32); // string_table_count > u32::MAX
        let err = decode_batch(&buf).unwrap_err();
        assert!(
            matches!(err, WireError::LengthTooLarge(..)),
            "oversized count must error as LengthTooLarge, got {err:?}",
        );
    }

    #[test]
    fn rejects_non_zero_hlc_reserved() {
        let mut bytes = encode_batch(&[OpRecord::GsetObserve {
            src: "a".into(),
            dst: "b".into(),
            ts_bucket: 0,
            observed: 0,
            weight: 0,
            hlc: HlcWire {
                wall_ms: 0,
                counter: 0,
            },
            writer: dummy_writer(0),
        }])
        .unwrap();
        // Tamper: find the HLC bytes (after magic+counts+st+op_kind) and flip
        // the reserved bytes. For a raw envelope: marker(1) + magic(4) +
        // varint op_count(1) + varint st_count(1) + 2*string_entries + 1
        // op_kind = some offset; easier to find by searching for the pattern.
        // We just look for `0x20` (GSET op kind) and flip bytes 13/14 after it
        // (HLC reserved offset within the 12 HLC bytes).
        assert_eq!(bytes[0], RAW, "small envelope must be raw");
        let idx = bytes.iter().position(|&b| b == OP_GSET).unwrap();
        bytes[idx + 1 + 10] = 0x99;
        let err = decode_batch(&bytes).unwrap_err();
        assert!(matches!(err, WireError::HlcReserved));
    }

    #[test]
    fn fuzz_brotli_compression_ratio() {
        // PRD §15 Week 5 deliverable: wire format 30% smaller than the
        // generic equivalent. "Generic equivalent" = JSON of the same
        // structure (no string table, no varint), which is what the
        // daemon would otherwise produce.
        let ops: Vec<OpRecord> = (0..500)
            .map(|i| OpRecord::GsetObserve {
                src: format!("auth/login_handler_{}", i % 10),
                dst: format!("auth/validate_session_{}", i % 7),
                ts_bucket: 1_700_000_000 + (i as u32 / 60) * 60,
                observed: (i % 9) as u16 + 1,
                weight: ((i % 9) as u16 + 1) * 100,
                hlc: HlcWire {
                    wall_ms: 1_700_000_000_000 + i as u64,
                    counter: 0,
                },
                writer: dummy_writer((i % 4) as u8),
            })
            .collect();
        let wire = encode_batch(&ops).unwrap();
        let json = serde_json::to_vec(&ops).unwrap();
        let ratio = wire.len() as f64 / json.len() as f64;
        eprintln!(
            "wire={} json={} ratio={:.3} (target ≤0.70)",
            wire.len(),
            json.len(),
            ratio
        );
        assert!(
            ratio <= 0.70,
            "wire format must be ≥30% smaller than JSON, got {:.3}",
            ratio
        );
    }
}
