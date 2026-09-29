package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestShouldShowOnboardingDoesNotBlockUsageOnlyUpload(t *testing.T) {
	if shouldShowOnboarding(true, 0, true, false) {
		t.Fatal("created empty config should not show onboarding when --upload-usage is set")
	}
	if shouldShowOnboarding(false, 0, true, false) {
		t.Fatal("empty repo config should not show onboarding when --upload-usage is set")
	}
	if !shouldShowOnboarding(false, 0, false, false) {
		t.Fatal("empty repo config should show onboarding when usage upload is not requested")
	}
	if shouldShowOnboarding(false, 0, false, true) {
		t.Fatal("dry-run should print payload instead of onboarding")
	}
}

func prepareCcusageUpload(t *testing.T, report []byte) (*pendingUsageUpload, error) {
	t.Helper()
	parsed, entries, err := parseCcusageReportWithLocalExtras(report)
	if err != nil {
		return nil, err
	}
	return prepareUsageUpload(parsed, entries, "combined", "no higher combined usage rows found")
}

func TestPrepareCcusageUploadOnlyOffersHigherRows(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	report := []byte(`{
		"type": "daily",
		"daily": [
			{
				"date": "2026-05-27",
				"inputTokens": 10,
				"outputTokens": 5,
				"cacheCreationTokens": 0,
				"cacheReadTokens": 85,
				"totalTokens": 100,
				"totalCost": 1.25,
				"modelsUsed": ["gpt-5.5"],
				"agents": [{
					"agent": "claude",
					"inputTokens": 10,
					"outputTokens": 5,
					"cacheCreationTokens": 0,
					"cacheReadTokens": 85,
					"totalTokens": 100,
					"totalCost": 1.25,
					"modelsUsed": ["gpt-5.5"]
				}]
			}
		]
	}`)

	first, err := prepareCcusageUpload(t, report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first.Report, `"2026-05-27"`) {
		t.Fatalf("expected first upload to contain the daily row: %s", first.Report)
	}
	// Emulate the confirmed upload so the maxima cache advances.
	if err := first.Commit(); err != nil {
		t.Fatal(err)
	}

	if _, err := prepareCcusageUpload(t, report); err == nil || !strings.Contains(err.Error(), "no higher combined usage rows found") {
		t.Fatalf("expected unchanged second upload to be skipped, got %v", err)
	}

	higher := []byte(`{
		"type": "daily",
		"daily": [
			{
				"date": "2026-05-27",
				"inputTokens": 12,
				"outputTokens": 6,
				"cacheCreationTokens": 0,
				"cacheReadTokens": 132,
				"totalTokens": 150,
				"totalCost": 1.75,
				"modelsUsed": ["gpt-5.5"],
				"agents": [{
					"agent": "claude",
					"inputTokens": 12,
					"outputTokens": 6,
					"cacheCreationTokens": 0,
					"cacheReadTokens": 132,
					"totalTokens": 150,
					"totalCost": 1.75,
					"modelsUsed": ["gpt-5.5"]
				}]
			}
		]
	}`)

	third, err := prepareCcusageUpload(t, higher)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(third.Report, `"totalTokens":150`) {
		t.Fatalf("expected higher row to be uploaded, got %s", third.Report)
	}
}

func TestIsHigherUsageSnapshotDetectsTokenAndCostIncreases(t *testing.T) {
	cached := map[string]any{
		"totalTokens": 100.0,
		"totalCost":   1.25,
	}

	if !isHigherUsageSnapshot(map[string]any{"totalTokens": 101.0, "totalCost": 1.25}, cached) {
		t.Fatal("expected higher token count to be treated as updated usage")
	}
	if !isHigherUsageSnapshot(map[string]any{"totalTokens": 100.0, "totalCost": 1.26}, cached) {
		t.Fatal("expected higher cost to be treated as updated usage")
	}
	if isHigherUsageSnapshot(map[string]any{"totalTokens": 100.0, "totalCost": 1.25}, cached) {
		t.Fatal("same usage snapshot should not be treated as updated")
	}
}

