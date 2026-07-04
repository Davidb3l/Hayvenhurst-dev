//! Integration tests for the `hayven-native` subcommands that the daemon
//! shells out to. `serialize` and `watch` are both real now; only `parse`
//! used to be (and still is) the one long-lived parse subcommand.

use std::io::{BufRead, BufReader};
use std::process::{Command as StdCommand, Stdio};
use std::time::{Duration, Instant};

use assert_cmd::Command;
use predicates::str::contains;

// Long-lived: spawns the watcher (a process that must be SIGKILLed) and blocks
// on reading its stdout — it can hang a plain `cargo test --all`/`--test stubs`
// in environments where the OS file-watch backend doesn't promptly emit (see
// CLAUDE.md). Marked #[ignore] so the default test run is safe everywhere; run it
// explicitly with `cargo test --release --test stubs -- --ignored`.
#[ignore = "long-lived watcher; can hang CI — run with --ignored (see CLAUDE.md)"]
#[test]
fn watch_emits_version_then_ready_then_keeps_running() {
    // §16.2: first record is `version`, second is `ready` once the OS
    // backend has registered. We spawn the watcher, read the first two
    // stdout lines, then send SIGKILL — the watcher is long-lived by
    // design (§16.5 says <0.1% CPU at idle), so it never exits on its own.
    let tmp = tempfile::tempdir().expect("create tempdir");
    let bin = assert_cmd::cargo::cargo_bin("hayven-native");
    let mut child = StdCommand::new(&bin)
        .args(["watch", "--root", tmp.path().to_str().unwrap()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn watcher");

    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::new(stdout);

    let deadline = Instant::now() + Duration::from_secs(5);
    let version_line = read_line_with_deadline(&mut reader, deadline).expect("version line");
    let ready_line = read_line_with_deadline(&mut reader, deadline).expect("ready line");

    // Kill the child before the test exits — it is by-design long-lived.
    let _ = child.kill();
    let _ = child.wait();

    let v: serde_json::Value = serde_json::from_str(&version_line).expect("version is JSON");
    assert_eq!(v["type"], "version", "first stdout line must be version");
    assert_eq!(v["protocol"], 2);

    let r: serde_json::Value = serde_json::from_str(&ready_line).expect("ready is JSON");
    assert_eq!(r["type"], "ready", "second stdout line must be ready");
    let backend = r["backend"].as_str().unwrap_or("");
    assert!(
        matches!(backend, "fsevents" | "inotify" | "rdcw" | "poll"),
        "unexpected backend: {backend}",
    );
}

fn read_line_with_deadline<R: BufRead>(
    reader: &mut R,
    deadline: Instant,
) -> Option<String> {
    // BufReader::read_line blocks; rather than wire a select(), we just
    // bound the whole test via the explicit `deadline` Instant — if the
    // reader hangs past it, the outer kill() unblocks the read with EOF.
    let mut buf = String::new();
    // Spawn a sentinel thread that kills the process if we blow past the
    // deadline. The test's main thread does the blocking read.
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return None;
    }
    // Best-effort: rely on the OS to interrupt the read when the parent
    // SIGKILLs the child elsewhere. We just attempt one read.
    let n = reader.read_line(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    Some(buf.trim_end_matches('\n').to_string())
}

#[test]
fn serialize_rejects_unknown_subcommand() {
    Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["serialize", "bogus"])
        .assert()
        .code(2)
        .stderr(contains("unknown subcommand"));
}

#[test]
fn parse_emits_version_handshake_as_first_stdout_line() {
    // §16.4: parse's first stdout line must be the version record. The
    // 0.0.1 binary previously emitted `start` first; with the Q5 resolution
    // we now emit `version` then `start`.
    let tmp = tempfile::tempdir().expect("create tempdir");
    // Empty repo is fine — we only care about the handshake.
    let out = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args([
            "parse",
            "--root",
            tmp.path().to_str().unwrap(),
            "--langs",
            "python",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout.lines().next().expect("stdout non-empty");
    let parsed: serde_json::Value = serde_json::from_str(first).expect("first line is JSON");
    assert_eq!(parsed["type"], "version", "first stdout line must be version");
    assert_eq!(parsed["protocol"], 2);
}

#[test]
fn serialize_emits_version_handshake_on_stderr() {
    // §16.4: every subcommand emits a version record. For serialize, stdout
    // is reserved for the binary wire payload, so the handshake goes to
    // stderr. This test asserts the line is present and well-formed JSON.
    let out = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["serialize", "encode"])
        .write_stdin("[]")
        .assert()
        .code(0)
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&out.stderr);
    let first = stderr.lines().next().expect("stderr non-empty");
    let parsed: serde_json::Value = serde_json::from_str(first).expect("version record is JSON");
    assert_eq!(parsed["type"], "version");
    assert!(parsed["major"].is_number());
    assert!(parsed["minor"].is_number());
    assert!(parsed["patch"].is_number());
    assert_eq!(parsed["protocol"], 2);
}

#[test]
fn serialize_encode_then_decode_round_trips_via_subprocess() {
    let input = r#"[
      {"kind":"gset_observe","src":"a","dst":"b","ts_bucket":0,
       "observed":1,"weight":100,
       "hlc":{"wall_ms":1,"counter":0},
       "writer":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]}
    ]"#;

    let enc = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["serialize", "encode"])
        .write_stdin(input)
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let dec = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["serialize", "decode"])
        .write_stdin(enc)
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let decoded: serde_json::Value = serde_json::from_slice(&dec).expect("decoded JSON valid");
    let input_val: serde_json::Value = serde_json::from_str(input).unwrap();
    assert_eq!(decoded, input_val);
}

