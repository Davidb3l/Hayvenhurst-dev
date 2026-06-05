package hayventrace

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"runtime/pprof"
	"time"
)

// CollectCPUProfile runs a runtime/pprof CPU profile for the given duration,
// parses the resulting samples, derives caller->callee edges from each
// sample's call stack, and feeds them into the collector's aggregator. It
// then triggers a flush.
//
// This is the literal "capture a CPU profile via runtime/pprof, then walk
// each sample's call stack" mechanism from the v1.1 roadmap. An edge's
// observed count is the number of CPU samples in which the adjacent
// (caller, callee) frame pair appeared (sample COUNT, not the nanosecond
// weight) — so with sample_rate=1 the wire invariant weight == observed
// holds trivially and honestly (we report sampled counts, not a 1-in-N
// extrapolation).
//
// It is an alternative to the always-on interval sampler (Start/sampleLoop);
// use whichever fits. CollectCPUProfile blocks for d. It is safe to call when
// the interval sampler is not running.
func (c *Collector) CollectCPUProfile(d time.Duration) (int, error) {
	var buf bytes.Buffer
	if err := pprof.StartCPUProfile(&buf); err != nil {
		return 0, err
	}
	time.Sleep(d)
	pprof.StopCPUProfile()

	stacks, err := parseProfileStacks(buf.Bytes())
	if err != nil {
		return 0, err
	}
	edges := 0
	for _, names := range stacks {
		filtered := c.filterNames(names)
		for _, e := range edgesFromNames(filtered) {
			c.agg.Add(e[0], e[1], 1)
			edges++
		}
	}
	c.FlushOnce()
	return edges, nil
}

// filterNames applies the collector's frame scoping to an already-resolved,
// leaf-first list of symbol names (the pprof path resolves names itself).
func (c *Collector) filterNames(names []string) []string {
	out := names[:0:0]
	for _, n := range names {
		if c.keepFrame(n) {
			out = append(out, n)
		}
	}
	return out
}

// parseProfileStacks decodes a runtime/pprof CPU profile (gzipped pprof
// protobuf) and returns one leaf-first []string of function names per sample.
//
// We decode only the fields we need from the profile.proto schema:
//
//	Profile { repeated Sample sample = 2; repeated Location location = 4;
//	          repeated Function function = 5; repeated string string_table = 6 }
//	Sample  { repeated uint64 location_id = 1 }
//	Location{ uint64 id = 1; repeated Line line = 4 }
//	Line    { uint64 function_id = 1 }
//	Function{ uint64 id = 1; int64 name = 2 (index into string_table) }
//
// This is a minimal, pure-stdlib protobuf reader — no third-party deps.
func parseProfileStacks(raw []byte) ([][]string, error) {
	data, err := maybeGunzip(raw)
	if err != nil {
		return nil, err
	}
	p := &protoReader{buf: data}

	var (
		strs      []string
		samples   [][]uint64 // per-sample location ids (leaf-first per pprof)
		locFuncs  = map[uint64][]uint64{}
		funcNames = map[uint64]int64{} // function id -> name string index
	)

	for p.more() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		switch {
		case field == 6 && wire == wireBytes: // string_table
			s, err := p.bytesField()
			if err != nil {
				return nil, err
			}
			strs = append(strs, string(s))
		case field == 2 && wire == wireBytes: // sample
			msg, err := p.bytesField()
			if err != nil {
				return nil, err
			}
			locs, err := parseSample(msg)
			if err != nil {
				return nil, err
			}
			samples = append(samples, locs)
		case field == 4 && wire == wireBytes: // location
			msg, err := p.bytesField()
			if err != nil {
				return nil, err
			}
			id, fns, err := parseLocation(msg)
			if err != nil {
				return nil, err
			}
			locFuncs[id] = fns
		case field == 5 && wire == wireBytes: // function
			msg, err := p.bytesField()
			if err != nil {
				return nil, err
			}
			id, nameIdx, err := parseFunction(msg)
			if err != nil {
				return nil, err
			}
			funcNames[id] = nameIdx
		default:
			if err := p.skip(wire); err != nil {
				return nil, err
			}
		}
	}

	nameOf := func(funcID uint64) string {
		idx, ok := funcNames[funcID]
		if !ok || idx < 0 || int(idx) >= len(strs) {
			return ""
		}
		return strs[idx]
	}

	out := make([][]string, 0, len(samples))
	for _, locIDs := range samples {
		var names []string
		// pprof location order within a sample is leaf-first; lines within a
		// location are leaf-first too (inlined frames). Preserve that order.
		for _, lid := range locIDs {
			for _, fid := range locFuncs[lid] {
				if n := nameOf(fid); n != "" {
					names = append(names, n)
				}
			}
		}
		if len(names) >= 2 {
			out = append(out, names)
		}
	}
	return out, nil
}