func TestCombinedMaximaVersionAllowsPlatformSplitsToLowerLegacyRows(t *testing.T) {
	// Each split moves usage out of the combined bucket, so the corrected rows
	// are smaller than what an older ccrank already uploaded. Every stale cache
	// version must reset once to let those lower rows through.
	for _, legacy := range []string{
		`{"daily":[{"date":"2026-08-12","totalTokens":1000,"totalCost":2}]}`,
		`{"version":2,"daily":[{"date":"2026-08-12","totalTokens":1000,"totalCost":2}]}`,
		`{"version":3,"daily":[{"date":"2026-08-12","totalTokens":1000,"totalCost":2}]}`,
		// Version 4 combined totals were slice sums that can sit above the
		// component-derived totals written from version 5 on.
		`{"version":4,"daily":[{"date":"2026-08-12","totalTokens":1000,"totalCost":2}]}`,
	} {
		home := t.TempDir()
		t.Setenv("HOME", home)
		cacheDir := filepath.Join(home, ".ccrank")
		if err := os.MkdirAll(cacheDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(cacheDir, "usage-maxima-combined.json"), []byte(legacy), 0o600); err != nil {
			t.Fatal(err)
		}

		report := map[string]any{"type": "daily"}
		entries := []map[string]any{{"date": "2026-08-12", "totalTokens": 400.0, "totalCost": 1.0}}
		pending, err := prepareUsageUpload(report, entries, "combined", "no higher combined usage rows found")
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(pending.Report, `"totalTokens":400`) {
			t.Fatalf("expected corrected lower row, got %s", pending.Report)
		}

		if err := pending.Commit(); err != nil {
			t.Fatal(err)
		}
		cache, err := os.ReadFile(filepath.Join(cacheDir, "usage-maxima-combined.json"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(cache), fmt.Sprintf(`"version": %d`, usageMaximaVersion)) {
			t.Fatalf("expected version %d cache, got %s", usageMaximaVersion, cache)
		}
	}
}

func TestUsageMaximaPathAcceptsEveryUploadedPlatform(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	for _, cacheName := range []string{"combined", platformKimi, platformGrok, platformGLM, platformPi, platformOpenCode, platformCursor, platformCodex} {
		if _, err := usageMaximaPath(cacheName); err != nil {
			t.Fatalf("usageMaximaPath(%q) = %v", cacheName, err)
		}
	}
	if _, err := usageMaximaPath("../escape"); err == nil {
		t.Fatal("expected unknown cache names to be rejected")
	}
}

func TestUploadCcusageNeverSendsReplace(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	if err := uploadCcusage(server.URL, "test-token", `{"daily":[]}`, "secrig", "kimi"); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["replace"]; ok {
		t.Fatalf("CLI must not send replace (got %#v) — LDP never had this field", payload["replace"])
	}
	if payload["platform"] != "kimi" {
		t.Fatalf("platform = %#v", payload["platform"])
	}
}

func TestUploadUsageReportKeepsMaximaAfterFailedUpload(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	cacheDir := filepath.Join(home, ".ccrank")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(cacheDir, "usage-maxima-kimi.json")
	if err := os.WriteFile(cachePath, []byte(`{"version":2,"daily":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "try again", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)

	pending := &pendingUsageUpload{
		Report: `{"daily":[]}`,
		Commit: func() error { t.Fatal("commit must not run for a failed upload"); return nil },
	}
	err := uploadUsageReport(server.URL, "test-token", pending, "secrig", "kimi")
	if err == nil {
		t.Fatal("expected failed upload")
	}
	after, readErr := os.ReadFile(cachePath)
	if readErr != nil {
		t.Fatalf("a failed upload must leave the maxima cache in place, got %v", readErr)
	}
	if string(after) != `{"version":2,"daily":[]}` {
		t.Fatalf("a failed upload must not modify the maxima cache, got %s", after)
	}
}

// A failed upload must not throw away rows the server already accepted. With an
// empty cache the whole history is re-offered as one batch, so a single row the
// server rejects anywhere in it would then fail every later run as well.
func TestFailedUploadKeepsCommittedRowsSoOnlyNewRowsAreReoffered(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	accept := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !accept {
			http.Error(w, `{"ok":false,"error":"rejected"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	report := map[string]any{"type": "daily"}
	unchanged := "no higher combined usage rows found"

	first := []map[string]any{
		{"date": "2026-07-01", "totalTokens": 400.0, "totalCost": 1.0},
		{"date": "2026-07-02", "totalTokens": 250.0, "totalCost": 0.5},
	}
	pending, err := prepareUsageUpload(report, first, "combined", unchanged)
	if err != nil {
		t.Fatal(err)
	}
	if err := uploadUsageReport(server.URL, "test-token", pending, "rig", platformCombined); err != nil {
		t.Fatal(err)
	}

	// A later run has one new row and the server rejects the batch.
	accept = false
	next := func() []map[string]any {
		return []map[string]any{
			{"date": "2026-07-01", "totalTokens": 400.0, "totalCost": 1.0},
			{"date": "2026-07-02", "totalTokens": 250.0, "totalCost": 0.5},
			{"date": "2026-07-03", "totalTokens": 90.0, "totalCost": 0.2},
		}
	}
	pending, err = prepareUsageUpload(report, next(), "combined", unchanged)
	if err != nil {
		t.Fatal(err)
	}
	if err := uploadUsageReport(server.URL, "test-token", pending, "rig", platformCombined); err == nil {
		t.Fatal("expected the rejected upload to surface")
	}

	retried, err := prepareUsageUpload(report, next(), "combined", unchanged)
	if err != nil {
		t.Fatalf("the rejected row must be re-offered, got %v", err)
	}
	if !strings.Contains(retried.Report, `"2026-07-03"`) {
		t.Fatalf("retried report lost the new row: %s", retried.Report)
	}
	if strings.Contains(retried.Report, `"2026-07-01"`) || strings.Contains(retried.Report, `"2026-07-02"`) {
		t.Fatalf("a failed upload must not re-offer rows the server already has: %s", retried.Report)
	}
}

func TestFailedUploadLeavesNoMaximaBehindAndReoffersRows(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		http.Error(w, "try again", http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)

	entries := []map[string]any{
		{"date": "2026-08-12", "totalTokens": 400.0, "totalCost": 1.0},
		{"date": "2026-08-13", "totalTokens": 250.0, "totalCost": 0.5},
	}
	report := map[string]any{"type": "daily"}

	pending, err := prepareUsageUpload(report, entries, platformKimi, "no higher Kimi usage rows found")
	if err != nil {
		t.Fatal(err)
	}
	if err := uploadUsageReport(server.URL, "test-token", pending, "rig", platformKimi); err == nil {
		t.Fatal("expected the failed upload to surface")
	}

	cachePath := filepath.Join(home, ".ccrank", "usage-maxima-kimi.json")
	if _, statErr := os.Stat(cachePath); !os.IsNotExist(statErr) {
		t.Fatalf("failed upload must not leave a maxima cache behind, got %v", statErr)
	}

	// The same rows must be offered again on the next run.
	retried, err := prepareUsageUpload(report, entries, platformKimi, "no higher Kimi usage rows found")
	if err != nil {
		t.Fatalf("rows must be re-offered after a failed upload, got %v", err)
	}
	if !strings.Contains(retried.Report, `"2026-08-12"`) || !strings.Contains(retried.Report, `"2026-08-13"`) {
		t.Fatalf("retried report lost rows: %s", retried.Report)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestSuccessfulUploadCommitsExactRowsAndSuppressesAnIdenticalRerun(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(raw))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	entries := []map[string]any{
		{"date": "2026-08-12", "totalTokens": 400.0, "totalCost": 1.0},
		{"date": "2026-08-13", "totalTokens": 250.0, "totalCost": 0.5},
	}
	report := map[string]any{"type": "daily"}

	pending, err := prepareUsageUpload(report, entries, platformKimi, "no higher Kimi usage rows found")
	if err != nil {
		t.Fatal(err)
	}
	if err := uploadUsageReport(server.URL, "test-token", pending, "rig", platformKimi); err != nil {
		t.Fatal(err)
	}
	if len(bodies) != 1 {
		t.Fatalf("uploads = %d, want 1", len(bodies))
	}

	cache, err := os.ReadFile(filepath.Join(home, ".ccrank", "usage-maxima-kimi.json"))
	if err != nil {
		t.Fatalf("successful upload must persist the maxima cache: %v", err)
	}
	var stored struct {
		Daily []struct {
			Date        string  `json:"date"`
			TotalTokens float64 `json:"totalTokens"`
			TotalCost   float64 `json:"totalCost"`
		} `json:"daily"`
	}
	if err := json.Unmarshal(cache, &stored); err != nil {
		t.Fatal(err)
	}
	want := map[string][2]float64{
		"2026-08-12": {400, 1},
		"2026-08-13": {250, 0.5},
	}
	if len(stored.Daily) != len(want) {
		t.Fatalf("cached rows = %#v, want exactly the uploaded rows", stored.Daily)
	}
	for _, row := range stored.Daily {
		expected, ok := want[row.Date]
		if !ok || row.TotalTokens != expected[0] || row.TotalCost != expected[1] {
			t.Fatalf("cached row %#v does not match the uploaded rows", row)
		}
	}

	// A second identical run must offer nothing and hit the server zero times.
	if _, err := prepareUsageUpload(report, entries, platformKimi, "no higher Kimi usage rows found"); err == nil || !strings.Contains(err.Error(), "no higher Kimi usage rows found") {
		t.Fatalf("identical rerun must be suppressed by the cache, got %v", err)
	}
	if len(bodies) != 1 {
		t.Fatalf("suppressed rerun must not upload, requests = %d", len(bodies))
	}
}

func TestUsageSnapshotForDateSumsMatchingRows(t *testing.T) {
	entries := []map[string]any{
		{
			"date":         "2026-06-23",
			"totalTokens":  100.0,
			"outputTokens": 40.0,
			"totalCost":    1.25,
		},
		{
			"period":       "2026-06-23",
			"totalTokens":  50.0,
			"outputTokens": 20.0,
			"costUSD":      0.75,
		},
		{
			"date":         "2026-06-22",
			"totalTokens":  1000.0,
			"outputTokens": 400.0,
			"totalCost":    10.0,
		},
	}

	snapshot := usageSnapshotForDate(entries, "2026-06-23")
	if snapshot == nil {
		t.Fatal("expected usage snapshot")
	}
	if snapshot.Date != "2026-06-23" {
		t.Fatalf("Date = %s", snapshot.Date)
	}
	if got := snapshot.TotalTokens; got != 150 {
		t.Fatalf("TotalTokens = %v", got)
	}
	if got := snapshot.OutputTokens; got != 60 {
		t.Fatalf("OutputTokens = %v", got)
	}
	if got := snapshot.TotalCost; got != 2.0 {
		t.Fatalf("TotalCost = %v", got)
	}
}

func TestCombineUsageSnapshotsIncludesSeparateKimiUpload(t *testing.T) {
	combined := &UsageSnapshot{Date: "2026-08-12", TotalTokens: 100, OutputTokens: 20, TotalCost: 1}
	kimi := &UsageSnapshot{Date: "2026-08-12", TotalTokens: 430, OutputTokens: 30, TotalCost: 0.25}

	total := combineUsageSnapshots(combined, kimi)
	if total.TotalTokens != 530 || total.OutputTokens != 50 || total.TotalCost != 1.25 {
		t.Fatalf("combined snapshot = %#v", total)
	}
}

func TestUsageDisplayFormattingMatchesLeaderboard(t *testing.T) {
	snapshot := UsageSnapshot{
		TotalCost:   558.2712551500013,
		TotalTokens: 569086557,
	}

	if got := snapshotCostText(snapshot); got != "$558.27" {
		t.Fatalf("cost text = %s", got)
	}
	if got := snapshotTokensText(snapshot); got != "569.1M" {
		t.Fatalf("tokens text = %s", got)
	}
	if !usageSnapshotsDisplayEqual(
		snapshot,
		UsageSnapshot{CostText: "$558.27", TokensText: "569.1M"},
	) {
		t.Fatal("expected formatted usage snapshots to match")
	}
}

func TestParsePublicDailyLeaderboardRows(t *testing.T) {
	html := `<table><tbody><tr class="rank-1">
		<td><span>&#x1f947;</span>1</td>
		<td><div class="font-medium"><a href="/user/arbaz-khan">Arbaz Khan</a></div><div>Token Maximalist</div></td>
		<td>562.5M</td>
		<td>$547.29</td>
		<td>4.3K t/$</td>
	</tr></tbody></table>`

	rows := parsePublicDailyLeaderboardRows(html, "2026-06-23", "https://ccrank.dev/leaderboard?sort=tokens&view=daily")
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	row := rows[0]
	if row.Rank != 1 {
		t.Fatalf("rank = %d", row.Rank)
	}
	if row.DisplayName != "Arbaz Khan" {
		t.Fatalf("display name = %s", row.DisplayName)
	}
	if row.CostText != "$547.29" || row.TotalCost != 547.29 {
		t.Fatalf("cost = %s/%v", row.CostText, row.TotalCost)
	}
	if row.TokensText != "562.5M" || row.TotalTokens != 562500000 {
		t.Fatalf("tokens = %s/%v", row.TokensText, row.TotalTokens)
	}
}

func TestLoadAntigravityUsageEntriesBuildsEstimatedDailyRows(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	settingsDir := filepath.Join(home, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(settingsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(settingsDir, "settings.json"), []byte(`{"model":"Gemini 3.5 Flash (High)"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	transcriptDir := filepath.Join(settingsDir, "brain", "session-a", ".system_generated", "logs")
	if err := os.MkdirAll(transcriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := []map[string]any{
		{
			"source":     "USER_EXPLICIT",
			"type":       "USER_INPUT",
			"status":     "DONE",
			"created_at": "2026-05-21T08:00:00Z",
			"content":    "aaaaaaaa",
		},
		{
			"source":     "MODEL",
			"type":       "PLANNER_RESPONSE",
			"status":     "DONE",
			"created_at": "2026-05-21T08:00:01Z",
			"content":    "bbbbbbbb",
			"thinking":   "cccc",
		},
		{
			"source":     "MODEL",
			"type":       "VIEW_FILE",
			"status":     "DONE",
			"created_at": "2026-05-21T08:00:02Z",
			"content":    "dddddddddddddddddddd",
		},
		{
			"source":     "MODEL",
			"type":       "RUN_COMMAND",
			"status":     "RUNNING",
			"created_at": "2026-05-21T08:00:03Z",
			"content":    "eeeeeeeeeeeeeeeeeeee",
		},
	}
	var transcript []byte
	for _, line := range lines {
		encoded, err := json.Marshal(line)
		if err != nil {
			t.Fatal(err)
		}
		transcript = append(transcript, encoded...)
		transcript = append(transcript, '\n')
	}
	if err := os.WriteFile(filepath.Join(transcriptDir, "transcript.jsonl"), transcript, 0o644); err != nil {
		t.Fatal(err)
	}

	entries, err := loadAntigravityUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	entry := entries[0]
	if entry["date"] != "2026-05-21" {
		t.Fatalf("date = %v", entry["date"])
	}
	if got := numberValue(entry["inputTokens"]); got != 7 {
		t.Fatalf("inputTokens = %v", got)
	}
	if got := numberValue(entry["outputTokens"]); got != 3 {
		t.Fatalf("outputTokens = %v", got)
	}
	if got := numberValue(entry["totalTokens"]); got != 10 {
		t.Fatalf("totalTokens = %v", got)
	}
	models, ok := entry["modelsUsed"].([]string)
	if !ok || len(models) != 1 || models[0] != "gemini-3-5-flash-high-antigravity-estimate" {
		t.Fatalf("modelsUsed = %#v", entry["modelsUsed"])
	}
}

func TestLoadKimiUsageEntriesAggregatesTurnsAndDeduplicatesMigratedSessions(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	duplicateRecords := []map[string]any{
		{
			"type":       "usage.record",
			"time":       float64(1786038447534),
			"model":      "moonshot-ai/kimi-k3",
			"usageScope": "turn",
			"usage": map[string]any{
				"inputOther":         100,
				"output":             20,
				"inputCacheRead":     200,
				"inputCacheCreation": 10,
			},
		},
		{
			"type":       "usage.record",
			"time":       float64(1786038448000),
			"model":      "moonshot-ai/kimi-k3",
			"usageScope": "session",
			"usage": map[string]any{
				"inputOther": 9999,
				"output":     9999,
			},
		},
	}

	writeJSONL := func(path string, records []map[string]any) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		var data []byte
		for _, record := range records {
			encoded, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			data = append(data, encoded...)
			data = append(data, '\n')
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	legacyWire := filepath.Join(home, ".kimi", "sessions", "work-a", "session-1", "wire.jsonl")
	currentWire := filepath.Join(home, ".kimi-code", "sessions", "wd-a", "session_session-1", "agents", "main", "wire.jsonl")
	writeJSONL(legacyWire, duplicateRecords)
	writeJSONL(currentWire, duplicateRecords)

	subagentWire := filepath.Join(home, ".kimi-code", "sessions", "wd-a", "session_session-1", "agents", "agent-0", "wire.jsonl")
	writeJSONL(subagentWire, []map[string]any{
		{
			"type":       "usage.record",
			"time":       float64(1786038450000),
			"model":      "moonshot-ai/kimi-k3",
			"usageScope": "turn",
			"usage": map[string]any{
				"inputOther":         50,
				"output":             10,
				"inputCacheRead":     25,
				"inputCacheCreation": 5,
			},
		},
	})

	entries, err := loadKimiUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}

	entry := entries[0]
	if got := numberValue(entry["inputTokens"]); got != 150 {
		t.Fatalf("inputTokens = %v", got)
	}
	if got := numberValue(entry["outputTokens"]); got != 30 {
		t.Fatalf("outputTokens = %v", got)
	}
	if got := numberValue(entry["cacheReadTokens"]); got != 225 {
		t.Fatalf("cacheReadTokens = %v", got)
	}
	if got := numberValue(entry["cacheCreationTokens"]); got != 15 {
		t.Fatalf("cacheCreationTokens = %v", got)
	}
	if got := numberValue(entry["totalTokens"]); got != 420 {
		t.Fatalf("totalTokens = %v", got)
	}
	if got := usageCostValue(entry); got != 0 {
		t.Fatalf("cost = %v", got)
	}
	models, ok := entry["modelsUsed"].([]string)
	if !ok || len(models) != 1 || models[0] != "moonshot-ai/kimi-k3" {
		t.Fatalf("modelsUsed = %#v", entry["modelsUsed"])
	}
}

func TestPiUsageIsRoutedToThePlatformThatOwnsEachModel(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	records := []map[string]any{
		{"type": "model_change", "provider": "moonshot", "modelId": "kimi-k2"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 100, "output": 20, "cacheRead": 300, "cacheWrite": 10,
				"totalTokens": 430, "cost": map[string]any{"total": 0.25},
			}},
		},
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:01:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 50, "output": 5, "totalTokens": 55,
				"cost": map[string]any{"total": 0.1},
			}},
		},
		{"type": "model_change", "provider": "hetzner", "modelId": "GLM-5.2-NVFP4"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:02:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 70, "output": 7, "totalTokens": 77,
				"cost": map[string]any{"total": 0.2},
			}},
		},
		{"type": "model_change", "provider": "xai", "modelId": "grok-4.6"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:03:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 80, "output": 8, "totalTokens": 88,
				"cost": map[string]any{"total": 0.3},
			}},
		},
	}

	var data []byte
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		platform string
		tokens   float64
		cost     float64
	}{
		{platformPi, 55, 0.1},
		{platformKimi, 430, 0.25},
		{platformGLM, 77, 0.2},
		{platformGrok, 88, 0.3},
	} {
		entries, err := loadPiUsageEntriesFor(tc.platform)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || numberValue(entries[0]["totalTokens"]) != tc.tokens {
			t.Fatalf("%s entries = %#v", tc.platform, entries)
		}
		if got := usageCostValue(entries[0]); got != tc.cost {
			t.Fatalf("%s cost = %v, want %v", tc.platform, got, tc.cost)
		}
	}

	// Pi no longer backfills the combined bucket: ccusage imports it natively
	// and ccrank uploads it under the Pi platform, so a failed ccusage run has
	// nothing left to report as combined usage.
	if _, _, err := parseCcusageReportWithLocalExtras([]byte(`not-json`)); err == nil {
		t.Fatal("expected an error when ccusage fails and no local extras remain")
	}
}

func TestServerConsistentTotal(t *testing.T) {
	for _, tc := range []struct{ reported, components, want float64 }{
		{10190, 10000, 10000},    // 1.9% off: replaced by the component sum
		{100050, 100000, 100050}, // 0.05% off: within tolerance, kept as reported
		{0, 0, 0},
		{5, 3, 3}, // tolerance floor is 1 token
		{5, 4, 5},
	} {
		if got := serverConsistentTotal(tc.reported, tc.components); got != tc.want {
			t.Fatalf("serverConsistentTotal(%v, %v) = %v, want %v", tc.reported, tc.components, got, tc.want)
		}
	}
}

// Pi copies the session's own totalTokens when it is non-zero. A record whose
// total is more than 0.1% off its components would get the server to reject the
// whole Pi upload (and the Kimi/Grok/GLM uploads that merge Pi records), so it
// is replaced by the component sum; consistent records keep their total.
func TestPiRecordWithInconsistentTotalIsMadeServerConsistent(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	message := func(ts string, input, output, cacheRead, total int) map[string]any {
		return map[string]any{
			"type":      "message",
			"timestamp": ts,
			"message": map[string]any{"usage": map[string]any{
				"input": input, "output": output, "cacheRead": cacheRead,
				"totalTokens": total, "cost": map[string]any{"total": 0.1},
			}},
		}
	}
	records := []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		message("2026-08-12T10:00:00Z", 1000, 200, 8800, 10190), // 1.9% off -> 10000
		message("2026-08-12T10:01:00Z", 50, 5, 0, 55),           // consistent -> 55
		message("2026-08-12T10:02:00Z", 100000, 0, 0, 100050),   // within tolerance -> 100050
	}
	var data []byte
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 110105 {
		t.Fatalf("totalTokens = %v, want 110105 (10000 + 55 + 100050)", got)
	}
	assertServerConsistentTotal(t, entries[0])
}

func TestPiSubagentTranscriptsCountTowardOwningPlatform(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	writeJSONL := func(path string, records []map[string]any) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		var data []byte
		for _, record := range records {
			encoded, err := json.Marshal(record)
			if err != nil {
				t.Fatal(err)
			}
			data = append(data, encoded...)
			data = append(data, '\n')
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	tsMillis := float64(day.UnixMilli())

	// Main session shape: model carried by model_change state.
	writeJSONL(filepath.Join(home, ".pi", "agent", "sessions", "main.jsonl"), []map[string]any{
		{"type": "model_change", "provider": "zai", "modelId": "glm-5.3"},
		{
			"type":      "message",
			"timestamp": "2026-09-09T10:00:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 1000, "output": 100, "cacheRead": 5000, "cacheWrite": 0,
				"totalTokens": 6100, "cost": map[string]any{"total": 1.5},
			}},
		},
	})

	// Subagent transcript shape: recordType instead of type, per-record model,
	// epoch-millis timestamps, no model_change lines, plus non-message noise.
	writeJSONL(filepath.Join(home, ".pi", "agent", "sessions", "sess", "subagent-artifacts", "w_transcript.jsonl"), []map[string]any{
		{
			"recordType": "message", "ts": tsMillis,
			"timestamp": "2026-09-09T12:00:00Z", "model": "glm-5.3-flash",
			"message": map[string]any{
				"provider": "zai", "model": "glm-5.3-flash", "timestamp": tsMillis,
				"usage": map[string]any{
					"input": 2000, "output": 200, "cacheRead": 7000, "cacheWrite": 0,
					"totalTokens": 9200, "cost": map[string]any{"total": 2.5},
				},
			},
		},
		{"recordType": "stderr", "ts": tsMillis, "text": "noise"},
		{"recordType": "tool_start", "ts": tsMillis},
	})

	entries, err := loadPiUsageEntriesFor(platformGLM)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 glm daily entry, got %d", len(entries))
	}
	entry := entries[0]
	if got := numberValue(entry["totalTokens"]); got != 15300 {
		t.Fatalf("totalTokens = %v, want 15300 (main 6100 + subagent 9200)", got)
	}
	if got := numberValue(entry["inputTokens"]); got != 3000 {
		t.Fatalf("inputTokens = %v, want 3000", got)
	}
	if got := usageCostValue(entry); got != 4.0 {
		t.Fatalf("cost = %v, want 4.0", got)
	}
	models, ok := entry["modelsUsed"].([]string)
	if !ok || len(models) != 2 || models[0] != "pi-zai-glm-5-3" || models[1] != "pi-zai-glm-5-3-flash" {
		t.Fatalf("modelsUsed = %#v", entry["modelsUsed"])
	}

	// The same lines must not also rank under Pi: only the excluded zero row.
	piEntries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(piEntries) != 1 {
		t.Fatalf("expected 1 pi daily entry, got %d", len(piEntries))
	}
	if got := numberValue(piEntries[0]["totalTokens"]); got != 0 {
		t.Fatalf("pi totalTokens = %v, want excluded zero row", got)
	}
}

func TestLoadPiUsageEntriesSkipsUnreadableSessions(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".pi", "agent", "sessions")
	records := []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 50, "output": 5, "totalTokens": 55,
				"cost": map[string]any{"total": 0.1},
			}},
		},
	}
	writeJSONL(t, filepath.Join(root, "readable.jsonl"), records)
	lockedFile := filepath.Join(root, "locked.jsonl")
	writeJSONL(t, lockedFile, records)
	lockedDir := filepath.Join(root, "locked-directory")
	writeJSONL(t, filepath.Join(lockedDir, "session.jsonl"), records)
	if err := os.Chmod(lockedFile, 0); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(lockedDir, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(lockedFile, 0o600)
		_ = os.Chmod(lockedDir, 0o700)
	})

	file, fileErr := os.Open(lockedFile)
	if fileErr == nil {
		_ = file.Close()
	}
	_, dirErr := os.ReadDir(lockedDir)
	if !os.IsPermission(fileErr) || !os.IsPermission(dirErr) {
		t.Skip("filesystem does not enforce permission bits")
	}

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || numberValue(entries[0]["totalTokens"]) != 55 {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestPiUsageIsHeldOutOfTheCombinedBucket(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-08-14","inputTokens":300,"outputTokens":30,"cacheReadTokens":900,"totalTokens":1230,"totalCost":3,
		"agents":[
			{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":510,"totalCost":1,"modelsUsed":["claude-opus-5"]},
			{"agent":"pi","inputTokens":150,"outputTokens":15,"cacheReadTokens":300,"totalTokens":465,"totalCost":1.5,"modelsUsed":["[pi] GLM-5.2-NVFP4"]},
			{"agent":"kimi","inputTokens":50,"outputTokens":5,"cacheReadTokens":200,"totalTokens":255,"totalCost":0.5,"modelsUsed":["kimi-k2"]},
			{"agent":"opencode","inputTokens":75,"outputTokens":10,"cacheReadTokens":150,"totalTokens":235,"totalCost":0.75,"modelsUsed":["opencode/gpt-5"]},
			{"agent":"grok","inputTokens":75,"outputTokens":15,"cacheReadTokens":225,"totalTokens":315,"totalCost":0.75,"modelsUsed":["grok-4.6-build"]},
			{"agent":"glm","inputTokens":50,"outputTokens":10,"cacheReadTokens":100,"totalTokens":160,"totalCost":0.5,"modelsUsed":["GLM-5.3"]}
		]}]}`)

	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	if len(combined) != 1 {
		t.Fatalf("combined entries = %#v", combined)
	}
	if got := numberValue(combined[0]["totalTokens"]); got != 510 {
		t.Fatalf("combined totalTokens = %v, want only the Claude agent's 510", got)
	}
	if got := usageCostValue(combined[0]); got != 1 {
		t.Fatalf("combined cost = %v, want 1", got)
	}
	if got := numberValue(combined[0]["cacheReadTokens"]); got != 400 {
		t.Fatalf("combined cacheReadTokens = %v, want 400", got)
	}
}

func TestCombinedRebuildRejectsRowsWithoutByAgentBreakdown(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	report := []byte(`{"daily":[{"period":"2026-08-14","inputTokens":300,"outputTokens":30,"totalTokens":330,"totalCost":3}]}`)
	_, _, err := parseCcusageReportWithLocalExtras(report)
	if err == nil || !strings.Contains(err.Error(), "--by-agent") || !strings.Contains(err.Error(), "agents[]") {
		t.Fatalf("expected a clear by-agent contract error, got %v", err)
	}
}

func TestUnheldDedicatedAgentDetection(t *testing.T) {
	cases := []struct {
		agent string
		want  string
	}{
		{"pi", ""},                       // already held out
		{"kimi", ""},                     // already held out
		{"opencode", ""},                 // already held out
		{"grok", ""},                     // already held out
		{"glm", ""},                      // already held out
		{"PI", ""},                       // held out, case-insensitive
		{"Kimi", ""},                     // held out, case-insensitive
		{"OpenCode", ""},                 // held out, case-insensitive
		{"Grok", ""},                     // held out, case-insensitive
		{"GLM", ""},                      // held out, case-insensitive
		{"claude", ""},                   // unrelated agent
		{"codex", ""},                    // already held out
		{"Codex", ""},                    // held out, case-insensitive
		{"codex-nightly", platformCodex}, // future codex-* names must fail loud
		{"gemini", ""},                   // unrelated agent
		{"hermes", ""},                   // unrelated agent
		{"antigravity", ""},              // unrelated agent
		{"", ""},                         // blank slice name
		{"cursor", ""},                   // already held out
		{"CURSOR", ""},                   // held out, case-insensitive
		{"muse", ""},                     // already held out
		{"Muse", ""},                     // held out, case-insensitive
		{"muse-spark", platformMuse},     // future muse-* names must fail loud
	}
	for _, tc := range cases {
		if got := unheldDedicatedAgent(tc.agent); got != tc.want {
			t.Errorf("unheldDedicatedAgent(%q) = %q, want %q", tc.agent, got, tc.want)
		}
	}
}

func TestCombinedRebuildHoldsOutNewlySupportedDedicatedAgents(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-08-14","inputTokens":300,"outputTokens":30,"totalTokens":330,"totalCost":3,
		"agents":[
			{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":510,"totalCost":1},
			{"agent":"grok","inputTokens":200,"outputTokens":20,"cacheReadTokens":0,"totalTokens":220,"totalCost":2}
		]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatalf("dedicated Grok rows must be held out without blocking combined usage, got %v", err)
	}
	if len(combined) != 1 || numberValue(combined[0]["totalTokens"]) != 510 {
		t.Fatalf("combined entries = %#v, want only Claude's 510 tokens", combined)
	}

	// Codex rows are held out the same way now that Codex uploads separately.
	report = []byte(`{"daily":[{"period":"2026-08-14","inputTokens":100,"outputTokens":10,"totalTokens":110,"totalCost":1,
		"agents":[
			{"agent":"claude","inputTokens":60,"outputTokens":6,"totalTokens":66,"totalCost":0.6},
			{"agent":"codex","inputTokens":40,"outputTokens":4,"totalTokens":44,"totalCost":0.4}
		]}]}`)
	_, entries, err = parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err = rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatalf("codex rows must be held out without blocking combined usage, got %v", err)
	}
	if len(combined) != 1 || numberValue(combined[0]["totalTokens"]) != 66 {
		t.Fatalf("combined entries = %#v, want only Claude's 66 tokens", combined)
	}
}

func TestCombinedRebuildHoldsOutCursorAgent(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-09-04","inputTokens":300,"outputTokens":30,"totalTokens":330,"totalCost":3,
		"agents":[
			{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":510,"totalCost":1},
			{"agent":"cursor","inputTokens":200,"outputTokens":20,"cacheReadTokens":0,"totalTokens":220,"totalCost":2}
		]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatalf("Cursor rows must be held out without blocking combined usage, got %v", err)
	}
	if len(combined) != 1 || numberValue(combined[0]["totalTokens"]) != 510 {
		t.Fatalf("combined entries = %#v, want only Claude's 510 tokens", combined)
	}
}

func TestCodexUsageSplitReconcilesWithCombined(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	// "Codex" is mixed-case on purpose: agent matching is case-insensitive.
	report := []byte(`{"type":"daily","daily":[
		{"period":"2026-09-01","inputTokens":300,"outputTokens":30,"cacheCreationTokens":10,"cacheReadTokens":700,"totalTokens":1040,"totalCost":3,
		"agents":[
			{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheCreationTokens":4,"cacheReadTokens":400,"totalTokens":514,"totalCost":1,"modelsUsed":["claude-opus-5"]},
			{"agent":"Codex","inputTokens":200,"outputTokens":20,"cacheCreationTokens":6,"cacheReadTokens":300,"totalTokens":526,"totalCost":2,"modelsUsed":["gpt-5.5"]}
		]},
		{"period":"2026-09-02","inputTokens":50,"outputTokens":5,"cacheCreationTokens":1,"cacheReadTokens":40,"totalTokens":96,"totalCost":0.5,
		"agents":[
			{"agent":"claude","inputTokens":50,"outputTokens":5,"cacheCreationTokens":1,"cacheReadTokens":40,"totalTokens":96,"totalCost":0.5,"modelsUsed":["claude-opus-5"]}
		]}
	]}`)

	_, raw, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	// Rows without an agents[] split (like the npx-failed fallback path) must
	// be skipped silently by the Codex builder, never an error.
	raw = append(raw, map[string]any{"date": "2026-09-03", "totalTokens": 8.0, "totalCost": 0.1})

	combined, err := rebuildCombinedEntries(raw[:2])
	if err != nil {
		t.Fatal(err)
	}
	if len(combined) != 2 {
		t.Fatalf("combined entries = %#v, want 2 rows", combined)
	}
	if got := numberValue(combined[0]["totalTokens"]); got != 514 {
		t.Fatalf("combined 2026-09-01 totalTokens = %v, want only Claude's 514", got)
	}
	if got := numberValue(combined[1]["totalTokens"]); got != 96 {
		t.Fatalf("combined 2026-09-02 totalTokens = %v, want 96", got)
	}

	pending, _, err := runCodexUsageFromEntries(raw)
	if err != nil {
		t.Fatal(err)
	}
	if pending == nil {
		t.Fatal("expected a Codex upload to be prepared")
	}
	var prepared struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &prepared); err != nil {
		t.Fatal(err)
	}
	if len(prepared.Daily) != 1 {
		t.Fatalf("codex rows = %#v, want only the 2026-09-01 row", prepared.Daily)
	}
	codex := prepared.Daily[0]
	if got := usageDate(codex); got != "2026-09-01" {
		t.Fatalf("codex date = %q, want 2026-09-01", got)
	}
	for key, want := range map[string]float64{
		"inputTokens": 200, "outputTokens": 20, "cacheCreationTokens": 6,
		"cacheReadTokens": 300, "totalTokens": 526, "totalCost": 2,
	} {
		if got := numberValue(codex[key]); got != want {
			t.Errorf("codex %s = %v, want %v", key, got, want)
		}
	}
	// Per-date reconciliation: combined (codex held out) + codex == original
	// ccusage totals, so the split loses and double-counts nothing.
	for key, want := range map[string]float64{
		"inputTokens": 300, "outputTokens": 30, "cacheCreationTokens": 10,
		"cacheReadTokens": 700, "totalTokens": 1040, "totalCost": 3,
	} {
		combinedVal, codexVal := numberValue(combined[0][key]), numberValue(codex[key])
		if key == "totalCost" {
			combinedVal, codexVal = usageCostValue(combined[0]), usageCostValue(codex)
		}
		if combinedVal+codexVal != want {
			t.Errorf("combined + codex %s = %v + %v, want original %v", key, combinedVal, codexVal, want)
		}
	}

	// The maxima gate uses a per-platform cache that resolves and commits.
	if err := pending.Commit(); err != nil {
		t.Fatal(err)
	}
	cache, err := os.ReadFile(filepath.Join(home, ".ccrank", "usage-maxima-codex.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cache), fmt.Sprintf(`"version": %d`, usageMaximaVersion)) {
		t.Fatalf("expected version %d codex cache, got %s", usageMaximaVersion, cache)
	}
	if _, _, err := runCodexUsageFromEntries(raw); err == nil || !strings.Contains(err.Error(), "no higher Codex usage rows found") {
		t.Fatalf("expected unchanged second upload to be skipped, got %v", err)
	}

	// Legacy servers predate the probe but have always known "codex", so the
	// fallback must keep permitting it.
	if !legacyPlatforms[platformCodex] {
		t.Fatal("codex must remain uploadable to legacy servers")
	}

	// No codex slices anywhere is a clean skip, not an error about row shape.
	for _, empty := range [][]map[string]any{
		nil,
		{{"date": "2026-09-03", "totalTokens": 8.0}},
	} {
		if _, _, err := runCodexUsageFromEntries(empty); err == nil || err.Error() != "no Codex usage found" {
			t.Fatalf("expected no Codex usage found, got %v", err)
		}
	}
}

func TestCombinedRebuildEmitsAZeroRowWhenOnlyDedicatedAgentsRan(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-08-14","inputTokens":150,"outputTokens":15,"totalTokens":465,"totalCost":1.5,
		"agents":[{"agent":"pi","inputTokens":150,"outputTokens":15,"cacheReadTokens":300,"totalTokens":465,"totalCost":1.5,"modelsUsed":["[pi] GLM-5.2-NVFP4"]}]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	// The row must survive at zero so an inflated row uploaded by an earlier
	// ccrank version is overwritten rather than left ranked.
	if len(combined) != 1 {
		t.Fatalf("combined entries = %#v", combined)
	}
	if got := numberValue(combined[0]["totalTokens"]); got != 0 {
		t.Fatalf("combined totalTokens = %v, want 0", got)
	}
	if got := usageDate(combined[0]); got != "2026-08-14" {
		t.Fatalf("combined date = %q", got)
	}
}

// assertServerConsistentTotal mirrors validateEntry in src/parser.ts: the server
// rejects the whole upload when a row's totalTokens is more than 0.1% (at least
// 1 token) away from the sum of its four component fields.
func assertServerConsistentTotal(t *testing.T, row map[string]any) {
	t.Helper()
	cacheRead := numberValue(row["cacheReadTokens"])
	if cacheRead == 0 {
		cacheRead = numberValue(row["cachedInputTokens"]) // parser.ts: cacheReadTokens || cachedInputTokens
	}
	sum := numberValue(row["inputTokens"]) + numberValue(row["outputTokens"]) +
		numberValue(row["cacheCreationTokens"]) + cacheRead
	total := numberValue(row["totalTokens"])
	tolerance := math.Max(1, math.Abs(total)*0.001)
	if math.Abs(total-sum) > tolerance {
		t.Fatalf("row %v: totalTokens %v differs from component sum %v beyond tolerance %v (the server would reject the whole upload)", row["date"], total, sum, tolerance)
	}
}

// ccusage's Antigravity slices report a total above the sum of the token fields
// they expose (extra tokens with no field of their own). Copying that total made
// Antigravity-dominated days fail the server's consistency check.
func TestCombinedRebuildFoldsUnexplainedSliceTokensIntoOutput(t *testing.T) {
	report := []byte(`{"daily":[
		{"period":"2026-07-01","agents":[
			{"agent":"antigravity","inputTokens":1000,"outputTokens":200,"cacheCreationTokens":0,"cacheReadTokens":8800,"totalTokens":10190,"totalCost":0.5},
			{"agent":"codex","inputTokens":50,"outputTokens":50,"cacheReadTokens":900,"totalTokens":1000,"totalCost":0.1}]},
		{"period":"2026-07-02","agents":[
			{"agent":"antigravity","inputTokens":100,"outputTokens":20,"cacheReadTokens":880,"totalTokens":1019,"totalCost":0.05},
			{"agent":"claude","inputTokens":10,"outputTokens":5,"cacheCreationTokens":5,"cacheReadTokens":980,"totalTokens":1000,"totalCost":0.2}]}
	]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	if len(combined) != 2 {
		t.Fatalf("combined entries = %#v", combined)
	}
	// The total is unchanged from the slice totals (10190; 1019 + 1000); the
	// unexplained remainder (190; 19) is folded into outputTokens (200+190;
	// 20+19+5) so the row equals its component sum.
	for index, want := range []struct{ total, output float64 }{{10190, 390}, {2019, 44}} {
		if got := numberValue(combined[index]["totalTokens"]); got != want.total {
			t.Fatalf("row %d totalTokens = %v, want %v", index, got, want.total)
		}
		if got := numberValue(combined[index]["outputTokens"]); got != want.output {
			t.Fatalf("row %d outputTokens = %v, want %v (remainder folded in)", index, got, want.output)
		}
		assertServerConsistentTotal(t, combined[index])
	}
}

func TestSliceTokensCountsOnlyCoherentSlices(t *testing.T) {
	for _, tc := range []struct {
		name                                                    string
		slice                                                   map[string]any
		wantVerdict                                             sliceVerdict
		wantInput, wantOutput, wantCacheCreation, wantCacheRead float64
	}{
		{"total above components by a plausible gap is folded into output",
			map[string]any{"inputTokens": 100.0, "outputTokens": 10.0, "cacheReadTokens": 400.0, "totalTokens": 530.0}, sliceCounted, 100, 30, 0, 400},
		{"consistent slice is unchanged",
			map[string]any{"inputTokens": 100.0, "outputTokens": 10.0, "cacheReadTokens": 400.0, "totalTokens": 510.0}, sliceCounted, 100, 10, 0, 400},
		{"components a hair above the total (within the server tolerance) are counted as is",
			map[string]any{"inputTokens": 100000.0, "totalTokens": 99950.0}, sliceCounted, 100000, 0, 0, 0},
		{"missing total counts the components",
			map[string]any{"inputTokens": 100.0, "outputTokens": 10.0, "totalTokens": 0.0}, sliceCounted, 100, 10, 0, 0},
		{"empty slice is fine and counts nothing",
			map[string]any{"totalTokens": 0.0}, sliceCounted, 0, 0, 0, 0},
		{"cachedInputTokens counts as cache read",
			map[string]any{"inputTokens": 100.0, "cachedInputTokens": 400.0, "totalTokens": 500.0}, sliceCounted, 100, 0, 0, 400},
		// A total implausibly far above the fields is not trusted, but the
		// fields themselves can never exceed what the slice reports, so they
		// (and the slice's cost) still count instead of being dropped.
		{"a huge total over one token field counts only the field",
			map[string]any{"agent": "antigravity", "inputTokens": 10.0, "totalTokens": 5e9}, sliceComponentsOnly, 10, 0, 0, 0},
		{"an unexplained gap just over 5% counts only the fields",
			map[string]any{"inputTokens": 40000.0, "outputTokens": 1000.0, "totalTokens": 46000.0}, sliceComponentsOnly, 40000, 1000, 0, 0},
		// Not counted: over-counting is permanent (the server never lowers a
		// row); an under-count can still be corrected later.
		{"overlapping fields (components far above the total) would inflate the row",
			map[string]any{"inputTokens": 1000.0, "outputTokens": 100.0, "cacheReadTokens": 800.0, "totalTokens": 1100.0}, sliceSkip, 0, 0, 0, 0},
		{"a total with no component fields is not attributed",
			map[string]any{"totalTokens": 500.0}, sliceSkip, 0, 0, 0, 0},
		{"a negative field would make the server reject the whole upload",
			map[string]any{"inputTokens": -5.0, "outputTokens": 105.0, "totalTokens": 100.0}, sliceSkip, 0, 0, 0, 0},
		{"a negative total is not counted",
			map[string]any{"inputTokens": 5.0, "totalTokens": -100.0}, sliceSkip, 0, 0, 0, 0},
	} {
		input, output, cacheCreation, cacheRead, verdict := sliceTokens(tc.slice)
		if verdict != tc.wantVerdict || input != tc.wantInput || output != tc.wantOutput || cacheCreation != tc.wantCacheCreation || cacheRead != tc.wantCacheRead {
			t.Fatalf("%s: got verdict=%v in=%v out=%v cc=%v cr=%v, want verdict=%v in=%v out=%v cc=%v cr=%v", tc.name,
				verdict, input, output, cacheCreation, cacheRead, tc.wantVerdict, tc.wantInput, tc.wantOutput, tc.wantCacheCreation, tc.wantCacheRead)
		}
	}
}

// An unusable slice is skipped from the row (with a warning) and a slice with an
// untrustworthy total still counts its token fields, instead of making the
// whole upload fail or inflating history permanently.
func TestCombinedAndCodexRowsHandleIncoherentSlices(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	report := []byte(`{"daily":[{"period":"2026-07-01","agents":[
		{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":510,"totalCost":1},
		{"agent":"gemini","inputTokens":10,"totalTokens":5000000000,"totalCost":9},
		{"agent":"grumble","inputTokens":1000,"outputTokens":100,"cacheReadTokens":800,"totalTokens":1100,"totalCost":4},
		{"agent":"codex","inputTokens":50,"outputTokens":5,"cacheReadTokens":0,"totalTokens":55,"totalCost":0.1},
		{"agent":"codex","inputTokens":1000,"outputTokens":100,"cacheReadTokens":800,"totalTokens":1100,"totalCost":7}]}]}`)
	_, raw, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(raw)
	if err != nil {
		t.Fatal(err)
	}
	// claude 510 + gemini's 10 token field (its absurd 5e9 total is ignored);
	// the overlapping "grumble" slice is skipped entirely, cost included.
	if got := numberValue(combined[0]["totalTokens"]); got != 520 {
		t.Fatalf("combined totalTokens = %v, want 520", got)
	}
	if got := usageCostValue(combined[0]); got != 10 {
		t.Fatalf("combined cost = %v, want 10 (claude 1 + gemini 9; grumble skipped)", got)
	}
	assertServerConsistentTotal(t, combined[0])
	pending, _, err := runCodexUsageFromEntries(raw)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &wire); err != nil {
		t.Fatal(err)
	}
	if got := numberValue(wire.Daily[0]["totalTokens"]); got != 55 {
		t.Fatalf("codex totalTokens = %v, want only the coherent slice (55)", got)
	}
	assertServerConsistentTotal(t, wire.Daily[0])
}

// ccusage's "zcode" agent is Z Code, which ccrank already uploads as the GLM
// platform from its rollout files; folding it into combined counts it twice.
func TestCombinedRebuildHoldsOutZCode(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-08-28","agents":[
		{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":510,"totalCost":1},
		{"agent":"zcode","inputTokens":700,"outputTokens":80,"cacheReadTokens":18000,"totalTokens":18780,"totalCost":2}]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatalf("zcode must be held out without blocking combined usage, got %v", err)
	}
	if len(combined) != 1 || numberValue(combined[0]["totalTokens"]) != 510 {
		t.Fatalf("combined entries = %#v, want only Claude's 510 tokens", combined)
	}
}

func TestCcusageAntigravityDates(t *testing.T) {
	_, raw, err := parseCcusageReport([]byte(`{"daily":[
		{"period":"2026-07-01","agents":[{"agent":"antigravity","inputTokens":1,"totalTokens":1},{"agent":"codex","totalTokens":5}]},
		{"period":"2026-07-02","agents":[{"agent":"antigravity","inputTokens":0,"totalTokens":0}]},
		{"period":"2026-07-03","agents":[{"agent":"claude","inputTokens":1,"totalTokens":1}]},
		{"period":"2026-07-04","agents":[{"agent":"antigravity","inputTokens":1000,"outputTokens":100,"cacheReadTokens":800,"totalTokens":1100}]}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	got := ccusageAntigravityDates(raw)
	// 07-04's slice is skipped as incoherent (overlapping fields), so the
	// transcript estimate must remain the fallback for that date.
	if len(got) != 1 || !got["2026-07-01"] {
		t.Fatalf("antigravity dates = %#v, want only 2026-07-01", got)
	}
}

func writeAntigravityTranscript(t *testing.T, home, date string, chars int) {
	t.Helper()
	path := filepath.Join(home, ".gemini", "antigravity-cli", "brain", "sess-"+date, ".system_generated", "logs", "transcript.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	line, err := json.Marshal(map[string]any{
		"source": "USER_EXPLICIT", "type": "USER_INPUT", "status": "DONE",
		"created_at": date + "T09:00:00Z", "content": strings.Repeat("x", chars),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(line, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// ccusage imports Antigravity natively; ccrank's transcript estimate covers the
// same sessions, so it must not be added on dates ccusage already reports, but
// stays as a fallback for dates ccusage does not.
func TestAntigravityTranscriptEstimateOnlyFillsDatesCcusageMisses(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeAntigravityTranscript(t, home, "2026-07-01", 400) // 100 estimated tokens
	writeAntigravityTranscript(t, home, "2026-07-05", 800) // 200 estimated tokens

	newEntries := func() []map[string]any {
		return []map[string]any{{
			"date": "2026-07-01", "inputTokens": 1000.0, "outputTokens": 0.0,
			"cacheCreationTokens": 0.0, "cacheReadTokens": 0.0, "totalTokens": 1000.0,
		}}
	}
	report := map[string]any{"daily": []map[string]any{}}

	covered := loadLocalUsageEntries(newEntries(), report, map[string]bool{"2026-07-01": true})
	if len(covered) != 2 || numberValue(covered[0]["totalTokens"]) != 1000 {
		t.Fatalf("covered date must keep ccusage's total untouched, got %#v", covered)
	}
	if usageDate(covered[1]) != "2026-07-05" || numberValue(covered[1]["totalTokens"]) != 200 {
		t.Fatalf("a date ccusage misses must still get the estimate, got %#v", covered)
	}

	uncovered := loadLocalUsageEntries(newEntries(), report, nil)
	if numberValue(uncovered[0]["totalTokens"]) != 1100 {
		t.Fatalf("without ccusage coverage the estimate is added, got %#v", uncovered[0])
	}
}

// The server reads cachedInputTokens as the cache-read count when
// cacheReadTokens is absent, so a derived total must not drop those tokens.
func TestCombinedRebuildCountsCachedInputTokensLikeTheServer(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-07-01","agents":[
		{"agent":"claude","inputTokens":100,"outputTokens":10,"cachedInputTokens":400,"totalTokens":510,"totalCost":1}]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	if got := numberValue(combined[0]["totalTokens"]); got != 510 {
		t.Fatalf("totalTokens = %v, want 510 (100 + 10 + 400 cached)", got)
	}
	if got := numberValue(combined[0]["cacheReadTokens"]); got != 400 {
		t.Fatalf("cacheReadTokens = %v, want the cached tokens carried over", got)
	}
	assertServerConsistentTotal(t, combined[0])
}

// The dedicated Codex upload is built from the same ccusage slices and is
// validated by the same server rule, so it derives its total the same way.
func TestCodexRowFoldsUnexplainedTokensIntoOutput(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	report := []byte(`{"daily":[{"period":"2026-07-01","agents":[
		{"agent":"codex","inputTokens":1000,"outputTokens":200,"cacheReadTokens":8800,"totalTokens":10190,"totalCost":0.5}]}]}`)
	_, raw, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	pending, _, err := runCodexUsageFromEntries(raw)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Daily) != 1 {
		t.Fatalf("wire rows = %#v", wire.Daily)
	}
	if got := numberValue(wire.Daily[0]["totalTokens"]); got != 10190 {
		t.Fatalf("codex totalTokens = %v, want the slice total 10190 kept", got)
	}
	if got := numberValue(wire.Daily[0]["outputTokens"]); got != 390 {
		t.Fatalf("codex outputTokens = %v, want 390 (200 + the 190 remainder)", got)
	}
	assertServerConsistentTotal(t, wire.Daily[0])
}

// The Codex builder honours the server's cachedInputTokens fallback too.
func TestCodexRowCountsCachedInputTokens(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, raw, err := parseCcusageReport([]byte(`{"daily":[{"period":"2026-07-01","agents":[
		{"agent":"codex","inputTokens":100,"outputTokens":10,"cachedInputTokens":400,"totalTokens":510,"totalCost":0.5}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	pending, _, err := runCodexUsageFromEntries(raw)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &wire); err != nil {
		t.Fatal(err)
	}
	if got := numberValue(wire.Daily[0]["cacheReadTokens"]); got != 400 {
		t.Fatalf("codex cacheReadTokens = %v, want 400", got)
	}
	assertServerConsistentTotal(t, wire.Daily[0])
}

// The Antigravity transcript estimator is merged into combined rows afterwards;
// it adds the same amount to a row's total and its components.
func TestCombinedRowStaysConsistentAfterAntigravityTranscriptMerge(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-07-01","agents":[
		{"agent":"antigravity","inputTokens":1000,"outputTokens":200,"cacheReadTokens":8800,"totalTokens":10190,"totalCost":0.5}]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	estimate := []map[string]any{{
		"date": "2026-07-01", "inputTokens": 73.0, "outputTokens": 13.0,
		"cacheCreationTokens": 0.0, "cacheReadTokens": 0.0, "totalTokens": 86.0,
	}}
	merged := mergeUsageEntries(combined, estimate)
	if len(merged) != 1 {
		t.Fatalf("merged entries = %#v", merged)
	}
	if got := numberValue(merged[0]["totalTokens"]); got != 10276 {
		t.Fatalf("merged totalTokens = %v, want 10276 (10190 + 86)", got)
	}
	assertServerConsistentTotal(t, merged[0])
}

// The rows that actually go on the wire, not just the in-memory entries, must
// pass the server's total check, including an Antigravity-only first row of the
// day and the full-history batch a run with no cache offers.
func TestCombinedUploadPayloadPassesServerTotalCheck(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	report := []byte(`{"daily":[
		{"period":"2026-06-30","agents":[{"agent":"codex","inputTokens":5,"outputTokens":5,"totalTokens":10}]},
		{"period":"2026-07-01","agents":[
			{"agent":"antigravity","inputTokens":1000,"outputTokens":200,"cacheReadTokens":8800,"totalTokens":10190,"totalCost":0.5}]},
		{"period":"2026-09-29","agents":[
			{"agent":"antigravity","inputTokens":50,"outputTokens":10,"cacheReadTokens":40,"totalTokens":101,"totalCost":0.01}]}
	]}`)
	parsed, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	setReportEntries(parsed, combined)
	pending, err := prepareUsageUpload(parsed, combined, "combined", "no higher combined usage rows found")
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Daily) != 3 {
		t.Fatalf("wire rows = %d, want the full 3-row history: %s", len(wire.Daily), pending.Report)
	}
	for _, row := range wire.Daily {
		assertServerConsistentTotal(t, row)
	}
}

func TestCombinedRebuildMergesMatchingModelBreakdowns(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-08-14","agents":[
		{"agent":"claude","inputTokens":10,"outputTokens":2,"cacheCreationTokens":3,"cacheReadTokens":4,"totalTokens":19,"totalCost":0.5,
		 "modelBreakdowns":[
			{"modelName":"zeta","inputTokens":1,"outputTokens":1,"cacheCreationTokens":1,"cacheReadTokens":1,"totalTokens":4,"cost":0.1},
			{"modelName":"alpha","inputTokens":9,"outputTokens":1,"cacheCreationTokens":2,"cacheReadTokens":3,"totalTokens":15,"cost":0.4}
		 ]},
		{"agent":"hermes","inputTokens":5,"outputTokens":6,"cacheCreationTokens":7,"cacheReadTokens":8,"totalTokens":26,"totalCost":0.6,
		 "modelBreakdowns":[
			{"modelName":"alpha","inputTokens":5,"outputTokens":6,"cacheCreationTokens":7,"cacheReadTokens":8,"totalTokens":26,"cost":0.6}
		 ]}
	]}]}`)
	_, entries, err := parseCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	combined, err := rebuildCombinedEntries(entries)
	if err != nil {
		t.Fatal(err)
	}
	if got := numberValue(combined[0]["totalTokens"]); got != 45 {
		t.Fatalf("combined totalTokens = %v, want 45", got)
	}
	breakdowns := combined[0]["modelBreakdowns"].([]map[string]any)
	if len(breakdowns) != 2 || modelBreakdownName(breakdowns[0]) != "alpha" || modelBreakdownName(breakdowns[1]) != "zeta" {
		t.Fatalf("modelBreakdowns = %#v", breakdowns)
	}
	alpha := breakdowns[0]
	for key, want := range map[string]float64{
		"inputTokens":         14,
		"outputTokens":        7,
		"cacheCreationTokens": 9,
		"cacheReadTokens":     11,
		"totalTokens":         41,
		"cost":                1,
	} {
		if got := numberValue(alpha[key]); got != want {
			t.Errorf("alpha %s = %v, want %v", key, got, want)
		}
	}
}

func TestMergeUsageEntriesAddsAntigravityToExistingDate(t *testing.T) {
	base := []map[string]any{
		{
			"date":         "2026-05-21",
			"inputTokens":  40.0,
			"outputTokens": 10.0,
			"totalTokens":  50.0,
			"totalCost":    5.0,
			"modelsUsed":   []any{"claude-opus-4-6"},
			"modelBreakdowns": []any{
				map[string]any{
					"modelName":    "claude-opus-4-6",
					"inputTokens":  40.0,
					"outputTokens": 10.0,
					"totalTokens":  50.0,
					"cost":         5.0,
				},
			},
		},
	}
	extras := []map[string]any{
		{
			"date":         "2026-05-21",
			"inputTokens":  7.0,
			"outputTokens": 3.0,
			"totalTokens":  10.0,
			"costUSD":      0.0,
			"modelsUsed":   []string{"gemini-antigravity-estimate"},
			"modelBreakdowns": []map[string]any{
				{
					"modelName":    "gemini-antigravity-estimate",
					"inputTokens":  7.0,
					"outputTokens": 3.0,
					"totalTokens":  10.0,
					"cost":         0.0,
				},
			},
		},
	}

	merged := mergeUsageEntries(base, extras)
	if len(merged) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(merged))
	}
	if got := numberValue(merged[0]["totalTokens"]); got != 60 {
		t.Fatalf("totalTokens = %v", got)
	}
	if got := numberValue(merged[0]["inputTokens"]); got != 47 {
		t.Fatalf("inputTokens = %v", got)
	}
	if got := numberValue(merged[0]["totalCost"]); got != 5 {
		t.Fatalf("totalCost = %v", got)
	}
	if got := numberValue(merged[0]["totalCostUSD"]); got != 5 {
		t.Fatalf("totalCostUSD = %v", got)
	}
	if got := numberValue(merged[0]["costUSD"]); got != 5 {
		t.Fatalf("costUSD = %v", got)
	}
	models := merged[0]["modelsUsed"].([]string)
	if len(models) != 2 {
		t.Fatalf("modelsUsed = %#v", models)
	}
	breakdowns := merged[0]["modelBreakdowns"].([]map[string]any)
	if len(breakdowns) != 2 {
		t.Fatalf("modelBreakdowns = %#v", breakdowns)
	}
	if got := numberValue(breakdowns[0]["cost"]); got != 5 {
		t.Fatalf("modelBreakdowns[0].cost = %v", got)
	}
}

func TestPiDedupCountsDuplicatedSessionFileOnce(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".pi", "agent", "sessions")

	records := []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 50, "output": 5, "totalTokens": 55,
				"cost": map[string]any{"total": 0.1},
			}},
		},
	}
	writeJSONL(t, filepath.Join(root, "session-1.jsonl"), records)
	writeJSONL(t, filepath.Join(root, "backups", "session-1-copy.jsonl"), records)

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 55 {
		t.Fatalf("totalTokens = %v, want 55 (duplicated file counted once)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 1 {
		t.Fatalf("messages = %v, want 1", got)
	}
}

func TestPiDedupCountsRereadRecordOnce(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	message := map[string]any{
		"type":      "message",
		"timestamp": "2026-08-12T10:00:00Z",
		"message": map[string]any{"usage": map[string]any{
			"input": 50, "output": 5, "totalTokens": 55,
			"cost": map[string]any{"total": 0.1},
		}},
	}
	writeJSONL(t, filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl"), []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		message,
		message,
	})

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 55 {
		t.Fatalf("totalTokens = %v, want 55 (re-read record counted once)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 1 {
		t.Fatalf("messages = %v, want 1", got)
	}
}

func TestPiDedupCoversSubagentTranscripts(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	day := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	tsMillis := float64(day.UnixMilli())
	record := map[string]any{
		"recordType": "message", "ts": tsMillis,
		"timestamp": "2026-09-09T12:00:00Z", "model": "glm-5.3-flash",
		"message": map[string]any{
			"provider": "zai", "model": "glm-5.3-flash", "timestamp": tsMillis,
			"usage": map[string]any{
				"input": 2000, "output": 200, "cacheRead": 7000, "cacheWrite": 0,
				"totalTokens": 9200, "cost": map[string]any{"total": 2.5},
			},
		},
	}
	base := filepath.Join(home, ".pi", "agent", "sessions", "sess", "subagent-artifacts")
	writeJSONL(t, filepath.Join(base, "w1_transcript.jsonl"), []map[string]any{record, record})
	writeJSONL(t, filepath.Join(base, "w2_transcript.jsonl"), []map[string]any{record})

	entries, err := loadPiUsageEntriesFor(platformGLM)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 9200 {
		t.Fatalf("totalTokens = %v, want 9200 (subagent duplicates counted once)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 1 {
		t.Fatalf("messages = %v, want 1", got)
	}
}

func TestPiDedupKeepsDistinctRecords(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	writeJSONL(t, filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl"), []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 50, "output": 5, "totalTokens": 55,
				"cost": map[string]any{"total": 0.1},
			}},
		},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:01:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 60, "output": 6, "totalTokens": 66,
				"cost": map[string]any{"total": 0.2},
			}},
		},
	})

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 121 {
		t.Fatalf("totalTokens = %v, want 121 (distinct records both counted)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 2 {
		t.Fatalf("messages = %v, want 2", got)
	}
}

func TestPiSameSecondIdenticalUsageCountsTwice(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	// Same second, same usage, differing only in the numeric ts flavor:
	// two distinct records, so both count (safe direction: totals only
	// ever go up).
	day := time.Date(2026, 8, 12, 10, 0, 0, 0, time.UTC)
	tsBase := float64(day.UnixMilli())
	usage := func() map[string]any {
		return map[string]any{
			"input": 50, "output": 5, "totalTokens": 55,
			"cost": map[string]any{"total": 0.1},
		}
	}
	writeJSONL(t, filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl"), []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type": "message", "timestamp": "2026-08-12T10:00:00Z", "ts": tsBase,
			"message": map[string]any{"usage": usage()},
		},
		{
			"type": "message", "timestamp": "2026-08-12T10:00:00Z", "ts": tsBase + 500,
			"message": map[string]any{"usage": usage()},
		},
	})

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 110 {
		t.Fatalf("totalTokens = %v, want 110 (same-second records both counted)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 2 {
		t.Fatalf("messages = %v, want 2", got)
	}
}

