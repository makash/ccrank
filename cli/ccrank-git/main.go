package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net/http"
	"net/url"
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

type UsageSnapshot struct {
	Date         string
	DisplayName  string
	Rank         int
	TotalCost    float64
	TotalTokens  float64
	OutputTokens float64
	CostText     string
	TokensText   string
	SourceURL    string
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
		if shouldShowOnboarding(created, len(cfg.Repos), *uploadUsage, *dryRun) {
			printOnboardingMessage()
			return
		}
		repos = cfg.Repos
	}

	payload := Payload{Machine: machine}
	summary := Summary{Errors: []string{}}
	if len(repos) > 0 {
		var err error
		payload, summary, err = buildPayload(repos, *descFlag, machine)
		if err != nil {
			fmt.Fprintln(os.Stderr, err.Error())
			os.Exit(1)
		}
	}

	if *dryRun || *urlFlag == "" || *tokenFlag == "" {
		out, _ := json.MarshalIndent(payload, "", "  ")
		fmt.Println(string(out))
		if !*dryRun {
			fmt.Fprintln(os.Stderr, "Missing --url or --token. Use --dry-run to inspect payload.")
		}
		return
	}

	if len(payload.Projects) > 0 {
		err := uploadPayload(*urlFlag, *tokenFlag, payload)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Upload failed:", err.Error())
			os.Exit(1)
		}
		fmt.Println("Upload complete")
	} else {
		fmt.Println("Git metadata upload skipped (no repos configured)")
	}

	if *skipUsage || *noUsage || !*uploadUsage {
		fmt.Println("Usage upload skipped (use --upload-usage to enable)")
		printSummary(summary, *jsonSummary)
		return
	}

	// Upload combined coding-agent usage from ccusage (Claude Code + Codex + Hermes + other agents).
	// ccrank production currently treats this as the legacy Claude bucket, so keep
	// the payload combined to avoid replacing old all-agent rows with narrower data.
	fmt.Println("Checking combined Claude Code + Codex + Hermes + Antigravity usage...")
	pending, localToday, err := runCcusage()
	usageErr := err
	if err != nil {
		fmt.Fprintln(os.Stderr, "  Combined usage: skipped -", err.Error())
	} else {
		// Combined rows are max-merged server-side (never-lower). Do not send
		// a replace flag — the LDP CLI never had one, and a replace=true
		// upload destroyed ~27B tokens of historical peaks on 2026-08-15.
		err = uploadUsageReport(*urlFlag, *tokenFlag, pending, machine, platformCombined, "combined")
		if err != nil {
			fmt.Fprintln(os.Stderr, "  Combined usage: upload failed -", err.Error())
			usageErr = err
		} else {
			fmt.Println("  Combined usage: upload complete")
		}
	}

	fmt.Println("  Codex CLI: included in combined usage upload")
	fmt.Println("  Gemini Antigravity: included from local transcripts when present")

	if usageErr != nil && shouldPrintCcusageHelp(usageErr) {
		printCcusageHelp()
	}

	supported := resolveSupportedPlatforms(*urlFlag, *tokenFlag)

	// Kimi Code exposes exact token counts in its native wire logs. Keep native
	// and Pi-hosted Kimi usage in a separate platform so zero-cost usage is
	// preserved instead of being folded into the legacy combined bucket.
	kimiToday := uploadDedicatedPlatform(dedicatedPlatformUpload{
		BaseURL: *urlFlag, Token: *tokenFlag, Machine: machine,
		Platform: platformKimi, Label: "Kimi Code",
		Checking:  "Checking Kimi usage from native Kimi Code and Pi sessions...",
		Supported: supported, Run: runKimiUsage,
	})

	// Grok CLI records per-turn token counts and a list-price cost in its
	// session updates; ccusage has no Grok importer.
	grokToday := uploadDedicatedPlatform(dedicatedPlatformUpload{
		BaseURL: *urlFlag, Token: *tokenFlag, Machine: machine,
		Platform: platformGrok, Label: "Grok CLI",
		Checking:  "Checking Grok usage from native Grok CLI and Pi sessions...",
		Supported: supported, Run: runGrokUsage,
	})

	// Z Code logs exact GLM token counts per request but carries no pricing;
	// ccusage has no GLM importer either.
	glmToday := uploadDedicatedPlatform(dedicatedPlatformUpload{
		BaseURL: *urlFlag, Token: *tokenFlag, Machine: machine,
		Platform: platformGLM, Label: "GLM (Z Code)",
		Checking:  "Checking GLM usage from native Z Code and Pi sessions...",
		Supported: supported, Run: runGLMUsage,
	})

	// OpenCode records every assistant reply in a local SQLite database with
	// its own token counts and cost; ccusage has no OpenCode importer.
	opencodeToday := uploadDedicatedPlatform(dedicatedPlatformUpload{
		BaseURL: *urlFlag, Token: *tokenFlag, Machine: machine,
		Platform: platformOpenCode, Label: "OpenCode",
		Checking:  "Checking OpenCode usage from its local session database...",
		Supported: supported, Run: runOpenCodeUsage,
	})

	// Pi rides its own platform now. ccusage imports Pi natively, so the
	// combined bucket holds it out and everything Pi ran that is not owned by
	// a dedicated platform is uploaded here instead.
	piToday := uploadDedicatedPlatform(dedicatedPlatformUpload{
		BaseURL: *urlFlag, Token: *tokenFlag, Machine: machine,
		Platform: platformPi, Label: "Pi",
		Checking:  "Checking Pi agent usage from Pi sessions...",
		Supported: supported, Run: runPiUsage,
	})

	localToday = combineUsageSnapshots(localToday, kimiToday)
	localToday = combineUsageSnapshots(localToday, grokToday)
	localToday = combineUsageSnapshots(localToday, glmToday)
	localToday = combineUsageSnapshots(localToday, opencodeToday)
	localToday = combineUsageSnapshots(localToday, piToday)
	if localToday != nil {
		if err := printDailyUsageComparison(*urlFlag, *tokenFlag, *localToday); err != nil {
			fmt.Fprintln(os.Stderr, "  Daily leaderboard check: skipped -", err.Error())
		}
	}

	printSummary(summary, *jsonSummary)
}

