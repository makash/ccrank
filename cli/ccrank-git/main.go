package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Day struct {
	Date        string `json:"date"`
	CommitCount int    `json:"commitCount"`
}

type Project struct {
	RepoName            string `json:"repoName"`
	RepoSlug            string `json:"repoSlug"`
	Description         string `json:"description"`
	DescriptionOverride bool   `json:"descriptionOverride"`
	Days                []Day  `json:"days"`
}

type Payload struct {
	Machine  string    `json:"machine,omitempty"`
	Projects []Project `json:"projects"`
}

type Config struct {
	Repos []string `json:"repos"`
}

func main() {
	urlFlag := flag.String("url", "", "Base URL of the leaderboard (e.g., https://ccrank.dev)")
	tokenFlag := flag.String("token", "", "API token from Settings → Git Metadata")
	descFlag := flag.String("description", "", "Optional description override")
	allRepos := flag.Bool("all-repos", false, "Deprecated: use config auto-discovery")
	repoFlag := flag.String("repo", "", "Upload git metadata for a single repo path")
	machineFlag := flag.String("machine", "", "Machine name (defaults to hostname)")
	allFlag := flag.Bool("all", false, "Deprecated: ccusage runs automatically")
	jsonSummary := flag.Bool("json", false, "Print summary as JSON")
	dryRun := flag.Bool("dry-run", false, "Print payload JSON without uploading")
	uploadUsage := flag.Bool("upload-usage", false, "Upload ccusage data in addition to git metadata")
	skipUsage := flag.Bool("skip-usage", false, "Skip automatic ccusage upload")
	noUsage := flag.Bool("no-usage", false, "Alias for --skip-usage")
	addThisRepo := flag.Bool("add-repo", false, "Add current repo (or scan directory) to ~/.ccrank/repos.json and exit")
	flag.Parse()

	if *allFlag || *allRepos {
		fmt.Fprintln(os.Stderr, "Note: --all and --all-repos are deprecated. Config is used automatically.")
	}

	machine := strings.TrimSpace(*machineFlag)
	if machine == "" {
		if host, err := os.Hostname(); err == nil {
			machine = host
		}
	}

	if *addThisRepo {
		if err := addRepoFromWd(); err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		return
	}

	var repos []string
	if strings.TrimSpace(*repoFlag) != "" {
		repos = []string{normalizePath(strings.TrimSpace(*repoFlag))}
	} else {
		cfg, created, err := loadOrCreateConfig()
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
		if created || len(cfg.Repos) == 0 {
			printOnboardingMessage()
			os.Exit(0)
		}
		repos = cfg.Repos
	}

	payload, summary, err := buildPayload(repos, *descFlag, machine)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	if *dryRun || *urlFlag == "" || *tokenFlag == "" {
		out, _ := json.MarshalIndent(payload, "", "  ")
		fmt.Println(string(out))
		if !*dryRun {
			fmt.Fprintln(os.Stderr, "Missing --url or --token. Use --dry-run to inspect payload.")
		}
		return
	}

	err = uploadPayload(*urlFlag, *tokenFlag, payload)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Upload failed:", err.Error())
		os.Exit(1)
	}

	fmt.Println("Upload complete")

	if *skipUsage || *noUsage || !*uploadUsage {
		fmt.Println("Usage upload skipped (use --upload-usage to enable)")
		printSummary(summary, *jsonSummary)
		return
	}

	// Upload combined coding-agent usage (Claude Code + Codex + other ccusage agents).
	// ccrank production currently treats this as the legacy Claude bucket, so keep
	// the payload combined to avoid replacing old all-agent rows with narrower data.
	fmt.Println("Checking combined Claude Code + Codex + Antigravity usage...")
	report, err := runCcusage()
	if err != nil {
		fmt.Fprintln(os.Stderr, "  Combined usage: skipped -", err.Error())
	} else {
		err = uploadCcusage(*urlFlag, *tokenFlag, report, machine, "claude")
		if err != nil {
			fmt.Fprintln(os.Stderr, "  Combined usage: upload failed -", err.Error())
		} else {
			fmt.Println("  Combined usage: upload complete")
		}
	}

	fmt.Println("  Codex CLI: included in combined usage upload")
	fmt.Println("  Gemini Antigravity: included from local transcripts when present")

	if err != nil {
		printCcusageHelp()
	}

	printSummary(summary, *jsonSummary)
}

