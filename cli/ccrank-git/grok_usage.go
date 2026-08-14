package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Grok CLI appends one JSON-RPC style event per line to
// ~/.grok/sessions/<encoded-cwd>/<session-id>/updates.jsonl. Token counts land
// on the "turn_completed" update, which carries a per-model breakdown and the
// list-price cost in ticks.
type grokUpdateLine struct {
	Timestamp float64           `json:"timestamp"`
	Method    string            `json:"method"`
	Params    *grokUpdateParams `json:"params"`
}

type grokUpdateParams struct {
	SessionID string          `json:"sessionId"`
	Update    *grokTurnUpdate `json:"update"`
	Meta      *grokUpdateMeta `json:"_meta"`
}

type grokUpdateMeta struct {
	EventID          string  `json:"eventId"`
	AgentTimestampMs float64 `json:"agentTimestampMs"`
}

type grokTurnUpdate struct {
	SessionUpdate string     `json:"sessionUpdate"`
	PromptID      string     `json:"prompt_id"`
	Usage         *grokUsage `json:"usage"`
}

// grokUsage doubles as the per-model breakdown shape; only the turn-level
// object carries ModelUsage.
type grokUsage struct {
	InputTokens         float64               `json:"inputTokens"`
	OutputTokens        float64               `json:"outputTokens"`
	TotalTokens         float64               `json:"totalTokens"`
	CachedReadTokens    float64               `json:"cachedReadTokens"`
	CacheCreationTokens float64               `json:"cacheCreationTokens"`
	CostUsdTicks        float64               `json:"costUsdTicks"`
	ModelUsage          map[string]*grokUsage `json:"modelUsage"`
}

// Grok reports cost in ticks rather than dollars. 1e10 ticks == 1 USD: at that
// scale real session logs imply $1.8-2.8 per million fresh input tokens and
// $0.4-0.9 per million cached reads, which match xAI list pricing. One order up
// would price cached reads above any published rate.
const grokCostTicksPerUSD = 1e10

type grokDailyUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Cost          float64
	Turns         int
	SessionFiles  map[string]bool
	Models        map[string]*grokModelUsage
}

type grokModelUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Cost          float64
}

func runGrokUsage() (string, *UsageSnapshot, error) {
	entries, err := loadGrokUsageEntries()
	if err != nil {
		return "", nil, err
	}
	piEntries, err := loadPiUsageEntriesFor(platformGrok)
	if err != nil {
		return "", nil, err
	}
	entries = mergeUsageEntries(entries, piEntries)
	if len(entries) == 0 {
		return "", nil, errors.New("no Grok usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	normalized, err := normalizeAndFilterUsageReportFor(report, entries, platformGrok, "no higher Grok usage rows found")
	return normalized, localToday, err
}

func loadGrokUsageEntries() ([]map[string]any, error) {
	root, err := grokSessionsPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	byDate := map[string]*grokDailyUsage{}
	seenEvents := map[string]bool{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Grok locks live session directories; skip what we cannot read
			// instead of failing the whole import.
			if os.IsPermission(err) {
				return nil
			}
			return err
		}
		if d.IsDir() || filepath.Base(path) != "updates.jsonl" {
			return nil
		}
		return readGrokUpdates(path, byDate, seenEvents)
	})
	if err != nil {
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
		if usage.TotalTokens == 0 {
			continue
		}

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
				"source":              "grok-updates-jsonl",
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
			"messages":                 usage.Turns,
			"sessionFiles":             len(usage.SessionFiles),
			"source":                   "grok-updates-jsonl",
		})
	}
	return entries, nil
}

func readGrokUpdates(path string, byDate map[string]*grokDailyUsage, seenEvents map[string]bool) error {
	file, err := os.Open(path)
	if err != nil {
		if os.IsPermission(err) {
			return nil
		}
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry grokUpdateLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Params == nil || entry.Params.Update == nil {
			continue
		}
		update := entry.Params.Update
		if update.SessionUpdate != "turn_completed" || update.Usage == nil {
			continue
		}

		date := grokUsageDate(entry.Params.Meta, entry.Timestamp)
		if date == "" {
			continue
		}

		// Rewinding a session replays completed turns into updates.jsonl, so
		// fold on the event id and count each turn once.
		fingerprint := grokEventFingerprint(entry)
		if seenEvents[fingerprint] {
			continue
		}
		seenEvents[fingerprint] = true

		day := byDate[date]
		if day == nil {
			day = &grokDailyUsage{SessionFiles: map[string]bool{}, Models: map[string]*grokModelUsage{}}
			byDate[date] = day
		}

		perModel := update.Usage.ModelUsage
		if len(perModel) == 0 {
			perModel = map[string]*grokUsage{"grok-unknown": update.Usage}
		}

		counted := false
		for modelName, modelUsage := range perModel {
			if modelUsage == nil {
				continue
			}
			input, output, cacheRead, cacheCreation, total := grokTokenSplit(modelUsage)
			if total == 0 {
				continue
			}
			cost := modelUsage.CostUsdTicks / grokCostTicksPerUSD

			day.Input += input
			day.Output += output
			day.CacheRead += cacheRead
			day.CacheCreation += cacheCreation
			day.TotalTokens += total
			day.Cost += cost
			counted = true

			name := strings.TrimSpace(modelName)
			if name == "" {
				name = "grok-unknown"
			}
			agg := day.Models[name]
			if agg == nil {
				agg = &grokModelUsage{}
				day.Models[name] = agg
			}
			agg.Input += input
			agg.Output += output
			agg.CacheRead += cacheRead
			agg.CacheCreation += cacheCreation
			agg.TotalTokens += total
			agg.Cost += cost
		}
		if counted {
			day.Turns++
			day.SessionFiles[path] = true
		}
	}
	return scanner.Err()
}

// grokTokenSplit converts Grok's counters into the additive convention ccusage
// uses, where the four buckets sum to the total. Grok folds cached reads into
// inputTokens, so they are subtracted back out before reporting.
func grokTokenSplit(usage *grokUsage) (input, output, cacheRead, cacheCreation, total float64) {
	cacheRead = usage.CachedReadTokens
	cacheCreation = usage.CacheCreationTokens
	input = usage.InputTokens - cacheRead - cacheCreation
	if input < 0 {
		input = 0
	}
	output = usage.OutputTokens
	total = input + output + cacheRead + cacheCreation
	return input, output, cacheRead, cacheCreation, total
}

func grokEventFingerprint(entry grokUpdateLine) string {
	if entry.Params.Meta != nil && strings.TrimSpace(entry.Params.Meta.EventID) != "" {
		return entry.Params.Meta.EventID
	}
	usage := entry.Params.Update.Usage
	return fmt.Sprintf("%s|%s|%g|%g|%g|%g",
		entry.Params.SessionID, entry.Params.Update.PromptID, entry.Timestamp,
		usage.InputTokens, usage.OutputTokens, usage.CostUsdTicks)
}

// grokUsageDate prefers the millisecond agent clock and falls back to the
// line's own timestamp, which Grok writes in whole seconds.
func grokUsageDate(meta *grokUpdateMeta, timestamp float64) string {
	if meta != nil && meta.AgentTimestampMs > 0 {
		return piUsageDate(meta.AgentTimestampMs)
	}
	if timestamp > 0 {
		return piUsageDate(timestamp * 1000)
	}
	return ""
}

func grokSessionsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".grok", "sessions"), nil
}