// legacyPlatforms are the buckets every deployment has understood since before
// /api/platforms existed. A leaderboard without the probe still accepts these,
// so they remain safe to upload when we cannot ask what it supports.
var legacyPlatforms = map[string]bool{
	platformCombined: true,
	"codex":          true,
	platformKimi:     true,
}

// resolveSupportedPlatforms asks the leaderboard what it accepts, falling back
// to the pre-probe set. Falling back is the conservative answer: it keeps the
// long-standing platforms uploading while holding back the newer ones, which an
// older server would misfile into the combined bucket.
func resolveSupportedPlatforms(baseURL, token string) map[string]bool {
	supported, err := loadSupportedPlatforms(baseURL, token)
	if err != nil {
		fmt.Fprintln(os.Stderr, "  Platform check: skipped -", err.Error())
		return legacyPlatforms
	}
	if supported == nil {
		fmt.Fprintln(os.Stderr, "  Platform check: this leaderboard predates per-agent platforms; update your deployment to rank Grok, GLM, and Pi separately")
		return legacyPlatforms
	}
	return supported
}

type dedicatedPlatformUpload struct {
	BaseURL   string
	Token     string
	Machine   string
	Platform  string
	Label     string
	Checking  string
	Supported map[string]bool
	Run       func() (*pendingUsageUpload, *UsageSnapshot, error)
}

// uploadDedicatedPlatform imports and uploads one platform ccusage does not
// cover, but only after the leaderboard has confirmed it knows the name. It
// returns the day's snapshot when something was uploaded, so the caller can fold
// it into the daily comparison.
func uploadDedicatedPlatform(job dedicatedPlatformUpload) *UsageSnapshot {
	if !job.Supported[job.Platform] {
		fmt.Fprintf(os.Stderr, "  %s: skipped - this leaderboard does not accept the %q platform yet\n", job.Label, job.Platform)
		return nil
	}

	fmt.Println(job.Checking)
	pending, today, err := job.Run()
	if err != nil {
		fmt.Fprintln(os.Stderr, "  "+job.Label+": skipped -", err.Error())
		return nil
	}
	if err := uploadUsageReport(job.BaseURL, job.Token, pending, job.Machine, job.Platform, job.Platform); err != nil {
		fmt.Fprintln(os.Stderr, "  "+job.Label+": upload failed -", err.Error())
		return nil
	}
	fmt.Println("  " + job.Label + ": upload complete")
	return today
}

