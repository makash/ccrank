package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeJSONL(t *testing.T, path string, records []map[string]any) {
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

func grokTurn(eventID string, tsSeconds int64, model string, in, out, cachedRead, ticks float64) map[string]any {
	return map[string]any{
		"timestamp": tsSeconds,
		"method":    "_x.ai/session/update",
		"params": map[string]any{
			"sessionId": "session-1",
			"update": map[string]any{
				"sessionUpdate": "turn_completed",
				"prompt_id":     eventID,
				"usage": map[string]any{
					"inputTokens":      in,
					"outputTokens":     out,
					"totalTokens":      in + out,
					"cachedReadTokens": cachedRead,
					"costUsdTicks":     ticks,
					"modelUsage": map[string]any{
						model: map[string]any{
							"inputTokens":      in,
							"outputTokens":     out,
							"totalTokens":      in + out,
							"cachedReadTokens": cachedRead,
							"costUsdTicks":     ticks,
						},
					},
				},
			},
			"_meta": map[string]any{"eventId": eventID},
		},
	}
}

func TestGrokUsageSplitsCachedReadsOutOfInputAndConvertsTicks(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	// 2026-08-12T12:00:00Z
	const ts = 1786536000
	writeJSONL(t, filepath.Join(home, ".grok", "sessions", "%2Ftmp%2Frepo", "sess-1", "updates.jsonl"), []map[string]any{
		{"timestamp": ts, "params": map[string]any{"update": map[string]any{"sessionUpdate": "agent_message"}}},
		grokTurn("event-1", ts, "grok-4.6-build", 1000, 200, 700, 1e10),
	})

	entries, err := loadGrokUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	entry := entries[0]
	// Grok folds cached reads into inputTokens, so fresh input is 1000-700.
	if got := numberValue(entry["inputTokens"]); got != 300 {
		t.Fatalf("inputTokens = %v, want 300", got)
	}
	if got := numberValue(entry["cacheReadTokens"]); got != 700 {
		t.Fatalf("cacheReadTokens = %v, want 700", got)
	}
	// The four buckets must still add up to Grok's own reported total.
	if got := numberValue(entry["totalTokens"]); got != 1200 {
		t.Fatalf("totalTokens = %v, want 1200", got)
	}
	if got := usageCostValue(entry); got != 1 {
		t.Fatalf("cost = %v, want 1 USD for 1e10 ticks", got)
	}
	if got := usageDate(entry); got != "2026-08-12" {
		t.Fatalf("date = %q", got)
	}
}

func TestGrokUsageCountsAReplayedTurnOnce(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	const ts = 1786536000
	// Rewinding a session replays completed turns into updates.jsonl.
	writeJSONL(t, filepath.Join(home, ".grok", "sessions", "%2Ftmp%2Frepo", "sess-1", "updates.jsonl"), []map[string]any{
		grokTurn("event-1", ts, "grok-4.6-build", 1000, 200, 700, 1e10),
		grokTurn("event-1", ts, "grok-4.6-build", 1000, 200, 700, 1e10),
		grokTurn("event-2", ts, "grok-4.6-build", 500, 100, 0, 5e9),
	})

	entries, err := loadGrokUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if got := numberValue(entries[0]["totalTokens"]); got != 1800 {
		t.Fatalf("totalTokens = %v, want 1200+600 with the replay dropped", got)
	}
	if got := usageCostValue(entries[0]); got != 1.5 {
		t.Fatalf("cost = %v, want 1.5", got)
	}
	if got := numberValue(entries[0]["messages"]); got != 2 {
		t.Fatalf("turns = %v, want 2", got)
	}
}

func TestGrokUsageIsEmptyWithoutASessionsDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	entries, err := loadGrokUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %#v", entries)
	}
}

func glmCall(requestID, completedAt, model string, in, out, cacheRead, cacheWrite float64) map[string]any {
	return map[string]any{
		"completedAt": completedAt,
		"requestId":   requestID,
		"sessionId":   "sess-1",
		"model":       map[string]any{"modelId": model, "providerId": "builtin:zai-coding-plan"},
		"response": map[string]any{
			"modelId": model,
			"usage": map[string]any{
				"inputTokens":      in,
				"outputTokens":     out,
				"totalTokens":      in + out,
				"cacheReadTokens":  cacheRead,
				"cacheWriteTokens": cacheWrite,
			},
		},
	}
}

func TestGLMUsageSplitsCachedReadsAndStaysTokenOnly(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	writeJSONL(t, filepath.Join(home, ".zcode", "cli", "rollout", "model-io-sess_abc.jsonl"), []map[string]any{
		glmCall("req-1", "2026-08-14T13:47:14.836Z", "GLM-5.3", 251, 17, 192, 0),
		glmCall("req-2", "2026-08-14T13:48:00.000Z", "GLM-5.3", 100, 10, 0, 40),
	})
	// A file that is not a model-io rollout must be ignored.
	writeJSONL(t, filepath.Join(home, ".zcode", "cli", "log", "zcode-2026-08-14.jsonl"), []map[string]any{
		glmCall("req-9", "2026-08-14T13:49:00.000Z", "GLM-5.3", 999, 999, 0, 0),
	})

	entries, err := loadGLMUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	entry := entries[0]
	// req-1 contributes 59 fresh input, req-2 contributes 60 (100-40 cache write).
	if got := numberValue(entry["inputTokens"]); got != 119 {
		t.Fatalf("inputTokens = %v, want 119", got)
	}
	if got := numberValue(entry["cacheReadTokens"]); got != 192 {
		t.Fatalf("cacheReadTokens = %v, want 192", got)
	}
	if got := numberValue(entry["cacheCreationTokens"]); got != 40 {
		t.Fatalf("cacheCreationTokens = %v, want 40", got)
	}
	if got := numberValue(entry["totalTokens"]); got != 378 {
		t.Fatalf("totalTokens = %v, want 268+110", got)
	}
	if got := usageCostValue(entry); got != 0 {
		t.Fatalf("cost = %v, want 0 because Z Code logs carry no pricing", got)
	}
}