func mustWd() string {
	wd, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to determine working directory")
		os.Exit(1)
	}
	return wd
}

func getCommitCounts(repoPath string) ([]Day, error) {
	cmd := exec.Command("git", "-C", repoPath, "log", "--since=28 days ago", "--pretty=format:%ad", "--date=short")
	output, err := cmd.Output()
	if err != nil {
		return nil, errors.New("failed to run git log (are you in a git repo?)")
	}

	counts := map[string]int{}
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		counts[line] += 1
	}

	dates := lastNDates(28)
	days := make([]Day, 0, len(dates))
	for _, date := range dates {
		days = append(days, Day{Date: date, CommitCount: counts[date]})
	}
	return days, nil
}

func lastNDates(n int) []string {
	dates := make([]string, 0, n)
	today := time.Now()
	for i := n - 1; i >= 0; i-- {
		d := today.AddDate(0, 0, -i)
		dates = append(dates, d.Format("2006-01-02"))
	}
	return dates
}

func readReadmeTitle(repoPath string) string {
	candidates := []string{"README.md", "readme.md"}
	for _, name := range candidates {
		full := filepath.Join(repoPath, name)
		if _, err := os.Stat(full); err == nil {
			contents, err := os.ReadFile(full)
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(contents), "\n") {
				if strings.HasPrefix(line, "# ") {
					return strings.TrimSpace(strings.TrimPrefix(line, "# "))
				}
			}
		}
	}
	return ""
}

func slugify(input string) string {
	lower := strings.ToLower(input)
	re := regexp.MustCompile(`[^a-z0-9]+`)
	slug := re.ReplaceAllString(lower, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 50 {
		slug = slug[:50]
	}
	if slug == "" {
		return "repo"
	}
	return slug
}

func uploadPayload(baseURL, token string, payload Payload) error {
	baseURL = strings.TrimRight(baseURL, "/")
	endpoint := baseURL + "/api/git/upload"

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 90 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	respBody, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s", strings.TrimSpace(string(respBody)))
	}

	var parsed map[string]any
	if err := json.Unmarshal(respBody, &parsed); err == nil {
		if ok, found := parsed["ok"].(bool); found && !ok {
			return fmt.Errorf("%s", strings.TrimSpace(string(respBody)))
		}
	}

	return nil
}

func runCcusage() (string, error) {
	cmd := exec.Command("npx", "ccusage@latest", "daily", "--json")
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New("no combined usage data found (is Node installed?)")
	}
	normalized, err := normalizeAndFilterCcusageReport(out)
	if err != nil {
		return "", err
	}
	return normalized, nil
}

func normalizeAndFilterCcusageReport(out []byte) (string, error) {
	report, entries, err := parseCcusageReport(out)
	if err != nil {
		return "", err
	}
	antigravityEntries, err := loadAntigravityUsageEntries()
	if err != nil {
		fmt.Fprintln(os.Stderr, "  Gemini Antigravity: skipped -", err.Error())
	} else if len(antigravityEntries) > 0 {
		entries = mergeUsageEntries(entries, antigravityEntries)
		setReportEntries(report, entries)
	}

	maxima, err := loadUsageMaxima()
	if err != nil {
		return "", err
	}

	changed := []map[string]any{}
	for _, entry := range entries {
		date := usageDate(entry)
		if date == "" {
			continue
		}
		entry["date"] = date

		currentTokens := numberValue(entry["totalTokens"])
		cached, found := maxima[date]
		if !found || currentTokens > numberValue(cached["totalTokens"]) {
			snapshot := cloneUsageEntry(entry)
			maxima[date] = snapshot
			changed = append(changed, snapshot)
		}
	}

	if err := writeUsageMaxima(maxima); err != nil {
		return "", err
	}

	if len(changed) == 0 {
		return "", errors.New("no higher combined usage rows found")
	}

	filtered := map[string]any{
		"daily":  changed,
		"totals": usageTotals(changed),
	}
	if reportType, ok := report["type"].(string); ok && reportType != "" {
		filtered["type"] = reportType
	}

	normalized, err := json.Marshal(filtered)
	if err != nil {
		return "", err
	}
	return string(normalized), nil
}

