package hayventrace

import (
	"sync"
	"time"
)

// CallKey identifies an observed edge in the call graph.
//
// Src and Dst are stable node-id strings (see the entity-id convention in
// the package doc). Kind is "call" for parity with the daemon's schema. The
// struct is comparable so it can be a map key directly.
type CallKey struct {
	Src  string
	Dst  string
	Kind string
}

// Observation is a flush-ready edge: src -> dst, a Unix-seconds timestamp,
// and the RAW count of how many times the edge was observed.
//
// Only Observed (the ground-truth count) is carried at the aggregator layer.
// Weight — the convenience value the daemon re-derives — is added by the
// flusher when it builds the wire payload, because only the flusher knows
// the envelope sample_rate (PRD §4.6: send both the ground truth and the
// convenience value, no hidden scaling).
type Observation struct {
	Src      string
	Dst      string
	Ts       int64
	Observed int
	Kind     string
}

// Aggregator accumulates call-edge counts in memory. It is safe for
// concurrent use: the trace/derivation path calls Add while the flusher
// calls Drain, both under a single mutex. Drain swaps the map atomically so
// the reset can never lose a concurrent increment.
type Aggregator struct {
	mu     sync.Mutex
	counts map[CallKey]int
}

// NewAggregator returns an empty, ready-to-use Aggregator.
func NewAggregator() *Aggregator {
	return &Aggregator{counts: make(map[CallKey]int)}
}

// Add records n occurrences of a single call edge. n is typically the count
// pprof attributes to an adjacent (caller, callee) frame pair within one
// derivation pass. Edges with empty src or dst are dropped (the daemon
// rejects them anyway).
func (a *Aggregator) Add(src, dst string, n int) {
	if src == "" || dst == "" || n <= 0 {
		return
	}
	k := CallKey{Src: src, Dst: dst, Kind: "call"}
	a.mu.Lock()
	if a.counts == nil {
		a.counts = make(map[CallKey]int)
	}
	a.counts[k] += n
	a.mu.Unlock()
}

// AddMany records one occurrence for each (src, dst) pair. Convenience for
// feeding a slice of derived edges.
func (a *Aggregator) AddMany(edges [][2]string) {
	a.mu.Lock()
	if a.counts == nil {
		a.counts = make(map[CallKey]int)
	}
	for _, e := range edges {
		if e[0] == "" || e[1] == "" {
			continue
		}
		a.counts[CallKey{Src: e[0], Dst: e[1], Kind: "call"}]++
	}
	a.mu.Unlock()
}

// Size returns the number of distinct edges currently held.
func (a *Aggregator) Size() int {
	a.mu.Lock()
	n := len(a.counts)
	a.mu.Unlock()
	return n
}

// Drain atomically returns all aggregated observations and resets state.
//
// Each returned Observation carries the current Unix timestamp (seconds) as
// Ts and the raw count as Observed. sample_rate scaling is applied downstream
// by the flusher. The order of the returned slice is unspecified (it follows
// Go's map iteration order).
func (a *Aggregator) Drain() []Observation {
	ts := time.Now().Unix()
	a.mu.Lock()
	counts := a.counts
	a.counts = make(map[CallKey]int)
	a.mu.Unlock()

	out := make([]Observation, 0, len(counts))
	for k, w := range counts {
		out = append(out, Observation{
			Src:      k.Src,
			Dst:      k.Dst,
			Ts:       ts,
			Observed: w,
			Kind:     k.Kind,
		})
	}
	return out
}
