package hayventrace

import (
	"runtime"
	"strings"
	"sync"
	"time"
)

// Config holds the user-tunable knobs. The zero value is usable: it expands
// to the documented defaults (daemon at http://localhost:7777, 30s flush,
// pprof-honest sample_rate=1, stdlib/runtime frames dropped).
type Config struct {
	// DaemonURL is the daemon base URL; "/api/traces/observations" is
	// appended. Empty -> "http://localhost:7777".
	DaemonURL string

	// FlushInterval is the background flush cadence AND the stack-sampling
	// cadence. <= 0 -> 30s.
	FlushInterval time.Duration

	// SampleInterval is how often a stack sample is taken between flushes.
	// <= 0 -> 10ms. A smaller value means more samples (finer edge counts,
	// more overhead). This is pprof-style time sampling.
	SampleInterval time.Duration

	// SampleRate is the envelope sample_rate. In pprof mode this is 1
	// (observed == weight). Set > 1 only if you implement a true 1-in-N hook
	// upstream; the daemon invariant weight == observed*sample_rate must hold.
	// <= 0 -> 1.
	SampleRate int

	// ProjectPrefixes scopes which frames are recorded: only frames whose
	// symbol name starts with one of these import-path prefixes are kept.
	// Empty -> keep everything except stdlib/runtime (see DropRuntime).
	ProjectPrefixes []string

	// DropRuntime drops Go runtime/stdlib frames (default true). When
	// ProjectPrefixes is set this is implied (anything outside the prefixes
	// is dropped anyway), but it still removes runtime frames that happen to
	// sit between project frames on the stack.
	DropRuntime bool

	// Source is the batch source tag. Empty -> "go".
	Source string

	// Sender is the injectable transport (the test seam). nil -> stdlib HTTP.
	Sender Sender

	// Timeout bounds each HTTP POST. <= 0 -> 2s.
	Timeout time.Duration
}

func (c Config) withDefaults() Config {
	if c.DaemonURL == "" {
		c.DaemonURL = "http://localhost:7777"
	}
	if c.FlushInterval <= 0 {
		c.FlushInterval = 30 * time.Second
	}
	if c.SampleInterval <= 0 {
		c.SampleInterval = 10 * time.Millisecond
	}
	if c.SampleRate <= 0 {
		c.SampleRate = 1
	}
	if c.Source == "" {
		c.Source = "go"
	}
	if c.Timeout <= 0 {
		c.Timeout = 2 * time.Second
	}
	// DropRuntime defaults to true; the zero value (false) is overridden only
	// here so callers who never set Config get the safe default. Callers who
	// genuinely want runtime frames set ProjectPrefixes or build the Collector
	// directly. We treat the unset bool as "true" via DropRuntimeSet semantics
	// in NewCollector; see Start.
	return c
}

// Collector owns the sampler goroutine, the aggregator, and the flusher. It
// periodically snapshots live goroutine call stacks (pprof-style sampling),
// derives caller->callee edges from adjacent frames, and feeds them to the
// aggregator. The flusher drains and POSTs on its own cadence.
type Collector struct {
	cfg      Config
	agg      *Aggregator
	flusher  *Flusher
	prefixes []string

	mu       sync.Mutex
	running  bool
	stop     chan struct{}
	done     chan struct{}
	profBuf  []runtime.StackRecord // reused snapshot buffer
	selfName string
}

// Start builds a Collector from cfg, installs the sampler and flusher, and
// returns it. Call Stop to shut down and flush a final batch.
//
// DropRuntime defaults to true here (the zero Config drops runtime/stdlib
// frames). To keep them, build via NewCollector with DropRuntime explicitly
// set as you wish.
func Start(cfg Config) *Collector {
	if !cfg.DropRuntime && len(cfg.ProjectPrefixes) == 0 {
		// Zero-config default: drop runtime/stdlib noise.
		cfg.DropRuntime = true
	}
	c := NewCollector(cfg)
	c.Start()
	return c
}

// NewCollector builds a Collector without starting it. Tests use this to
// inject a mock Sender and drive sampling/flush manually.
func NewCollector(cfg Config) *Collector {
	cfg = cfg.withDefaults()
	agg := NewAggregator()
	opts := []FlusherOption{
		WithInterval(cfg.FlushInterval),
		WithSampleRate(cfg.SampleRate),
		WithTimeout(cfg.Timeout),
		WithSource(cfg.Source),
	}
	if cfg.Sender != nil {
		opts = append(opts, WithSender(cfg.Sender))
	}
	return &Collector{
		cfg:      cfg,
		agg:      agg,
		flusher:  NewFlusher(agg, cfg.DaemonURL, opts...),
		prefixes: cfg.ProjectPrefixes,
		selfName: "github.com/hayvenhurst/hayven-trace",
	}
}

// Aggregator exposes the underlying aggregator (for tests/inspection).
func (c *Collector) Aggregator() *Aggregator { return c.agg }

// Flusher exposes the underlying flusher (for tests/inspection).
func (c *Collector) Flusher() *Flusher { return c.flusher }

// Start launches the sampler and the background flusher. Idempotent.
func (c *Collector) Start() {
	c.mu.Lock()
	if c.running {
		c.mu.Unlock()
		return
	}
	c.running = true
	c.stop = make(chan struct{})
	c.done = make(chan struct{})
	c.mu.Unlock()

	c.flusher.Start()
	go c.sampleLoop()
}

