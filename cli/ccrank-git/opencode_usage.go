package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// OpenCode records every assistant reply as one row in a live-written SQLite
// database at $XDG_DATA_HOME/opencode/opencode.db (default
// ~/.local/share/opencode/opencode.db). The row's JSON payload carries the
// token counters and cost opencode computed for that reply.
type openCodeMessageData struct {
	Role    string              `json:"role"`
	ModelID string              `json:"modelID"`
	Cost    float64             `json:"cost"`
	Tokens  *openCodeTokenCount `json:"tokens"`
}

type openCodeTokenCount struct {
	Input     float64        `json:"input"`
	Output    float64        `json:"output"`
	Reasoning float64        `json:"reasoning"`
	Cache     *openCodeCache `json:"cache"`
}

type openCodeCache struct {
	Read  float64 `json:"read"`
	Write float64 `json:"write"`
}

func (c *openCodeCache) readValue() float64 {
	if c == nil {
		return 0
	}
	return c.Read
}

func (c *openCodeCache) writeValue() float64 {
	if c == nil {
		return 0
	}
	return c.Write
}

type openCodeDailyUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Cost          float64
	Messages      int
	Models        map[string]*openCodeModelUsage
}

type openCodeModelUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Cost          float64
}

func runOpenCodeUsage() (*pendingUsageUpload, *UsageSnapshot, error) {
	entries, err := loadOpenCodeUsageEntries()
	if err != nil {
		return nil, nil, err
	}
	if len(entries) == 0 {
		return nil, nil, errors.New("no OpenCode usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	pending, err := prepareUsageUpload(report, entries, platformOpenCode, "no higher OpenCode usage rows found")
	return pending, localToday, err
}

func loadOpenCodeUsageEntries() ([]map[string]any, error) {
	dbPath, err := openCodeDBPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	// Read-only: opencode keeps the database open in WAL mode and writes to it
	// live, so the import must never take a write lock or touch its files.
	db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	// No json1 in the query: SQLite raises "malformed JSON" and aborts the
	// scan if any row carries invalid JSON, so the role filter runs in Go.
	rows, err := db.Query("SELECT id, time_created, data FROM message")
	if err != nil {
		// An opencode install that has not created its schema yet reads as
		// "no usage", not as a failed run.
		return nil, nil
	}
	defer rows.Close()

	byDate := map[string]*openCodeDailyUsage{}
	seenMessages := map[string]bool{}
	for rows.Next() {
		var id string
		var timeCreated int64
		var data string
		if err := rows.Scan(&id, &timeCreated, &data); err != nil {
			continue
		}
		// One row per assistant reply; the id guard folds any duplicate the
		// database hands back into a single record.
		if seenMessages[id] {
			continue
		}
		seenMessages[id] = true

		var parsed openCodeMessageData
		if err := json.Unmarshal([]byte(data), &parsed); err != nil || parsed.Tokens == nil {
			continue
		}
		if parsed.Role != "assistant" {
			continue
		}

		date := piUsageDate(timeCreated)
		if date == "" {
			continue
		}

		modelName := strings.TrimSpace(parsed.ModelID)
		if modelName == "" {
			modelName = "opencode-unknown"
		}
		// opencode reports reasoning separately from output and adds both into
		// its own total, so fold reasoning into output to keep the four buckets
		// summing to the total, as ccusage rows do.
		cacheRead := parsed.Tokens.Cache.readValue()
		cacheCreation := parsed.Tokens.Cache.writeValue()
		input := parsed.Tokens.Input
		output := parsed.Tokens.Output + parsed.Tokens.Reasoning
		total := input + output + cacheRead + cacheCreation
		if total == 0 {
			continue
		}

		day := byDate[date]
		if day == nil {
			day = &openCodeDailyUsage{Models: map[string]*openCodeModelUsage{}}
			byDate[date] = day
		}
		day.Input += input
		day.Output += output
		day.CacheRead += cacheRead
		day.CacheCreation += cacheCreation
		day.TotalTokens += total
		day.Cost += parsed.Cost
		day.Messages++

		modelUsage := day.Models[modelName]
		if modelUsage == nil {
			modelUsage = &openCodeModelUsage{}
			day.Models[modelName] = modelUsage
		}
		modelUsage.Input += input
		modelUsage.Output += output
		modelUsage.CacheRead += cacheRead
		modelUsage.CacheCreation += cacheCreation
		modelUsage.TotalTokens += total
		modelUsage.Cost += parsed.Cost
	}
	if err := rows.Err(); err != nil {
		return nil, err
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
				"source":              "opencode-sqlite",
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
			"messages":                 usage.Messages,
			"source":                   "opencode-sqlite",
		})
	}
	return entries, nil
}

// openCodeDBPath resolves the session database, honoring XDG_DATA_HOME the way
// opencode itself does.
func openCodeDBPath() (string, error) {
	if dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dataHome != "" {
		return filepath.Join(dataHome, "opencode", "opencode.db"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "opencode", "opencode.db"), nil
}
