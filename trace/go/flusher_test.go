package hayventrace

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeSender records payloads and can be primed to fail.
type fakeSender struct {
	mu    sync.Mutex
	calls []capturedCall
	err   error
}

type capturedCall struct {
	url     string
	payload []byte
}

func (s *fakeSender) Send(_ context.Context, url string, payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	cp := make([]byte, len(payload))
	copy(cp, payload)
	s.calls = append(s.calls, capturedCall{url: url, payload: cp})
	return nil
}

func (s *fakeSender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls)
}

func decodePayload(t *testing.T, b []byte) wirePayload {
	t.Helper()
	var p wirePayload
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	return p
}

func TestFlushOnceEncodesEnvelope(t *testing.T) {
	agg := NewAggregator()
	agg.Add("a", "b", 2)
	agg.Add("a", "c", 1)
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithSender(fake), WithSampleRate(1))

	n := f.FlushOnce()
	if n != 2 {
		t.Fatalf("flushed %d, want 2 distinct edges", n)
	}
	if fake.count() != 1 {
		t.Fatalf("sender calls = %d, want 1", fake.count())
	}
	if fake.calls[0].url != "http://daemon/api/traces/observations" {
		t.Fatalf("url = %q", fake.calls[0].url)
	}
	body := decodePayload(t, fake.calls[0].payload)
	if body.Source != "go" {
		t.Fatalf("source = %q, want go", body.Source)
	}
	if body.SampleRate != 1 {
		t.Fatalf("sample_rate = %d, want 1", body.SampleRate)
	}
	byEdge := map[[2]string]wireObservation{}
	for _, o := range body.Observations {
		byEdge[[2]string{o.Src, o.Dst}] = o
	}
	ab := byEdge[[2]string{"a", "b"}]
	if ab.Observed != 2 || ab.Weight != 2 || ab.Kind != "call" {
		t.Fatalf("a->b = %+v, want observed=2 weight=2 kind=call", ab)
	}
	ac := byEdge[[2]string{"a", "c"}]
	if ac.Observed != 1 || ac.Weight != 1 {
		t.Fatalf("a->c = %+v, want observed=1 weight=1", ac)
	}

	// Drained — second flush is a no-op.
	if got := f.FlushOnce(); got != 0 {
		t.Fatalf("second flush = %d, want 0", got)
	}
}

func TestWeightInvariantHolds(t *testing.T) {
	// The daemon enforces weight == observed * sample_rate (±1) and 400s a
	// mismatch. Lock it client-side for both the pprof default (rate=1) and a
	// hypothetical true 1-in-N rate.
	for _, rate := range []int{1, 50} {
		agg := NewAggregator()
		agg.Add("alpha", "beta", 7)
		agg.Add("alpha", "gamma", 3)
		fake := &fakeSender{}
		f := NewFlusher(agg, "http://daemon", WithSender(fake), WithSampleRate(rate))
		f.FlushOnce()
		if fake.count() != 1 {
			t.Fatalf("rate=%d: sender calls = %d", rate, fake.count())
		}
		body := decodePayload(t, fake.calls[0].payload)
		if body.SampleRate != rate {
			t.Fatalf("rate=%d: sample_rate = %d", rate, body.SampleRate)
		}
		for _, o := range body.Observations {
			if o.Weight != o.Observed*body.SampleRate {
				t.Fatalf("rate=%d: weight=%d != observed=%d * rate=%d",
					rate, o.Weight, o.Observed, body.SampleRate)
			}
		}
	}
}

func TestFlushClampsToUint16Max(t *testing.T) {
	agg := NewAggregator()
	agg.Add("hot", "edge", maxCount+500) // above daemon ceiling
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithSender(fake), WithSampleRate(1))
	f.FlushOnce()
	body := decodePayload(t, fake.calls[0].payload)
	o := body.Observations[0]
	if o.Observed != maxCount || o.Weight != maxCount {
		t.Fatalf("clamp failed: observed=%d weight=%d, want %d", o.Observed, o.Weight, maxCount)
	}
	if o.Weight != o.Observed*body.SampleRate {
		t.Fatalf("invariant broken after clamp: weight=%d observed=%d rate=%d", o.Weight, o.Observed, body.SampleRate)
	}
}

func TestFlushSwallowsSenderErrors(t *testing.T) {
	agg := NewAggregator()
	agg.Add("x", "y", 1)
	fake := &fakeSender{err: errors.New("connection refused")}
	f := NewFlusher(agg, "http://daemon", WithSender(fake))

	// Must not panic / propagate.
	n := f.FlushOnce()
	if n != 1 {
		t.Fatalf("flushed %d, want 1 (drained even on error)", n)
	}
	if f.LastError() == nil {
		t.Fatalf("LastError = nil, want the sender error")
	}
}

func TestBackgroundFlusherDrainsPeriodically(t *testing.T) {
	agg := NewAggregator()
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithInterval(10*time.Millisecond), WithSender(fake), WithSampleRate(1))
	f.Start()
	for i := 0; i < 50; i++ {
		agg.Add("a", "b", 1)
		time.Sleep(time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	f.Stop(true)

	if fake.count() < 1 {
		t.Fatalf("no background flush happened")
	}
	total := 0
	for _, c := range fake.calls {
		body := decodePayload(t, c.payload)
		for _, o := range body.Observations {
			if o.Src == "a" && o.Dst == "b" {
				total += o.Weight
			}
		}
	}
	if total != 50 {
		t.Fatalf("total weight = %d, want 50 (sample_rate=1)", total)
	}
}

func TestStopWithoutFlushDoesNotSend(t *testing.T) {
	agg := NewAggregator()
	agg.Add("a", "b", 1)
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithInterval(time.Hour), WithSender(fake))
	f.Start()
	f.Stop(false)
	if fake.count() != 0 {
		t.Fatalf("sender calls = %d, want 0", fake.count())
	}
}

func TestJoinURL(t *testing.T) {
	cases := map[string]string{
		"http://localhost:7777":   "http://localhost:7777/api/traces/observations",
		"http://localhost:7777/":  "http://localhost:7777/api/traces/observations",
		"http://localhost:7777//": "http://localhost:7777/api/traces/observations",
	}
	for in, want := range cases {
		if got := joinURL(in, "/api/traces/observations"); got != want {
			t.Fatalf("joinURL(%q) = %q, want %q", in, got, want)
		}
	}
}
