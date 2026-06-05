//! In-process aggregation of `(src, dst)` call observations.
//!
//! The aggregator is the only piece of shared state the trace hot path
//! touches besides the sample counter. It must be cheap to update — a
//! `HashMap<CallKey, u64>` keyed by the `(src, dst, kind)` edge is the
//! simplest fast option, mirroring the Python collector's `dict`.
//!
//! Concurrency: the `tracing` layer's `on_enter` runs on whatever thread is
//! executing user code. We take a coarse [`Mutex`] around aggregation writes;
//! `drain` also grabs it to atomically swap the counter map. Contention is
//! bounded because we only write on *sampled* spans (1 in N).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Identifies an observed edge in the call graph.
///
/// `src` and `dst` are stable node-id strings (see the crate-level docs for
/// the entity-id convention). The daemon resolves these to graph nodes
/// best-effort.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CallKey {
    pub src: String,
    pub dst: String,
    pub kind: String,
}

impl CallKey {
    pub fn new(src: impl Into<String>, dst: impl Into<String>) -> Self {
        Self {
            src: src.into(),
            dst: dst.into(),
            kind: "call".to_string(),
        }
    }
}

/// A flush-ready observation: `src → dst`, `ts`, and the raw sample count.
///
/// Only `observed` (the raw sampled count) is carried at the aggregator
/// layer. `weight` — the scaled estimate of total invocations — is added by
/// the flusher when it builds the wire payload, because only the flusher
/// knows the sample rate the daemon will use to verify the conversion
/// (PRD §4.6: carry both the ground truth and the convenience value, no
/// hidden scaling).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub src: String,
    pub dst: String,
    /// Unix seconds (the daemon requires a finite number in UNIX SECONDS).
    pub ts: u64,
    /// Raw sampled count for this edge.
    pub observed: u64,
    pub kind: String,
}

/// Accumulates call counts in memory, flushed atomically by [`Aggregator::drain`].
#[derive(Debug)]
pub struct Aggregator {
    counts: Mutex<HashMap<CallKey, u64>>,
}

impl Default for Aggregator {
    fn default() -> Self {
        Self::new()
    }
}

impl Aggregator {
    pub fn new() -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
        }
    }

    /// Record a single sampled call edge (`weight` is the increment, usually 1).
    pub fn add(&self, src: impl Into<String>, dst: impl Into<String>, weight: u64) {
        let key = CallKey::new(src, dst);
        let mut guard = self.counts.lock().unwrap_or_else(|p| p.into_inner());
        *guard.entry(key).or_insert(0) += weight;
    }

    /// Number of distinct edges currently held.
    pub fn size(&self) -> usize {
        let guard = self.counts.lock().unwrap_or_else(|p| p.into_inner());
        guard.len()
    }

    /// Atomically return all aggregated observations and reset state.
    ///
    /// Returned observations carry the current Unix timestamp as `ts` and the
    /// raw sample count as `observed`. Sample-rate scaling is applied
    /// downstream by the flusher.
    pub fn drain(&self) -> Vec<Observation> {
        let ts = now_unix_secs();
        let taken: HashMap<CallKey, u64> = {
            let mut guard = self.counts.lock().unwrap_or_else(|p| p.into_inner());
            std::mem::take(&mut *guard)
        };
        taken
            .into_iter()
            .map(|(k, observed)| Observation {
                src: k.src,
                dst: k.dst,
                ts,
                observed,
                kind: k.kind,
            })
            .collect()
    }
}

/// Current wall-clock time in Unix seconds. Falls back to 0 if the system
/// clock is somehow before the epoch (never panics into user code).
pub(crate) fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn add_single_edge_counts() {
        let a = Aggregator::new();
        a.add("mod::foo", "mod::bar", 1);
        a.add("mod::foo", "mod::bar", 1);
        a.add("mod::foo", "mod::baz", 1);
        let obs = a.drain();
        let mut by_edge = HashMap::new();
        for o in obs {
            by_edge.insert((o.src, o.dst), o.observed);
        }
        assert_eq!(by_edge[&("mod::foo".into(), "mod::bar".into())], 2);
        assert_eq!(by_edge[&("mod::foo".into(), "mod::baz".into())], 1);
    }

    #[test]
    fn drain_resets_state_atomically() {
        let a = Aggregator::new();
        a.add("a", "b", 1);
        assert_eq!(a.size(), 1);
        let drained = a.drain();
        assert_eq!(drained.len(), 1);
        // After drain the map is empty.
        assert_eq!(a.size(), 0);
        // A second drain yields nothing.
        assert!(a.drain().is_empty());
        // And the aggregator is reusable.
        a.add("a", "b", 1);
        assert_eq!(a.size(), 1);
    }

    #[test]
    fn observation_carries_observed_not_weight() {
        let a = Aggregator::new();
        a.add("mod::caller", "mod::callee", 1);
        let obs = a.drain();
        assert_eq!(obs.len(), 1);
        let o = &obs[0];
        assert_eq!(o.src, "mod::caller");
        assert_eq!(o.dst, "mod::callee");
        assert_eq!(o.kind, "call");
        assert_eq!(o.observed, 1);
    }

    #[test]
    fn concurrent_adds_are_consistent() {
        let a = Arc::new(Aggregator::new());
        const THREADS: u64 = 8;
        const PER: u64 = 5000;
        let mut handles = Vec::new();
        for _ in 0..THREADS {
            let a = Arc::clone(&a);
            handles.push(thread::spawn(move || {
                for i in 0..PER {
                    a.add("src", format!("dst{}", i % 4), 1);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let obs = a.drain();
        let total: u64 = obs.iter().map(|o| o.observed).sum();
        assert_eq!(total, THREADS * PER);
        // 4 distinct dsts.
        assert_eq!(obs.len(), 4);
    }
}
