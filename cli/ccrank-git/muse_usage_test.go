package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeMuseSession(t *testing.T, path string, lines []string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data := ""
	for _, line := range lines {
		data += line + "\n"
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func museCompletedRecord(id string, recordedAt float64, model string, input, output, cached, cacheWrite, cacheRead, reasoning float64) string {
	record := map[string]any{
		"schema_version": 1,
		"id":             id,
		"stream":         map[string]any{"kind": "session", "id": "sess-1"},
		"sequence":       1,
		"recorded_at":    recordedAt,
		"record_type":    "event",
		"payload_type":   "runtime.session",
		"payload": map[string]any{
			"kind":   "run",
			"run_id": "run-1",
			"event": map[string]any{
				"kind":  "model_completed",
				"model": model,
				"usage": map[string]any{
					"input_tokens":       input,
					"output_tokens":      output,
					"cached_tokens":      cached,
					"cache_write_tokens": cacheWrite,
					"cache_read_tokens":  cacheRead,
					"reasoning_tokens":   reasoning,
				},
			},
		},
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func museRetainedFrame(inner string) string {
	frame := map[string]any{
		"retained_frame":       "session_permission_transaction",
		"frame_schema_version": 1,
		"children":             []map[string]any{{"child_index": 0, "record_json": inner}},
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestLoadMuseUsageEntries(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	ts := float64(day.UnixMicro())
	otherDay := time.Date(2026, 9, 8, 9, 0, 0, 0, time.UTC)
	otherTs := float64(otherDay.UnixMicro())

	sessionDir := filepath.Join(home, ".local", "share", "muse", "sessions", "2026", "09", "09", "sess-1")
	first := museCompletedRecord("rec-1", ts, "muse-spark-1.3-contributor", 38085, 151, 33777, 0, 33777, 47)
	writeMuseSession(t, filepath.Join(sessionDir, "session.jsonl"), []string{
		first,
		// Same record id re-read: counted once.
		first,
		// Retained-frame envelope unwraps to a second call.
		museRetainedFrame(museCompletedRecord("rec-2", ts, "muse-spark-1.3", 1000, 100, 0, 0, 0, 0)),
		// Noise: not a model_completed event, and a zero-total call.
		`{"schema_version":1,"id":"rec-noise","recorded_at":1789014198596806,"payload_type":"runtime.session","payload":{"kind":"run","event":{"kind":"output"}}}`,
		museCompletedRecord("rec-zero", ts, "muse-spark-1.3", 0, 0, 0, 0, 0, 0),
		// Missing model falls back to muse-unknown on the same day.
		museCompletedRecord("rec-3", ts, "", 500, 50, 100, 0, 100, 0),
	})
	writeMuseSession(t, filepath.Join(sessionDir, "subagent", "sub-1", "session.jsonl"), []string{
		museCompletedRecord("rec-4", otherTs, "muse-spark-1.3-contributor", 2000, 200, 500, 0, 500, 0),
	})

	entries, err := loadMuseUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %#v, want 2 dated entries", entries)
	}

	// Entries sort ascending: 2026-09-08 first.
	older := entries[0]
	if usageDate(older) != "2026-09-08" {
		t.Fatalf("older entry date = %q", usageDate(older))
	}
	// 2000 input with 500 cached splits to 1500 fresh + 500 read.
	if got := numberValue(older["inputTokens"]); got != 1500 {
		t.Fatalf("older inputTokens = %v, want 1500", got)
	}
	if got := numberValue(older["cacheReadTokens"]); got != 500 {
		t.Fatalf("older cacheReadTokens = %v, want 500", got)
	}
	if got := numberValue(older["totalTokens"]); got != 2200 {
		t.Fatalf("older totalTokens = %v, want 2200", got)
	}

	day9 := entries[1]
	if usageDate(day9) != "2026-09-09" {
		t.Fatalf("day entry date = %q", usageDate(day9))
	}
	// rec-1: 38085-33777=4308 fresh, 151 output (its 47 reasoning tokens
	// are already inside output, not added again), total 38236.
	// rec-2: 1000 in, 100 out. rec-3: 500-100=400 fresh, 50 out, 100 read.
	// rec-1 duplicate and rec-zero add nothing.
	if got := numberValue(day9["inputTokens"]); got != 4308+1000+400 {
		t.Fatalf("inputTokens = %v, want 5708", got)
	}
	if got := numberValue(day9["outputTokens"]); got != 151+100+50 {
		t.Fatalf("outputTokens = %v, want 301", got)
	}
	if got := numberValue(day9["cacheReadTokens"]); got != 33777+100 {
		t.Fatalf("cacheReadTokens = %v, want 33877", got)
	}
	if got := numberValue(day9["totalTokens"]); got != 38236+1100+550 {
		t.Fatalf("totalTokens = %v, want 39886", got)
	}
	if got := usageCostValue(day9); got != 0 {
		t.Fatalf("cost = %v, want 0 (token-only)", got)
	}
	if got := numberValue(day9["messages"]); got != 3 {
		t.Fatalf("messages = %v, want 3 de-duplicated calls", got)
	}
	if got := numberValue(day9["sessionFiles"]); got != 1 {
		t.Fatalf("sessionFiles = %v, want 1", got)
	}
	models, ok := day9["modelsUsed"].([]string)
	if !ok || len(models) != 3 ||
		models[0] != "muse-spark-1.3" ||
		models[1] != "muse-spark-1.3-contributor" ||
		models[2] != "muse-unknown" {
		t.Fatalf("modelsUsed = %#v", day9["modelsUsed"])
	}
	if day9["source"] != "muse-session-jsonl" {
		t.Fatalf("source = %#v", day9["source"])
	}
}

func TestLoadMuseUsageEntriesMissingDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")

	entries, err := loadMuseUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %#v, want none", entries)
	}
	if _, _, err := runMuseUsage(); err == nil {
		t.Fatal("expected a no-usage error when no Muse sessions exist")
	}
}

func TestLoadMuseUsageEntriesHonorsXDGDataHome(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	dataHome := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	writeMuseSession(t, filepath.Join(dataHome, "muse", "sessions", "sess-x", "session.jsonl"), []string{
		museCompletedRecord("rec-x", float64(day.UnixMicro()), "muse-spark-1.3", 100, 10, 0, 0, 0, 0),
	})

	entries, err := loadMuseUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || numberValue(entries[0]["totalTokens"]) != 110 {
		t.Fatalf("entries = %#v, want the XDG-hosted session", entries)
	}
}

func TestPiPlatformForModelRoutesMuse(t *testing.T) {
	if got := piPlatformForModel("muse-spark-1.3-contributor"); got != platformMuse {
		t.Fatalf("piPlatformForModel(muse-spark) = %q, want muse", got)
	}
	if got := piPlatformForModel("pi-meta-muse-spark-1-3"); got != platformMuse {
		t.Fatalf("piPlatformForModel(pi-fronted muse) = %q, want muse", got)
	}
	// A hybrid name containing another vendor marker still resolves to muse:
	// muse is checked before kimi/grok/glm, matching detectPlatform.
	if got := piPlatformForModel("kimi-muse-bridge-1"); got != platformMuse {
		t.Fatalf("piPlatformForModel(hybrid) = %q, want muse", got)
	}
}

func TestMuseCacheWriteSemantics(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	ts := float64(day.UnixMicro())

	writeMuseSession(t, filepath.Join(home, ".local", "share", "muse", "sessions", "sess-w", "session.jsonl"), []string{
		// 10000 input with 6000 cached and 1000 written splits to 3000
		// fresh + 6000 read + 1000 creation, total 10000 + 100 output.
		museCompletedRecord("rec-w", ts, "muse-spark-1.3", 10000, 100, 6000, 1000, 6000, 0),
		// Over-claimed cache (read + write exceeds input) clamps fresh to
		// zero instead of going negative; buckets stay non-negative.
		museCompletedRecord("rec-clamp", ts, "muse-spark-1.3", 100, 10, 90, 50, 90, 0),
	})

	entries, err := loadMuseUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v, want 1 dated entry", entries)
	}
	entry := entries[0]
	if got := numberValue(entry["inputTokens"]); got != 3000 {
		t.Fatalf("inputTokens = %v, want 3000 (clamped record adds 0 fresh)", got)
	}
	if got := numberValue(entry["cacheCreationTokens"]); got != 1000+50 {
		t.Fatalf("cacheCreationTokens = %v, want 1050", got)
	}
	if got := numberValue(entry["cacheReadTokens"]); got != 6000+90 {
		t.Fatalf("cacheReadTokens = %v, want 6090", got)
	}
	if got := numberValue(entry["totalTokens"]); got != 10100+150 {
		t.Fatalf("totalTokens = %v, want 10250", got)
	}
}

func TestMuseUsageDateFormats(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	if got := museUsageDate(float64(day.UnixMicro())); got != "2026-09-09" {
		t.Fatalf("microsecond float date = %q", got)
	}
	if got := museUsageDate("2026-09-09T12:00:00Z"); got != "2026-09-09" {
		t.Fatalf("RFC3339 date = %q", got)
	}
	if got := museUsageDate(""); got != "" {
		t.Fatalf("empty date = %q, want empty", got)
	}
	if got := museUsageDate(nil); got != "" {
		t.Fatalf("nil date = %q, want empty", got)
	}
}

func TestMuseFallbackFingerprintDedups(t *testing.T) {
	byDate := map[string]*museDailyUsage{}
	seen := map[string]bool{}
	record := museSessionLine{
		PayloadType: "runtime.session",
		RecordedAt:  float64(time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC).UnixMicro()),
		Payload: &musePayload{Event: &museEvent{
			Kind:  "model_completed",
			Model: "muse-spark-1.3",
			Usage: &museUsage{Input: 100, Output: 10},
		}},
	}
	// No record id: the path/date/model/counters fingerprint still dedups a
	// re-read of the same line.
	accumulateMuseRecord("/s/session.jsonl", record, byDate, seen)
	accumulateMuseRecord("/s/session.jsonl", record, byDate, seen)
	total := 0.0
	for _, day := range byDate {
		total += day.TotalTokens
	}
	if total != 110 {
		t.Fatalf("total = %v, want 110 counted once", total)
	}
}

func TestMuseOverlappingRootsDedup(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	dataHome := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", dataHome)

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	line := museCompletedRecord("rec-dup", float64(day.UnixMicro()), "muse-spark-1.3", 100, 10, 0, 0, 0, 0)
	// Same record id visible under both the XDG root and the default root
	// (e.g. XDG_DATA_HOME points at ~/.local/share): counted once.
	writeMuseSession(t, filepath.Join(dataHome, "muse", "sessions", "s1", "session.jsonl"), []string{line})
	writeMuseSession(t, filepath.Join(home, ".local", "share", "muse", "sessions", "s1", "session.jsonl"), []string{line})

	entries, err := loadMuseUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || numberValue(entries[0]["totalTokens"]) != 110 {
		t.Fatalf("entries = %#v, want one 110-token entry", entries)
	}
}

func TestMuseEnvelopeOuterRecordCounts(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_DATA_HOME", "")

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	ts := float64(day.UnixMicro())
	outer := map[string]any{
		"schema_version": 1,
		"id":             "rec-outer",
		"recorded_at":    ts,
		"payload_type":   "runtime.session",
		"payload": map[string]any{
			"kind": "run",
			"event": map[string]any{
				"kind":  "model_completed",
				"model": "muse-spark-1.3",
				"usage": map[string]any{
					"input_tokens": 100, "output_tokens": 10,
				},
			},
		},
		"children": []map[string]any{{
			"child_index": 0,
			"record_json": museCompletedRecord("rec-inner", ts, "muse-spark-1.3", 200, 20, 0, 0, 0, 0),
		}},
	}
	encoded, err := json.Marshal(outer)
	if err != nil {
		t.Fatal(err)
	}
	writeMuseSession(t, filepath.Join(home, ".local", "share", "muse", "sessions", "s", "session.jsonl"), []string{string(encoded)})

	entries, err := loadMuseUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	// Both the qualifying outer record and the child record count; record-id
	// dedup keeps this free of double-counting.
	if len(entries) != 1 || numberValue(entries[0]["totalTokens"]) != 330 {
		t.Fatalf("entries = %#v, want one 330-token entry", entries)
	}
	if got := numberValue(entries[0]["messages"]); got != 2 {
		t.Fatalf("messages = %v, want 2 calls", got)
	}
}

func TestMuseUsageMaximaCacheName(t *testing.T) {
	if _, err := usageMaximaPath(platformMuse); err != nil {
		t.Fatalf("usageMaximaPath(muse) = %v", err)
	}
}
