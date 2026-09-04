package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func cursorTestJWT(sub string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"sub":%q}`, sub)))
	return header + "." + payload + ".sig"
}

func seedCursorStateDB(t *testing.T, home, accessToken string) {
	t.Helper()
	dbPath := cursorStateDBPathForHome(home)
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`, "cursorAuth/accessToken", accessToken); err != nil {
		t.Fatal(err)
	}
}

func TestCursorSessionCookieFromJWTSub(t *testing.T) {
	token := cursorTestJWT("auth0|user_01ABCXYZ")
	cookie, err := cursorSessionCookie(token)
	if err != nil {
		t.Fatal(err)
	}
	want := "user_01ABCXYZ%3A%3A" + token
	if cookie != want {
		t.Fatalf("cookie = %q, want %q", cookie, want)
	}
}

func TestCursorSessionCookieRejectsJWTWithoutUserID(t *testing.T) {
	token := cursorTestJWT("auth0|someone-else")
	if _, err := cursorSessionCookie(token); err == nil {
		t.Fatal("expected an error for a JWT without user_")
	}
}

func TestCursorUsageAggregatesEventsByUTCDay(t *testing.T) {
	events := []cursorUsageEvent{
		{
			Timestamp:      json.RawMessage(`"1717200000000"`), // 2024-06-01 00:00 UTC
			Model:          "cursor-grok-4.6-xhigh",
			ChargedCents:   json.RawMessage(`17.0394`),
			ConversationID: "conv-a",
			TokenUsage: &cursorTokenUsage{
				InputTokens:      40505,
				OutputTokens:     11740,
				CacheReadTokens:  37888,
				CacheWriteTokens: 200,
				TotalCents:       17.0394,
			},
		},
		{
			Timestamp:      json.RawMessage(`1717286400000`), // 2024-06-02 00:00 UTC
			Model:          "composer-2.5",
			ChargedCents:   json.RawMessage(`"-"`),
			ConversationID: "conv-b",
			TokenUsage: &cursorTokenUsage{
				InputTokens:  100,
				OutputTokens: 50,
				TotalCents:   4,
			},
		},
	}

	entries := aggregateCursorUsageEvents(events)
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(entries))
	}

	first := entries[0]
	if first["date"] != "2024-06-01" {
		t.Fatalf("first date = %v", first["date"])
	}
	if numberValue(first["inputTokens"]) != 40505 {
		t.Fatalf("input = %v", first["inputTokens"])
	}
	if numberValue(first["outputTokens"]) != 11740 {
		t.Fatalf("output = %v", first["outputTokens"])
	}
	if numberValue(first["cacheReadTokens"]) != 37888 {
		t.Fatalf("cacheRead = %v", first["cacheReadTokens"])
	}
	if numberValue(first["cacheCreationTokens"]) != 200 {
		t.Fatalf("cacheCreation = %v", first["cacheCreationTokens"])
	}
	if numberValue(first["totalTokens"]) != 40505+11740+37888+200 {
		t.Fatalf("total = %v", first["totalTokens"])
	}
	if diff := numberValue(first["costUSD"]) - 0.170394; diff > 0.000001 || diff < -0.000001 {
		t.Fatalf("cost = %v, want 0.170394", first["costUSD"])
	}
	if first["source"] != "cursor-dashboard" {
		t.Fatalf("source = %v", first["source"])
	}

	second := entries[1]
	if second["date"] != "2024-06-02" {
		t.Fatalf("second date = %v", second["date"])
	}
	if numberValue(second["costUSD"]) != 0.04 {
		t.Fatalf("fallback cost = %v, want totalCents/100", second["costUSD"])
	}
	models, _ := second["modelsUsed"].([]string)
	if len(models) != 1 || models[0] != "composer-2.5" {
		t.Fatalf("models = %#v", second["modelsUsed"])
	}
}

