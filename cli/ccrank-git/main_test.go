package main

import (
	"encoding/json"
	"fmt"
	"io"
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
	for _, cacheName := range []string{"combined", platformKimi, platformGrok, platformGLM, platformPi} {
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

func TestUploadUsageReportResetsMaximaAfterFailedUpload(t *testing.T) {
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
	err := uploadUsageReport(server.URL, "test-token", pending, "secrig", "kimi", "kimi")
	if err == nil {
		t.Fatal("expected failed upload")
	}
	if _, statErr := os.Stat(cachePath); !os.IsNotExist(statErr) {
		t.Fatalf("expected retry cache removal, got %v", statErr)
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
	if err := uploadUsageReport(server.URL, "test-token", pending, "rig", platformKimi, platformKimi); err == nil {
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
	if err := uploadUsageReport(server.URL, "test-token", pending, "rig", platformKimi, platformKimi); err != nil {
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
		{"pi", ""},          // already held out
		{"kimi", ""},        // already held out
		{"opencode", ""},    // already held out
		{"grok", ""},        // already held out
		{"glm", ""},         // already held out
		{"PI", ""},          // held out, case-insensitive
		{"Kimi", ""},        // held out, case-insensitive
		{"OpenCode", ""},    // held out, case-insensitive
		{"Grok", ""},        // held out, case-insensitive
		{"GLM", ""},         // held out, case-insensitive
		{"claude", ""},      // unrelated agent
		{"codex", ""},       // unrelated agent
		{"gemini", ""},      // unrelated agent
		{"hermes", ""},      // unrelated agent
		{"antigravity", ""}, // unrelated agent
		{"", ""},            // blank slice name
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
			{"agent":"claude","inputTokens":100,"outputTokens":10,"cacheReadTokens":400,"totalTokens":110,"totalCost":1},
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
	if len(combined) != 1 || numberValue(combined[0]["totalTokens"]) != 110 {
		t.Fatalf("combined entries = %#v, want only Claude's 110 tokens", combined)
	}

	// The same row without the suspicious agent still rebuilds cleanly.
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
		t.Fatalf("claude/codex rows must never trip the detector, got %v", err)
	}
	if len(combined) != 1 || numberValue(combined[0]["totalTokens"]) != 110 {
		t.Fatalf("combined entries = %#v", combined)
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

func TestCombinedRebuildMergesMatchingModelBreakdowns(t *testing.T) {
	report := []byte(`{"daily":[{"period":"2026-08-14","agents":[
		{"agent":"claude","inputTokens":10,"outputTokens":2,"cacheCreationTokens":3,"cacheReadTokens":4,"totalTokens":19,"totalCost":0.5,
		 "modelBreakdowns":[
			{"modelName":"zeta","inputTokens":1,"outputTokens":1,"cacheCreationTokens":1,"cacheReadTokens":1,"totalTokens":4,"cost":0.1},
			{"modelName":"alpha","inputTokens":9,"outputTokens":1,"cacheCreationTokens":2,"cacheReadTokens":3,"totalTokens":15,"cost":0.4}
		 ]},
		{"agent":"codex","inputTokens":5,"outputTokens":6,"cacheCreationTokens":7,"cacheReadTokens":8,"totalTokens":26,"totalCost":0.6,
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
