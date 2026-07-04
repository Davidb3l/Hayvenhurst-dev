package hayventrace

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Env var names, mirroring the Python collector's table.
const (
	EnvEnable   = "HAYVEN_TRACE"           // set "1" to enable
	EnvURL      = "HAYVEN_TRACE_URL"       // daemon base URL
	EnvRate     = "HAYVEN_TRACE_RATE"      // sample_rate (true 1-in-N only)
	EnvInterval = "HAYVEN_TRACE_INTERVAL"  // flush cadence, seconds
	EnvSampleMs = "HAYVEN_TRACE_SAMPLE_MS" // stack-sample cadence, milliseconds
	EnvProject  = "HAYVEN_TRACE_PROJECT"   // ":"-separated import-path prefixes
)

// ConfigFromEnv builds a Config from the HAYVEN_TRACE_* environment, applying
// the documented defaults for anything unset.
//
// Note on HAYVEN_TRACE_RATE: the pprof/stack-sampling mechanism reports
// sampled edge COUNTS honestly with sample_rate=1 (observed == weight), so
// the rate env is ignored in that mode and documented as such. It is read
// here only so a future true 1-in-N hook can honor it; today it stays 1
// unless explicitly > 1, and the wire invariant is preserved either way.
func ConfigFromEnv() Config {
	cfg := Config{DropRuntime: true}
	if v := os.Getenv(EnvURL); v != "" {
		cfg.DaemonURL = v
	}
	if v := os.Getenv(EnvInterval); v != "" {
		if secs, err := strconv.ParseFloat(v, 64); err == nil && secs > 0 {
			cfg.FlushInterval = time.Duration(secs * float64(time.Second))
		}
	}
	// Per-test coverage NEEDS dense sampling (a fast test that runs between two
	// 10ms ticks is otherwise never observed). HAYVEN_TRACE_SAMPLE_MS lowers the
	// stack-sample cadence; <= 0 / unset keeps the 10ms default. The edge path
	// is unaffected by the value beyond finer counts.
	if v := os.Getenv(EnvSampleMs); v != "" {
		if ms, err := strconv.ParseFloat(v, 64); err == nil && ms > 0 {
			cfg.SampleInterval = time.Duration(ms * float64(time.Millisecond))
		}
	}
	if v := os.Getenv(EnvRate); v != "" {
		if r, err := strconv.Atoi(v); err == nil && r > 1 {
			cfg.SampleRate = r
		}
	}
	if v := os.Getenv(EnvProject); v != "" {
		var prefixes []string
		for _, p := range strings.Split(v, ":") {
			if p = strings.TrimSpace(p); p != "" {
				prefixes = append(prefixes, p)
			}
		}
		cfg.ProjectPrefixes = prefixes
	}
	return cfg
}

// Enabled reports whether HAYVEN_TRACE is set to a truthy value ("1", "true",
// "yes", case-insensitive).
func Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvEnable))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// StartFromEnv starts a Collector configured from the environment IF
// HAYVEN_TRACE is enabled, returning the active Collector. If tracing is not
// enabled it returns nil and does nothing — callers can safely
// `defer hayventrace.StartFromEnv().Stop()` only after a nil check, so prefer:
//
//	if c := hayventrace.StartFromEnv(); c != nil {
//	    defer c.Stop()
//	}
func StartFromEnv() *Collector {
	if !Enabled() {
		return nil
	}
	return Start(ConfigFromEnv())
}