func shouldShowOnboarding(created bool, repoCount int, uploadUsage bool, dryRun bool) bool {
	return (created || repoCount == 0) && !uploadUsage && !dryRun
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

func runCcusage() (*pendingUsageUpload, *UsageSnapshot, error) {
	// --by-agent splits each daily row per source CLI so agents ccrank uploads
	// under their own platform can be held out of the combined bucket.
	cmd := exec.Command("npx", "ccusage@latest", "daily", "--json", "--by-agent")
	out, err := cmd.Output()
	if err != nil {
		report := map[string]any{"daily": []map[string]any{}}
		entries := loadLocalUsageEntries(nil, report)
		if len(entries) == 0 {
			return nil, nil, errors.New("no combined usage data found (is Node installed?)")
		}
		localToday := usageSnapshotForDate(entries, time.Now().Format("2006-01-02"))
		pending, err := prepareUsageUpload(report, entries, "combined", "no higher combined usage rows found")
		if err != nil {
			return nil, localToday, err
		}
		return pending, localToday, nil
	}
	report, entries, err := parseCcusageReportWithLocalExtras(out)
	if err != nil {
		return nil, nil, err
	}
	localToday := usageSnapshotForDate(entries, time.Now().Format("2006-01-02"))
	pending, err := prepareUsageUpload(report, entries, "combined", "no higher combined usage rows found")
	if err != nil {
		return nil, localToday, err
	}
	return pending, localToday, nil
}

func parseCcusageReportWithLocalExtras(out []byte) (map[string]any, []map[string]any, error) {
	report, entries, err := parseCcusageReport(out)
	if err != nil {
		report = map[string]any{"daily": []map[string]any{}}
		entries = nil
	} else {
		entries, err = rebuildCombinedEntries(entries)
		if err != nil {
			return nil, nil, err
		}
		setReportEntries(report, entries)
	}

	entries = loadLocalUsageEntries(entries, report)
	if len(entries) == 0 && err != nil {
		return nil, nil, err
	}
	return report, entries, nil
}

// loadLocalUsageEntries folds in agents ccusage cannot see. Pi is deliberately
// absent: ccusage imports it natively now, and ccrank uploads it under its own
// platform, so merging it here would count every Pi session twice.
func loadLocalUsageEntries(entries []map[string]any, report map[string]any) []map[string]any {
	antigravityEntries, err := loadAntigravityUsageEntries()
	if err != nil {
		// Tolerate unreadable transcripts: they are skipped with a warning
		// rather than failing the run. The combined upload always max-merges
		// server-side, so a partial local view can never lower a row.
		fmt.Fprintln(os.Stderr, "  Gemini Antigravity: skipped -", err.Error())
	} else if len(antigravityEntries) > 0 {
		entries = mergeUsageEntries(entries, antigravityEntries)
		setReportEntries(report, entries)
	}
	return entries
}

// ccusage imports Pi and Kimi natively, and ccrank uploads both under their own
// platform. Holding them out of the combined bucket keeps usage a dedicated
// importer already reports from being counted twice.
var ccusageDedicatedAgents = map[string]bool{
	"pi":       true,
	"kimi":     true,
	"opencode": true,
	"grok":     true,
	"glm":      true,
}

// dedicatedPlatformNames lists every platform ccrank ranks on its own. If
// ccusage ever ships a native importer for one of these, its per-agent slices
// would double-count unless the agent joins ccusageDedicatedAgents.
var dedicatedPlatformNames = []string{platformPi, platformKimi, platformGrok, platformGLM, "opencode"}

// unheldDedicatedAgent reports which dedicated platform an agent name looks
// like when that agent is not held out of the combined bucket. An empty result
// means the name is safe to fold into combined rows.
func unheldDedicatedAgent(agent string) string {
	name := strings.ToLower(strings.TrimSpace(agent))
	if ccusageDedicatedAgents[name] {
		return ""
	}
	for _, platform := range dedicatedPlatformNames {
		if strings.HasPrefix(name, platform) {
			return platform
		}
	}
	return ""
}

// rebuildCombinedEntries drops the per-agent slices ccrank uploads separately.
// Since every ccusage invocation requests --by-agent, accepting a row without
// those slices could permanently double-count usage from dedicated platforms.
// A date whose usage came entirely from those agents collapses to a zero row
// rather than disappearing, so an inflated row written by an earlier ccrank
// version is overwritten instead of left ranked.
func rebuildCombinedEntries(entries []map[string]any) ([]map[string]any, error) {
	rebuilt := make([]map[string]any, 0, len(entries))
	for index, entry := range entries {
		agents, ok := entry["agents"].([]any)
		if !ok {
			date := usageDate(entry)
			if date == "" {
				date = fmt.Sprintf("index %d", index)
			}
			return nil, fmt.Errorf("ccusage --by-agent row %s is missing a usable agents[] array", date)
		}
		date := usageDate(entry)
		if date == "" {
			continue
		}

		var input, output, cacheCreation, cacheRead, total, cost float64
		modelNames := []string{}
		modelBreakdowns := []any{}
		for _, raw := range agents {
			agent, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			name := strings.ToLower(strings.TrimSpace(fmt.Sprint(agent["agent"])))
			if ccusageDedicatedAgents[name] {
				continue
			}
			if owner := unheldDedicatedAgent(name); owner != "" {
				// ccusage grew a native importer for a platform ccrank uploads
				// separately. Folding the slice in here would double-count it on
				// every combined row, so fail loudly instead.
				return nil, fmt.Errorf("ccusage --by-agent row %s reports agent %q from the dedicated %q platform; add it to ccusageDedicatedAgents or upgrade ccrank so its usage is not double-counted", date, name, owner)
			}
			input += numberValue(agent["inputTokens"])
			output += numberValue(agent["outputTokens"])
			cacheCreation += numberValue(agent["cacheCreationTokens"])
			cacheRead += numberValue(agent["cacheReadTokens"])
			total += numberValue(agent["totalTokens"])
			cost += usageCostValue(agent)
			for _, model := range extractModelNames(agent["modelsUsed"]) {
				modelNames = append(modelNames, model)
			}
			if breakdowns, ok := agent["modelBreakdowns"].([]any); ok {
				modelBreakdowns = append(modelBreakdowns, breakdowns...)
			}
		}
		sort.Strings(modelNames)

		rebuilt = append(rebuilt, map[string]any{
			"date":                     date,
			"inputTokens":              input,
			"outputTokens":             output,
			"cacheCreationTokens":      cacheCreation,
			"cacheReadTokens":          cacheRead,
			"totalInputTokens":         input,
			"totalOutputTokens":        output,
			"totalCacheCreationTokens": cacheCreation,
			"totalCacheReadTokens":     cacheRead,
			"totalTokens":              total,
			"totalCost":                cost,
			"totalCostUSD":             cost,
			"costUSD":                  cost,
			"modelsUsed":               modelNames,
			"modelBreakdowns":          mergeModelBreakdowns(nil, modelBreakdowns),
		})
	}
	return rebuilt, nil
}

func extractModelNames(raw any) []string {
	values, ok := raw.([]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(values))
	for _, value := range values {
		name := strings.TrimSpace(fmt.Sprint(value))
		if name != "" && name != "<nil>" {
			names = append(names, name)
		}
	}
	return names
}

// pendingUsageUpload pairs a serialized usage report with the commit that
// records its rows in the monotonic maxima cache. Commit MUST run only after
// the upload is confirmed (HTTP 2xx): the server max-merges and silently
// discards rows that are not higher, so a cache written before confirmation
// would mark unapplied rows as uploaded and they would never be re-offered.
type pendingUsageUpload struct {
	Report string
	Commit func() error
}

// prepareUsageUpload filters entries down to the rows that beat the cached
// maxima and serializes them for upload. Nothing touches disk here; the
// returned commit persists the advanced maxima and the caller owes it an
// upload-first ordering (beads z0m: writing before uploading let rows the
// server never applied vanish from every future run).
func prepareUsageUpload(report map[string]any, entries []map[string]any, cacheName, unchangedMessage string) (*pendingUsageUpload, error) {
	maxima, err := loadUsageMaxima(cacheName)
	if err != nil {
		return nil, err
	}

	changed := []map[string]any{}
	for _, entry := range entries {
		date := usageDate(entry)
		if date == "" {
			continue
		}
		entry["date"] = date

		cached, found := maxima[date]
		if !found || isHigherUsageSnapshot(entry, cached) {
			snapshot := cloneUsageEntry(entry)
			maxima[date] = snapshot
			changed = append(changed, snapshot)
		}
	}

	if len(changed) == 0 {
		return nil, errors.New(unchangedMessage)
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
		return nil, err
	}
	return &pendingUsageUpload{
		Report: string(normalized),
		Commit: func() error { return writeUsageMaxima(cacheName, maxima) },
	}, nil
}

func usageSnapshotForDate(entries []map[string]any, date string) *UsageSnapshot {
	date = strings.TrimSpace(date)
	if date == "" {
		return nil
	}

	var snapshot *UsageSnapshot
	for _, entry := range entries {
		if usageDate(entry) != date {
			continue
		}
		if snapshot == nil {
			snapshot = &UsageSnapshot{Date: date}
		}
		snapshot.TotalCost += usageCostValue(entry)
		snapshot.TotalTokens += numberValue(entry["totalTokens"])
		snapshot.OutputTokens += numberValue(entry["outputTokens"])
	}
	return snapshot
}

func combineUsageSnapshots(first, second *UsageSnapshot) *UsageSnapshot {
	if first == nil {
		return second
	}
	if second == nil {
		return first
	}
	if first.Date != second.Date {
		return first
	}
	return &UsageSnapshot{
		Date:         first.Date,
		TotalCost:    first.TotalCost + second.TotalCost,
		TotalTokens:  first.TotalTokens + second.TotalTokens,
		OutputTokens: first.OutputTokens + second.OutputTokens,
	}
}

func isHigherUsageSnapshot(current, cached map[string]any) bool {
	return numberValue(current["totalTokens"]) > numberValue(cached["totalTokens"]) ||
		usageCostValue(current) > usageCostValue(cached)
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

type piSessionLine struct {
	Type      string     `json:"type"`
	Timestamp any        `json:"timestamp"`
	Provider  string     `json:"provider"`
	ModelID   string     `json:"modelId"`
	Message   *piMessage `json:"message"`
}

type piMessage struct {
	Timestamp any      `json:"timestamp"`
	Usage     *piUsage `json:"usage"`
}

type piUsage struct {
	Input       float64     `json:"input"`
	Output      float64     `json:"output"`
	CacheRead   float64     `json:"cacheRead"`
	CacheWrite  float64     `json:"cacheWrite"`
	TotalTokens float64     `json:"totalTokens"`
	Cost        piUsageCost `json:"cost"`
}

type piUsageCost struct {
	Total float64 `json:"total"`
}

type piDailyUsage struct {
	Input        float64
	Output       float64
	CacheWrite   float64
	CacheRead    float64
	TotalTokens  float64
	Cost         float64
	Messages     int
	Excluded     bool
	SessionFiles map[string]bool
	Models       map[string]*piModelUsage
}

type piModelUsage struct {
	Input       float64
	Output      float64
	CacheWrite  float64
	CacheRead   float64
	TotalTokens float64
	Cost        float64
}

// Platform buckets ccrank uploads under. Agents without a dedicated importer
// stay in the legacy combined bucket, which production still reads as "claude".
const (
	platformCombined = "claude"
	platformPi       = "pi"
	platformKimi     = "kimi"
	platformGrok     = "grok"
	platformGLM      = "glm"
	platformOpenCode = "opencode"
)

func loadPiKimiUsageEntries() ([]map[string]any, error) {
	return loadPiUsageEntriesFor(platformKimi)
}

func runPiUsage() (*pendingUsageUpload, *UsageSnapshot, error) {
	entries, err := loadPiUsageEntriesFor(platformPi)
	if err != nil {
		return nil, nil, err
	}
	if len(entries) == 0 {
		return nil, nil, errors.New("no Pi usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	pending, err := prepareUsageUpload(report, entries, platformPi, "no higher Pi usage rows found")
	return pending, localToday, err
}

func loadPiUsageEntriesFor(platform string) ([]map[string]any, error) {
	root, err := piSessionsPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	byDate := map[string]*piDailyUsage{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Pi can lock live session files; skip what we cannot read instead
			// of failing every platform imported from the shared session tree.
			if os.IsPermission(err) {
				return nil
			}
			return err
		}
		if d.IsDir() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		return readPiSession(path, byDate, platform)
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
		if usage.TotalTokens == 0 && !(usage.Excluded && platform == platformPi) {
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
				"cacheCreationTokens": modelUsage.CacheWrite,
				"cacheReadTokens":     modelUsage.CacheRead,
				"totalTokens":         modelUsage.TotalTokens,
				"cost":                modelUsage.Cost,
				"source":              "pi-session-jsonl",
			})
		}

		entries = append(entries, map[string]any{
			"date":                     date,
			"inputTokens":              usage.Input,
			"outputTokens":             usage.Output,
			"cacheCreationTokens":      usage.CacheWrite,
			"cacheReadTokens":          usage.CacheRead,
			"totalInputTokens":         usage.Input,
			"totalOutputTokens":        usage.Output,
			"totalCacheCreationTokens": usage.CacheWrite,
			"totalCacheReadTokens":     usage.CacheRead,
			"totalTokens":              usage.TotalTokens,
			"totalCost":                usage.Cost,
			"totalCostUSD":             usage.Cost,
			"costUSD":                  usage.Cost,
			"modelsUsed":               modelNames,
			"modelBreakdowns":          modelBreakdowns,
			"messages":                 usage.Messages,
			"sessionFiles":             len(usage.SessionFiles),
			"source":                   "pi-session-jsonl",
		})
	}
	return entries, nil
}

func readPiSession(path string, byDate map[string]*piDailyUsage, platform string) error {
	file, err := os.Open(path)
	if err != nil {
		if os.IsPermission(err) {
			return nil
		}
		return err
	}
	defer file.Close()

	modelName := "pi-unknown"
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry piSessionLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}

		if entry.Type == "model_change" {
			modelName = piModelName(entry.Provider, entry.ModelID)
			continue
		}
		if entry.Type != "message" || entry.Message == nil || entry.Message.Usage == nil {
			continue
		}

		date := piUsageDate(entry.Timestamp)
		if date == "" {
			date = piUsageDate(entry.Message.Timestamp)
		}
		if date == "" {
			continue
		}
		if piPlatformForModel(modelName) != platform {
			// Preserve a zero row when a model moves out of the Pi bucket into
			// a dedicated platform. That lets the upload overwrite a stale Pi
			// row instead of leaving it ranked twice.
			if platform == platformPi {
				day := byDate[date]
				if day == nil {
					day = &piDailyUsage{SessionFiles: map[string]bool{}, Models: map[string]*piModelUsage{}}
					byDate[date] = day
				}
				day.Excluded = true
			}
			continue
		}

		usage := entry.Message.Usage
		inputTokens := usage.Input
		outputTokens := usage.Output
		cacheWriteTokens := usage.CacheWrite
		cacheReadTokens := usage.CacheRead
		totalTokens := usage.TotalTokens
		if totalTokens == 0 {
			totalTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens
		}
		if totalTokens == 0 {
			continue
		}

		day := byDate[date]
		if day == nil {
			day = &piDailyUsage{SessionFiles: map[string]bool{}, Models: map[string]*piModelUsage{}}
			byDate[date] = day
		}
		day.Input += inputTokens
		day.Output += outputTokens
		day.CacheWrite += cacheWriteTokens
		day.CacheRead += cacheReadTokens
		day.TotalTokens += totalTokens
		day.Cost += usage.Cost.Total
		day.Messages += 1
		day.SessionFiles[path] = true

		modelUsage := day.Models[modelName]
		if modelUsage == nil {
			modelUsage = &piModelUsage{}
			day.Models[modelName] = modelUsage
		}
		modelUsage.Input += inputTokens
		modelUsage.Output += outputTokens
		modelUsage.CacheWrite += cacheWriteTokens
		modelUsage.CacheRead += cacheReadTokens
		modelUsage.TotalTokens += totalTokens
		modelUsage.Cost += usage.Cost.Total
	}
	return scanner.Err()
}

func piSessionsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".pi", "agent", "sessions"), nil
}

func piModelName(provider, modelID string) string {
	parts := []string{"pi"}
	provider = slugify(provider)
	modelID = slugify(modelID)
	if provider != "" && provider != "repo" {
		parts = append(parts, provider)
	}
	if modelID != "" && modelID != "repo" {
		parts = append(parts, modelID)
	}
	if len(parts) == 1 {
		return "pi-unknown"
	}
	return strings.Join(parts, "-")
}

func isKimiModelName(modelName string) bool {
	lower := strings.ToLower(modelName)
	return strings.Contains(lower, "kimi") || strings.Contains(lower, "moonshot")
}

// piPlatformForModel routes a Pi session model to the platform that owns it. Pi
// fronts models from several vendors, and every vendor ccrank imports natively
// is ranked under its own platform rather than under Pi.
func piPlatformForModel(modelName string) string {
	lower := strings.ToLower(modelName)
	switch {
	case isKimiModelName(modelName):
		return platformKimi
	case strings.Contains(lower, "grok"), strings.Contains(lower, "xai"):
		return platformGrok
	case strings.Contains(lower, "glm"), strings.Contains(lower, "zai"), strings.Contains(lower, "z-ai"):
		return platformGLM
	}
	return platformPi
}

