package main

import (
	"bytes"
	"context"
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
	cursorUsageSource = "cursor-cloud"
	// ponytail: 500×500 = 250k events, enough for current dashboard histories.
	// Signal: "exceeded the 500-page fetch limit". Next rung: page until the
	// newest cached date instead of refetching the whole history every run.
	cursorUsagePageSize    = 500
	cursorUsageMaxPages    = 500
	cursorUsageHTTPTimeout = 120 * time.Second
	// The dashboard 403s Go's default user-agent; tokscale uses the same browser UA.
	cursorUsageUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
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
	TotalUsageEventsCount int             `json:"totalUsageEventsCount"`
	UsageEventsDisplay    json.RawMessage `json:"usageEventsDisplay"`
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
	localToday := usageSnapshotForDate(entries, time.Now().UTC().Format("2006-01-02"))
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
	return aggregateCursorUsageEvents(events), nil
}

func readCursorAccessToken() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dbPath := cursorStateDBPathForHome(home)
	dbToken, dbErr := readCursorAccessTokenFromDB(dbPath)
	if dbErr == nil && dbToken != "" {
		return dbToken, nil
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
	if dbErr != nil && !os.IsNotExist(dbErr) {
		return "", dbErr
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
	ctx, cancel := context.WithTimeout(context.Background(), cursorUsageHTTPTimeout)
	defer cancel()

	client := &http.Client{
		Timeout: cursorUsageHTTPTimeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) == 0 {
				return nil
			}
			from := via[0].URL
			if req.URL.Scheme != from.Scheme || req.URL.Host != from.Host {
				return fmt.Errorf("refusing Cursor usage redirect to %s", req.URL.Host)
			}
			return nil
		},
	}

	var all []cursorUsageEvent
	seen := map[string]bool{}
	var totalCount int
	gotTotal := false

	for page := 1; page <= cursorUsageMaxPages; page++ {
		if err := ctx.Err(); err != nil {
			return nil, errors.New("Cursor usage fetch exceeded its time budget before the full history was collected")
		}
		pageEvents, advertisedTotal, err := fetchCursorUsageEventsPage(ctx, client, sessionCookie, page)
		if err != nil {
			return nil, err
		}
		if advertisedTotal > 0 {
			totalCount = advertisedTotal
			gotTotal = true
		}
		received := len(pageEvents)
		for _, event := range pageEvents {
			fp := cursorEventFingerprint(event)
			if seen[fp] {
				continue
			}
			seen[fp] = true
			all = append(all, event)
		}
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

func fetchCursorUsageEventsPage(ctx context.Context, client *http.Client, sessionCookie string, page int) ([]cursorUsageEvent, int, error) {
	body, err := json.Marshal(map[string]any{
		"teamId":   0,
		"page":     page,
		"pageSize": cursorUsagePageSize,
	})
	if err != nil {
		return nil, 0, err
	}

	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(cursorUsageAPIBase, "/")+"/api/dashboard/get-filtered-usage-events", bytes.NewReader(body))
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
		if len(msg) > 200 {
			msg = msg[:200]
		}
		if msg == "" {
			msg = res.Status
		}
		return nil, 0, fmt.Errorf("Cursor usage API: %s", msg)
	}

	var payload cursorUsageEventsResponse
	if err := json.Unmarshal(respBody, &payload); err != nil {
		return nil, 0, errors.New("Cursor usage API returned invalid JSON")
	}
	if payload.UsageEventsDisplay == nil || string(payload.UsageEventsDisplay) == "null" {
		return nil, 0, errors.New("Cursor usage API returned no usageEventsDisplay array")
	}
	var events []cursorUsageEvent
	if err := json.Unmarshal(payload.UsageEventsDisplay, &events); err != nil {
		return nil, 0, errors.New("Cursor usage API returned invalid usageEventsDisplay")
	}
	return events, payload.TotalUsageEventsCount, nil
}

func aggregateCursorUsageEvents(events []cursorUsageEvent) []map[string]any {
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

		date := cursorEventDate(event)
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
	// Prefer billed chargedCents when Cursor reports a real charge; otherwise
	// keep the list-price totalCents so included-plan events still have a value.
	if charged := jsonFlexibleFloat(event.ChargedCents); charged > 0 {
		cost = charged / 100
	}
	return input, output, cacheRead, cacheCreation, cost
}

func cursorEventDate(event cursorUsageEvent) string {
	ms := jsonFlexibleInt(event.Timestamp)
	if ms <= 0 {
		return ""
	}
	if ms < 1_000_000_000_000 {
		ms *= 1000
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02")
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
