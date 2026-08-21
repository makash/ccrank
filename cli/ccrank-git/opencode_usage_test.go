package main

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

type openCodeFixtureTokens struct {
	Input     float64 `json:"input"`
	Output    float64 `json:"output"`
	Reasoning float64 `json:"reasoning"`
	Cache     struct {
		Read  float64 `json:"read"`
		Write float64 `json:"write"`
	} `json:"cache"`
}

func openCodeFixtureData(t *testing.T, modelID string, cost float64, tokens openCodeFixtureTokens) string {
	t.Helper()
	payload := map[string]any{
		"role":    "assistant",
		"modelID": modelID,
		"cost":    cost,
		"tokens": map[string]any{
			"input":     tokens.Input,
			"output":    tokens.Output,
			"reasoning": tokens.Reasoning,
			"cache":     map[string]any{"read": tokens.Cache.Read, "write": tokens.Cache.Write},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal fixture message: %v", err)
	}
	return string(raw)
}

func seedOpenCodeDB(t *testing.T, rows [][3]any) string {
	t.Helper()
	dir := t.TempDir()
	dbDir := filepath.Join(dir, "opencode")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(dbDir, "opencode.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open fixture db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`); err != nil {
		t.Fatalf("create table: %v", err)
	}
	for _, row := range rows {
		if _, err := db.Exec(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, row[0], "ses_fixture", row[1], row[1], row[2]); err != nil {
			t.Fatalf("insert fixture row: %v", err)
		}
	}
	return dir
}

func openCodeEntryByDate(t *testing.T, entries []map[string]any, date string) map[string]any {
	t.Helper()
	for _, entry := range entries {
		if entry["date"] == date {
			return entry
		}
	}
	t.Fatalf("no opencode entry for date %s in %d entries", date, len(entries))
	return nil
}

func assertNum(t *testing.T, entry map[string]any, key string, want float64) {
	t.Helper()
	got, ok := entry[key].(float64)
	if !ok {
		t.Fatalf("%s: expected number, got %T (%v)", key, entry[key], entry[key])
	}
	if got != want {
		t.Fatalf("%s: got %v, want %v", key, got, want)
	}
}

func TestOpenCodeUsageAggregatesAssistantMessages(t *testing.T) {
	localTZ := time.Local
	dayOne := time.Date(2026, 8, 20, 12, 0, 0, 0, localTZ).UnixMilli()
	dayTwo := time.Date(2026, 8, 21, 9, 30, 0, 0, localTZ).UnixMilli()

	first := openCodeFixtureTokens{Input: 100, Output: 200, Reasoning: 50}
	first.Cache.Read = 300
	first.Cache.Write = 10
	second := openCodeFixtureTokens{Input: 7, Output: 8, Reasoning: 0}
	second.Cache.Read = 9
	second.Cache.Write = 0

	fixtureDir := seedOpenCodeDB(t, [][3]any{
		{"msg_1", dayOne, openCodeFixtureData(t, "x-preview-f-free", 0.25, first)},
		{"msg_2", dayOne, openCodeFixtureData(t, "qwen3-coder-480b", 0, second)},
		{"msg_3", dayTwo, openCodeFixtureData(t, "x-preview-f-free", 0, openCodeFixtureTokens{})},
		{"msg_user", dayOne, `{"role":"user","modelID":"x-preview-f-free","cost":9,"tokens":{"input":999999,"output":999999,"reasoning":0,"cache":{"read":0,"write":0}}}`},
		{"msg_broken", dayOne, `{not json`},
	})
	t.Setenv("XDG_DATA_HOME", fixtureDir)

	entries, err := loadOpenCodeUsageEntries()
	if err != nil {
		t.Fatalf("loadOpenCodeUsageEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 daily entry (all-zero messages are skipped), got %d", len(entries))
	}

	day := openCodeEntryByDate(t, entries, "2026-08-20")
	assertNum(t, day, "inputTokens", 107)
	assertNum(t, day, "outputTokens", 258)
	assertNum(t, day, "cacheReadTokens", 309)
	assertNum(t, day, "cacheCreationTokens", 10)
	assertNum(t, day, "totalTokens", 684)
	assertNum(t, day, "totalCost", 0.25)
	models := day["modelsUsed"].([]string)
	if len(models) != 2 || models[0] != "qwen3-coder-480b" || models[1] != "x-preview-f-free" {
		t.Fatalf("unexpected modelsUsed: %v", models)
	}
	breakdowns := day["modelBreakdowns"].([]map[string]any)
	if len(breakdowns) != 2 {
		t.Fatalf("expected 2 model breakdowns, got %d", len(breakdowns))
	}
	assertNum(t, breakdowns[0], "totalTokens", 24)
	assertNum(t, breakdowns[1], "totalTokens", 660)
}

func TestOpenCodeUsageMissingInstallIsEmpty(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	entries, err := loadOpenCodeUsageEntries()
	if err != nil {
		t.Fatalf("missing install must not error, got %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no entries, got %d", len(entries))
	}
}

func TestOpenCodeUsageSchemalessDatabaseIsEmpty(t *testing.T) {
	dir := t.TempDir()
	dbDir := filepath.Join(dir, "opencode")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(dbDir, "opencode.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE other (id text)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	db.Close()

	t.Setenv("XDG_DATA_HOME", dir)
	entries, err := loadOpenCodeUsageEntries()
	if err != nil {
		t.Fatalf("schemaless database must not error, got %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no entries, got %d", len(entries))
	}
}

func TestOpenCodeUsageRealDatabaseInteg(t *testing.T) {
	realDB := os.Getenv("CCRANK_INTEG_DB")
	if realDB == "" {
		t.Skip("set CCRANK_INTEG_DB=/path/to/opencode.db to run against a live database")
	}
	t.Setenv("XDG_DATA_HOME", func() string {
		dir := t.TempDir()
		link := filepath.Join(dir, "opencode")
		if err := os.MkdirAll(link, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.Symlink(realDB, filepath.Join(link, "opencode.db")); err != nil {
			t.Fatalf("symlink: %v", err)
		}
		return dir
	}())
	entries, err := loadOpenCodeUsageEntries()
	if err != nil {
		t.Fatalf("loadOpenCodeUsageEntries: %v", err)
	}
	var grandTotal float64
	for _, entry := range entries {
		grandTotal += entry["totalTokens"].(float64)
	}
	t.Logf("real opencode db: %d days, %.0f total tokens", len(entries), grandTotal)
	if grandTotal <= 0 {
		t.Fatalf("expected positive token totals from the real database")
	}
}
