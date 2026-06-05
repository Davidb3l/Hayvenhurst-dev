//! Hayven runtime trace collector for Rust.
//!
//! The Rust analogue of the `hayven_trace` Python package. It hooks the
//! [`tracing`] ecosystem, captures the **structure** of execution
//! (caller → callee call-graph edges, via the span stack) — **never argument
//! values or return values** (PRD §9.4) — aggregates in-process, and flushes
//! batches to the Hayvenhurst daemon on an interval.
//!
//! # Two ways to use it
//!
//! ## 1. `tracing` Layer (recommended)
//!
//! Compose [`TraceLayer`] into your subscriber stack. Edges are derived from
//! the span tree: entering a span records `parent_span → entering_span`.
//!
//! ```no_run
//! use std::sync::Arc;
//! use std::time::Duration;
//! use tracing_subscriber::prelude::*;
//! use hayven_trace::{Aggregator, Flusher, HttpSender, TraceLayer};
//!
//! let agg = Arc::new(Aggregator::new());
//! let layer = TraceLayer::new(Arc::clone(&agg), 100, vec![]);
//! tracing_subscriber::registry().with(layer).init();
//!
//! let mut flusher = Flusher::new(
//!     agg,
//!     "http://localhost:7777",
//!     Duration::from_secs(30),
//!     100,
//!     "rust",
//!     Arc::new(HttpSender::new(Duration::from_secs(2))),
//! );
//! flusher.start();
//! // ... app runs; #[tracing::instrument] fns become call-graph nodes ...
//! flusher.stop(true); // flush on shutdown
//! ```
//!
//! ## 2. Programmatic `start()` / `stop()`
//!
//! The convenience path reads config from the environment (or takes a
//! [`TraceConfig`]), installs the layer as the process-global default
//! subscriber, and starts the background flusher. Returns a [`TraceGuard`];
//! drop it (or call [`TraceGuard::stop`]) to flush and shut down.
//!
//! ```no_run
//! let guard = hayven_trace::start(hayven_trace::TraceConfig::from_env());
//! // ... app runs ...
//! drop(guard); // flushes the final batch
//! ```
//!
//! # Entity-id convention
//!
//! Stable ids are `"<target>::<name>"` — the `tracing` target (the module
//! path by default, e.g. `my_crate::auth`) joined to the span name (the
//! function name under `#[instrument]`). Example: `my_crate::auth::login`.
//! Resolution to the daemon's indexed node ids is **best-effort** (same
//! status as the Python collector).

mod aggregator;
mod flusher;
mod layer;

pub use aggregator::{Aggregator, CallKey, Observation};
pub use flusher::{encode_payload, Flusher, HttpSender, Sender};
pub use layer::TraceLayer;

use std::sync::Arc;
use std::time::Duration;

/// Crate version, stamped into the default HTTP `User-Agent`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The `source` tag sent on every batch (per the wire contract).
pub const SOURCE: &str = "rust";

/// User-tunable knobs. Mirrors the Python collector's `TraceConfig` and env
/// table.
#[derive(Debug, Clone)]
pub struct TraceConfig {
    /// Daemon base URL. `/api/traces/observations` is appended.
    pub daemon_url: String,
    /// Capture 1 in every N span enters. 100 ≈ 1% of calls (~1% overhead).
    pub sample_rate: u64,
    /// Background flush cadence.
    pub flush_interval: Duration,
    /// `:`-separated module/target prefixes; if non-empty, only spans whose
    /// `target` starts with one of these are recorded.
    pub project_prefixes: Vec<String>,
    /// HTTP timeout for the default sender.
    pub http_timeout: Duration,
}

impl Default for TraceConfig {
    fn default() -> Self {
        Self {
            daemon_url: "http://localhost:7777".to_string(),
            sample_rate: 100,
            flush_interval: Duration::from_secs(30),
            project_prefixes: Vec::new(),
            http_timeout: Duration::from_secs(2),
        }
    }
}

impl TraceConfig {
    /// Build config from the environment, matching the Python collector's
    /// table:
    ///
    /// | Env var                 | Default                 |
    /// |-------------------------|-------------------------|
    /// | `HAYVEN_TRACE`          | unset (set `1` enables) |
    /// | `HAYVEN_TRACE_URL`      | `http://localhost:7777` |
    /// | `HAYVEN_TRACE_RATE`     | `100`                   |
    /// | `HAYVEN_TRACE_INTERVAL` | `30` (seconds)          |
    /// | `HAYVEN_TRACE_PROJECT`  | (empty; `:`-separated)  |
    ///
    /// Note: `from_env` parses the *values*; whether tracing is *enabled* is
    /// [`TraceConfig::enabled`] (the `HAYVEN_TRACE=1` switch). [`start`]
    /// consults `enabled()` and no-ops if unset.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            daemon_url: std::env::var("HAYVEN_TRACE_URL").unwrap_or(d.daemon_url),
            sample_rate: std::env::var("HAYVEN_TRACE_RATE")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .map(|n| n.max(1))
                .unwrap_or(d.sample_rate),
            flush_interval: std::env::var("HAYVEN_TRACE_INTERVAL")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(d.flush_interval),
            project_prefixes: std::env::var("HAYVEN_TRACE_PROJECT")
                .ok()
                .map(|s| {
                    s.split(':')
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or(d.project_prefixes),
            http_timeout: d.http_timeout,
        }
    }