func normalizeCcusageReport(out []byte) (string, error) {
	report, _, err := parseCcusageReport(out)
	if err != nil {
		return "", err
	}

	normalized, err := json.Marshal(report)
	if err != nil {
		return "", err
	}
	return string(normalized), nil
}

func parseCcusageReport(out []byte) (map[string]any, []map[string]any, error) {
	var report map[string]any
	if err := json.Unmarshal(out, &report); err != nil {
		return nil, nil, errors.New("ccusage returned invalid JSON")
	}

	rawEntries, ok := report["daily"].([]any)
	if !ok {
		rawEntries, ok = report["data"].([]any)
	}
	if !ok {
		return nil, nil, errors.New("ccusage report has no daily data")
	}

	entries := []map[string]any{}
	for _, item := range rawEntries {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if date := usageDate(entry); date != "" {
			entry["date"] = date
		}
		entries = append(entries, entry)
	}

	if _, ok := report["daily"].([]any); ok {
		report["daily"] = entries
	} else {
		report["data"] = entries
	}
	return report, entries, nil
}

func setReportEntries(report map[string]any, entries []map[string]any) {
	if _, ok := report["daily"]; ok {
		report["daily"] = entries
		return
	}
	if _, ok := report["data"]; ok {
		report["data"] = entries
		return
	}
	report["daily"] = entries
}

func mergeUsageEntries(entries []map[string]any, extras []map[string]any) []map[string]any {
	byDate := map[string]map[string]any{}
	order := []string{}

	for _, entry := range entries {
		date := usageDate(entry)
		if date == "" {
			continue
		}
		entry["date"] = date
		if existing, ok := byDate[date]; ok {
			mergeUsageEntry(existing, entry)
			continue
		}
		byDate[date] = entry
		order = append(order, date)
	}

	for _, entry := range extras {
		date := usageDate(entry)
		if date == "" {
			continue
		}
		entry["date"] = date
		if existing, ok := byDate[date]; ok {
			mergeUsageEntry(existing, entry)
			continue
		}
		byDate[date] = entry
		order = append(order, date)
	}

	sort.Strings(order)
	merged := make([]map[string]any, 0, len(order))
	for _, date := range order {
		merged = append(merged, byDate[date])
	}
	return merged
}

func mergeUsageEntry(dst map[string]any, src map[string]any) {
	for _, key := range []string{
		"inputTokens",
		"outputTokens",
		"cacheCreationTokens",
		"cacheReadTokens",
		"cachedInputTokens",
		"totalInputTokens",
		"totalOutputTokens",
		"totalCacheCreationTokens",
		"totalCacheReadTokens",
		"totalTokens",
	} {
		dst[key] = numberValue(dst[key]) + numberValue(src[key])
	}
	mergedCost := usageCostValue(dst) + usageCostValue(src)
	if mergedCost > 0 {
		dst["totalCost"] = mergedCost
		dst["totalCostUSD"] = mergedCost
		dst["costUSD"] = mergedCost
	}
	dst["modelsUsed"] = mergeStringArrays(dst["modelsUsed"], src["modelsUsed"])
	dst["modelBreakdowns"] = mergeModelBreakdowns(dst["modelBreakdowns"], src["modelBreakdowns"])
}

func mergeStringArrays(a any, b any) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(raw any) {
		switch values := raw.(type) {
		case []string:
			for _, value := range values {
				value = strings.TrimSpace(value)
				if value != "" && !seen[value] {
					seen[value] = true
					out = append(out, value)
				}
			}
		case []any:
			for _, value := range values {
				text := strings.TrimSpace(fmt.Sprint(value))
				if text != "" && text != "<nil>" && !seen[text] {
					seen[text] = true
					out = append(out, text)
				}
			}
		}
	}
	add(a)
	add(b)
	return out
}

