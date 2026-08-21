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
	"time"
)

type kimiWireLine struct {
	Type       string     `json:"type"`
	Time       any        `json:"time"`
	Model      string     `json:"model"`
	UsageScope string     `json:"usageScope"`
	Usage      *kimiUsage `json:"usage"`
}

type kimiUsage struct {
	InputOther         float64 `json:"inputOther"`
	Output             float64 `json:"output"`
	InputCacheRead     float64 `json:"inputCacheRead"`
	InputCacheCreation float64 `json:"inputCacheCreation"`
}

type kimiDailyUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Messages      int
	SessionFiles  map[string]bool
	Models        map[string]*kimiModelUsage
}

type kimiModelUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
}

func runKimiUsage() (*pendingUsageUpload, *UsageSnapshot, error) {
	entries, err := loadKimiUsageEntries()
	if err != nil {
		return nil, nil, err
	}
	piEntries, err := loadPiKimiUsageEntries()
	if err != nil {
		return nil, nil, err
	}
	entries = mergeUsageEntries(entries, piEntries)
	if len(entries) == 0 {
		return nil, nil, errors.New("no Kimi usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	pending, err := prepareUsageUpload(report, entries, "kimi", "no higher Kimi usage rows found")
	return pending, localToday, err
}

func todayDate() string {
	return time.Now().Format("2006-01-02")
}

func loadKimiUsageEntries() ([]map[string]any, error) {
	roots, err := kimiSessionRoots()
	if err != nil {
		return nil, err
	}

	byDate := map[string]*kimiDailyUsage{}
	seenRecords := map[string]bool{}
	for _, root := range roots {
		err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || filepath.Base(path) != "wire.jsonl" {
				return nil
			}
			return readKimiWire(path, byDate, seenRecords)
		})
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
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
				"cost":                0.0,
				"source":              "kimi-wire-jsonl",
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
			"totalCost":                0.0,
			"totalCostUSD":             0.0,
			"costUSD":                  0.0,
			"modelsUsed":               modelNames,
			"modelBreakdowns":          modelBreakdowns,
			"messages":                 usage.Messages,
			"sessionFiles":             len(usage.SessionFiles),
			"source":                   "kimi-wire-jsonl",
		})
	}
	return entries, nil
}

func readKimiWire(path string, byDate map[string]*kimiDailyUsage, seenRecords map[string]bool) error {
	file, err := os.Open(path)
	if err != nil {
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
		var entry kimiWireLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Type != "usage.record" || entry.Usage == nil {
			continue
		}
		scope := strings.TrimSpace(entry.UsageScope)
		if scope != "" && scope != "turn" {
			continue
		}

		date := piUsageDate(entry.Time)
		if date == "" {
			continue
		}
		modelName := strings.TrimSpace(entry.Model)
		if modelName == "" {
			modelName = "kimi-unknown"
		}
		usage := entry.Usage
		totalTokens := usage.InputOther + usage.Output + usage.InputCacheRead + usage.InputCacheCreation
		if totalTokens == 0 {
			continue
		}

		fingerprint := fmt.Sprintf("%v|%s|%s|%g|%g|%g|%g", entry.Time, modelName, scope,
			usage.InputOther, usage.Output, usage.InputCacheRead, usage.InputCacheCreation)
		if seenRecords[fingerprint] {
			continue
		}
		seenRecords[fingerprint] = true

		day := byDate[date]
		if day == nil {
			day = &kimiDailyUsage{SessionFiles: map[string]bool{}, Models: map[string]*kimiModelUsage{}}
			byDate[date] = day
		}
		day.Input += usage.InputOther
		day.Output += usage.Output
		day.CacheRead += usage.InputCacheRead
		day.CacheCreation += usage.InputCacheCreation
		day.TotalTokens += totalTokens
		day.Messages += 1
		day.SessionFiles[path] = true

		modelUsage := day.Models[modelName]
		if modelUsage == nil {
			modelUsage = &kimiModelUsage{}
			day.Models[modelName] = modelUsage
		}
		modelUsage.Input += usage.InputOther
		modelUsage.Output += usage.Output
		modelUsage.CacheRead += usage.InputCacheRead
		modelUsage.CacheCreation += usage.InputCacheCreation
		modelUsage.TotalTokens += totalTokens
	}
	return scanner.Err()
}

func kimiSessionRoots() ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return []string{
		filepath.Join(home, ".kimi", "sessions"),
		filepath.Join(home, ".kimi-code", "sessions"),
	}, nil
}
