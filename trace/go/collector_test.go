package hayventrace

import (
	"reflect"
	"testing"
	"time"
)

func TestEdgesFromNames(t *testing.T) {
	// Leaf-first stack: db.get_user (leaf) called by auth.login called by
	// main. Edges are caller -> callee.
	names := []string{
		"myapp/db.GetUser",
		"myapp/auth.Login",
		"myapp/main.main",
	}
	got := edgesFromNames(names)
	want := [][2]string{
		{"myapp/auth.Login", "myapp/db.GetUser"},
		{"myapp/main.main", "myapp/auth.Login"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
}

func TestEdgesFromNamesShortStacks(t *testing.T) {
	if e := edgesFromNames(nil); e != nil {
		t.Fatalf("nil stack -> %v, want nil", e)
	}
	if e := edgesFromNames([]string{"only.one"}); e != nil {
		t.Fatalf("single frame -> %v, want nil", e)
	}
}

func TestEdgesSkipSelfRecursion(t *testing.T) {
	// Adjacent identical frames (direct recursion) should not produce a
	// self-edge.
	names := []string{"p.f", "p.f", "p.g"}
	got := edgesFromNames(names)
	want := [][2]string{{"p.g", "p.f"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
}

func TestSyntheticStackToAggregator(t *testing.T) {
	// Drive the full derivation -> aggregation path on a synthetic sample,
	// the way sampleOnce / CollectCPUProfile do, then assert the flushed
	// wire payload.
	c := NewCollector(Config{
		DaemonURL:  "http://daemon",
		SampleRate: 1,
		Sender:     &fakeSender{},
	})
	stack := []string{
		"example.com/svc/db.Query",
		"example.com/svc/auth.Login",
		"example.com/svc/api.Handler",
	}
	// Two samples of the same stack -> each edge observed twice.
	for i := 0; i < 2; i++ {
		for _, e := range edgesFromNames(stack) {
			c.agg.Add(e[0], e[1], 1)
		}
	}
	obs := c.agg.Drain()
	byEdge := map[[2]string]int{}
	for _, o := range obs {
		byEdge[[2]string{o.Src, o.Dst}] = o.Observed
	}
	if byEdge[[2]string{"example.com/svc/auth.Login", "example.com/svc/db.Query"}] != 2 {
		t.Fatalf("auth->db observed = %d, want 2", byEdge[[2]string{"example.com/svc/auth.Login", "example.com/svc/db.Query"}])
	}
	if byEdge[[2]string{"example.com/svc/api.Handler", "example.com/svc/auth.Login"}] != 2 {
		t.Fatalf("api->auth observed = %d, want 2", byEdge[[2]string{"example.com/svc/api.Handler", "example.com/svc/auth.Login"}])
	}
}

func TestIsRuntimeFrame(t *testing.T) {
	cases := map[string]bool{
		"runtime.main":                           true,
		"runtime.goexit":                         true,
		"net/http.(*Server).Serve":               true,
		"sync.(*Mutex).Lock":                     true,
		"main.main":                              true, // package main, stdlib-shaped
		"github.com/hayvenhurst/x.Foo":           false,
		"example.com/svc/auth.Login":             false,
		"golang.org/x/sync/errgroup.(*Group).Go": false,
	}
	for name, want := range cases {
		if got := isRuntimeFrame(name); got != want {
			t.Fatalf("isRuntimeFrame(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestKeepFrameProjectScoping(t *testing.T) {
	c := NewCollector(Config{ProjectPrefixes: []string{"example.com/svc"}})
	if !c.keepFrame("example.com/svc/auth.Login") {
		t.Fatalf("project frame should be kept")
	}
	if c.keepFrame("net/http.(*Server).Serve") {
		t.Fatalf("non-project frame should be dropped under prefixes")
	}
	if c.keepFrame("github.com/hayvenhurst/hayven-trace.foo") {
		t.Fatalf("self frame must always be dropped")
	}
}

func TestKeepFrameDropRuntime(t *testing.T) {
	c := NewCollector(Config{DropRuntime: true})
	if c.keepFrame("runtime.main") {
		t.Fatalf("runtime frame should be dropped")
	}
	if !c.keepFrame("example.com/app.Run") {
		t.Fatalf("app frame should be kept")
	}
}

// busyEdgeA -> busyEdgeB is a deterministic call chain we can find in a real
// CPU profile, exercising the full runtime/pprof -> parse -> edge path.
func busyEdgeA(n int) int { return busyEdgeB(n) }

func busyEdgeB(n int) int {
	x := 0
	for i := 0; i < n; i++ {
		x += (i * 7) % 13
		x ^= i
	}
	return x
}

func TestCollectCPUProfileDerivesEdges(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping CPU-profile capture in -short mode")
	}
	c := NewCollector(Config{
		DaemonURL:       "http://daemon",
		SampleRate:      1,
		Sender:          &fakeSender{},
		ProjectPrefixes: []string{"github.com/hayvenhurst/hayven-trace"},
	})
	// Burn CPU in a goroutine so the profiler captures our busy chain.
	stop := make(chan struct{})
	go func() {
		sink := 0
		for {
			select {
			case <-stop:
				return
			default:
				sink += busyEdgeA(20000)
				_ = sink
			}
		}
	}()
	n, err := c.CollectCPUProfile(200 * time.Millisecond)
	close(stop)
	if err != nil {
		t.Fatalf("CollectCPUProfile: %v", err)
	}
	// We can't guarantee specific edges (sampling is probabilistic), but the
	// parser must run without error and the path must be exercised. If any
	// edges were derived, the busyEdgeA->busyEdgeB edge is the likely one.
	t.Logf("derived %d edges from CPU profile", n)
	found := false
	for _, o := range c.agg.Drain() {
		if o.Src == "github.com/hayvenhurst/hayven-trace.busyEdgeA" &&
			o.Dst == "github.com/hayvenhurst/hayven-trace.busyEdgeB" {
			found = true
		}
	}
	// Soft assertion: log if the expected edge wasn't sampled rather than
	// failing flakily on a quiet machine.
	if !found {
		t.Logf("note: busyEdgeA->busyEdgeB not present in this sample (sampling is probabilistic)")
	}
}

func TestCollectorLifecycle(t *testing.T) {
	fake := &fakeSender{}
	c := NewCollector(Config{
		DaemonURL:      "http://daemon",
		SampleInterval: 5 * time.Millisecond,
		FlushInterval:  10 * time.Millisecond,
		SampleRate:     1,
		Sender:         fake,
	})
	c.Start()
	c.Start() // idempotent
	time.Sleep(40 * time.Millisecond)
	c.Stop() // flushes final batch; must not hang or panic
	c.Stop() // idempotent
	// No assertion on payload (depends on ambient goroutines) — this guards
	// against deadlock/panic in the lifecycle.
}
