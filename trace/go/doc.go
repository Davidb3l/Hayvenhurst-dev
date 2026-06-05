// Package hayventrace is a runtime call-graph trace collector for the
// Hayvenhurst code-intelligence daemon, mirroring the canonical Python
// collector (trace/python/) in idiomatic Go.
//
// It captures a CPU profile via runtime/pprof, walks each sample's call
// stack, and emits caller -> callee EDGES from adjacent frames. Edges are
// aggregated in memory (counts keyed by (src, dst)) and flushed to the
// daemon on a background goroutine every 30s by default.
//
// Privacy (PRD §9.4): only the STRUCTURE of execution is captured —
// caller -> callee edges. Argument values and return values are never read.
//
// Public surface:
//
//	c := hayventrace.Start(hayventrace.Config{}) // or hayventrace.StartFromEnv()
//	defer c.Stop()                                // flushes a final batch
//	// ... your code runs; pprof samples it in the background ...
//	c.FlushOnce()                                 // optional manual flush
//
// # pprof sampling and the weight = observed * sample_rate invariant
//
// The daemon enforces weight == observed * sample_rate (±1) on every
// observation and rejects the batch with HTTP 400 otherwise. pprof gives
// WEIGHTED sampled call stacks, not clean 1-in-N call counts, so we make an
// HONEST mapping: sample_rate = 1, and observed = weight = the count of
// times an edge appeared across pprof samples. We report pprof's sampled
// edge counts as ground truth with NO extrapolation, so the invariant holds
// trivially (weight = observed * 1). We are NOT claiming 1-in-N
// extrapolation — pprof's own sampling rate (hz) is the sampling; we report
// the sampled counts honestly.
//
// # Entity-id convention
//
// Frames are recorded as stable ids of the form "<import-path>.<Func>" or
// "<import-path>.<Type>.<Method>" — exactly what runtime.Func.Name() yields
// for a Go symbol (e.g. "github.com/hayvenhurst/hayven-trace.(*Aggregator).Add").
// Resolution to the daemon's §1 node ids (<scope>/<module>/<qualified_name>)
// is BEST-EFFORT, the same status as the Python collector today.
package hayventrace

// Version is the collector version, surfaced in the HTTP User-Agent.
const Version = "0.0.1"
