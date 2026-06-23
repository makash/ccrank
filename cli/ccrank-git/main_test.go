package main

import (
	"encoding/json"
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

func TestNormalizeAndFilterCcusageReportOnlySkipsUnchangedRows(t *testing.T) {
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
				"modelsUsed": ["gpt-5.5"]
			}
		]
	}`)

	first, err := normalizeAndFilterCcusageReport(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first, `"2026-05-27"`) {
		t.Fatalf("expected first upload to contain the daily row: %s", first)
	}

	_, err = normalizeAndFilterCcusageReport(report)
	if err == nil || !strings.Contains(err.Error(), "no higher combined usage rows found") {
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
				"modelsUsed": ["gpt-5.5"]
			}
		]
	}`)

	third, err := normalizeAndFilterCcusageReport(higher)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(third, `"totalTokens":150`) {
		t.Fatalf("expected higher row to be uploaded, got %s", third)
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
		<td><div class="font-medium"><a href="/user/arbaz-khan">Arbaz Khan</a></div><div>Claude Maximalist</div></td>
		<td>$547.29</td>
		<td>562.5M</td>
		<td>4.3K t/$</td>
	</tr></tbody></table>`

	rows := parsePublicDailyLeaderboardRows(html, "2026-06-23", "https://ccrank.dev/leaderboard?sort=cost&view=daily")
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
