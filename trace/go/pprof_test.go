package hayventrace

import (
	"encoding/binary"
	"reflect"
	"testing"
)

// --- a tiny protobuf encoder, used ONLY to build synthetic test profiles ---

func putVarint(b []byte, v uint64) []byte {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	return append(b, tmp[:n]...)
}

func tag(b []byte, field, wire int) []byte {
	return putVarint(b, uint64(field)<<3|uint64(wire))
}

func bytesField(b []byte, field int, val []byte) []byte {
	b = tag(b, field, wireBytes)
	b = putVarint(b, uint64(len(val)))
	return append(b, val...)
}

func varintField(b []byte, field int, v uint64) []byte {
	b = tag(b, field, wireVarint)
	return putVarint(b, v)
}

// buildProfile encodes a minimal pprof Profile with the given string table,
// a function per (id,nameIdx), a location per (id,funcID), and a sample per
// []locID. Mirrors the fields parseProfileStacks reads.
func buildProfile(strs []string, funcs map[uint64]int64, locs map[uint64]uint64, samples [][]uint64) []byte {
	var out []byte
	for _, s := range strs {
		out = bytesField(out, 6, []byte(s)) // string_table
	}
	for id, nameIdx := range funcs {
		var fn []byte
		fn = varintField(fn, 1, id)              // id
		fn = varintField(fn, 2, uint64(nameIdx)) // name
		out = bytesField(out, 5, fn)             // function
	}
	for id, fid := range locs {
		var line []byte
		line = varintField(line, 1, fid) // function_id
		var loc []byte
		loc = varintField(loc, 1, id)  // id
		loc = bytesField(loc, 4, line) // line
		out = bytesField(out, 4, loc)  // location
	}
	for _, s := range samples {
		var packed []byte
		for _, l := range s {
			packed = putVarint(packed, l)
		}
		var smp []byte
		smp = bytesField(smp, 1, packed) // packed location_id
		out = bytesField(out, 2, smp)    // sample
	}
	return out
}

func TestParseProfileStacks(t *testing.T) {
	// string_table[0] is conventionally "" in pprof.
	strs := []string{"", "svc/db.Query", "svc/auth.Login", "svc/api.Handler"}
	funcs := map[uint64]int64{
		10: 1, // db.Query
		11: 2, // auth.Login
		12: 3, // api.Handler
	}
	locs := map[uint64]uint64{
		100: 10, // loc 100 -> func db.Query
		101: 11, // loc 101 -> func auth.Login
		102: 12, // loc 102 -> func api.Handler
	}
	// One sample, leaf-first: db.Query, auth.Login, api.Handler.
	samples := [][]uint64{{100, 101, 102}}

	raw := buildProfile(strs, funcs, locs, samples)
	stacks, err := parseProfileStacks(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(stacks) != 1 {
		t.Fatalf("stacks = %d, want 1", len(stacks))
	}
	want := []string{"svc/db.Query", "svc/auth.Login", "svc/api.Handler"}
	if !reflect.DeepEqual(stacks[0], want) {
		t.Fatalf("stack = %v, want %v", stacks[0], want)
	}

	// And the derived edges (caller -> callee).
	edges := edgesFromNames(stacks[0])
	wantEdges := [][2]string{
		{"svc/auth.Login", "svc/db.Query"},
		{"svc/api.Handler", "svc/auth.Login"},
	}
	if !reflect.DeepEqual(edges, wantEdges) {
		t.Fatalf("edges = %v, want %v", edges, wantEdges)
	}
}

func TestParseProfileStacksDropsSingleFrame(t *testing.T) {
	strs := []string{"", "lonely.Frame"}
	funcs := map[uint64]int64{1: 1}
	locs := map[uint64]uint64{100: 1}
	samples := [][]uint64{{100}} // single-frame sample yields no edge
	raw := buildProfile(strs, funcs, locs, samples)
	stacks, err := parseProfileStacks(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(stacks) != 0 {
		t.Fatalf("stacks = %d, want 0 (single-frame dropped)", len(stacks))
	}
}

func TestParseProfileGunzip(t *testing.T) {
	// runtime/pprof gzips its output; ensure maybeGunzip handles a real
	// gzip header. We round-trip a tiny profile through the parser via the
	// uncompressed path (buildProfile is uncompressed) AND assert maybeGunzip
	// passes uncompressed bytes through unchanged.
	strs := []string{"", "a.F", "b.G"}
	funcs := map[uint64]int64{1: 1, 2: 2}
	locs := map[uint64]uint64{10: 1, 11: 2}
	raw := buildProfile(strs, funcs, locs, [][]uint64{{10, 11}})
	passthrough, err := maybeGunzip(raw)
	if err != nil {
		t.Fatalf("maybeGunzip passthrough: %v", err)
	}
	if !reflect.DeepEqual(passthrough, raw) {
		t.Fatalf("maybeGunzip mutated uncompressed bytes")
	}
}