func TestPiFixedTimestampsOneBucketDifferentCountsTwice(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	// Identical timestamps in every flavor, one usage bucket different:
	// distinct records, so both count.
	usage := func(input float64) map[string]any {
		return map[string]any{
			"input": input, "output": 5, "totalTokens": input + 5,
			"cost": map[string]any{"total": 0.1},
		}
	}
	writeJSONL(t, filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl"), []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type": "message", "timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": usage(50)},
		},
		{
			"type": "message", "timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": usage(60)},
		},
	})

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 120 {
		t.Fatalf("totalTokens = %v, want 120 (one-bucket-different records both counted)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 2 {
		t.Fatalf("messages = %v, want 2", got)
	}
}

func TestPiDedupDistinguishesRawRecordShape(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	// Same date, model, timestamps, and usage, differing only in the raw
	// record-shape field (type vs recordType): distinct lines, both count.
	usage := func() map[string]any {
		return map[string]any{
			"input": 50, "output": 5, "totalTokens": 55,
			"cost": map[string]any{"total": 0.1},
		}
	}
	message := func() map[string]any {
		return map[string]any{
			"provider": "anthropic", "model": "claude-sonnet",
			"timestamp": "2026-08-12T10:00:00Z", "usage": usage(),
		}
	}
	writeJSONL(t, filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl"), []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type": "message", "timestamp": "2026-08-12T10:00:00Z",
			"message": message(),
		},
		{
			"recordType": "message", "timestamp": "2026-08-12T10:00:00Z",
			"message": message(),
		},
	})

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 110 {
		t.Fatalf("totalTokens = %v, want 110 (raw-shape-different records both counted)", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 2 {
		t.Fatalf("messages = %v, want 2", got)
	}
}

func TestPiRecordFingerprintCoversRawFieldsAndTimestampReps(t *testing.T) {
	newEntry := func() (*piSessionLine, *piUsage) {
		usage := &piUsage{Input: 50, Output: 5, TotalTokens: 55, Cost: piUsageCost{Total: 0.1}}
		entry := &piSessionLine{
			Type: "message", Timestamp: "2026-08-12T10:00:00Z",
			Provider: "anthropic", ModelID: "claude-sonnet",
			Message: &piMessage{
				Timestamp: "2026-08-12T10:00:00Z",
				Provider:  "anthropic", Model: "claude-sonnet", Usage: usage,
			},
		}
		return entry, usage
	}
	entry, usage := newEntry()
	base := piRecordFingerprint("2026-08-12", "pi-anthropic-claude-sonnet", entry, usage, 55)

	// Identical values stay deterministic.
	again, againUsage := newEntry()
	if got := piRecordFingerprint("2026-08-12", "pi-anthropic-claude-sonnet", again, againUsage, 55); got != base {
		t.Fatal("identical records must produce identical fingerprints")
	}

	// Every raw record-shape field participates in the fingerprint.
	mutations := []struct {
		name   string
		mutate func(*piSessionLine)
	}{
		{"Type", func(e *piSessionLine) { e.Type = "message2" }},
		{"RecordType", func(e *piSessionLine) { e.RecordType = "message" }},
		{"Provider", func(e *piSessionLine) { e.Provider = "other" }},
		{"Model", func(e *piSessionLine) { e.Model = "other" }},
		{"ModelID", func(e *piSessionLine) { e.ModelID = "other" }},
	}
	for _, m := range mutations {
		mutated, mutatedUsage := newEntry()
		m.mutate(mutated)
		if got := piRecordFingerprint("2026-08-12", "pi-anthropic-claude-sonnet", mutated, mutatedUsage, 55); got == base {
			t.Fatalf("mutating %s must change the fingerprint", m.name)
		}
	}

	// Same instant in different Go representations must not collapse to
	// the same text: %v alone formats string "5" and float64 5 identically.
	str, strUsage := newEntry()
	str.Ts = "5"
	num, numUsage := newEntry()
	num.Ts = float64(5)
	if piRecordFingerprint("2026-08-12", "pi-anthropic-claude-sonnet", str, strUsage, 55) ==
		piRecordFingerprint("2026-08-12", "pi-anthropic-claude-sonnet", num, numUsage, 55) {
		t.Fatal("string and numeric timestamp reps must produce distinct fingerprints")
	}
}

func TestKimiUsageSymlinkedDuplicateFileReadsOnce(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)

	real := filepath.Join(home, ".kimi-code", "sessions", "wd-a", "session_session-1", "agents", "main", "wire.jsonl")
	writeJSONL(t, real, []map[string]any{
		{
			"type":       "usage.record",
			"time":       float64(1786038447534),
			"model":      "moonshot-ai/kimi-k3",
			"usageScope": "turn",
			"usage": map[string]any{
				"inputOther":         100,
				"output":             20,
				"inputCacheRead":     200,
				"inputCacheCreation": 10,
			},
		},
	})
	linkDir := filepath.Join(home, ".kimi-code", "sessions", "wd-a", "session_session-1", "agents", "archive")
	if err := os.MkdirAll(linkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(linkDir, "wire.jsonl")); err != nil {
		t.Fatal(err)
	}

	entries, err := loadKimiUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 330 {
		t.Fatalf("totalTokens = %v, want 330 (symlinked file read once)", got)
	}
	if got := numberValue(entries[0]["sessionFiles"]); got != 1 {
		t.Fatalf("sessionFiles = %v, want 1", got)
	}
}

