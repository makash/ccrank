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

// Z Code (the GLM coding CLI) records one request/response envelope per line in
// ~/.zcode/cli/rollout/model-io-sess_<session-id>.jsonl. Each completed call
// carries a normalized usage object alongside the model that served it.
type glmRolloutLine struct {
	CompletedAt string       `json:"completedAt"`
	RequestID   string       `json:"requestId"`
	SessionID   string       `json:"sessionId"`
	Model       *glmModel    `json:"model"`
	Response    *glmResponse `json:"response"`
}

type glmModel struct {
	ModelID    string `json:"modelId"`
	ProviderID string `json:"providerId"`
}

type glmResponse struct {
	ModelID string    `json:"modelId"`
	Usage   *glmUsage `json:"usage"`
}

type glmUsage struct {
	InputTokens      float64 `json:"inputTokens"`
	OutputTokens     float64 `json:"outputTokens"`
	TotalTokens      float64 `json:"totalTokens"`
	CacheReadTokens  float64 `json:"cacheReadTokens"`
	CacheWriteTokens float64 `json:"cacheWriteTokens"`
}

type glmDailyUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Messages      int
	SessionFiles  map[string]bool
	Models        map[string]*glmModelUsage
}

type glmModelUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
}

func runGLMUsage() (*pendingUsageUpload, *UsageSnapshot, error) {
	entries, err := loadGLMUsageEntries()
	if err != nil {
		return nil, nil, err
	}
	piEntries, err := loadPiUsageEntriesFor(platformGLM)
	if err != nil {
		return nil, nil, err
	}
	entries = mergeUsageEntries(entries, piEntries)
	if len(entries) == 0 {
		return nil, nil, errors.New("no GLM usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	pending, err := prepareUsageUpload(report, entries, platformGLM, "no higher GLM usage rows found")
	return pending, localToday, err
}

func loadGLMUsageEntries() ([]map[string]any, error) {
	roots, err := glmRolloutRoots()
	if err != nil {
		return nil, err
	}

	byDate := map[string]*glmDailyUsage{}
	seenRequests := map[string]bool{}
	for _, root := range roots {
		if _, err := os.Stat(root); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				if os.IsPermission(err) {
					return nil
				}
				return err
			}
			if d.IsDir() || filepath.Ext(path) != ".jsonl" {
				return nil
			}
			if !strings.HasPrefix(filepath.Base(path), "model-io-") {
				return nil
			}
			return readGLMRollout(path, byDate, seenRequests)
		})
		if err != nil {
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
				// Z Code logs carry no pricing, and ccusage reports 0 for models
				// it has no rate for, so GLM stays token-only.
				"cost":   0.0,
				"source": "zcode-rollout-jsonl",
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
			"source":                   "zcode-rollout-jsonl",
		})
	}
	return entries, nil
}

func readGLMRollout(path string, byDate map[string]*glmDailyUsage, seenRequests map[string]bool) error {
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
		var entry glmRolloutLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Response == nil || entry.Response.Usage == nil {
			continue
		}

		date := piUsageDate(entry.CompletedAt)
		if date == "" {
			continue
		}

		modelName := glmModelName(entry)
		usage := entry.Response.Usage
		// Z Code folds cached reads into inputTokens; split them back out so the
		// four buckets add up to the total, as ccusage rows do.
		cacheRead := usage.CacheReadTokens
		cacheCreation := usage.CacheWriteTokens
		input := usage.InputTokens - cacheRead - cacheCreation
		if input < 0 {
			input = 0
		}
		output := usage.OutputTokens
		total := input + output + cacheRead + cacheCreation
		if total == 0 {
			continue
		}

		// A retried request keeps its requestId, so fold retries of the same
		// call into a single record.
		fingerprint := strings.TrimSpace(entry.RequestID)
		if fingerprint == "" {
			fingerprint = fmt.Sprintf("%s|%s|%s|%g|%g", entry.SessionID, entry.CompletedAt, modelName,
				usage.InputTokens, usage.OutputTokens)
		}
		if seenRequests[fingerprint] {
			continue
		}
		seenRequests[fingerprint] = true

		day := byDate[date]
		if day == nil {
			day = &glmDailyUsage{SessionFiles: map[string]bool{}, Models: map[string]*glmModelUsage{}}
			byDate[date] = day
		}
		day.Input += input
		day.Output += output
		day.CacheRead += cacheRead
		day.CacheCreation += cacheCreation
		day.TotalTokens += total
		day.Messages++
		day.SessionFiles[path] = true

		modelUsage := day.Models[modelName]
		if modelUsage == nil {
			modelUsage = &glmModelUsage{}
			day.Models[modelName] = modelUsage
		}
		modelUsage.Input += input
		modelUsage.Output += output
		modelUsage.CacheRead += cacheRead
		modelUsage.CacheCreation += cacheCreation
		modelUsage.TotalTokens += total
	}
	return scanner.Err()
}

func glmModelName(entry glmRolloutLine) string {
	if entry.Model != nil && strings.TrimSpace(entry.Model.ModelID) != "" {
		return strings.TrimSpace(entry.Model.ModelID)
	}
	if entry.Response != nil && strings.TrimSpace(entry.Response.ModelID) != "" {
		return strings.TrimSpace(entry.Response.ModelID)
	}
	return "glm-unknown"
}

func glmRolloutRoots() ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return []string{
		filepath.Join(home, ".zcode", "cli", "rollout"),
		filepath.Join(home, ".zcode", "rollout"),
	}, nil
}