func TestCursorUsageBucketsSharedSourceDaysInUTC(t *testing.T) {
	// 2026-09-04 20:00 UTC is 2026-09-05 01:30 in IST and 2026-09-04 12:00 in PST.
	// cursor-cloud is shared across machines, so the day must not depend on local TZ.
	ms := time.Date(2026, 9, 4, 20, 0, 0, 0, time.UTC).UnixMilli()
	event := cursorUsageEvent{
		Timestamp:      json.RawMessage(fmt.Sprintf(`"%d"`, ms)),
		Model:          "composer-2.5",
		ConversationID: "conv",
		TokenUsage:     &cursorTokenUsage{InputTokens: 10, OutputTokens: 5},
	}
	entries := aggregateCursorUsageEvents([]cursorUsageEvent{event})
	if len(entries) != 1 || entries[0]["date"] != "2026-09-04" {
		t.Fatalf("UTC day = %#v, want 2026-09-04", entries)
	}
}

func TestCursorUsageDedupsOverlappingPagesAndSkipsEmptyEvents(t *testing.T) {
	dup := cursorUsageEvent{
		Timestamp:      json.RawMessage(`"1000"`),
		Model:          "composer-2.5",
		ConversationID: "same",
		TokenUsage:     &cursorTokenUsage{InputTokens: 10, OutputTokens: 5},
	}
	empty := cursorUsageEvent{
		Timestamp: json.RawMessage(`"2000"`),
		Model:     "composer-2.5",
	}
	events := []cursorUsageEvent{dup, dup, empty}

	entries := aggregateCursorUsageEvents(events)
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if numberValue(entries[0]["totalTokens"]) != 15 {
		t.Fatalf("deduped total = %v", entries[0]["totalTokens"])
	}
	if numberValue(entries[0]["messages"]) != 1 {
		t.Fatalf("messages = %v", entries[0]["messages"])
	}
}

func TestCursorUsageMissingInstallIsEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData"))

	entries, err := loadCursorUsageEntries()
	if err != nil {
		t.Fatalf("missing Cursor install must be empty, got %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestFetchCursorUsageEventsPagesUntilAdvertisedTotal(t *testing.T) {
	orig := cursorUsageAPIBase
	t.Cleanup(func() { cursorUsageAPIBase = orig })

	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/dashboard/get-filtered-usage-events" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("Origin") != "https://cursor.com" {
			t.Errorf("missing Origin CSRF header")
		}
		if !strings.Contains(r.Header.Get("Cookie"), "WorkosCursorSessionToken=user_01TEST%") {
			t.Errorf("cookie = %q", r.Header.Get("Cookie"))
		}
		pages++
		w.Header().Set("Content-Type", "application/json")
		if pages == 1 {
			_, _ = w.Write([]byte(`{"totalUsageEventsCount":3,"usageEventsDisplay":[
				{"timestamp":"1717200000000","model":"composer-2.5","conversationId":"a","tokenUsage":{"inputTokens":1,"outputTokens":1}},
				{"timestamp":"1717200000000","model":"composer-2.5","conversationId":"b","tokenUsage":{"inputTokens":2,"outputTokens":2}}
			]}`))
			return
		}
		_, _ = w.Write([]byte(`{"totalUsageEventsCount":3,"usageEventsDisplay":[
			{"timestamp":"1717286400000","model":"cursor-grok-4.6-xhigh","conversationId":"c","tokenUsage":{"inputTokens":3,"outputTokens":3}}
		]}`))
	}))
	t.Cleanup(server.Close)
	cursorUsageAPIBase = server.URL

	events, err := fetchCursorUsageEvents("user_01TEST%3A%3Afake")
	if err != nil {
		t.Fatal(err)
	}
	if pages != 2 {
		t.Fatalf("pages = %d, want 2", pages)
	}
	if len(events) != 3 {
		t.Fatalf("events = %d, want 3", len(events))
	}
}