func piUsageDate(raw any) string {
	switch value := raw.(type) {
	case string:
		value = strings.TrimSpace(value)
		if value == "" {
			return ""
		}
		if parsed, err := time.Parse(time.RFC3339, value); err == nil {
			return parsed.In(time.Local).Format("2006-01-02")
		}
		if len(value) >= 10 {
			return value[:10]
		}
	case float64:
		if value > 0 {
			return time.Unix(0, int64(value)*int64(time.Millisecond)).In(time.Local).Format("2006-01-02")
		}
	case int64:
		if value > 0 {
			return time.Unix(0, value*int64(time.Millisecond)).In(time.Local).Format("2006-01-02")
		}
	case int:
		if value > 0 {
			return time.Unix(0, int64(value)*int64(time.Millisecond)).In(time.Local).Format("2006-01-02")
		}
	}
	return ""
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
			// An unreadable transcript must not mark the combined report
			// incomplete: that downgrades the upload to a max merge, which
			// would silently discard the corrected, smaller rows this version
			// uploads after splitting agents into their own platforms.
			if os.IsPermission(err) {
				return nil
			}
			return err
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
		if os.IsPermission(err) {
			return nil
		}
		return err
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

// usageMaximaVersion gates the monotonic upload cache. Bump it whenever a
// change makes correct rows smaller than ones already uploaded. Zeroing Grok's
// phantom list-price cost did not warrant a bump: resets only matter when
// combined rows shrink, and the server max-merges every upload, so a downward
// correction is impossible regardless — the smaller grok rows simply lose the
// merge until their tokens genuinely grow again.
const usageMaximaVersion = 3

func loadUsageMaxima(cacheName string) (map[string]map[string]any, error) {
	path, err := usageMaximaPath(cacheName)
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
		return nil, fmt.Errorf("invalid ~/.ccrank/usage-maxima-%s.json", cacheName)
	}
	if cacheName == "combined" && numberValue(report["version"]) != usageMaximaVersion {
		// Version 2 split Kimi out of the legacy combined platform; version 3
		// splits out Pi, which ccusage began importing natively and ccrank was
		// merging on top of. Both shrink the combined bucket, so treat older
		// maxima as empty once and let the lower corrected rows overwrite it.
		return maxima, nil
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

func writeUsageMaxima(cacheName string, maxima map[string]map[string]any) error {
	path, err := usageMaximaPath(cacheName)
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
		"version": usageMaximaVersion,
		"daily":   entries,
		"totals":  usageTotals(entries),
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

func usageMaximaPath(cacheName string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch cacheName {
	case "combined", platformKimi, platformGrok, platformGLM, platformPi, platformOpenCode:
	default:
		return "", errors.New("invalid usage maxima cache name")
	}
	return filepath.Join(home, ".ccrank", "usage-maxima-"+cacheName+".json"), nil
}

func printCcusageHelp() {
	fmt.Fprintln(os.Stderr, "To enable usage uploads:")
	fmt.Fprintln(os.Stderr, "  1) Install mise: https://mise.jdx.dev")
	fmt.Fprintln(os.Stderr, "  2) From a repo folder, run:")
	fmt.Fprintln(os.Stderr, "     Combined all agents: npx ccusage@latest daily --json --by-agent")
	fmt.Fprintln(os.Stderr, "  Pi usage is imported automatically from ~/.pi/agent/sessions when present.")
	fmt.Fprintln(os.Stderr, "  Kimi Code usage is imported automatically from ~/.kimi/sessions and ~/.kimi-code/sessions.")
	fmt.Fprintln(os.Stderr, "  Grok CLI usage is imported automatically from ~/.grok/sessions.")
	fmt.Fprintln(os.Stderr, "  GLM usage is imported automatically from ~/.zcode/cli/rollout.")
	fmt.Fprintln(os.Stderr, "  OpenCode usage is imported automatically from ~/.local/share/opencode/opencode.db.")
}

// loadSupportedPlatforms asks the leaderboard which platforms it understands.
//
// A deployment that predates a platform drops the CLI's explicit platform as
// invalid and re-detects the rows from their model names, which lands them in
// the combined bucket. The server max-merges, so that would pollute the
// combined row up to the Grok-only figure (bounded, never a sum) and
// misattribute usage. Uploading a dedicated platform is therefore only safe
// once the server has confirmed it knows the name.
//
// Returns nil when the endpoint is absent, which means the server is older than
// this capability probe and no dedicated platform may be uploaded.
func loadSupportedPlatforms(baseURL, token string) (map[string]bool, error) {
	baseURL = strings.TrimRight(baseURL, "/")
	req, err := http.NewRequest("GET", baseURL+"/api/platforms", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("%s", strings.TrimSpace(string(body)))
	}

	var payload struct {
		Platforms []string `json:"platforms"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, errors.New("leaderboard returned an invalid platform list")
	}
	if len(payload.Platforms) == 0 {
		return nil, nil
	}

	supported := make(map[string]bool, len(payload.Platforms))
	for _, platform := range payload.Platforms {
		supported[strings.ToLower(strings.TrimSpace(platform))] = true
	}
	return supported, nil
}

func uploadCcusage(baseURL, token, report, machine, platform string) error {
	baseURL = strings.TrimRight(baseURL, "/")
	endpoint := baseURL + "/api/upload"

	source := strings.TrimSpace(machine)
	if source == "" {
		source = "default"
	}
	// Never send a replace field. The server always max-merges. The LDP CLI
	// never had this field; reintroducing it is how 2026-08-15 destroyed
	// historical peaks. See test/never-lower.test.mjs.
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

// uploadUsageReport posts a prepared usage report and settles the monotonic
// maxima cache accordingly: the cache advances only once the upload is
// confirmed (HTTP 2xx), and any failure clears it so the offered rows come
// back on the next run instead of being marked as uploaded forever.
func uploadUsageReport(baseURL, token string, pending *pendingUsageUpload, machine, platform, cacheName string) error {
	if err := uploadCcusage(baseURL, token, pending.Report, machine, platform); err != nil {
		if resetErr := resetUsageMaxima(cacheName); resetErr != nil {
			return fmt.Errorf("%w (could not reset retry cache: %v)", err, resetErr)
		}
		return err
	}
	if err := pending.Commit(); err != nil {
		// The rows are on the server; re-offering them next run is harmless
		// because the server max-merges.
		return fmt.Errorf("uploaded, but could not record the retry cache: %w", err)
	}
	return nil
}

// resetUsageMaxima deletes a platform's maxima cache so rows prepared for a
// failed upload are re-offered next run. A missing cache is already reset.
func resetUsageMaxima(cacheName string) error {
	path, pathErr := usageMaximaPath(cacheName)
	if pathErr != nil {
		return pathErr
	}
	if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
		return removeErr
	}
	return nil
}

func printDailyUsageComparison(baseURL, token string, local UsageSnapshot) error {
	if strings.TrimSpace(baseURL) == "" {
		return errors.New("missing leaderboard URL")
	}
	if strings.TrimSpace(local.Date) == "" {
		return errors.New("local usage snapshot has no date")
	}

	remote, err := fetchAuthenticatedDailyUsage(baseURL, token, local.Date)
	if err != nil {
		remote, err = fetchPublicDailyLeaderboardUsage(baseURL, local)
		if err != nil {
			return err
		}
	}

	status := "different"
	if usageSnapshotsDisplayEqual(local, *remote) {
		status = "same"
	}

	remoteLabel := "leaderboard"
	if remote.DisplayName != "" {
		remoteLabel = "leaderboard " + remote.DisplayName
	}
	fmt.Printf("  Daily leaderboard check: %s for %s\n", status, local.Date)
	fmt.Printf("    Local: %s tokens / %s\n", snapshotTokensText(local), snapshotCostText(local))
	fmt.Printf("    %s: %s tokens / %s\n", remoteLabel, snapshotTokensText(*remote), snapshotCostText(*remote))
	if status != "same" && remote.SourceURL != "" {
		fmt.Printf("    URL: %s\n", remote.SourceURL)
	}
	return nil
}

func fetchAuthenticatedDailyUsage(baseURL, token, date string) (*UsageSnapshot, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, errors.New("missing API token")
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/api/me/usage?view=daily&date=" + url.QueryEscape(date)
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("authenticated stats unavailable: %s", strings.TrimSpace(string(body)))
	}

	var parsed struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		User  struct {
			DisplayName string `json:"display_name"`
		} `json:"user"`
		Stats struct {
			Date              string  `json:"date"`
			TotalCost         float64 `json:"total_cost"`
			TotalTokens       float64 `json:"total_tokens"`
			TotalOutputTokens float64 `json:"total_output_tokens"`
			Rank              int     `json:"rank"`
		} `json:"stats"`
		LeaderboardURL string `json:"leaderboard_url"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !parsed.OK {
		if parsed.Error == "" {
			parsed.Error = "unknown response"
		}
		return nil, errors.New(parsed.Error)
	}

	if parsed.Stats.Date == "" {
		parsed.Stats.Date = date
	}
	return &UsageSnapshot{
		Date:         parsed.Stats.Date,
		DisplayName:  strings.TrimSpace(parsed.User.DisplayName),
		Rank:         parsed.Stats.Rank,
		TotalCost:    parsed.Stats.TotalCost,
		TotalTokens:  parsed.Stats.TotalTokens,
		OutputTokens: parsed.Stats.TotalOutputTokens,
		SourceURL:    parsed.LeaderboardURL,
	}, nil
}

func fetchPublicDailyLeaderboardUsage(baseURL string, local UsageSnapshot) (*UsageSnapshot, error) {
	rows, sourceURL, err := fetchPublicDailyLeaderboardRows(baseURL, local.Date)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("no rows found at %s", sourceURL)
	}

	localCost := snapshotCostText(local)
	localTokens := snapshotTokensText(local)
	for i := range rows {
		if snapshotCostText(rows[i]) == localCost && snapshotTokensText(rows[i]) == localTokens {
			return &rows[i], nil
		}
	}

	if len(rows) == 1 {
		return &rows[0], nil
	}
	return nil, fmt.Errorf("could not identify your row in %s", sourceURL)
}

func fetchPublicDailyLeaderboardRows(baseURL, date string) ([]UsageSnapshot, string, error) {
	sourceURL := dailyLeaderboardURL(baseURL, date)
	req, err := http.NewRequest("GET", sourceURL, nil)
	if err != nil {
		return nil, sourceURL, err
	}

	client := &http.Client{Timeout: 20 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, sourceURL, err
	}
	defer res.Body.Close()

	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, sourceURL, fmt.Errorf("leaderboard returned HTTP %d", res.StatusCode)
	}

	return parsePublicDailyLeaderboardRows(string(body), date, sourceURL), sourceURL, nil
}

func dailyLeaderboardURL(baseURL, date string) string {
	values := url.Values{}
	values.Set("sort", "tokens")
	values.Set("view", "daily")
	if strings.TrimSpace(date) != "" {
		values.Set("date", date)
	}
	return strings.TrimRight(baseURL, "/") + "/leaderboard?" + values.Encode()
}

func parsePublicDailyLeaderboardRows(body, date, sourceURL string) []UsageSnapshot {
	rowRe := regexp.MustCompile(`(?is)<tr\b[^>]*>.*?</tr>`)
	cellRe := regexp.MustCompile(`(?is)<td\b[^>]*>(.*?)</td>`)
	rows := []UsageSnapshot{}

	for _, row := range rowRe.FindAllString(body, -1) {
		cells := cellRe.FindAllStringSubmatch(row, -1)
		if len(cells) < 4 {
			continue
		}

		tokensText := cleanHTMLText(cells[2][1])
		costText := cleanHTMLText(cells[3][1])
		cost, costErr := parseUsageCostText(costText)
		tokens, tokensErr := parseUsageTokensText(tokensText)
		if costErr != nil || tokensErr != nil {
			continue
		}

		rows = append(rows, UsageSnapshot{
			Date:        date,
			DisplayName: publicLeaderboardDisplayName(cells[1][1]),
			Rank:        firstInt(cleanHTMLText(cells[0][1])),
			TotalCost:   cost,
			TotalTokens: tokens,
			CostText:    costText,
			TokensText:  tokensText,
			SourceURL:   sourceURL,
		})
	}
	return rows
}

func publicLeaderboardDisplayName(cellHTML string) string {
	linkRe := regexp.MustCompile(`(?is)<a\b[^>]*>(.*?)</a>`)
	if match := linkRe.FindStringSubmatch(cellHTML); len(match) == 2 {
		return cleanHTMLText(match[1])
	}
	return cleanHTMLText(cellHTML)
}

func cleanHTMLText(raw string) string {
	tagRe := regexp.MustCompile(`(?is)<[^>]+>`)
	text := tagRe.ReplaceAllString(raw, " ")
	text = html.UnescapeString(text)
	return strings.Join(strings.Fields(text), " ")
}

func firstInt(text string) int {
	match := regexp.MustCompile(`\d+`).FindString(text)
	if match == "" {
		return 0
	}
	value, _ := strconv.Atoi(match)
	return value
}

func parseUsageCostText(text string) (float64, error) {
	cleaned := strings.ReplaceAll(text, ",", "")
	cleaned = strings.TrimSpace(strings.TrimPrefix(cleaned, "$"))
	return strconv.ParseFloat(cleaned, 64)
}

func parseUsageTokensText(text string) (float64, error) {
	cleaned := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(text), ",", ""))
	if cleaned == "" {
		return 0, errors.New("empty token value")
	}

	multiplier := 1.0
	suffix := cleaned[len(cleaned)-1:]
	switch suffix {
	case "B":
		multiplier = 1_000_000_000
		cleaned = strings.TrimSpace(strings.TrimSuffix(cleaned, "B"))
	case "M":
		multiplier = 1_000_000
		cleaned = strings.TrimSpace(strings.TrimSuffix(cleaned, "M"))
	case "K":
		multiplier = 1_000
		cleaned = strings.TrimSpace(strings.TrimSuffix(cleaned, "K"))
	}

	value, err := strconv.ParseFloat(cleaned, 64)
	if err != nil {
		return 0, err
	}
	return value * multiplier, nil
}

