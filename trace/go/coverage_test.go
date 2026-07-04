package hayventrace

import (
	"reflect"
	"sort"
	"testing"
)

func TestSymbolLeaf(t *testing.T) {
	cases := map[string]string{
		"github.com/spf13/cobra.TestExecute":        "TestExecute",
		"github.com/spf13/cobra.(*Command).execute": "execute",
		"github.com/spf13/cobra.(*Suite).TestThing": "TestThing",
		"github.com/spf13/cobra.TestExecute.func1":  "func1",
		"main.main":                                 "main",
		"pkg.(*T).M.func1":                          "func1",
		"noPackageName":                             "noPackageName",
		"":                                          "",
	}
	for in, want := range cases {
		if got := symbolLeaf(in); got != want {
			t.Fatalf("symbolLeaf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIsTestLeaf(t *testing.T) {
	cases := map[string]bool{
		"TestExecute": true,
		"Test":        true,
		"Test_helper": true,
		"Test3":       true,
		"TestX":       true,
		"Testify":     false, // Test + lowercase
		"Tester":      false, // Test + lowercase
		"BenchmarkX":  false,
		"ExampleX":    false,
		"FuzzX":       false,
		"execute":     false,
		"func1":       false,
		"":            false,
	}
	for in, want := range cases {
		if got := isTestLeaf(in); got != want {
			t.Fatalf("isTestLeaf(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestTestRootDetection(t *testing.T) {
	// Top-level test: pkg.TestExecute is the root.
	t.Run("top-level", func(t *testing.T) {
		names := []string{
			"github.com/spf13/cobra.(*Command).execute",
			"github.com/spf13/cobra.TestExecute",
			"testing.tRunner",
		}
		i := testRootIndex(names)
		if i != 1 || names[i] != "github.com/spf13/cobra.TestExecute" {
			t.Fatalf("root index = %d (%q), want 1 (TestExecute)", i, safeIdx(names, i))
		}
	})

	// Subtest closure: the closure leaf `func1` does not match; the outer
	// TestExecute (nearer the root) is still the root.
	t.Run("subtest-closure", func(t *testing.T) {
		names := []string{
			"github.com/spf13/cobra.(*Command).execute",
			"github.com/spf13/cobra.TestExecute.func1",
			"github.com/spf13/cobra.TestExecute",
			"testing.tRunner",
		}
		i := testRootIndex(names)
		if i != 2 || names[i] != "github.com/spf13/cobra.TestExecute" {
			t.Fatalf("root index = %d (%q), want 2 (TestExecute, not the func1 closure)", i, safeIdx(names, i))
		}
	})

	// Method receiver: pkg.(*Suite).TestThing has leaf TestThing -> detected.
	t.Run("method-receiver", func(t *testing.T) {
		names := []string{
			"github.com/x/svc.(*Suite).helper",
			"github.com/x/svc.(*Suite).TestThing",
			"testing.tRunner",
		}
		i := testRootIndex(names)
		if i != 1 || names[i] != "github.com/x/svc.(*Suite).TestThing" {
			t.Fatalf("root index = %d (%q), want 1 (TestThing method)", i, safeIdx(names, i))
		}
	})

	// Non-test method receiver: pkg.(*Command).execute is not a root.
	t.Run("non-test", func(t *testing.T) {
		names := []string{
			"github.com/spf13/cobra.(*Command).Find",
			"github.com/spf13/cobra.(*Command).execute",
			"main.main",
		}
		if i := testRootIndex(names); i != -1 {
			t.Fatalf("root index = %d (%q), want -1 (no test root)", i, safeIdx(names, i))
		}
	})

	// Benchmark is NOT a coverage root (stricter than isGoName).
	t.Run("benchmark-not-root", func(t *testing.T) {
		names := []string{
			"github.com/spf13/cobra.(*Command).execute",
			"github.com/spf13/cobra.BenchmarkExecute",
			"testing.(*B).runN",
		}
		if i := testRootIndex(names); i != -1 {
			t.Fatalf("root index = %d (%q), want -1 (Benchmark is not a coverage root)", i, safeIdx(names, i))
		}
	})
}

func safeIdx(s []string, i int) string {
	if i < 0 || i >= len(s) {
		return "<none>"
	}
	return s[i]
}

func TestAddCoverageAttribution(t *testing.T) {
	// Synthetic stack [entityA(deep), entityB, TestExecute(root), tRunner-ish].
	// Attribution yields cells (TestExecute, entityA) and (TestExecute, entityB),
	// excluding the test root itself and the outer non-kept tRunner sentinel.
	names := []string{
		"github.com/spf13/cobra.(*Command).execute", // entityA (deepest)
		"github.com/spf13/cobra.(*Command).Find",    // entityB
		"github.com/spf13/cobra.TestExecute",        // root
		"github.com/spf13/cobra.someTestHelper",     // outer (above root) — still attributed
	}
	cov := NewCoverageAggregator()
	addCoverage(cov, names)

	rows := cov.Drain()
	got := map[CoverageKey]int{}
	for _, r := range rows {
		got[CoverageKey{Test: r.Test, Entity: r.Entity}] = r.Weight
	}
	want := map[CoverageKey]int{
		{Test: "github.com/spf13/cobra.TestExecute", Entity: "github.com/spf13/cobra.(*Command).execute"}: 1,
		{Test: "github.com/spf13/cobra.TestExecute", Entity: "github.com/spf13/cobra.(*Command).Find"}:    1,
		{Test: "github.com/spf13/cobra.TestExecute", Entity: "github.com/spf13/cobra.someTestHelper"}:     1,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("coverage cells = %v, want %v", got, want)
	}
	// The test root itself must never appear as an entity.
	for k := range got {
		if k.Entity == "github.com/spf13/cobra.TestExecute" {
			t.Fatalf("test root leaked in as an entity: %v", k)
		}
	}
}

func TestAddCoverageNoTestRoot(t *testing.T) {
	// A stack with no Test* frame contributes nothing.
	names := []string{
		"github.com/spf13/cobra.(*Command).execute",
		"github.com/spf13/cobra.(*Command).Find",
		"main.main",
	}
	cov := NewCoverageAggregator()
	addCoverage(cov, names)
	if cov.Size() != 0 {
		t.Fatalf("coverage size = %d, want 0 (no test root)", cov.Size())
	}
}

func TestCoverageWeightAccumulates(t *testing.T) {
	// Two samples of the same stack -> each (test, entity) cell weight 2,
	// mirroring the edge aggregator's per-sample counting.
	names := []string{
		"github.com/spf13/cobra.(*Command).execute",
		"github.com/spf13/cobra.TestExecute",
	}
	cov := NewCoverageAggregator()
	addCoverage(cov, names)
	addCoverage(cov, names)
	rows := cov.Drain()
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1 distinct cell", len(rows))
	}
	if rows[0].Weight != 2 {
		t.Fatalf("weight = %d, want 2", rows[0].Weight)
	}
	// Drained — second drain is empty.
	if len(cov.Drain()) != 0 {
		t.Fatalf("second drain not empty")
	}
}

func TestFlushIncludesTestCoverage(t *testing.T) {
	// End-to-end: a coverage aggregator wired into the flusher emits a
	// `test_coverage` array matching the daemon's {test, entity, weight} shape.
	agg := NewAggregator()
	agg.Add("a", "b", 1)
	cov := NewCoverageAggregator()
	cov.Add("pkg.TestX", "pkg.foo", 3)
	cov.Add("pkg.TestX", "pkg.bar", 1)
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithSender(fake), WithSampleRate(1), WithCoverage(cov))

	f.FlushOnce()
	if fake.count() != 1 {
		t.Fatalf("sender calls = %d, want 1", fake.count())
	}
	body := decodePayload(t, fake.calls[0].payload)
	if len(body.Observations) != 1 {
		t.Fatalf("observations = %d, want 1", len(body.Observations))
	}
	byCell := map[CoverageKey]int{}
	for _, c := range body.TestCoverage {
		byCell[CoverageKey{Test: c.Test, Entity: c.Entity}] = c.Weight
	}
	if byCell[CoverageKey{Test: "pkg.TestX", Entity: "pkg.foo"}] != 3 {
		t.Fatalf("TestX->foo weight = %d, want 3", byCell[CoverageKey{Test: "pkg.TestX", Entity: "pkg.foo"}])
	}
	if byCell[CoverageKey{Test: "pkg.TestX", Entity: "pkg.bar"}] != 1 {
		t.Fatalf("TestX->bar weight = %d, want 1", byCell[CoverageKey{Test: "pkg.TestX", Entity: "pkg.bar"}])
	}
}

func TestFlushCoverageOnlyBatchSends(t *testing.T) {
	// Coverage is NOT gated on observations: an empty edge drain but non-empty
	// coverage must still POST (the daemon accepts coverage-only batches).
	agg := NewAggregator() // empty
	cov := NewCoverageAggregator()
	cov.Add("pkg.TestY", "pkg.baz", 1)
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithSender(fake), WithSampleRate(1), WithCoverage(cov))

	n := f.FlushOnce()
	if n != 0 {
		t.Fatalf("edge count = %d, want 0 (no edges)", n)
	}
	if fake.count() != 1 {
		t.Fatalf("sender calls = %d, want 1 (coverage-only batch must still POST)", fake.count())
	}
	body := decodePayload(t, fake.calls[0].payload)
	if len(body.Observations) != 0 {
		t.Fatalf("observations = %d, want 0", len(body.Observations))
	}
	if len(body.TestCoverage) != 1 {
		t.Fatalf("test_coverage = %d, want 1", len(body.TestCoverage))
	}
	// Fully drained -> second flush is a no-op (both empty).
	if got := f.FlushOnce(); got != 0 || fake.count() != 1 {
		t.Fatalf("second flush sent something: n=%d calls=%d", got, fake.count())
	}
}

func TestFlushNoCoverageAggregatorUnchanged(t *testing.T) {
	// Back-compat: a flusher with no coverage aggregator behaves exactly as
	// before — no test_coverage field, edge-only.
	agg := NewAggregator()
	agg.Add("a", "b", 1)
	fake := &fakeSender{}
	f := NewFlusher(agg, "http://daemon", WithSender(fake), WithSampleRate(1))
	f.FlushOnce()
	body := decodePayload(t, fake.calls[0].payload)
	if len(body.TestCoverage) != 0 {
		t.Fatalf("test_coverage = %d, want 0 (no coverage aggregator)", len(body.TestCoverage))
	}
}

// TestCoverageRowsDeterministicForGolden keeps the sort import honest and
// documents that Drain order is unspecified (callers must sort if they compare).
func TestCoverageDrainOrderUnspecified(t *testing.T) {
	cov := NewCoverageAggregator()
	cov.Add("t", "e1", 1)
	cov.Add("t", "e2", 1)
	rows := cov.Drain()
	sort.Slice(rows, func(i, j int) bool { return rows[i].Entity < rows[j].Entity })
	if len(rows) != 2 || rows[0].Entity != "e1" || rows[1].Entity != "e2" {
		t.Fatalf("rows = %+v", rows)
	}
}
