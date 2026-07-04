package hayventrace

import (
	"strings"
	"sync"
)

// CoverageKey identifies a (test, entity) per-test coverage cell.
//
// Both fields are RAW Go symbol names (the same strings resolve() produces and
// that already resolve to graph nodes) — Test is the SELECTOR (the root-test
// symbol that was active on the sampled stack) and Entity is a symbol that test
// actually executed. Kept separate from CallKey because coverage is a per-test
// multiset, not an edge: the global call graph (edges) is unchanged by this
// feature; coverage is purely additive so the daemon can answer "which tests
// truly touched X" without reverse-walking a shared hub (e.g. cobra's
// (*Command).execute) that links ~every test to ~every symbol.
type CoverageKey struct {
	Test   string
	Entity string
}

// CoverageRow is a flush-ready per-test coverage cell: (test, entity, weight).
// Weight is the number of samples the (test, entity) pair appeared in, mirroring
// the edge aggregator's per-sample counting.
type CoverageRow struct {
	Test   string
	Entity string
	Weight int
}

// CoverageAggregator accumulates, per root-test, the multiset of entities that
// test ran. Lifecycle mirrors Aggregator exactly: cheap thread-safe increments
// on the sampling path, atomic Drain that resets state so the flusher clears
// coverage on the same cadence as the edge aggregate. A flat map keyed by
// (test, entity) keeps Drain a single map swap and the wire row shape falls
// straight out of the entries.
type CoverageAggregator struct {
	mu     sync.Mutex
	counts map[CoverageKey]int
}

// NewCoverageAggregator returns an empty, ready-to-use CoverageAggregator.
func NewCoverageAggregator() *CoverageAggregator {
	return &CoverageAggregator{counts: make(map[CoverageKey]int)}
}

// Add increments coverage of entity under the root-test test by n. Empty
// fields or non-positive counts are dropped (the daemon skips them anyway).
func (a *CoverageAggregator) Add(test, entity string, n int) {
	if test == "" || entity == "" || n <= 0 {
		return
	}
	k := CoverageKey{Test: test, Entity: entity}
	a.mu.Lock()
	if a.counts == nil {
		a.counts = make(map[CoverageKey]int)
	}
	a.counts[k] += n
	a.mu.Unlock()
}

// Size returns the number of distinct (test, entity) cells currently held.
func (a *CoverageAggregator) Size() int {
	a.mu.Lock()
	n := len(a.counts)
	a.mu.Unlock()
	return n
}

// Drain atomically returns all (test, entity, weight) rows and resets state.
// Called by the flusher on the same lifecycle as the edge drain so the coverage
// map is cleared after a flush. The order of the returned slice is unspecified.
func (a *CoverageAggregator) Drain() []CoverageRow {
	a.mu.Lock()
	counts := a.counts
	a.counts = make(map[CoverageKey]int)
	a.mu.Unlock()

	out := make([]CoverageRow, 0, len(counts))
	for k, w := range counts {
		out = append(out, CoverageRow{Test: k.Test, Entity: k.Entity, Weight: w})
	}
	return out
}

// symbolLeaf returns the function/method leaf of a raw Go symbol name: the part
// after the last ".", after stripping a receiver qualifier like "(*Command)".
//
// Examples:
//
//	github.com/spf13/cobra.TestExecute          -> "TestExecute"
//	github.com/spf13/cobra.(*Command).execute   -> "execute"
//	github.com/spf13/cobra.(*Suite).TestThing   -> "TestThing"
//	github.com/spf13/cobra.TestExecute.func1     -> "func1"   (subtest closure)
//	main.main                                    -> "main"
//
// The package path may contain "/" but never "(" or ")"; the receiver group
// "(*T)" / "(T)" appears between two "." after the package path. We take the
// final "."-segment that is NOT inside a parenthesized receiver group.
func symbolLeaf(name string) string {
	if name == "" {
		return ""
	}
	// Walk from the end, ignoring any "." that sits inside a "(...)" receiver
	// group, and return the suffix after the first such "." we find. depth
	// tracks paren nesting as we scan right-to-left.
	depth := 0
	for i := len(name) - 1; i >= 0; i-- {
		switch name[i] {
		case ')':
			depth++
		case '(':
			if depth > 0 {
				depth--
			}
		case '.':
			if depth == 0 {
				return name[i+1:]
			}
		}
	}
	return name
}

// isTestLeaf reports whether a symbol leaf is a Go TEST name for the coverage
// SELECTOR: it must match ^Test([A-Z0-9_]|$). This is STRICTER than the graph
// side's isGoName on purpose — it matches ONLY Test* (not Benchmark/Example/
// Fuzz), mirroring the Python collector restricting the selector to test_*. We
// want runnable regression tests as the attribution roots.
//
//	TestExecute   -> true   (Test + uppercase)
//	Test          -> true   (exactly Test)
//	Test_helper   -> true   (Test + underscore)
//	Test3         -> true   (Test + digit)
//	Testify       -> false  (Test + lowercase: not a test fn shape)
//	BenchmarkX    -> false
//	execute       -> false
//	func1         -> false  (subtest closure leaf)
func isTestLeaf(leaf string) bool {
	if !strings.HasPrefix(leaf, "Test") {
		return false
	}
	if len(leaf) == 4 {
		return true // exactly "Test"
	}
	c := leaf[4]
	return c == '_' || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// testRootIndex finds the test root on a leaf-first stack of kept symbol names:
// the OUTERMOST frame (nearest the stack root = highest index, since index 0 is
// the deepest/currently-executing frame) whose leaf is a Go TEST name. Returns
// the index, or -1 when the stack has no test root.
//
// Choosing the OUTERMOST such frame makes attribution robust to subtests: a
// subtest closure `TestX.func1` has leaf `func1` (won't match), while the real
// outer `TestX` frame is nearer the root and wins. If two real Test* frames are
// somehow both present (a test calling a helper that calls another Test*), the
// outermost — the one actually being run — is the correct selector.
func testRootIndex(names []string) int {
	for i := len(names) - 1; i >= 0; i-- {
		if isTestLeaf(symbolLeaf(names[i])) {
			return i
		}
	}
	return -1
}

// addCoverage attributes one sampled stack's coverage cells into agg.
//
// For a stack that HAS a test root (the outermost Test* frame), every OTHER
// kept frame on that stack — the entities the test is executing — gets a cell
// (test=<test-root symbol>, entity=<frame symbol>, +1). The test root itself is
// excluded (it is the selector, not a covered entity); self/runtime frames were
// already filtered out by keepFrame before resolve() produced `names`. Stacks
// with no test root contribute nothing. Weight accrues across samples via the
// aggregator's per-call increment, exactly like the edge aggregator.
//
// This is the unit-testable core of the attribution. It is pure: it depends only
// on the ordered kept names, not on the runtime.
func addCoverage(agg *CoverageAggregator, names []string) {
	root := testRootIndex(names)
	if root < 0 {
		return
	}
	test := names[root]
	for i, entity := range names {
		if i == root || entity == "" || entity == test {
			continue
		}
		agg.Add(test, entity, 1)
	}
}