func mergeModelBreakdowns(a any, b any) []map[string]any {
	byModel := map[string]map[string]any{}
	order := []string{}
	add := func(raw any) {
		for _, item := range modelBreakdownList(raw) {
			model := modelBreakdownName(item)
			if model == "" {
				continue
			}
			existing, ok := byModel[model]
			if !ok {
				copied := cloneUsageEntry(item)
				byModel[model] = copied
				order = append(order, model)
				continue
			}
			for _, key := range []string{
				"inputTokens",
				"outputTokens",
				"cacheCreationTokens",
				"cacheReadTokens",
				"cachedInputTokens",
				"totalTokens",
			} {
				existing[key] = numberValue(existing[key]) + numberValue(item[key])
			}
			mergedCost := usageCostValue(existing) + usageCostValue(item)
			if mergedCost > 0 {
				existing["cost"] = mergedCost
				existing["costUSD"] = mergedCost
				existing["totalCost"] = mergedCost
				existing["totalCostUSD"] = mergedCost
			}
		}
	}
	add(a)
	add(b)

	sort.Strings(order)
	out := make([]map[string]any, 0, len(order))
	for _, model := range order {
		out = append(out, byModel[model])
	}
	return out
}

func modelBreakdownList(raw any) []map[string]any {
	switch values := raw.(type) {
	case []map[string]any:
		return values
	case []any:
		out := []map[string]any{}
		for _, item := range values {
			if entry, ok := item.(map[string]any); ok {
				out = append(out, entry)
			}
		}
		return out
	default:
		return nil
	}
}

func modelBreakdownName(entry map[string]any) string {
	for _, key := range []string{"modelName", "model", "name"} {
		value := strings.TrimSpace(fmt.Sprint(entry[key]))
		if value != "" && value != "<nil>" {
			return value
		}
	}
	return ""
}

func usageDate(entry map[string]any) string {
	for _, key := range []string{"date", "period", "week", "month"} {
		if raw, ok := entry[key]; ok {
			value := strings.TrimSpace(fmt.Sprint(raw))
			if value != "" && value != "<nil>" {
				if len(value) >= 10 {
					return value[:10]
				}
				return value
			}
		}
	}
	return ""
}

func numberValue(raw any) float64 {
	switch value := raw.(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case json.Number:
		parsed, _ := value.Float64()
		return parsed
	default:
		return 0
	}
}

func usageCostValue(entry map[string]any) float64 {
	for _, key := range []string{"totalCost", "totalCostUSD", "costUSD", "cost_usd", "cost"} {
		if value := numberValue(entry[key]); value != 0 {
			return value
		}
	}
	return 0
}