func parseSample(msg []byte) ([]uint64, error) {
	p := &protoReader{buf: msg}
	var locs []uint64
	for p.more() {
		field, wire, err := p.tag()
		if err != nil {
			return nil, err
		}
		if field == 1 { // location_id (packed or repeated varint)
			if wire == wireBytes {
				packed, err := p.bytesField()
				if err != nil {
					return nil, err
				}
				pp := &protoReader{buf: packed}
				for pp.more() {
					v, err := pp.varint()
					if err != nil {
						return nil, err
					}
					locs = append(locs, v)
				}
				continue
			}
			if wire == wireVarint {
				v, err := p.varint()
				if err != nil {
					return nil, err
				}
				locs = append(locs, v)
				continue
			}
		}
		if err := p.skip(wire); err != nil {
			return nil, err
		}
	}
	return locs, nil
}

func parseLocation(msg []byte) (id uint64, funcIDs []uint64, err error) {
	p := &protoReader{buf: msg}
	for p.more() {
		field, wire, err := p.tag()
		if err != nil {
			return 0, nil, err
		}
		switch {
		case field == 1 && wire == wireVarint: // id
			id, err = p.varint()
			if err != nil {
				return 0, nil, err
			}
		case field == 4 && wire == wireBytes: // line
			lineMsg, err := p.bytesField()
			if err != nil {
				return 0, nil, err
			}
			fid, err := parseLine(lineMsg)
			if err != nil {
				return 0, nil, err
			}
			if fid != 0 {
				funcIDs = append(funcIDs, fid)
			}
		default:
			if err := p.skip(wire); err != nil {
				return 0, nil, err
			}
		}
	}
	return id, funcIDs, nil
}

func parseLine(msg []byte) (uint64, error) {
	p := &protoReader{buf: msg}
	var fid uint64
	for p.more() {
		field, wire, err := p.tag()
		if err != nil {
			return 0, err
		}
		if field == 1 && wire == wireVarint { // function_id
			fid, err = p.varint()
			if err != nil {
				return 0, err
			}
			continue
		}
		if err := p.skip(wire); err != nil {
			return 0, err
		}
	}
	return fid, nil
}

func parseFunction(msg []byte) (id uint64, nameIdx int64, err error) {
	p := &protoReader{buf: msg}
	nameIdx = -1
	for p.more() {
		field, wire, err := p.tag()
		if err != nil {
			return 0, 0, err
		}
		switch {
		case field == 1 && wire == wireVarint: // id
			id, err = p.varint()
			if err != nil {
				return 0, 0, err
			}
		case field == 2 && wire == wireVarint: // name (string_table index)
			v, err := p.varint()
			if err != nil {
				return 0, 0, err
			}
			nameIdx = int64(v)
		default:
			if err := p.skip(wire); err != nil {
				return 0, 0, err
			}
		}
	}
	return id, nameIdx, nil
}

func maybeGunzip(raw []byte) ([]byte, error) {
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		return io.ReadAll(zr)
	}
	return raw, nil
}

// --- minimal protobuf wire reader (pure stdlib) ---

const (
	wireVarint  = 0
	wireBytes   = 2
	wireFixed64 = 1
	wireFixed32 = 5
)

type protoReader struct {
	buf []byte
	pos int
}

func (p *protoReader) more() bool { return p.pos < len(p.buf) }

func (p *protoReader) varint() (uint64, error) {
	v, n := binary.Uvarint(p.buf[p.pos:])
	if n <= 0 {
		return 0, fmt.Errorf("hayven-trace: bad varint at %d", p.pos)
	}
	p.pos += n
	return v, nil
}

func (p *protoReader) tag() (field int, wire int, err error) {
	v, err := p.varint()
	if err != nil {
		return 0, 0, err
	}
	return int(v >> 3), int(v & 0x7), nil
}

func (p *protoReader) bytesField() ([]byte, error) {
	n, err := p.varint()
	if err != nil {
		return nil, err
	}
	if p.pos+int(n) > len(p.buf) {
		return nil, fmt.Errorf("hayven-trace: bytes field overruns buffer")
	}
	b := p.buf[p.pos : p.pos+int(n)]
	p.pos += int(n)
	return b, nil
}

func (p *protoReader) skip(wire int) error {
	switch wire {
	case wireVarint:
		_, err := p.varint()
		return err
	case wireBytes:
		_, err := p.bytesField()
		return err
	case wireFixed64:
		if p.pos+8 > len(p.buf) {
			return fmt.Errorf("hayven-trace: fixed64 overruns buffer")
		}
		p.pos += 8
		return nil
	case wireFixed32:
		if p.pos+4 > len(p.buf) {
			return fmt.Errorf("hayven-trace: fixed32 overruns buffer")
		}
		p.pos += 4
		return nil
	default:
		return fmt.Errorf("hayven-trace: unknown wire type %d", wire)
	}
}