// Stop halts the sampler, stops the flusher, and flushes a final batch.
func (c *Collector) Stop() {
	c.mu.Lock()
	if !c.running {
		c.mu.Unlock()
		return
	}
	c.running = false
	close(c.stop)
	done := c.done
	c.mu.Unlock()

	if done != nil {
		<-done
	}
	c.flusher.Stop(true)
}

// FlushOnce drains and POSTs immediately, returning the batch size.
func (c *Collector) FlushOnce() int { return c.flusher.FlushOnce() }

// sampleLoop takes a goroutine-stack snapshot every SampleInterval and feeds
// the derived edges into the aggregator. This is the pprof-style time
// sampler: each tick is one "sample"; an edge's observed count is the number
// of samples in which the adjacent (caller, callee) frame pair appeared.
func (c *Collector) sampleLoop() {
	defer close(c.done)
	t := time.NewTicker(c.cfg.SampleInterval)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			c.sampleOnce()
		}
	}
}

// sampleOnce captures all live goroutine stacks and aggregates their edges.
func (c *Collector) sampleOnce() {
	stacks := c.snapshot()
	for _, st := range stacks {
		names := c.resolve(st)
		for _, e := range edgesFromNames(names) {
			c.agg.Add(e[0], e[1], 1)
		}
	}
}

// snapshot returns the current set of goroutine stacks as PC slices, using
// runtime.GoroutineProfile (pure stdlib). The buffer is grown and reused.
func (c *Collector) snapshot() [][]uintptr {
	// GoroutineProfile fills a slice of StackRecords; it returns ok=false if
	// the buffer is too small, telling us the needed size.
	for {
		n, ok := runtime.GoroutineProfile(c.profBuf)
		if ok {
			out := make([][]uintptr, 0, n)
			for i := 0; i < n; i++ {
				out = append(out, trimZeros(c.profBuf[i].Stack0[:]))
			}
			return out
		}
		// Grow with headroom and retry.
		c.profBuf = make([]runtime.StackRecord, n+8)
	}
}

func trimZeros(pcs []uintptr) []uintptr {
	for i, pc := range pcs {
		if pc == 0 {
			return pcs[:i]
		}
	}
	return pcs
}

// resolve turns a PC slice into an ordered list of symbol names, applying the
// project/runtime frame filters. The returned slice is leaf-first (index 0 is
// the currently-executing frame), matching runtime.CallersFrames ordering.
func (c *Collector) resolve(pcs []uintptr) []string {
	if len(pcs) == 0 {
		return nil
	}
	// runtime.CallersFrames expects PCs as returned by runtime.Callers; the
	// StackRecord PCs are return addresses, so the standard idiom applies.
	frames := runtime.CallersFrames(pcs)
	var names []string
	for {
		fr, more := frames.Next()
		name := fr.Function
		if name != "" && c.keepFrame(name) {
			names = append(names, name)
		}
		if !more {
			break
		}
	}
	return names
}

// keepFrame applies the configured scoping filters to a symbol name.
func (c *Collector) keepFrame(name string) bool {
	// Never record our own frames — they would amplify the trace's cost.
	if strings.HasPrefix(name, c.selfName) {
		return false
	}
	if len(c.prefixes) > 0 {
		for _, p := range c.prefixes {
			if strings.HasPrefix(name, p) {
				return true
			}
		}
		return false
	}
	if c.cfg.DropRuntime && isRuntimeFrame(name) {
		return false
	}
	return true
}

// isRuntimeFrame reports whether a symbol belongs to the Go runtime/stdlib.
// Heuristic: stdlib symbol names have no domain-style "." before the first
// "/" (e.g. "runtime.main", "net/http.(*Server).Serve", "sync.(*Mutex).Lock")
// whereas third-party/project packages carry an import host
// ("github.com/...", "example.com/..."). It is best-effort, matching the
// Python collector's stdlib-prefix filter status.
func isRuntimeFrame(name string) bool {
	// Find the package path portion (everything up to the last "/" before the
	// first "."). Simplest reliable signal: does the first path segment
	// contain a "."? Project/3rd-party import paths start with a hostname
	// like "github.com". Stdlib paths ("net/http", "runtime") do not.
	slash := strings.IndexByte(name, '/')
	var firstSeg string
	if slash >= 0 {
		firstSeg = name[:slash]
	} else {
		// No slash: take everything before the first "." (package name).
		if dot := strings.IndexByte(name, '.'); dot >= 0 {
			firstSeg = name[:dot]
		} else {
			firstSeg = name
		}
	}
	return !strings.Contains(firstSeg, ".")
}

// edgesFromNames derives caller->callee edges from a leaf-first stack of
// symbol names. Adjacent frames form an edge: names[i+1] (caller) ->
// names[i] (callee). Returns [][2]string{ {src,dst}, ... }.
//
// This is the unit-testable core of the pprof stack -> edge derivation. It is
// pure: it depends only on the ordered names, not on the runtime.
func edgesFromNames(names []string) [][2]string {
	if len(names) < 2 {
		return nil
	}
	edges := make([][2]string, 0, len(names)-1)
	for i := 0; i+1 < len(names); i++ {
		callee := names[i]
		caller := names[i+1]
		if caller == "" || callee == "" || caller == callee {
			continue
		}
		edges = append(edges, [2]string{caller, callee})
	}
	return edges
}