type antigravityTranscriptLine struct {
	Source    string `json:"source"`
	Type      string `json:"type"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	Content   string `json:"content"`
	Thinking  string `json:"thinking"`
}

type antigravityDailyUsage struct {
	InputChars      int
	OutputChars     int
	TranscriptFiles int
	Steps           int
}

func loadAntigravityUsageEntries() ([]map[string]any, error) {
	root, err := antigravityBrainPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	model := antigravityModelName()
	byDate := map[string]*antigravityDailyUsage{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() || filepath.Base(path) != "transcript.jsonl" {
			return nil
		}
		if filepath.Base(filepath.Dir(path)) != "logs" {
			return nil
		}
		return readAntigravityTranscript(path, byDate)
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
		inputTokens := estimateTokensFromChars(usage.InputChars)
		outputTokens := estimateTokensFromChars(usage.OutputChars)
		totalTokens := inputTokens + outputTokens
		if totalTokens == 0 {
			continue
		}
		modelBreakdown := map[string]any{
			"modelName":               model,
			"inputTokens":             float64(inputTokens),
			"outputTokens":            float64(outputTokens),
			"cacheCreationTokens":     0.0,
			"cacheReadTokens":         0.0,
			"totalTokens":             float64(totalTokens),
			"cost":                    0.0,
			"estimated":               true,
			"estimator":               "antigravity-transcript-chars-v1",
			"transcriptFiles":         usage.TranscriptFiles,
			"steps":                   usage.Steps,
			"inputTranscriptChars":    usage.InputChars,
			"outputTranscriptChars":   usage.OutputChars,
			"estimatedCharsPerToken":  4,
			"estimationConservatism":  "lower-bound",
			"estimationSource":        "local-antigravity-transcript",
			"estimationGeneratedBy":   "ccrank",
			"estimationGeneratedFrom": "~/.gemini/antigravity-cli/brain",
		}
		entries = append(entries, map[string]any{
			"date":                     date,
			"inputTokens":              float64(inputTokens),
			"outputTokens":             float64(outputTokens),
			"cacheCreationTokens":      0.0,
			"cacheReadTokens":          0.0,
			"totalInputTokens":         float64(inputTokens),
			"totalOutputTokens":        float64(outputTokens),
			"totalCacheCreationTokens": 0.0,
			"totalCacheReadTokens":     0.0,
			"totalTokens":              float64(totalTokens),
			"totalCost":                0.0,
			"totalCostUSD":             0.0,
			"costUSD":                  0.0,
			"modelsUsed":               []string{model},
			"modelBreakdowns":          []map[string]any{modelBreakdown},
			"estimated":                true,
			"source":                   "antigravity-local-transcript",
		})
	}
	return entries, nil
}

func readAntigravityTranscript(path string, byDate map[string]*antigravityDailyUsage) error {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()

	seenDates := map[string]bool{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry antigravityTranscriptLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		date := antigravityDate(entry.CreatedAt)
		if date == "" || strings.EqualFold(entry.Status, "RUNNING") {
			continue
		}
		usage := byDate[date]
		if usage == nil {
			usage = &antigravityDailyUsage{}
			byDate[date] = usage
		}
		if !seenDates[date] {
			usage.TranscriptFiles += 1
			seenDates[date] = true
		}
		chars := len([]rune(entry.Content)) + len([]rune(entry.Thinking))
		if isAntigravityModelOutput(entry) {
			usage.OutputChars += chars
		} else {
			usage.InputChars += chars
		}
		usage.Steps += 1
	}
	return scanner.Err()
}

func isAntigravityModelOutput(entry antigravityTranscriptLine) bool {
	return strings.EqualFold(entry.Source, "MODEL") && strings.EqualFold(entry.Type, "PLANNER_RESPONSE")
}

func antigravityDate(createdAt string) string {
	createdAt = strings.TrimSpace(createdAt)
	if createdAt == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		if len(createdAt) >= 10 {
			return createdAt[:10]
		}
		return ""
	}
	return parsed.In(time.Local).Format("2006-01-02")
}

func estimateTokensFromChars(chars int) int {
	if chars <= 0 {
		return 0
	}
	return (chars + 3) / 4
}

func antigravityBrainPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".gemini", "antigravity-cli", "brain"), nil
}

func antigravityModelName() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "gemini-antigravity-estimate"
	}
	data, err := os.ReadFile(filepath.Join(home, ".gemini", "antigravity-cli", "settings.json"))
	if err != nil {
		return "gemini-antigravity-estimate"
	}
	var settings struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return "gemini-antigravity-estimate"
	}
	model := slugify(settings.Model)
	if model == "" || model == "repo" {
		return "gemini-antigravity-estimate"
	}
	if !strings.Contains(model, "gemini") {
		model = "gemini-" + model
	}
	return model + "-antigravity-estimate"
}

func cloneUsageEntry(entry map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range entry {
		out[key] = value
	}
	return out
}

func usageTotals(entries []map[string]any) map[string]any {
	totals := map[string]any{
		"inputTokens":              0.0,
		"outputTokens":             0.0,
		"cacheCreationTokens":      0.0,
		"cacheReadTokens":          0.0,
		"totalInputTokens":         0.0,
		"totalOutputTokens":        0.0,
		"totalCacheCreationTokens": 0.0,
		"totalCacheReadTokens":     0.0,
		"totalTokens":              0.0,
		"totalCost":                0.0,
		"totalCostUSD":             0.0,
	}

	for _, entry := range entries {
		input := numberValue(entry["inputTokens"])
		output := numberValue(entry["outputTokens"])
		cacheCreation := numberValue(entry["cacheCreationTokens"])
		cacheRead := numberValue(entry["cacheReadTokens"])
		if cacheRead == 0 {
			cacheRead = numberValue(entry["cachedInputTokens"])
		}
		tokens := numberValue(entry["totalTokens"])
		cost := numberValue(entry["totalCost"])
		if cost == 0 {
			cost = numberValue(entry["totalCostUSD"])
		}
		if cost == 0 {
			cost = numberValue(entry["costUSD"])
		}

		totals["inputTokens"] = numberValue(totals["inputTokens"]) + input
		totals["outputTokens"] = numberValue(totals["outputTokens"]) + output
		totals["cacheCreationTokens"] = numberValue(totals["cacheCreationTokens"]) + cacheCreation
		totals["cacheReadTokens"] = numberValue(totals["cacheReadTokens"]) + cacheRead
		totals["totalInputTokens"] = numberValue(totals["totalInputTokens"]) + input
		totals["totalOutputTokens"] = numberValue(totals["totalOutputTokens"]) + output
		totals["totalCacheCreationTokens"] = numberValue(totals["totalCacheCreationTokens"]) + cacheCreation
		totals["totalCacheReadTokens"] = numberValue(totals["totalCacheReadTokens"]) + cacheRead
		totals["totalTokens"] = numberValue(totals["totalTokens"]) + tokens
		totals["totalCost"] = numberValue(totals["totalCost"]) + cost
		totals["totalCostUSD"] = numberValue(totals["totalCostUSD"]) + cost
	}

	return totals
}

func loadUsageMaxima() (map[string]map[string]any, error) {
	path, err := usageMaximaPath()
	if err != nil {
		return nil, err
	}

	maxima := map[string]map[string]any{}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return maxima, nil
		}
		return nil, err
	}

	var report map[string]any
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, errors.New("invalid ~/.ccrank/usage-maxima-combined.json")
	}

	rawEntries, _ := report["daily"].([]any)
	for _, item := range rawEntries {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		date := usageDate(entry)
		if date == "" {
			continue
		}
		entry["date"] = date
		maxima[date] = entry
	}
	return maxima, nil
}

func writeUsageMaxima(maxima map[string]map[string]any) error {
	path, err := usageMaximaPath()
	if err != nil {
		return err
	}

	dates := make([]string, 0, len(maxima))
	for date := range maxima {
		dates = append(dates, date)
	}
	sort.Strings(dates)

	entries := make([]map[string]any, 0, len(dates))
	for _, date := range dates {
		entries = append(entries, maxima[date])
	}

	report := map[string]any{
		"daily":  entries,
		"totals": usageTotals(entries),
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(path, out, 0o600)
}

func usageMaximaPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ccrank", "usage-maxima-combined.json"), nil
}

func printCcusageHelp() {
	fmt.Fprintln(os.Stderr, "To enable usage uploads:")
	fmt.Fprintln(os.Stderr, "  1) Install mise: https://mise.jdx.dev")
	fmt.Fprintln(os.Stderr, "  2) From a repo folder, run:")
	fmt.Fprintln(os.Stderr, "     Combined: npx ccusage@latest daily --json")
}

func uploadCcusage(baseURL, token, report, machine, platform string) error {
	baseURL = strings.TrimRight(baseURL, "/")
	endpoint := baseURL + "/api/upload"

	source := strings.TrimSpace(machine)
	if source == "" {
		source = "default"
	}
	payload := map[string]any{
		"json":     report,
		"source":   source,
		"platform": platform,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 90 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	respBody, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s", strings.TrimSpace(string(respBody)))
	}

	return nil
}

type Summary struct {
	Scanned    int      `json:"scanned"`
	GitRepos   int      `json:"git_repos"`
	Uploaded   int      `json:"uploaded"`
	Skipped    int      `json:"skipped"`
	Errors     []string `json:"errors"`
	Duplicates int      `json:"duplicates"`
}

func buildPayload(repoPaths []string, descriptionOverride string, machine string) (Payload, Summary, error) {
	summary := Summary{Errors: []string{}}
	seen := map[string]bool{}
	projects := []Project{}

	for _, repoPath := range repoPaths {
		summary.Scanned += 1
		repoPath = strings.TrimSpace(repoPath)
		if repoPath == "" {
			summary.Skipped += 1
			continue
		}

		if !isGitRepo(repoPath) {
			summary.Skipped += 1
			continue
		}

		identity := repoPath
		if remote := gitRemoteURL(repoPath); remote != "" {
			identity = remote
		}
		if seen[identity] {
			summary.Duplicates += 1
			continue
		}
		seen[identity] = true

		repoName := filepath.Base(repoPath)
		repoSlug := slugify(repoName)
		description := strings.TrimSpace(descriptionOverride)
		if description == "" {
			description = readReadmeTitle(repoPath)
		}
		if description == "" {
			description = repoName
		}

		days, err := getCommitCounts(repoPath)
		if err != nil {
			summary.Errors = append(summary.Errors, fmt.Sprintf("%s: %s", repoPath, err.Error()))
			summary.Skipped += 1
			continue
		}

		projects = append(projects, Project{
			RepoName:            repoName,
			RepoSlug:            repoSlug,
			Description:         description,
			DescriptionOverride: descriptionOverride != "",
			Days:                days,
		})
		summary.GitRepos += 1
	}

	payload := Payload{
		Machine:  strings.TrimSpace(machine),
		Projects: projects,
	}

	summary.Uploaded = len(projects)
	if len(projects) == 0 {
		return payload, summary, errors.New("no valid git repos found to upload")
	}
	return payload, summary, nil
}

func printSummary(summary Summary, asJSON bool) {
	if asJSON {
		out, _ := json.MarshalIndent(summary, "", "  ")
		fmt.Println(string(out))
		return
	}

	fmt.Printf("Summary: scanned=%d git_repos=%d uploaded=%d skipped=%d duplicates=%d\n",
		summary.Scanned, summary.GitRepos, summary.Uploaded, summary.Skipped, summary.Duplicates)
	if len(summary.Errors) > 0 {
		fmt.Println("Errors:")
		for _, err := range summary.Errors {
			fmt.Printf("- %s\n", err)
		}
	}
}

func loadOrCreateConfig() (Config, bool, error) {
	cfgPath, err := ccrankConfigPath()
	if err != nil {
		return Config{}, false, err
	}

	data, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			cfg := Config{Repos: []string{}}
			if err := writeConfig(cfgPath, cfg); err != nil {
				return Config{}, false, err
			}
			return cfg, true, nil
		}
		return Config{}, false, err
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, false, errors.New("Invalid ~/.ccrank/repos.json. Please back it up and delete it so it can be recreated.")
	}

	cfg.Repos = normalizeRepos(cfg.Repos)
	return cfg, false, nil
}

func addRepoFromWd() error {
	cfg, _, err := loadOrCreateConfig()
	if err != nil {
		return err
	}
	wd := mustWd()

	if repoRoot, ok := gitRepoRoot(wd); ok {
		cfg.Repos = mergeRepos(cfg.Repos, []string{repoRoot})
		if err := writeConfigAtHome(cfg); err != nil {
			return err
		}
		fmt.Println("Added repo root to ~/.ccrank/repos.json")
		return nil
	}

	repos := scanForRepos(wd)
	if len(repos) == 0 {
		return errors.New("no git repos found in this folder")
	}
	if len(repos) > 30 {
		fmt.Fprintln(os.Stderr, "Note: ccrank currently supports up to 30 repos. Adding the 30 most recently active repos.")
		repos = repos[:30]
	}
	cfg.Repos = mergeRepos(cfg.Repos, repos)
	if err := writeConfigAtHome(cfg); err != nil {
		return err
	}
	fmt.Println("Added repos to ~/.ccrank/repos.json")
	return nil
}

func mergeRepos(existing []string, incoming []string) []string {
	seen := map[string]bool{}
	merged := []string{}
	for _, repo := range append(existing, incoming...) {
		repo = normalizePath(repo)
		if repo == "" || seen[repo] {
			continue
		}
		seen[repo] = true
		merged = append(merged, repo)
	}
	return merged
}

func writeConfigAtHome(cfg Config) error {
	cfgPath, err := ccrankConfigPath()
	if err != nil {
		return err
	}
	return writeConfig(cfgPath, cfg)
}

func writeConfig(path string, cfg Config) error {
	cfg.Repos = normalizeRepos(cfg.Repos)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	return os.WriteFile(path, out, 0o644)
}

func ccrankConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".ccrank", "repos.json"), nil
}

func expandHome(path string) string {
	if path == "" {
		return path
	}
	if strings.HasPrefix(path, "~"+string(os.PathSeparator)) || path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			if path == "~" {
				return home
			}
			return filepath.Join(home, strings.TrimPrefix(path, "~"+string(os.PathSeparator)))
		}
	}
	return path
}

func normalizeRepos(repos []string) []string {
	out := []string{}
	for _, repo := range repos {
		repo = strings.TrimSpace(repo)
		if repo == "" {
			continue
		}
		out = append(out, normalizePath(repo))
	}
	return out
}

func normalizePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	path = expandHome(path)
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return filepath.Clean(path)
}

func gitRepoRoot(path string) (string, bool) {
	cmd := exec.Command("git", "-C", path, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return "", false
	}
	return normalizePath(root), true
}

func scanForRepos(root string) []string {
	candidates := findGitRepos(root)
	type rankedRepo struct {
		path  string
		score int64
	}
	ranked := []rankedRepo{}
	for _, repo := range candidates {
		if score, ok := lastCommitUnix(repo); ok {
			ranked = append(ranked, rankedRepo{path: normalizePath(repo), score: score})
		}
	}
	sort.Slice(ranked, func(i, j int) bool {
		return ranked[i].score > ranked[j].score
	})
	out := []string{}
	for _, entry := range ranked {
		out = append(out, entry.path)
	}
	return out
}

func lastCommitUnix(repoPath string) (int64, bool) {
	cmd := exec.Command("git", "-C", repoPath, "log", "-1", "--format=%ct")
	out, err := cmd.Output()
	if err != nil {
		return 0, false
	}
	raw := strings.TrimSpace(string(out))
	if raw == "" {
		return 0, false
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func findGitRepos(root string) []string {
	repos := []string{}
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			cfg := filepath.Join(path, "config")
			if info, err := os.Stat(cfg); err == nil && !info.IsDir() {
				repoRoot := filepath.Dir(path)
				repos = append(repos, repoRoot)
			}
			return filepath.SkipDir
		}
		return nil
	})
	return repos
}

func isGitRepo(repoPath string) bool {
	cmd := exec.Command("git", "-C", repoPath, "rev-parse", "--is-inside-work-tree")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(out)) == "true"
}

func gitRemoteURL(repoPath string) string {
	cmd := exec.Command("git", "-C", repoPath, "config", "--get", "remote.origin.url")
	out, err := cmd.Output()
	if err == nil {
		url := strings.TrimSpace(string(out))
		if url != "" {
			return url
		}
	}

	remotesCmd := exec.Command("git", "-C", repoPath, "remote")
	remotesOut, err := remotesCmd.Output()
	if err != nil {
		return ""
	}
	remotes := strings.Split(strings.TrimSpace(string(remotesOut)), "\n")
	if len(remotes) == 0 || remotes[0] == "" {
		return ""
	}
	name := remotes[0]
	cmd = exec.Command("git", "-C", repoPath, "config", "--get", "remote."+name+".url")
	out, err = cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func printOnboardingMessage() {
	fmt.Println("Welcome to ccrank — track your Claude Code & Codex CLI usage.")
	fmt.Println("We created ~/.ccrank/repos.json to store the repos you want to upload.")
	fmt.Println("")
	fmt.Println("To add a single repo, run this inside a project folder:")
	fmt.Println("  ccrank-git --add-repo")
	fmt.Println("")
	fmt.Println("To add many repos at once, run this in a folder like ~/code:")
	fmt.Println("  ccrank-git --add-repo")
	fmt.Println("It will scan recursively and add the 30 most recently active repos.")
	fmt.Println("")
	fmt.Println("Git metadata uploads by default. Use --upload-usage to include Claude Code and Codex CLI usage data.")
}