func TestPiSymlinkedDuplicateFileReadsOnce(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	root := filepath.Join(home, ".pi", "agent", "sessions")

	real := filepath.Join(root, "session-1.jsonl")
	writeJSONL(t, real, []map[string]any{
		{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"},
		{
			"type":      "message",
			"timestamp": "2026-08-12T10:00:00Z",
			"message": map[string]any{"usage": map[string]any{
				"input": 50, "output": 5, "totalTokens": 55,
				"cost": map[string]any{"total": 0.1},
			}},
		},
	})
	linkDir := filepath.Join(root, "backups")
	if err := os.MkdirAll(linkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(linkDir, "session-1-link.jsonl")); err != nil {
		t.Fatal(err)
	}

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry, got %d", len(entries))
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 55 {
		t.Fatalf("totalTokens = %v, want 55 (symlinked file read once)", got)
	}
	if got := numberValue(entries[0]["sessionFiles"]); got != 1 {
		t.Fatalf("sessionFiles = %v, want 1", got)
	}
}

func TestUploadNeverSendsReplaceForAnyPlatform(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	var payloads []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/upload" {
			t.Errorf("path = %q", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		payloads = append(payloads, payload)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	platforms := append([]string{platformCombined}, dedicatedPlatformNames...)
	for i, platform := range platforms {
		cacheName := platform
		if platform == platformCombined {
			cacheName = "combined"
		}
		entries := []map[string]any{{
			"date":        "2026-09-04",
			"totalTokens": float64((i + 1) * 10),
			"totalCost":   0.1,
		}}
		report := map[string]any{"type": "daily", "daily": entries}
		pending, err := prepareUsageUpload(report, entries, cacheName, "none")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(pending.Report, "replace") {
			t.Fatalf("%s report must not mention replace: %s", platform, pending.Report)
		}
		if err := uploadCcusage(server.URL, "test-token", pending.Report, "rig-arbaz", platform); err != nil {
			t.Fatal(err)
		}
	}

	if len(payloads) != len(platforms) {
		t.Fatalf("payloads = %d, want %d", len(payloads), len(platforms))
	}
	for i, payload := range payloads {
		if _, ok := payload["replace"]; ok {
			t.Fatalf("%s payload must not send replace", platforms[i])
		}
		if payload["platform"] != platforms[i] {
			t.Fatalf("platform = %#v, want %q", payload["platform"], platforms[i])
		}
		if _, ok := payload["json"].(string); !ok {
			t.Fatalf("%s payload is missing its json report", platforms[i])
		}
	}
}

// Each Pi record can be within the server's 1-token tolerance floor and still
// drift past 0.1% once many tiny records are summed into the day row the server
// actually checks, so the aggregate is guarded too.
func TestPiDayRowIsServerConsistentWhenTinyRecordsDrift(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, ".pi", "agent", "sessions", "session-1.jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	records := []map[string]any{{"type": "model_change", "provider": "anthropic", "modelId": "claude-sonnet"}}
	for minute := 0; minute < 5; minute++ {
		records = append(records, map[string]any{
			"type":      "message",
			"timestamp": fmt.Sprintf("2026-08-12T10:0%d:00Z", minute),
			"message": map[string]any{"usage": map[string]any{
				"input": 300, "output": 100, "totalTokens": 401, // 1 token off each: within the per-record floor
				"cost": map[string]any{"total": 0.1},
			}},
		})
	}
	var data []byte
	for _, record := range records {
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatal(err)
		}
		data = append(data, encoded...)
		data = append(data, '\n')
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 2000 {
		t.Fatalf("day totalTokens = %v, want the component sum 2000 (5 x 401 = 2005 is beyond the server tolerance)", got)
	}
	assertServerConsistentTotal(t, entries[0])
}

// The shipped wiring, not just the pieces: runCcusage must hand ccusage's own
// Antigravity dates to loadLocalUsageEntries so the transcript estimate is not
// added on top of them. A fake npx serves the ccusage output.
func TestRunCcusageDoesNotDoubleCountAntigravityWhereCcusageReportsIt(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	writeAntigravityTranscript(t, home, "2026-07-01", 400) // would add 100 estimated tokens

	bin := t.TempDir()
	fixture := filepath.Join(bin, "ccusage.json")
	if err := os.WriteFile(fixture, []byte(`{"daily":[{"period":"2026-07-01","agents":[
		{"agent":"antigravity","inputTokens":1000,"outputTokens":0,"cacheReadTokens":0,"totalTokens":1000,"totalCost":0.5}]}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "npx"), []byte("#!/bin/sh\ncat "+fixture+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")

	pending, _, _, err := runCcusage()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &wire); err != nil {
		t.Fatal(err)
	}
	if len(wire.Daily) != 1 {
		t.Fatalf("wire rows = %#v", wire.Daily)
	}
	if got := numberValue(wire.Daily[0]["totalTokens"]); got != 1000 {
		t.Fatalf("totalTokens = %v, want ccusage's 1000 with no transcript estimate on top", got)
	}
}

func TestUncoveredZCodeEntriesKeepsZCodeOnlyWhereGLMHasNoData(t *testing.T) {
	_, raw, err := parseCcusageReport([]byte(`{"daily":[
		{"period":"2026-08-14","agents":[{"agent":"zcode","inputTokens":22306,"outputTokens":4456,"cacheReadTokens":321920,"totalTokens":348682,"totalCost":0.13}]},
		{"period":"2026-08-28","agents":[{"agent":"zcode","inputTokens":709370,"outputTokens":82816,"cacheReadTokens":18093184,"totalTokens":18885370,"totalCost":2}]},
		{"period":"2026-08-29","agents":[{"agent":"claude","inputTokens":1,"totalTokens":1}]}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	rows := uncoveredZCodeEntries(raw, map[string]bool{"2026-08-28": true})
	if len(rows) != 1 || usageDate(rows[0]) != "2026-08-14" {
		t.Fatalf("rows = %#v, want only the uncovered 2026-08-14", rows)
	}
	if got := numberValue(rows[0]["totalTokens"]); got != 348682 {
		t.Fatalf("totalTokens = %v, want 348682", got)
	}
	assertServerConsistentTotal(t, rows[0])
}

// End to end through the real runCcusage: zcode usage the native GLM upload
// already covers stays out of combined (no double count), and zcode usage on a
// date whose rollout files were pruned is kept (no real usage lost).
func TestRunCcusageKeepsZCodeOnlyWhereTheGLMUploadDoesNotCoverIt(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	// Native Z Code rollout exists for 2026-08-28 only.
	writeJSONL(t, filepath.Join(home, ".zcode", "cli", "rollout", "model-io-sess_abc.jsonl"), []map[string]any{
		glmCall("req-1", "2026-08-28T13:47:14.836Z", "GLM-5.3", 251, 17, 192, 0),
	})

	bin := t.TempDir()
	fixture := filepath.Join(bin, "ccusage.json")
	if err := os.WriteFile(fixture, []byte(`{"daily":[
		{"period":"2026-08-14","agents":[{"agent":"zcode","inputTokens":22306,"outputTokens":4456,"cacheReadTokens":321920,"totalTokens":348682,"totalCost":0.13}]},
		{"period":"2026-08-28","agents":[
			{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":510,"totalCost":1},
			{"agent":"zcode","inputTokens":709370,"outputTokens":82816,"cacheReadTokens":18093184,"totalTokens":18885370,"totalCost":2}]}
	]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "npx"), []byte("#!/bin/sh\ncat "+fixture+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")

	pending, _, _, err := runCcusage()
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Daily []map[string]any `json:"daily"`
	}
	if err := json.Unmarshal([]byte(pending.Report), &wire); err != nil {
		t.Fatal(err)
	}
	totals := map[string]float64{}
	for _, row := range wire.Daily {
		totals[usageDate(row)] = numberValue(row["totalTokens"])
		assertServerConsistentTotal(t, row)
	}
	if totals["2026-08-14"] != 348682 {
		t.Fatalf("2026-08-14 = %v, want zcode's 348682 kept (GLM has no data that day)", totals["2026-08-14"])
	}
	if totals["2026-08-28"] != 510 {
		t.Fatalf("2026-08-28 = %v, want only Claude's 510 (zcode is uploaded as GLM that day)", totals["2026-08-28"])
	}
}