func TestGLMUsageCountsARetriedRequestOnce(t *testing.T) {
	oldLocal := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = oldLocal })

	home := t.TempDir()
	t.Setenv("HOME", home)
	writeJSONL(t, filepath.Join(home, ".zcode", "cli", "rollout", "model-io-sess_abc.jsonl"), []map[string]any{
		glmCall("req-1", "2026-08-14T13:47:14.836Z", "GLM-5.3", 251, 17, 192, 0),
		glmCall("req-1", "2026-08-14T13:47:20.000Z", "GLM-5.3", 251, 17, 192, 0),
	})

	entries, err := loadGLMUsageEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || numberValue(entries[0]["totalTokens"]) != 268 {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestPiPlatformForModelRoutesEachVendor(t *testing.T) {
	for model, want := range map[string]string{
		"pi-hetzner-glm-5-2-nvfp4":                platformGLM,
		"pi-moonshot-kimi-k2":                     platformKimi,
		"pi-xai-grok-4-6":                         platformGrok,
		"pi-commandcode-claude-sonnet-5":          platformPi,
		"pi-hetzner-deepseek-v4-flash-0731":       platformPi,
		"pi-commandcode-deepseek-deepseek-v4-pro": platformPi,
	} {
		if got := piPlatformForModel(model); got != want {
			t.Errorf("piPlatformForModel(%q) = %q, want %q", model, got, want)
		}
	}
}

func TestLoadSupportedPlatformsReadsTheProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/platforms" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"platforms":["claude","codex","kimi","grok","glm","pi"]}`))
	}))
	t.Cleanup(server.Close)

	supported, err := loadSupportedPlatforms(server.URL, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	for _, platform := range []string{platformCombined, platformKimi, platformGrok, platformGLM, platformPi} {
		if !supported[platform] {
			t.Errorf("%q should be supported", platform)
		}
	}
}

func TestLoadSupportedPlatformsTreatsAMissingProbeAsALegacyServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)

	supported, err := loadSupportedPlatforms(server.URL, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	if supported != nil {
		t.Fatalf("supported = %#v, want nil for a server without the probe", supported)
	}
}

func TestLegacyServersNeverReceiveANewPlatform(t *testing.T) {
	// A deployment that predates a platform drops the explicit platform and
	// re-detects the rows as `claude`. The server max-merges, so sending one
	// would pollute the combined row up to the Grok-only figure (bounded,
	// never a sum) and misattribute usage.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/platforms" {
			http.NotFound(w, r)
			return
		}
		t.Errorf("legacy server must not receive %s", r.URL.Path)
	}))
	t.Cleanup(server.Close)

	supported := resolveSupportedPlatforms(server.URL, "test-token")
	for _, platform := range []string{platformGrok, platformGLM, platformPi} {
		if supported[platform] {
			t.Errorf("%q must be held back from a legacy server", platform)
		}
	}
	// The long-standing platforms must keep uploading, or the probe would
	// regress Kimi tracking on every server that has not updated yet.
	for _, platform := range []string{platformCombined, platformKimi} {
		if !supported[platform] {
			t.Errorf("%q must still upload to a legacy server", platform)
		}
	}

	for _, platform := range []string{platformGrok, platformGLM, platformPi} {
		today := uploadDedicatedPlatform(dedicatedPlatformUpload{
			BaseURL: server.URL, Token: "test-token", Machine: "rig",
			Platform: platform, Label: platform, Supported: supported,
			Run: func() (string, *UsageSnapshot, error) {
				t.Errorf("%q importer must not run against a legacy server", platform)
				return "", nil, nil
			},
		})
		if today != nil {
			t.Errorf("%q must report no snapshot when held back", platform)
		}
	}
}

func TestUnreadableLocalSessionsDoNotFailTheCombinedUpload(t *testing.T) {
	// An unreadable transcript or Pi session must be skipped with a warning,
	// not fail the run — one unreadable file would otherwise take out every
	// platform's upload. (This used to matter for the replace=false downgrade
	// path; since the always-max-merge invariant it matters for availability.)
	if os.Geteuid() == 0 {
		t.Skip("root can read mode 0000 files")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)

	brain := filepath.Join(home, ".gemini", "antigravity-cli", "brain", "sess-1", "logs")
	if err := os.MkdirAll(brain, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(brain, "transcript.jsonl")
	if err := os.WriteFile(transcript, []byte("{}\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(transcript, 0o644) })

	if _, err := loadAntigravityUsageEntries(); err != nil {
		t.Fatalf("unreadable transcript must be skipped, got %v", err)
	}

	piDir := filepath.Join(home, ".pi", "agent", "sessions")
	if err := os.MkdirAll(piDir, 0o755); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(piDir, "locked.jsonl")
	if err := os.WriteFile(locked, []byte("{}\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o644) })

	// One unreadable Pi file would otherwise take out four platforms at once.
	for _, platform := range []string{platformPi, platformKimi, platformGrok, platformGLM} {
		if _, err := loadPiUsageEntriesFor(platform); err != nil {
			t.Errorf("%s: unreadable Pi session must be skipped, got %v", platform, err)
		}
	}
}
