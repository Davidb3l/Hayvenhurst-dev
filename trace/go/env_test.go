package hayventrace

import (
	"reflect"
	"testing"
	"time"
)

func TestConfigFromEnv(t *testing.T) {
	t.Setenv(EnvURL, "http://daemon:9999")
	t.Setenv(EnvInterval, "5")
	t.Setenv(EnvRate, "10")
	t.Setenv(EnvProject, "example.com/a:example.com/b: :")

	cfg := ConfigFromEnv()
	if cfg.DaemonURL != "http://daemon:9999" {
		t.Fatalf("url = %q", cfg.DaemonURL)
	}
	if cfg.FlushInterval != 5*time.Second {
		t.Fatalf("interval = %v", cfg.FlushInterval)
	}
	if cfg.SampleRate != 10 {
		t.Fatalf("rate = %d", cfg.SampleRate)
	}
	if !reflect.DeepEqual(cfg.ProjectPrefixes, []string{"example.com/a", "example.com/b"}) {
		t.Fatalf("prefixes = %v", cfg.ProjectPrefixes)
	}
	if !cfg.DropRuntime {
		t.Fatalf("DropRuntime should default true")
	}
}

func TestConfigFromEnvDefaultsRate(t *testing.T) {
	// Unset / rate==1 stays at the pprof-honest default (1).
	cfg := ConfigFromEnv()
	if cfg.SampleRate != 0 { // withDefaults() applies the 1; ConfigFromEnv leaves 0 unless >1
		t.Logf("ConfigFromEnv leaves SampleRate=%d (withDefaults coerces to 1)", cfg.SampleRate)
	}
	full := cfg.withDefaults()
	if full.SampleRate != 1 {
		t.Fatalf("defaulted rate = %d, want 1", full.SampleRate)
	}
}

func TestEnabled(t *testing.T) {
	for _, v := range []string{"1", "true", "YES", "On"} {
		t.Setenv(EnvEnable, v)
		if !Enabled() {
			t.Fatalf("Enabled() = false for %q", v)
		}
	}
	for _, v := range []string{"", "0", "false", "no"} {
		t.Setenv(EnvEnable, v)
		if Enabled() {
			t.Fatalf("Enabled() = true for %q", v)
		}
	}
}

func TestStartFromEnvDisabled(t *testing.T) {
	t.Setenv(EnvEnable, "0")
	if c := StartFromEnv(); c != nil {
		c.Stop()
		t.Fatalf("StartFromEnv() returned non-nil when disabled")
	}
}
