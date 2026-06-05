//! A [`tracing_subscriber::Layer`] that derives caller→callee call-graph
//! **edges** from the span stack.
//!
//! This is the idiomatic Rust integration point — the analogue of the Python
//! collector's `sys.settrace`. In Rust there is no global "every function
//! call" hook, so instead we observe the `tracing` span tree: each
//! `#[tracing::instrument]`-ed (or manually `span!`-ed) function becomes a
//! node, and **entering** a span records an edge from the parent span (the
//! caller) to the entering span (the callee).
//!
//! Hot-path discipline (mirrors the Python tracer):
//!
//! * On `on_enter` we do, in the common skip case, one atomic increment and a
//!   modulo — the sample-rate gate — before touching the aggregator.
//! * Entity ids (the `target` / name) are resolved at **`on_new_span`** time
//!   and cached in the span's registry extension, so `on_enter` (which can
//!   fire many times for one span) doesn't re-derive them.
//! * Project scoping filters by the span `target` (module path) prefix.
//!
//! Privacy (PRD §9.4): we read only span **metadata** — `target`, `name`,
//! module path, file. We never read field *values*, so argument and return
//! values can't leak.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tracing::span::{Attributes, Id};
use tracing::Subscriber;
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

use crate::aggregator::Aggregator;

/// Cached per-span entity id, stashed in the span's registry extension at
/// `on_new_span` time so `on_enter` is cheap.
#[derive(Clone)]
struct NodeId(String);

/// The trace layer. Construct via [`crate::TraceConfig::build_layer`] or
/// [`TraceLayer::new`].
pub struct TraceLayer {
    agg: Arc<Aggregator>,
    sample_rate: u64,
    counter: AtomicU64,
    /// `:`-separated module/target prefixes. If non-empty, ONLY spans whose
    /// `target` starts with one of these are recorded.
    project_prefixes: Vec<String>,
}

impl TraceLayer {
    pub fn new(agg: Arc<Aggregator>, sample_rate: u64, project_prefixes: Vec<String>) -> Self {
        Self {
            agg,
            sample_rate: sample_rate.max(1),
            counter: AtomicU64::new(0),
            project_prefixes,
        }
    }

    /// Whether a span with this `target` is in scope for recording.
    fn in_scope(&self, target: &str) -> bool {
        if self.project_prefixes.is_empty() {
            return true;
        }
        self.project_prefixes
            .iter()
            .any(|p| target.starts_with(p.as_str()))
    }
}

/// Build the stable entity id for a span from its metadata.
///
/// Convention (documented in the README): `"<target>::<name>"`, where
/// `target` is the `tracing` target — by default the module path,
/// e.g. `my_crate::auth` — and `name` is the span name (the function name for
/// `#[instrument]`). Example: `my_crate::auth::login`. This mirrors the
/// daemon's `<module>:<qualname>` shape with Rust's `::` path separator.
fn node_id_from_meta(meta: &tracing::Metadata<'_>) -> String {
    let target = meta.target();
    let name = meta.name();
    if target.is_empty() {
        name.to_string()
    } else {
        format!("{target}::{name}")
    }
}

impl<S> Layer<S> for TraceLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    /// Resolve and cache this span's entity id once, when the span is created.
    fn on_new_span(&self, _attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        let node = node_id_from_meta(span.metadata());
        span.extensions_mut().insert(NodeId(node));
    }

    /// Record the caller→callee edge on span entry.
    ///
    /// The "caller" is the current parent span (the span we were already
    /// inside when this one was entered); the "callee" is the entering span.
    fn on_enter(&self, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };

        // Scope filter on the callee's target.
        if !self.in_scope(span.metadata().target()) {
            return;
        }

        // Sample-rate gate: deterministic "every Nth enter", matching the
        // Python tracer (cheaper than RNG, reproducible in tests).
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        if n % self.sample_rate != 0 {
            return;
        }

        // Callee id (cached at on_new_span).
        let dst = span
            .extensions()
            .get::<NodeId>()
            .map(|n| n.0.clone())
            .unwrap_or_else(|| node_id_from_meta(span.metadata()));

        // Caller id: the parent span on the stack. If there is no parent we
        // are at an entry point; use a stable sentinel (matches the Python
        // collector's `<entry>`).
        let src = span
            .parent()
            .map(|p| {
                p.extensions()
                    .get::<NodeId>()
                    .map(|n| n.0.clone())
                    .unwrap_or_else(|| node_id_from_meta(p.metadata()))
            })
            .unwrap_or_else(|| "<entry>".to_string());

        self.agg.add(src, dst, 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::Level;
    use tracing_subscriber::prelude::*;

    fn collect_edges(agg: &Aggregator) -> std::collections::HashMap<(String, String), u64> {
        agg.drain()
            .into_iter()
            .map(|o| ((o.src, o.dst), o.observed))
            .collect()
    }

    #[test]
    fn records_parent_child_edge_at_full_rate() {
        let agg = Arc::new(Aggregator::new());
        let layer = TraceLayer::new(Arc::clone(&agg), 1, vec![]);
        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            let root = tracing::span!(Level::INFO, "root");
            let _r = root.enter();
            let child = tracing::span!(Level::INFO, "child");
            let _c = child.enter();
        });

        let edges = collect_edges(&agg);
        // The "child" span's parent is "root" → edge (root -> child) recorded.
        let has_root_child = edges.keys().any(|(s, d)| {
            s.ends_with("::root") && d.ends_with("::child")
        });
        assert!(has_root_child, "expected root->child edge, got {edges:?}");
        // Root has no parent span → recorded as <entry> -> root.
        let has_entry_root = edges
            .keys()
            .any(|(s, d)| s == "<entry>" && d.ends_with("::root"));
        assert!(has_entry_root, "expected <entry>->root edge, got {edges:?}");
    }

    #[test]
    fn sample_rate_thins_observations() {
        let agg = Arc::new(Aggregator::new());
        let layer = TraceLayer::new(Arc::clone(&agg), 1000, vec![]);
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            for _ in 0..50 {
                let s = tracing::span!(Level::INFO, "spin");
                let _e = s.enter();
            }
        });
        let edges = collect_edges(&agg);
        let total: u64 = edges.values().sum();
        // 1-in-1000 over 50 enters should record ~0.
        assert!(total <= 1, "expected ~0 at 1-in-1000, got {total}");
    }

    #[test]
    fn project_scope_filters_out_other_targets() {
        let agg = Arc::new(Aggregator::new());
        // Scope to a target prefix nothing in this test matches.
        let layer = TraceLayer::new(Arc::clone(&agg), 1, vec!["no_such_crate".into()]);
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            let s = tracing::span!(Level::INFO, "x");
            let _e = s.enter();
        });
        assert_eq!(agg.size(), 0, "out-of-scope spans must not be recorded");
    }

    #[test]
    fn node_id_uses_target_and_name() {
        // Spans created here have this module as their target.
        let agg = Arc::new(Aggregator::new());
        let layer = TraceLayer::new(Arc::clone(&agg), 1, vec![]);
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            let s = tracing::span!(Level::INFO, "my_fn");
            let _e = s.enter();
        });
        let edges = collect_edges(&agg);
        let dst = edges.keys().map(|(_s, d)| d.clone()).next().unwrap();
        assert!(dst.ends_with("::my_fn"), "got {dst}");
        assert!(dst.contains("layer"), "target should be the module path: {dst}");
    }
}
