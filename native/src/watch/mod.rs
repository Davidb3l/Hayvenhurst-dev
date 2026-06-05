//! `watch` subcommand — native OS file watcher.
//!
//! ARCHITECTURE.md §16. Streams §16.2 NDJSON records on stdout:
//!
//!   1. `version` (mandatory first record per §16.4)
//!   2. `ready`   (after the OS backend has registered)
//!   3. `change`  (one per coalesced filesystem event)
//!   4. `overflow` (when the OS event queue saturates — §16.5)
//!   5. `heartbeat` (every 15 s; lets the daemon detect a hung backend)
//!   6. `warn` / `fatal` (non-fatal / fatal anomalies)
//!
//! Cross-platform via the `notify` crate (FSEvents/inotify/RDCW). We do
//! NOT do daemon-side debouncing here — the daemon owns that, both
//! because it has the ingest pipeline context and because the watcher
//! should stay below 0.1% CPU at idle by doing as little as possible
//! per event.
//!
//! Path filtering matches the parse walker's skip list (target/,
//! node_modules/, .git/, …) so the daemon never has to debounce noise
//! from build caches.

use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use notify::event::{CreateKind, EventKind, Flag, ModifyKind, RemoveKind, RenameMode};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;

use crate::version_record;

// EXIT_OK is structurally implied (the watcher never returns 0 by design —
// see §16.5: it's a long-lived process, exit means parent killed it).
const EXIT_FATAL: i32 = 1;
/// Heartbeat cadence per §16.2 — every 15 seconds.
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Directories whose contents are never useful to watch. Mirrors
/// `parse::walker::ALWAYS_SKIP_DIRS` so the daemon never has to debounce
/// noise from a Cargo rebuild or an npm install.
const ALWAYS_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".hayven",
    ".git",
    ".next",
    ".turbo",
    ".cache",
];

/// One NDJSON record on the watcher's stdout. Internally tagged so the
/// daemon's parser dispatches by `type`.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WatchRecord {
    Ready {
        platform: &'static str,
        backend: &'static str,
    },
    Change {
        file: String,
        kind: &'static str,
        ts_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        from: Option<String>,
    },
    Overflow {
        dropped: u64,
        since_ms: u64,
    },
    Heartbeat {
        ts_ms: u64,
    },
    Warn {
        message: String,
    },
    Fatal {
        message: String,
    },
}

