//! F6: the parse record channel must be BOUNDED.
//!
//! `parse::run` serializes each record on a rayon worker and ships the byte
//! buffer to a single writer thread. That channel used to be
//! `mpsc::channel` — unbounded. When the daemon reads our stdout slowly the
//! writer thread blocks on the pipe, and with an unbounded queue every record
//! the workers keep producing piles up in the child's heap with nothing to
//! stop it. Peak RSS ends up set by the consumer's worst stall rather than by
//! anything the child controls.
//!
//! HOW THIS TEST DISCRIMINATES. A test that merely runs `parse` and checks the
//! output passes identically for a bounded and an unbounded channel — the
//! bytes are the same either way. So this test creates a fixture large enough
//! to produce far more records than the queue depth, spawns `parse` with a
//! pipe that is DELIBERATELY NOT READ, and samples the child's resident set
//! while it is stalled. With backpressure the child parks at a small, flat
//! footprint; without it the heap grows with every record produced. Then it
//! drains the pipe and asserts the stream is still complete and correct, which
//! is the regression risk the fix itself introduces (a bounded channel is a
//! place a pipeline can deadlock).

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

/// Files in the fixture. Each yields on the order of 25 records, so this is
/// comfortably past `RECORD_QUEUE_DEPTH` (4096) — an unbounded queue has to
/// hold the difference in RAM.
const FIXTURE_FILES: usize = 1500;

/// Ceiling for the stalled child's RSS.
///
/// Calibrated, not guessed. Measured on this fixture with `--jobs 4` pinned:
///
///   BOUNDED    31.0 MiB (debug)   29.6 MiB (release)
///   UNBOUNDED  69.0 MiB (debug)   56.8 MiB (release)
///
/// The gap is the undelivered NDJSON stream sitting in the child's heap. 44 MiB
/// sits between the two with ~42% headroom over the bounded figure and ~29%
/// below the lowest unbounded one, so ordinary host variance will not trip it
/// while the unbounded design fails it decisively in both profiles. If this
/// ever gets flaky, widen the gap by raising FIXTURE_FILES rather than raising
/// the ceiling — the ceiling is what makes the test mean anything.
const RSS_CEILING_KIB: u64 = 44 * 1024;

fn binary() -> std::path::PathBuf {
    // `CARGO_BIN_EXE_<name>` is set by cargo for integration tests.
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_hayven-native"))
}

/// `(rss_kib, cpu_centiseconds)` for `pid`, via `ps`. `None` when `ps` is
/// missing or the process has already exited.
///
/// CPU time is the load-bearing half: it is monotonic and it goes flat exactly
/// when the rayon workers stop producing, which is the moment the measurement
/// below becomes meaningful. Plateauing on RSS instead is unreliable — in a
/// debug build the heap grows slowly and lumpily enough to look settled while
/// the parse is still only a fifth of the way through, which silently turns
/// this into a test that passes for both designs.
#[cfg(unix)]
fn sample(pid: u32) -> Option<(u64, u64)> {
    let out = Command::new("ps")
        .args(["-o", "rss=,cputime=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut fields = text.split_whitespace();
    let rss: u64 = fields.next()?.parse().ok()?;
    Some((rss, parse_cputime(fields.next()?)?))
}

/// `[[DD-]HH:]MM:SS[.ss]` -> centiseconds. `ps` uses this shape on both macOS
/// and Linux; the leading day field is separated by `-`.
fn parse_cputime(raw: &str) -> Option<u64> {
    let (days, rest) = match raw.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, raw),
    };
    let mut total = 0f64;
    for part in rest.split(':') {
        total = total * 60.0 + part.parse::<f64>().ok()?;
    }
    Some((total * 100.0) as u64 + days * 24 * 3600 * 100)
}

#[cfg(unix)]
#[test]
fn parse_applies_backpressure_when_the_reader_stalls() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path();
    for i in 0..FIXTURE_FILES {
        let mut src = String::new();
        // Long identifiers on purpose: each serialized record then carries ~1 KB
        // of name, so an unbounded backlog dwarfs the process baseline and the
        // RSS assertion below can actually tell the two designs apart.
        let pad = "x".repeat(300);
        for f in 0..10 {
            src.push_str(&format!(
                "export function fn_{pad}_{i}_{f}(a: number, b: string) {{\n  \
                 return helper_{pad}_{f}(a) + other_{pad}_{f}(b);\n}}\n"
            ));
        }
        std::fs::write(root.join(format!("m{i}.ts")), src).expect("write fixture");
    }

    let mut child = Command::new(binary())
        .arg("parse")
        .arg("--root")
        .arg(root)
        // Pin the worker count so the process baseline does not vary with the
        // host core count — otherwise the RSS ceiling below is machine-specific.
        .arg("--jobs")
        .arg("4")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn parse");

    // Do NOT read stdout. The pipe buffer fills, the writer thread blocks on
    // it, and everything the workers keep producing has nowhere to go.
    //
    // Sample until the footprint PLATEAUS rather than for a fixed window. A
    // fixed window silently makes this test vacuous in a debug build: the
    // parse is ~10x slower there, so a 2-second window ends long before the
    // backlog has accumulated and bounded/unbounded look identical. Waiting
    // for the plateau means "the producers are done and everything they made
    // is either in the 64 KiB pipe or in the child's heap" in both profiles.
    let pid = child.id();
    let mut peak_kib = 0u64;
    let mut last_cpu = 0u64;
    let mut flat_samples = 0u32;
    let mut settled = false;
    for _ in 0..1200 {
        std::thread::sleep(Duration::from_millis(100));
        let Some((kib, cpu)) = sample(pid) else { break };
        peak_kib = peak_kib.max(kib);
        if cpu > last_cpu {
            last_cpu = cpu;
            flat_samples = 0;
        } else {
            flat_samples += 1;
            if flat_samples >= 20 {
                settled = true; // 2 s of zero CPU: the producers are done.
                break;
            }
        }
    }
    assert!(
        settled,
        "the child never went CPU-idle, so the parse had not finished and the \
         measurement below would not mean anything"
    );
    assert!(
        peak_kib > 0,
        "could not sample the child's RSS — the process exited early?"
    );
    assert!(
        peak_kib < RSS_CEILING_KIB,
        "stalled parse child grew to {peak_kib} KiB (ceiling {RSS_CEILING_KIB} KiB): \
         the record channel is not applying backpressure"
    );

    // Now drain. A bounded channel is a place a pipeline can deadlock, so the
    // second half of this test is that the stream is still COMPLETE: the
    // workers must resume and the process must exit cleanly.
    let mut out = String::new();
    child
        .stdout
        .take()
        .expect("stdout")
        .read_to_string(&mut out)
        .expect("read stdout");
    let status = child.wait().expect("wait");
    assert!(status.success(), "parse exited with {status:?}");

    let done = out
        .lines()
        .find(|l| l.contains("\"type\":\"done\""))
        .expect("a done record must be emitted after the stall");
    assert!(
        done.contains(&format!("\"files_done\":{FIXTURE_FILES}")),
        "every fixture file must still be parsed after the stall: {done}"
    );
    assert!(
        out.lines().count() > 4096,
        "fixture must produce more records than the queue depth, else the \
         bound was never exercised (got {} lines)",
        out.lines().count()
    );
}
