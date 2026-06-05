package hayventrace

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

// maxCount is the daemon's per-observation ceiling on `observed` and
// `weight` (UINT16_MAX; see daemon/src/daemon/routes/traces.ts). Values above
// it are rejected with HTTP 400, so we clamp. With sample_rate=1 a clamp on
// observed keeps weight == observed, preserving the invariant.
const maxCount = 0xffff

// Sender is the injectable transport. Production uses an HTTP POST; tests
// inject a mock so the flusher can be exercised without a live daemon. A
// non-nil error makes FlushOnce no-op gracefully (it is stashed, not raised).
type Sender interface {
	Send(ctx context.Context, url string, payload []byte) error
}

// SenderFunc adapts a function to the Sender interface.
type SenderFunc func(ctx context.Context, url string, payload []byte) error

// Send implements Sender.
func (f SenderFunc) Send(ctx context.Context, url string, payload []byte) error {
	return f(ctx, url, payload)
}

// wireObservation is the on-wire shape of a single observation. We carry BOTH
// the raw `observed` count and the daemon-convenience `weight` so the daemon
// can verify weight == observed * sample_rate (it 400s on mismatch).
type wireObservation struct {
	Src      string `json:"src"`
	Dst      string `json:"dst"`
	Ts       int64  `json:"ts"`
	Observed int    `json:"observed"`
	Weight   int    `json:"weight"`
	Kind     string `json:"kind"`
}

// wirePayload is the POST envelope. sample_rate is envelope-level.
type wirePayload struct {
	Source       string            `json:"source"`
	SampleRate   int               `json:"sample_rate"`
	Observations []wireObservation `json:"observations"`
}

// Flusher drains an Aggregator on an interval and POSTs the batch to the
// daemon. It runs on a background goroutine; a flush gracefully no-ops if the
// daemon is unreachable (the error is recorded, never propagated into user
// code). The transport is injectable for testing.
type Flusher struct {
	agg        *Aggregator
	url        string
	interval   time.Duration
	sampleRate int
	timeout    time.Duration
	source     string
	sender     Sender

	mu             sync.Mutex
	lastFlushAt    time.Time
	lastFlushCount int
	lastErr        error

	stop    chan struct{}
	done    chan struct{}
	running bool
}

// FlusherOption configures a Flusher.
type FlusherOption func(*Flusher)

// WithInterval sets the background flush cadence (default 30s).
func WithInterval(d time.Duration) FlusherOption {
	return func(f *Flusher) {
		if d > 0 {
			f.interval = d
		}
	}
}

// WithSampleRate sets the envelope sample_rate. For pprof mode this MUST be 1
// (observed == weight). Values < 1 are coerced to 1.
func WithSampleRate(r int) FlusherOption {
	return func(f *Flusher) {
		if r < 1 {
			r = 1
		}
		f.sampleRate = r
	}
}

// WithTimeout bounds each HTTP POST so a broken daemon never stalls a flush.
func WithTimeout(d time.Duration) FlusherOption {
	return func(f *Flusher) {
		if d > 0 {
			f.timeout = d
		}
	}
}

// WithSender injects a custom transport (the test seam).
func WithSender(s Sender) FlusherOption {
	return func(f *Flusher) {
		if s != nil {
			f.sender = s
		}
	}
}

// WithSource overrides the batch source tag (default "go").
func WithSource(src string) FlusherOption {
	return func(f *Flusher) {
		if src != "" {
			f.source = src
		}
	}
}

// NewFlusher builds a Flusher targeting daemonURL (the
// "/api/traces/observations" path is appended). With no options it uses the
// pprof-honest defaults: source="go", sample_rate=1, interval=30s, and the
// stdlib HTTP sender.
func NewFlusher(agg *Aggregator, daemonURL string, opts ...FlusherOption) *Flusher {
	f := &Flusher{
		agg:        agg,
		url:        joinURL(daemonURL, "/api/traces/observations"),
		interval:   30 * time.Second,
		sampleRate: 1,
		timeout:    2 * time.Second,
		source:     "go",
	}
	for _, o := range opts {
		o(f)
	}
	if f.sender == nil {
		f.sender = &httpSender{client: &http.Client{Timeout: f.timeout}}
	}
	return f
}