func usageSnapshotsDisplayEqual(local, remote UsageSnapshot) bool {
	return snapshotCostText(local) == snapshotCostText(remote) &&
		snapshotTokensText(local) == snapshotTokensText(remote)
}

func snapshotCostText(snapshot UsageSnapshot) string {
	if strings.TrimSpace(snapshot.CostText) != "" {
		return strings.TrimSpace(snapshot.CostText)
	}
	return formatUsageCost(snapshot.TotalCost)
}

func snapshotTokensText(snapshot UsageSnapshot) string {
	if strings.TrimSpace(snapshot.TokensText) != "" {
		return strings.TrimSpace(snapshot.TokensText)
	}
	return formatUsageTokens(snapshot.TotalTokens)
}

func formatUsageCost(cost float64) string {
	return fmt.Sprintf("$%.2f", cost)
}

func formatUsageTokens(tokens float64) string {
	switch {
	case tokens >= 1_000_000_000:
		return fmt.Sprintf("%.1fB", tokens/1_000_000_000)
	case tokens >= 1_000_000:
		return fmt.Sprintf("%.1fM", tokens/1_000_000)
	case tokens >= 1_000:
		return fmt.Sprintf("%.1fK", tokens/1_000)
	default:
		return fmt.Sprintf("%.0f", tokens)
	}
}

func shouldPrintCcusageHelp(err error) bool {
	if err == nil {
		return false
	}
	return !strings.Contains(err.Error(), "no higher combined usage rows found")
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
	fmt.Println("Welcome to ccrank — track your Claude Code, Codex CLI & Kimi Code usage.")
	fmt.Println("We created ~/.ccrank/repos.json to store the repos you want to upload.")
	fmt.Println("")
	fmt.Println("To add a single repo, run this inside a project folder:")
	fmt.Println("  ccrank-git --add-repo")
	fmt.Println("")
	fmt.Println("To add many repos at once, run this in a folder like ~/code:")
	fmt.Println("  ccrank-git --add-repo")
	fmt.Println("It will scan recursively and add the 30 most recently active repos.")
	fmt.Println("")
	fmt.Println("Git metadata uploads by default. Use --upload-usage to include Claude Code, Codex, Kimi, Pi, Hermes, and other supported usage.")
}
