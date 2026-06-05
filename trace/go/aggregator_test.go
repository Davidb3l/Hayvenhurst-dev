package hayventrace

import (
	"sync"
	"testing"
)

func TestAddSingleEdge(t *testing.T) {
	a := NewAggregator()
	a.Add("mod.foo", "mod.bar", 1)
	a.Add("mod.foo", "mod.bar", 1)
	a.Add("mod.foo", "mod.baz", 1)

	got := map[CallKey]int{}
	for _, o := range a.Drain() {
		got[CallKey{Src: o.Src, Dst: o.Dst, Kind: o.Kind}] = o.Observed
	}
	if got[CallKey{"mod.foo", "mod.bar", "call"}] != 2 {
		t.Fatalf("foo->bar = %d, want 2", got[CallKey{"mod.foo", "mod.bar", "call"}])
	}
	if got[CallKey{"mod.foo", "mod.baz", "call"}] != 1 {
		t.Fatalf("foo->baz = %d, want 1", got[CallKey{"mod.foo", "mod.baz", "call"}])
	}
}

func TestAddCountN(t *testing.T) {
	a := NewAggregator()
	a.Add("a", "b", 5)
	a.Add("a", "b", 3)
	obs := a.Drain()
	if len(obs) != 1 || obs[0].Observed != 8 {
		t.Fatalf("got %+v, want single edge observed=8", obs)
	}
}

func TestDrainResetsState(t *testing.T) {
	a := NewAggregator()
	a.Add("a", "b", 1)
	a.Drain()
	if a.Size() != 0 {
		t.Fatalf("size after drain = %d, want 0", a.Size())
	}
	// Draining empty returns no observations.
	if obs := a.Drain(); len(obs) != 0 {
		t.Fatalf("empty drain returned %d observations", len(obs))
	}
	a.Add("a", "b", 1)
	if a.Size() != 1 {
		t.Fatalf("size after re-add = %d, want 1", a.Size())
	}
}

func TestAddDropsEmptyAndNonPositive(t *testing.T) {
	a := NewAggregator()
	a.Add("", "b", 1)
	a.Add("a", "", 1)
	a.Add("a", "b", 0)
	a.Add("a", "b", -3)
	if a.Size() != 0 {
		t.Fatalf("size = %d, want 0 (all dropped)", a.Size())
	}
}

func TestObservationShape(t *testing.T) {
	a := NewAggregator()
	a.Add("mod.caller", "mod.callee", 1)
	obs := a.Drain()
	if len(obs) != 1 {
		t.Fatalf("len = %d, want 1", len(obs))
	}
	o := obs[0]
	if o.Src != "mod.caller" || o.Dst != "mod.callee" || o.Kind != "call" || o.Observed != 1 {
		t.Fatalf("unexpected observation %+v", o)
	}
	if o.Ts <= 0 {
		t.Fatalf("ts = %d, want positive unix seconds", o.Ts)
	}
}

func TestConcurrentAddsAreConsistent(t *testing.T) {
	a := NewAggregator()
	const threads = 8
	const per = 5000
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < threads; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for j := 0; j < per; j++ {
				a.Add("src", []string{"dst0", "dst1", "dst2", "dst3"}[j%4], 1)
			}
		}()
	}
	close(start)
	wg.Wait()

	obs := a.Drain()
	total := 0
	dsts := map[string]bool{}
	for _, o := range obs {
		total += o.Observed
		dsts[o.Dst] = true
	}
	if total != threads*per {
		t.Fatalf("total = %d, want %d", total, threads*per)
	}
	if len(dsts) != 4 {
		t.Fatalf("distinct dsts = %d, want 4", len(dsts))
	}
}

func TestAddMany(t *testing.T) {
	a := NewAggregator()
	a.AddMany([][2]string{{"x", "y"}, {"x", "y"}, {"x", "z"}, {"", "drop"}})
	got := map[CallKey]int{}
	for _, o := range a.Drain() {
		got[CallKey{o.Src, o.Dst, o.Kind}] = o.Observed
	}
	if got[CallKey{"x", "y", "call"}] != 2 {
		t.Fatalf("x->y = %d, want 2", got[CallKey{"x", "y", "call"}])
	}
	if got[CallKey{"x", "z", "call"}] != 1 {
		t.Fatalf("x->z = %d, want 1", got[CallKey{"x", "z", "call"}])
	}
	if len(got) != 2 {
		t.Fatalf("distinct edges = %d, want 2 (empty src dropped)", len(got))
	}
}