/// Entry point for `hayven-native watch --root <abs-path>`.
pub fn run(root: PathBuf) -> i32 {
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    // §16.4 handshake: version is the first line on stdout.
    if let Err(e) = write_record(&mut out, &version_record_value()) {
        // Stdout is broken; nothing else will work either.
        eprintln!("hayven-native watch: failed to write version handshake: {e}");
        return EXIT_FATAL;
    }

    // Canonicalize before passing to notify — relative paths or symlinks
    // confuse the per-file event normalization below.
    let root = match root.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            let _ = write_record(
                &mut out,
                &WatchRecord::Fatal {
                    message: format!("canonicalize {}: {e}", root.display()),
                },
            );
            return EXIT_FATAL;
        }
    };

    // Build a notify watcher. The channel buffers raw events while the
    // main thread translates and writes them.
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = match RecommendedWatcher::new(
        move |res| {
            // Best-effort delivery — if the receiver is gone we're
            // shutting down and can drop events.
            let _ = tx.send(res);
        },
        Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            let _ = write_record(
                &mut out,
                &WatchRecord::Fatal {
                    message: format!("create watcher: {e}"),
                },
            );
            return EXIT_FATAL;
        }
    };

    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        let _ = write_record(
            &mut out,
            &WatchRecord::Fatal {
                message: format!("watch {}: {e}", root.display()),
            },
        );
        return EXIT_FATAL;
    }

    // We have a live OS subscription; tell the daemon.
    if let Err(e) = write_record(
        &mut out,
        &WatchRecord::Ready {
            platform: platform_name(),
            backend: backend_name(),
        },
    ) {
        eprintln!("hayven-native watch: ready write failed: {e}");
        return EXIT_FATAL;
    }

    // Heartbeat ticker on its own thread — sends a sentinel through the
    // same channel so the main loop is a single select point.
    let (hb_tx, hb_rx) = mpsc::channel::<()>();
    let hb_handle = thread::spawn(move || loop {
        thread::sleep(HEARTBEAT_INTERVAL);
        if hb_tx.send(()).is_err() {
            // Receiver dropped — shut down quietly.
            break;
        }
    });

    // Overflow accounting. `overflow_count` accumulates rescan signals until
    // we emit a single coalesced Overflow record (like the heartbeat), so the
    // `dropped` field is an honest count and `since_ms` marks when the
    // uncertainty window opened rather than being reset on every event.
    let mut overflow_count: u64 = 0;
    let mut overflow_since_ms: u64 = 0;

    loop {
        // Poll both the event channel and the heartbeat tick. notify's
        // channel is mpsc; we use a small timeout so we can also flush
        // the heartbeat without spawning a select crate.
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(Ok(event)) => {
                // CRITICAL: notify surfaces queue saturation on the Ok(Ok)
                // path, NOT as a channel error. inotify Q_OVERFLOW and
                // FSEvents MUST_SCAN_SUBDIRS both arrive as
                // EventKind::Other + Flag::Rescan (verified against
                // notify 8.2.0 inotify.rs:212 / fsevent.rs:116). We must
                // catch the flag here or §16.5's "overflow → full rescan"
                // never fires and changes are silently lost.
                if is_overflow_event(&event) {
                    if overflow_count == 0 {
                        overflow_since_ms = now_ms();
                    }
                    overflow_count += 1;
                } else if let Some(record) = translate(&event, &root) {
                    if let Err(e) = write_record(&mut out, &record) {
                        eprintln!("hayven-native watch: stdout write failed: {e}");
                        return EXIT_FATAL;
                    }
                }
            }
            Ok(Err(e)) => {
                // Backend errors on the channel. The watch-registration limit
                // (inotify max_user_watches) also maps to an overflow-style
                // "we can't trust our view" signal.
                if is_overflow_err(&e) {
                    if overflow_count == 0 {
                        overflow_since_ms = now_ms();
                    }
                    overflow_count += 1;
                } else {
                    let _ = write_record(
                        &mut out,
                        &WatchRecord::Warn {
                            message: format!("backend error: {e}"),
                        },
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Fall through to the overflow/heartbeat flush below.
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The notify thread is gone; this is fatal.
                let _ = write_record(
                    &mut out,
                    &WatchRecord::Fatal {
                        message: "notify channel disconnected".to_string(),
                    },
                );
                drop(hb_handle);
                return EXIT_FATAL;
            }
        }

        // Coalesced overflow emit. One record per loop pass even if a burst of
        // rescan signals arrived, carrying the accumulated count and the
        // window-open timestamp.
        if overflow_count > 0 {
            let rec = WatchRecord::Overflow {
                dropped: overflow_count,
                since_ms: overflow_since_ms,
            };
            if let Err(we) = write_record(&mut out, &rec) {
                eprintln!("hayven-native watch: overflow write failed: {we}");
                return EXIT_FATAL;
            }
            overflow_count = 0;
        }

        // Drain any pending heartbeat ticks. We coalesce — if multiple
        // arrived while we were busy, emit one.
        let mut tick = false;
        while hb_rx.try_recv().is_ok() {
            tick = true;
        }
        if tick {
            if let Err(e) = write_record(&mut out, &WatchRecord::Heartbeat { ts_ms: now_ms() }) {
                eprintln!("hayven-native watch: heartbeat write failed: {e}");
                return EXIT_FATAL;
            }
        }
    }
}