func joinURL(base, path string) string {
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	return base + path
}

// Start launches the background flush goroutine. Idempotent.
func (f *Flusher) Start() {
	f.mu.Lock()
	if f.running {
		f.mu.Unlock()
		return
	}
	f.running = true
	f.stop = make(chan struct{})
	f.done = make(chan struct{})
	f.mu.Unlock()
	go f.run()
}

// Stop halts the background goroutine. If flush is true it performs a final
// FlushOnce so the last batch is not lost on shutdown.
func (f *Flusher) Stop(flush bool) {
	f.mu.Lock()
	if f.running {
		close(f.stop)
		f.running = false
	}
	done := f.done
	f.mu.Unlock()

	if done != nil {
		<-done
	}
	if flush {
		f.FlushOnce()
	}
}

func (f *Flusher) run() {
	defer close(f.done)
	t := time.NewTicker(f.interval)
	defer t.Stop()
	for {
		select {
		case <-f.stop:
			return
		case <-t.C:
			f.FlushOnce()
		}
	}
}

// FlushOnce drains the aggregator and POSTs the batch. It returns the number
// of observations sent (0 if nothing was buffered). Transport errors are
// recorded on LastError and never propagated — a flush against an unreachable
// daemon is a graceful no-op.
func (f *Flusher) FlushOnce() int {
	obs := f.agg.Drain()
	if len(obs) == 0 {
		return 0
	}
	payload, err := f.encode(obs)
	if err != nil {
		f.mu.Lock()
		f.lastErr = err
		f.mu.Unlock()
		return len(obs)
	}
	ctx, cancel := context.WithTimeout(context.Background(), f.timeout)
	defer cancel()
	if err := f.sender.Send(ctx, f.url, payload); err != nil {
		f.mu.Lock()
		f.lastErr = err
		f.mu.Unlock()
		return len(obs)
	}
	f.mu.Lock()
	f.lastFlushAt = time.Now()
	f.lastFlushCount = len(obs)
	f.lastErr = nil
	f.mu.Unlock()
	return len(obs)
}

// encode builds the wire payload. It sends BOTH the raw `observed` count and
// `weight = observed * sample_rate`; the daemon re-derives weight and rejects
// a mismatch beyond ±1. Counts are clamped to the daemon's uint16 ceiling so
// a busy edge never trips the size guard (the clamp keeps the invariant since
// in pprof mode sample_rate == 1).
func (f *Flusher) encode(obs []Observation) ([]byte, error) {
	rate := f.sampleRate
	if rate < 1 {
		rate = 1
	}
	out := make([]wireObservation, 0, len(obs))
	for _, o := range obs {
		observed := o.Observed
		if observed > maxCount {
			observed = maxCount
		}
		weight := observed * rate
		if weight > maxCount {
			// Cannot happen when rate==1; for rate>1 clamp observed so the
			// invariant (weight == observed*rate) still holds exactly.
			observed = maxCount / rate
			weight = observed * rate
		}
		kind := o.Kind
		if kind == "" {
			kind = "call"
		}
		out = append(out, wireObservation{
			Src:      o.Src,
			Dst:      o.Dst,
			Ts:       o.Ts,
			Observed: observed,
			Weight:   weight,
			Kind:     kind,
		})
	}
	return json.Marshal(wirePayload{
		Source:       f.source,
		SampleRate:   rate,
		Observations: out,
	})
}

// LastError returns the most recent flush error, or nil. Useful for tests and
// diagnostics; it is never raised into user code.
func (f *Flusher) LastError() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastErr
}

// LastFlushCount returns the size of the most recent successful batch.
func (f *Flusher) LastFlushCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastFlushCount
}

// httpSender is the default stdlib transport.
type httpSender struct {
	client *http.Client
}

// Send POSTs the payload as application/json and discards the response body.
func (h *httpSender) Send(ctx context.Context, url string, payload []byte) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "hayven-trace-go/"+Version)
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	// Drain and close so the connection can be reused.
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return nil
}