func TestFetchCursorUsageEventsKeepsPagingWhenPagesOverlap(t *testing.T) {
	orig := cursorUsageAPIBase
	t.Cleanup(func() { cursorUsageAPIBase = orig })

	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pages++
		w.Header().Set("Content-Type", "application/json")
		if pages == 1 {
			_, _ = w.Write([]byte(`{"totalUsageEventsCount":3,"usageEventsDisplay":[
				{"timestamp":"1","model":"composer-2.5","conversationId":"a","tokenUsage":{"inputTokens":1,"outputTokens":1}},
				{"timestamp":"2","model":"composer-2.5","conversationId":"b","tokenUsage":{"inputTokens":2,"outputTokens":2}}
			]}`))
			return
		}
		_, _ = w.Write([]byte(`{"totalUsageEventsCount":3,"usageEventsDisplay":[
			{"timestamp":"2","model":"composer-2.5","conversationId":"b","tokenUsage":{"inputTokens":2,"outputTokens":2}},
			{"timestamp":"3","model":"composer-2.5","conversationId":"c","tokenUsage":{"inputTokens":3,"outputTokens":3}}
		]}`))
	}))
	t.Cleanup(server.Close)
	cursorUsageAPIBase = server.URL

	events, err := fetchCursorUsageEvents("user_01TEST%3A%3Afake")
	if err != nil {
		t.Fatal(err)
	}
	if pages != 2 {
		t.Fatalf("pages = %d, want 2", pages)
	}
	if len(events) != 3 {
		t.Fatalf("unique events = %d, want 3 (overlap must not stop pagination early)", len(events))
	}
}

func TestFetchCursorUsageEventsRejectsMissingDisplayArray(t *testing.T) {
	orig := cursorUsageAPIBase
	t.Cleanup(func() { cursorUsageAPIBase = orig })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(server.Close)
	cursorUsageAPIBase = server.URL

	_, err := fetchCursorUsageEvents("user_01TEST%3A%3Afake")
	if err == nil || !strings.Contains(err.Error(), "usageEventsDisplay") {
		t.Fatalf("got %v", err)
	}
}

func TestFetchCursorUsageEventsExpiredSession(t *testing.T) {
	orig := cursorUsageAPIBase
	t.Cleanup(func() { cursorUsageAPIBase = orig })

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)
	cursorUsageAPIBase = server.URL

	_, err := fetchCursorUsageEvents("user_01TEST%3A%3Afake")
	if err == nil || !strings.Contains(err.Error(), "sign in") {
		t.Fatalf("got %v", err)
	}
}

func TestLoadCursorUsageEntriesFromLocalLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))
	t.Setenv("APPDATA", filepath.Join(home, "AppData"))
	seedCursorStateDB(t, home, cursorTestJWT("auth0|user_01LOCAL"))

	orig := cursorUsageAPIBase
	t.Cleanup(func() { cursorUsageAPIBase = orig })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalUsageEventsCount":1,"usageEventsDisplay":[
			{"timestamp":"1717200000000","model":"composer-2.5","conversationId":"a","chargedCents":10,"tokenUsage":{"inputTokens":8,"outputTokens":2}}
		]}`))
	}))
	t.Cleanup(server.Close)
	cursorUsageAPIBase = server.URL

	entries, err := loadCursorUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if numberValue(entries[0]["totalTokens"]) != 10 {
		t.Fatalf("total = %v", entries[0]["totalTokens"])
	}
	if numberValue(entries[0]["costUSD"]) != 0.10 {
		t.Fatalf("cost = %v", entries[0]["costUSD"])
	}
}

func TestUploadDedicatedPlatformHonorsExplicitSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/upload" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	uploadDedicatedPlatform(dedicatedPlatformUpload{
		BaseURL: server.URL, Token: "test-token", Machine: "laptop-hostname",
		Source: cursorUsageSource, Platform: platformCursor, Label: "Cursor",
		Supported: map[string]bool{platformCursor: true},
		Run: func() (*pendingUsageUpload, *UsageSnapshot, error) {
			entries := []map[string]any{{
				"date":        "2026-09-04",
				"totalTokens": 10,
				"totalCost":   0.1,
			}}
			report := map[string]any{"type": "daily", "daily": entries}
			pending, err := prepareUsageUpload(report, entries, platformCursor, "none")
			return pending, nil, err
		},
	})
	if payload["source"] != cursorUsageSource {
		t.Fatalf("source = %#v, want %q so two machines do not double-count", payload["source"], cursorUsageSource)
	}
	if payload["platform"] != platformCursor {
		t.Fatalf("platform = %#v", payload["platform"])
	}
	if _, ok := payload["replace"]; ok {
		t.Fatal("must not send replace")
	}
}