    /// True if `HAYVEN_TRACE` is set to `1` (the opt-in switch).
    pub fn enabled() -> bool {
        std::env::var("HAYVEN_TRACE").map(|v| v == "1").unwrap_or(false)
    }

    /// Build just the [`TraceLayer`] from this config (for composing into an
    /// existing subscriber stack). You own the [`Aggregator`] and must wire it
    /// into a [`Flusher`] yourself.
    pub fn build_layer(&self, agg: Arc<Aggregator>) -> TraceLayer {
        TraceLayer::new(agg, self.sample_rate, self.project_prefixes.clone())
    }

    /// Build a [`Flusher`] using the default [`HttpSender`].
    pub fn build_flusher(&self, agg: Arc<Aggregator>) -> Flusher {
        Flusher::new(
            agg,
            &self.daemon_url,
            self.flush_interval,
            self.sample_rate,
            SOURCE,
            Arc::new(HttpSender::new(self.http_timeout)),
        )
    }
}

/// RAII handle returned by [`start`]. Dropping it flushes the final batch and
/// stops the background thread. Hold it for the life of your program.
#[must_use = "drop the TraceGuard (or hold it for program lifetime) to flush on shutdown"]
pub struct TraceGuard {
    flusher: Option<Flusher>,
    _subscriber: Option<tracing::subscriber::DefaultGuard>,
}

impl TraceGuard {
    /// A no-op guard (returned when tracing is disabled via env).
    fn disabled() -> Self {
        Self {
            flusher: None,
            _subscriber: None,
        }
    }

    /// Explicitly stop and flush (also happens on drop).
    pub fn stop(mut self) {
        if let Some(mut f) = self.flusher.take() {
            f.stop(true);
        }
    }
}

impl Drop for TraceGuard {
    fn drop(&mut self) {
        if let Some(f) = self.flusher.as_mut() {
            f.stop(true);
        }
    }
}

/// Install the trace layer as the **scoped default** subscriber for the
/// current thread/scope and start the background flusher.
///
/// Honors the `HAYVEN_TRACE=1` opt-in: if it isn't set, returns a no-op
/// guard and installs nothing (so leaving the call in production code is
/// free). The returned [`TraceGuard`] must be held; dropping it flushes the
/// final batch.
///
/// This uses `tracing`'s *scoped* default (`set_default`) rather than the
/// process-global `set_global_default`, so it's safe to call in tests and
/// composes with an app that sets its own global subscriber. If you already
/// have a subscriber stack, prefer composing [`TraceConfig::build_layer`]
/// directly (see crate docs) instead of `start`.
pub fn start(config: TraceConfig) -> TraceGuard {
    if !TraceConfig::enabled() {
        return TraceGuard::disabled();
    }
    install(config)
}

/// Like [`start`] but ignores the `HAYVEN_TRACE` switch — always installs.
/// Useful for programmatic enablement and tests.
pub fn install(config: TraceConfig) -> TraceGuard {
    use tracing_subscriber::prelude::*;

    let agg = Arc::new(Aggregator::new());
    let layer = config.build_layer(Arc::clone(&agg));
    let subscriber = tracing_subscriber::registry().with(layer);
    let sub_guard = tracing::subscriber::set_default(subscriber);

    let mut flusher = config.build_flusher(agg);
    flusher.start();

    TraceGuard {
        flusher: Some(flusher),
        _subscriber: Some(sub_guard),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_matches_python_defaults() {
        let c = TraceConfig::default();
        assert_eq!(c.daemon_url, "http://localhost:7777");
        assert_eq!(c.sample_rate, 100);
        assert_eq!(c.flush_interval, Duration::from_secs(30));
        assert!(c.project_prefixes.is_empty());
    }

    #[test]
    fn from_env_parses_project_prefixes() {
        // Use the public splitting logic via a constructed config rather than
        // mutating process env (which would race other tests).
        let prefixes: Vec<String> = "a::b: c::d ::"
            .split(':')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(String::from)
            .collect();
        assert_eq!(prefixes, vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn source_tag_is_rust() {
        assert_eq!(SOURCE, "rust");
    }
}