/// Map a single `notify::Event` to a `WatchRecord::Change`, applying our
/// skip-list filter. Returns `None` when the event should be dropped
/// (build-cache directory, non-file, unsupported kind).
fn translate(event: &Event, root: &Path) -> Option<WatchRecord> {
    let kind = match &event.kind {
        EventKind::Create(CreateKind::File | CreateKind::Any) => "create",
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any) => "modify",
        EventKind::Modify(ModifyKind::Name(RenameMode::Any))
        | EventKind::Modify(ModifyKind::Name(RenameMode::To))
        | EventKind::Modify(ModifyKind::Name(RenameMode::From))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => "rename",
        EventKind::Remove(RemoveKind::File | RemoveKind::Any) => "delete",
        // Metadata-only, access events, etc. are not interesting for our
        // re-ingest pipeline. The daemon never bills CPU for them.
        _ => return None,
    };

    let path = event.paths.first()?;
    if is_under_skipped_dir(path, root) {
        return None;
    }

    // For rename events with both endpoints (RenameMode::Both), notify
    // reports source in paths[0] and dest in paths[1]. Surface dst as
    // `file` and src as `from`. For single-path rename events (just
    // From or just To), we report the one path we have and omit `from`.
    if kind == "rename" && event.paths.len() >= 2 {
        let from_path = &event.paths[0];
        let to_path = &event.paths[1];
        let from_rel = from_path.strip_prefix(root).unwrap_or(from_path);
        let to_rel = to_path.strip_prefix(root).unwrap_or(to_path);
        return Some(WatchRecord::Change {
            file: to_rel.to_string_lossy().replace('\\', "/"),
            kind,
            ts_ms: now_ms(),
            from: Some(from_rel.to_string_lossy().replace('\\', "/")),
        });
    }

    let rel = path.strip_prefix(root).unwrap_or(path);
    let file = rel.to_string_lossy().replace('\\', "/");
    Some(WatchRecord::Change {
        file,
        kind,
        ts_ms: now_ms(),
        from: None,
    })
}

/// Walk up `path` from the file toward `root`, returning true if any
/// directory along the way matches a skip-list name. Anchored at `root`
/// so a project literally named `node_modules/` doesn't self-exclude.
fn is_under_skipped_dir(path: &Path, root: &Path) -> bool {
    let mut cur = path.parent();
    while let Some(dir) = cur {
        if dir == root {
            return false;
        }
        if let Some(name) = dir.file_name().and_then(|s| s.to_str()) {
            if ALWAYS_SKIP_DIRS.contains(&name) {
                return true;
            }
        }
        cur = dir.parent();
    }
    false
}

fn write_record<T: Serialize>(out: &mut impl Write, rec: &T) -> io::Result<()> {
    let mut buf = serde_json::to_vec(rec)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    buf.push(b'\n');
    out.write_all(&buf)?;
    out.flush()
}

fn version_record_value() -> serde_json::Value {
    serde_json::to_value(version_record()).unwrap_or(serde_json::json!({"type": "version"}))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "other"
    }
}

fn backend_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "fsevents"
    } else if cfg!(target_os = "linux") {
        "inotify"
    } else if cfg!(target_os = "windows") {
        "rdcw"
    } else {
        "poll"
    }
}

/// True when an `Ok(Ok(event))` is actually a queue-saturation signal rather
/// than a real change. notify 8.x delivers inotify Q_OVERFLOW and FSEvents
/// MUST_SCAN_SUBDIRS as `EventKind::Other` carrying `Flag::Rescan` — NOT as a
/// channel error. The daemon turns this into a full re-scan (§16.5).
fn is_overflow_event(event: &Event) -> bool {
    event.flag() == Some(Flag::Rescan)
}

/// Recognize the remaining backend-error saturation cases that DO arrive on
/// the `Ok(Err(_))` channel branch — chiefly the inotify watch-registration
/// limit (`max_user_watches`). Queue overflow does NOT come through here; see
/// `is_overflow_event`.
fn is_overflow_err(err: &notify::Error) -> bool {
    match err.kind {
        notify::ErrorKind::MaxFilesWatch => true,
        _ => {
            let msg = err.to_string().to_lowercase();
            msg.contains("overflow") || msg.contains("must scan")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rescan_flagged_event_is_overflow() {
        // The exact shape notify produces on inotify Q_OVERFLOW / FSEvents
        // MUST_SCAN_SUBDIRS. Regression guard for the bug where these were
        // dropped by translate()'s catch-all and overflow never fired.
        let ev = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(is_overflow_event(&ev));
    }

    #[test]
    fn ordinary_event_is_not_overflow() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Content,
        )));
        assert!(!is_overflow_event(&ev));
    }

    #[test]
    fn rescan_event_is_not_translated_as_a_change() {
        // It must NOT also produce a Change record (would double-report).
        let ev = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert!(translate(&ev, std::path::Path::new("/")).is_none());
    }
}
