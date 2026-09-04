package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	_ "modernc.org/sqlite"
)

// Cursor does not keep a local token ledger (IDE bubble tokenCount is zero,
// agent transcripts have no usage object). Billed Agent and CLI usage lives
// on the Cursor dashboard. The importer reads the desktop login from
// state.vscdb, fetches usage events from cursor.com, and uploads aggregates.
// The Cursor session token never leaves this process.
const (
	cursorUsageSource      = "cursor-cloud"
	cursorUsagePageSize    = 200
	cursorUsageMaxPages    = 100
	cursorUsageHTTPTimeout = 120 * time.Second
	cursorUsageUserAgent   = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

// Tests replace this with an httptest server. Production talks to cursor.com.
var cursorUsageAPIBase = "https://cursor.com"

type cursorTokenUsage struct {
	InputTokens      float64 `json:"inputTokens"`
	OutputTokens     float64 `json:"outputTokens"`
	CacheReadTokens  float64 `json:"cacheReadTokens"`
	CacheWriteTokens float64 `json:"cacheWriteTokens"`
	TotalCents       float64 `json:"totalCents"`
}

type cursorUsageEvent struct {
	Timestamp      json.RawMessage   `json:"timestamp"`
	Model          string            `json:"model"`
	ChargedCents   json.RawMessage   `json:"chargedCents"`
	TokenUsage     *cursorTokenUsage `json:"tokenUsage"`
	ConversationID string            `json:"conversationId"`
}

type cursorUsageEventsResponse struct {
	TotalUsageEventsCount int                `json:"totalUsageEventsCount"`
	UsageEventsDisplay    []cursorUsageEvent `json:"usageEventsDisplay"`
}

type cursorDailyUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Cost          float64
	Events        int
	Models        map[string]*cursorModelUsage
}

type cursorModelUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Cost          float64
}

func runCursorUsage() (*pendingUsageUpload, *UsageSnapshot, error) {
	entries, err := loadCursorUsageEntries()
	if err != nil {
		return nil, nil, err
	}
	if len(entries) == 0 {
		return nil, nil, errors.New("no Cursor usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	pending, err := prepareUsageUpload(report, entries, platformCursor, "no higher Cursor usage rows found")
	return pending, localToday, err
}

func loadCursorUsageEntries() ([]map[string]any, error) {
	token, err := readCursorAccessToken()
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, nil
	}

	cookie, err := cursorSessionCookie(token)
	if err != nil {
		return nil, err
	}

	events, err := fetchCursorUsageEvents(cookie)
	if err != nil {
		return nil, err
	}
	return aggregateCursorUsageEvents(events, time.Local), nil
}

func readCursorAccessToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dbPath := cursorStateDBPathForHome(home)
	if token, err := readCursorAccessTokenFromDB(dbPath); err != nil {
		if !os.IsNotExist(err) {
			return "", err
		}
	} else if token != "" {
		return token, nil
	}
	for _, path := range []string{
		filepath.Join(home, ".config", "cursor", "auth.json"),
		filepath.Join(home, ".cursor", "auth.json"),
	} {
		token, err := readCursorAccessTokenFromJSON(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", err
		}
		if token != "" {
			return token, nil
		}
	}
	return "", nil
}

func cursorStateDBPathForHome(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
	case "windows":
		if appdata := strings.TrimSpace(os.Getenv("APPDATA")); appdata != "" {
			return filepath.Join(appdata, "Cursor", "User", "globalStorage", "state.vscdb")
		}
		return filepath.Join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb")
	default:
		if xdg := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdg != "" {
			return filepath.Join(xdg, "Cursor", "User", "globalStorage", "state.vscdb")
		}
		return filepath.Join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")
	}
}

func readCursorAccessTokenFromDB(dbPath string) (string, error) {
	if _, err := os.Stat(dbPath); err != nil {
		return "", err
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?mode=ro")
	if err != nil {
		return "", err
	}
	defer db.Close()

	var value []byte
	err = db.QueryRow("SELECT value FROM ItemTable WHERE key = ?", "cursorAuth/accessToken").Scan(&value)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	return normalizeCursorAccessToken(string(value)), nil
}

func readCursorAccessTokenFromJSON(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var payload struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", nil
	}
	return normalizeCursorAccessToken(payload.AccessToken), nil
}

func normalizeCursorAccessToken(raw string) string {
	token := strings.TrimSpace(raw)
	token = strings.Trim(token, `"`)
	return token
}

func cursorSessionCookie(accessToken string) (string, error) {
	userID, err := cursorUserIDFromAccessToken(accessToken)
	if err != nil {
		return "", err
	}
	return userID + "%3A%3A" + accessToken, nil
}