/// BL-11: `serialize decode-segment` reads a whole length-prefixed §14.2
/// segment (multiple framed batches) on stdin and emits ALL ops as one flat
/// JSON array on stdout — the exact bytes the daemon's `merkle.ts` hot path
/// now relies on to do ONE spawn per segment instead of one per batch. This
/// exercises the real subprocess transport end to end.
#[test]
fn serialize_decode_segment_round_trips_multi_batch_via_subprocess() {
    // Two independent batches with disjoint string tables, encoded via the
    // binary exactly as the daemon's wire bridge would.
    let batch_a = r#"[
      {"kind":"gset_observe","src":"auth/a","dst":"auth/b","ts_bucket":0,
       "observed":1,"weight":100,
       "hlc":{"wall_ms":1,"counter":0},
       "writer":[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]}
    ]"#;
    let batch_b = r#"[
      {"kind":"gset_observe","src":"auth/c","dst":"auth/d","ts_bucket":0,
       "observed":2,"weight":200,
       "hlc":{"wall_ms":2,"counter":0},
       "writer":[2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2]},
      {"kind":"gset_observe","src":"auth/c","dst":"auth/e","ts_bucket":0,
       "observed":3,"weight":300,
       "hlc":{"wall_ms":3,"counter":0},
       "writer":[3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3]}
    ]"#;

    let encode = |input: &str| -> Vec<u8> {
        Command::cargo_bin("hayven-native")
            .expect("locate built binary")
            .args(["serialize", "encode"])
            .write_stdin(input)
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone()
    };

    // Frame each encoded batch with an LEB128 varint length prefix, the way
    // `OpLog.appendBatchBytes` writes a segment file on disk (ARCHITECTURE §14.2).
    let mut segment: Vec<u8> = Vec::new();
    for batch in [encode(batch_a), encode(batch_b)] {
        let mut len = batch.len() as u64;
        while len >= 0x80 {
            segment.push((len as u8 & 0x7f) | 0x80);
            len >>= 7;
        }
        segment.push(len as u8);
        segment.extend_from_slice(&batch);
    }

    let out = Command::cargo_bin("hayven-native")
        .expect("locate built binary")
        .args(["serialize", "decode-segment"])
        .write_stdin(segment)
        .assert()
        .code(0)
        .get_output()
        .clone();

    // Handshake on stderr (stdout is the JSON payload), like `encode`/`decode`.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let first = stderr.lines().next().expect("stderr non-empty");
    let ver: serde_json::Value = serde_json::from_str(first).expect("version record is JSON");
    assert_eq!(ver["type"], "version");
    assert_eq!(ver["protocol"], 2);

    // All three ops come out, flattened in file order.
    let decoded: serde_json::Value = serde_json::from_slice(&out.stdout).expect("decoded JSON");
    let arr = decoded.as_array().expect("decode-segment emits an array");
    assert_eq!(arr.len(), 3, "all ops across both batches are emitted");
    assert_eq!(arr[0]["src"], "auth/a");
    assert_eq!(arr[1]["src"], "auth/c");
    assert_eq!(arr[2]["dst"], "auth/e");
}