func cursorUserIDFromAccessToken(accessToken string) (string, error) {
	parts := strings.Split(accessToken, ".")
	if len(parts) < 2 {
		return "", errors.New("Cursor access token is not a JWT")
	}
	payload, err := decodeCursorJWTPayload(parts[1])
	if err != nil {
		return "", errors.New("Cursor access token JWT payload is invalid")
	}
	var claims struct {
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || strings.TrimSpace(claims.Sub) == "" {
		return "", errors.New("Cursor access token JWT is missing sub")
	}
	userID := cursorUserIDFromSub(claims.Sub)
	if userID == "" {
		return "", errors.New("Cursor access token JWT is missing a user id")
	}
	return userID, nil
}

func decodeCursorJWTPayload(segment string) ([]byte, error) {
	if data, err := base64.RawURLEncoding.DecodeString(segment); err == nil {
		return data, nil
	}
	return base64.URLEncoding.DecodeString(segment)
}

func cursorUserIDFromSub(sub string) string {
	idx := strings.Index(sub, "user_")
	if idx < 0 {
		return ""
	}
	rest := sub[idx:]
	end := 0
	for end < len(rest) {
		r := rune(rest[end])
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			break
		}
		end++
	}
	if end <= len("user_") {
		return ""
	}
	return rest[:end]
}

func fetchCursorUsageEvents(sessionCookie string) ([]cursorUsageEvent, error) {
	client := &http.Client{Timeout: cursorUsageHTTPTimeout}
	deadline := time.Now().Add(cursorUsageHTTPTimeout)
	var all []cursorUsageEvent
	var totalCount int
	gotTotal := false

	for page := 1; page <= cursorUsageMaxPages; page++ {
		if remaining := time.Until(deadline); remaining <= 0 {
			return nil, errors.New("Cursor usage fetch exceeded its time budget before the full history was collected")
		}
		pageEvents, advertisedTotal, err := fetchCursorUsageEventsPage(client, sessionCookie, page)
		if err != nil {
			return nil, err
		}
		if !gotTotal && advertisedTotal > 0 {
			totalCount = advertisedTotal
			gotTotal = true
		}
		all = append(all, pageEvents...)
		received := len(pageEvents)
		if gotTotal {
			if len(all) >= totalCount {
				return all, nil
			}
			if received == 0 {
				return nil, fmt.Errorf("Cursor API returned an empty page before its advertised total of %d events", totalCount)
			}
			continue
		}
		if received == 0 || received < cursorUsagePageSize {
			return all, nil
		}
	}
	return nil, fmt.Errorf("Cursor usage exceeded the %d-page fetch limit before the full history was collected", cursorUsageMaxPages)
}

func fetchCursorUsageEventsPage(client *http.Client, sessionCookie string, page int) ([]cursorUsageEvent, int, error) {
	body, err := json.Marshal(map[string]any{
		"teamId":   0,
		"page":     page,
		"pageSize": cursorUsagePageSize,
	})
	if err != nil {
		return nil, 0, err
	}

	req, err := http.NewRequest("POST", strings.TrimRight(cursorUsageAPIBase, "/")+"/api/dashboard/get-filtered-usage-events", bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", "https://cursor.com")
	req.Header.Set("Referer", "https://www.cursor.com/settings")
	req.Header.Set("User-Agent", cursorUsageUserAgent)
	req.Header.Set("Cookie", "WorkosCursorSessionToken="+sessionCookie)

	res, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden {
		return nil, 0, errors.New("Cursor session expired; open the Cursor app, sign in, and retry")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		msg := strings.TrimSpace(string(respBody))
		if msg == "" {
			msg = res.Status
		}
		return nil, 0, fmt.Errorf("Cursor usage API: %s", msg)
	}

	var payload cursorUsageEventsResponse
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return nil, 0, errors.New("Cursor usage API returned invalid JSON")
	}
	return payload.UsageEventsDisplay, payload.TotalUsageEventsCount, nil
}

func aggregateCursorUsageEvents(events []cursorUsageEvent, loc *time.Location) []map[string]any {
	if loc == nil {
		loc = time.Local
	}
	byDate := map[string]*cursorDailyUsage{}
	seen := map[string]bool{}
	for _, event := range events {
		fingerprint := cursorEventFingerprint(event)
		if seen[fingerprint] {
			continue
		}
		seen[fingerprint] = true

		input, output, cacheRead, cacheCreation, cost := cursorEventTotals(event)
		total := input + output + cacheRead + cacheCreation
		if total == 0 && cost == 0 {
			continue
		}

		date := cursorEventDate(event, loc)
		if date == "" {
			continue
		}

		modelName := strings.TrimSpace(event.Model)
		if modelName == "" {
			modelName = "cursor-unknown"
		}

		day := byDate[date]
		if day == nil {
			day = &cursorDailyUsage{Models: map[string]*cursorModelUsage{}}
			byDate[date] = day
		}
		day.Input += input
		day.Output += output
		day.CacheRead += cacheRead
		day.CacheCreation += cacheCreation
		day.TotalTokens += total
		day.Cost += cost
		day.Events++

		modelUsage := day.Models[modelName]
		if modelUsage == nil {
			modelUsage = &cursorModelUsage{}
			day.Models[modelName] = modelUsage
		}
		modelUsage.Input += input
		modelUsage.Output += output
		modelUsage.CacheRead += cacheRead
		modelUsage.CacheCreation += cacheCreation
		modelUsage.TotalTokens += total
		modelUsage.Cost += cost
	}

	dates := make([]string, 0, len(byDate))
	for date := range byDate {
		dates = append(dates, date)
	}
	sort.Strings(dates)

	entries := make([]map[string]any, 0, len(dates))
	for _, date := range dates {
		usage := byDate[date]
		modelNames := make([]string, 0, len(usage.Models))
		for modelName := range usage.Models {
			modelNames = append(modelNames, modelName)
		}
		sort.Strings(modelNames)

		modelBreakdowns := make([]map[string]any, 0, len(modelNames))
		for _, modelName := range modelNames {
			modelUsage := usage.Models[modelName]
			modelBreakdowns = append(modelBreakdowns, map[string]any{
				"modelName":           modelName,
				"inputTokens":         modelUsage.Input,
				"outputTokens":        modelUsage.Output,
				"cacheCreationTokens": modelUsage.CacheCreation,
				"cacheReadTokens":     modelUsage.CacheRead,
				"totalTokens":         modelUsage.TotalTokens,
				"cost":                modelUsage.Cost,
				"source":              "cursor-dashboard",
			})
		}

		entries = append(entries, map[string]any{
			"date":                     date,
			"inputTokens":              usage.Input,
			"outputTokens":             usage.Output,
			"cacheCreationTokens":      usage.CacheCreation,
			"cacheReadTokens":          usage.CacheRead,
			"totalInputTokens":         usage.Input,
			"totalOutputTokens":        usage.Output,
			"totalCacheCreationTokens": usage.CacheCreation,
			"totalCacheReadTokens":     usage.CacheRead,
			"totalTokens":              usage.TotalTokens,
			"totalCost":                usage.Cost,
			"totalCostUSD":             usage.Cost,
			"costUSD":                  usage.Cost,
			"modelsUsed":               modelNames,
			"modelBreakdowns":          modelBreakdowns,
			"messages":                 usage.Events,
			"source":                   "cursor-dashboard",
		})
	}
	return entries
}

func cursorEventTotals(event cursorUsageEvent) (input, output, cacheRead, cacheCreation, cost float64) {
	if event.TokenUsage != nil {
		input = event.TokenUsage.InputTokens
		output = event.TokenUsage.OutputTokens
		cacheRead = event.TokenUsage.CacheReadTokens
		cacheCreation = event.TokenUsage.CacheWriteTokens
		cost = event.TokenUsage.TotalCents / 100
	}
	if charged := jsonFlexibleFloat(event.ChargedCents); charged > 0 {
		cost = charged / 100
	}
	return input, output, cacheRead, cacheCreation, cost
}

func cursorEventDate(event cursorUsageEvent, loc *time.Location) string {
	ms := jsonFlexibleInt(event.Timestamp)
	if ms <= 0 {
		return ""
	}
	if ms < 1_000_000_000_000 {
		ms *= 1000
	}
	return time.UnixMilli(ms).In(loc).Format("2006-01-02")
}

func cursorEventFingerprint(event cursorUsageEvent) string {
	input, output := 0.0, 0.0
	if event.TokenUsage != nil {
		input = event.TokenUsage.InputTokens
		output = event.TokenUsage.OutputTokens
	}
	return strings.Join([]string{
		strconv.FormatInt(jsonFlexibleInt(event.Timestamp), 10),
		event.ConversationID,
		event.Model,
		strconv.FormatFloat(input, 'f', 0, 64),
		strconv.FormatFloat(output, 'f', 0, 64),
	}, "|")
}

func jsonFlexibleFloat(raw json.RawMessage) float64 {
	s := strings.TrimSpace(string(raw))
	s = strings.Trim(s, `"`)
	if s == "" || s == "null" || s == "-" {
		return 0
	}
	n, _ := strconv.ParseFloat(s, 64)
	return n
}

func jsonFlexibleInt(raw json.RawMessage) int64 {
	s := strings.TrimSpace(string(raw))
	s = strings.Trim(s, `"`)
	if s == "" || s == "null" {
		return 0
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		return n
	}
	f, _ := strconv.ParseFloat(s, 64)
	return int64(f)
}
