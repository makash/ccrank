package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Muse Code (Meta's terminal coding agent) records one JSON record per line in
// session.jsonl files under $XDG_DATA_HOME/muse/sessions (default
// ~/.local/share/muse/sessions), laid out as sessions/YYYY/MM/DD/<session-id>/
// with subagent transcripts nested under subagent/. Some lines are
// retained_frame envelopes whose children carry the records as embedded JSON
// strings. Every model call lands as a runtime.session/model_completed event
// carrying the token counters and the model that served it. Contributor-plan
// logs carry no pricing, so cost stays zero like the Kimi/Grok/GLM importers.
type museSessionChild struct {
	RecordJSON string `json:"record_json"`
}

type museSessionLine struct {
	Children    []museSessionChild `json:"children"`
	PayloadType string             `json:"payload_type"`
	RecordID    string             `json:"id"`
	RecordedAt  any                `json:"recorded_at"`
	Payload     *musePayload       `json:"payload"`
}

type musePayload struct {
	Kind  string     `json:"kind"`
	Event *museEvent `json:"event"`
}

type museEvent struct {
	Kind  string     `json:"kind"`
	Model string     `json:"model"`
	Usage *museUsage `json:"usage"`
}

type museUsage struct {
	Input      float64 `json:"input_tokens"`
	Output     float64 `json:"output_tokens"`
	Cached     float64 `json:"cached_tokens"`
	CacheWrite float64 `json:"cache_write_tokens"`
	CacheRead  float64 `json:"cache_read_tokens"`
	Reasoning  float64 `json:"reasoning_tokens"`
}

// markerModelCompleted pre-filters session lines before JSON parsing. Only
// model_completed events (direct, or wrapped in a retained_frame envelope's
// record_json strings) can count, so a line carrying the contiguous literal
// is always parsed. A countable kind can also hide without the literal via
// JSON \uXXXX escapes (directly, or doubly escaped inside a record_json
// envelope), so lines with an escape capable of hiding the marker fall back
// to full parsing — see museHasEscapeCandidate. Everything else
// (transcripts, tool output, bare frames — the bulk of a multi-GB store)
// skips the parse entirely.
var markerModelCompleted = []byte("model_completed")

var markerUnicodeEscape = []byte(`\u`)

// museLineMayCount reports whether a raw session line could decode to a
// countable event. Literal hits parse; escape candidates parse as a safe
// fallback since the kind may be escape-encoded; the rest skip.
func museLineMayCount(raw []byte) bool {
	if bytes.Contains(raw, markerModelCompleted) {
		return true
	}
	return museHasEscapeCandidate(raw)
}

// museHasEscapeCandidate scans raw for a \uXXXX escape capable of hiding the
// marker. A countable kind decodes to "model_completed"; without the literal,
// at least one of its letters/underscore must come from a \u escape (no other
// JSON escape yields those characters), so direct records leave a marker-char
// escape behind. Inside a record_json envelope the same holds one level down,
// where each character of the inner \uXXXX may itself arrive via an outer
// escape — hence escapes decoding to nested \u syntax (backslash, u, hex
// digits) are candidates too. Anything else cannot hide the marker: emoji,
// HTML and control escapes decode to unrelated characters, and \U is invalid
// JSON (encoding/json rejects it, so such lines fail validation either way).
func museHasEscapeCandidate(raw []byte) bool {
	for i := 0; i+1 < len(raw); {
		j := bytes.Index(raw[i:], markerUnicodeEscape)
		if j < 0 {
			return false
		}
		i += j
		if i+6 <= len(raw) {
			if cp, ok := museDecodeHex4(raw[i+2 : i+6]); ok && museEscapeCandidateDecodes(cp) {
				return true
			}
		}
		i += 2
	}
	return false
}

// museEscapeCandidateDecodes reports whether code point cp could participate
// in a literal-hidden model_completed: a marker letter/underscore, or a
// character that could form another \u escape after record_json unwrapping.
func museEscapeCandidateDecodes(cp uint16) bool {
	switch cp {
	case 'm', 'o', 'd', 'e', 'l', '_', 'c', 'p', 't', '\\', 'u':
		return true
	}
	return cp >= '0' && cp <= '9' ||
		cp >= 'A' && cp <= 'F' ||
		cp >= 'a' && cp <= 'f'
}

// museDecodeHex4 decodes 4 ASCII hex digits (either case, as encoding/json
// accepts) to a code point.
func museDecodeHex4(b []byte) (uint16, bool) {
	var cp uint16
	for _, c := range b {
		var v uint16
		switch {
		case c >= '0' && c <= '9':
			v = uint16(c - '0')
		case c >= 'a' && c <= 'f':
			v = uint16(c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			v = uint16(c - 'A' + 10)
		default:
			return 0, false
		}
		cp = cp*16 + v
	}
	return cp, true
}

type museDailyUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
	Messages      int
	SessionFiles  map[string]bool
	Models        map[string]*museModelUsage
}

type museModelUsage struct {
	Input         float64
	Output        float64
	CacheRead     float64
	CacheCreation float64
	TotalTokens   float64
}

func runMuseUsage() (*pendingUsageUpload, *UsageSnapshot, error) {
	entries, err := loadMuseUsageEntries()
	if err != nil {
		return nil, nil, err
	}
	if len(entries) == 0 {
		return nil, nil, errors.New("no Muse usage found")
	}
	localToday := usageSnapshotForDate(entries, todayDate())
	report := map[string]any{"type": "daily", "daily": entries}
	pending, err := prepareUsageUpload(report, entries, platformMuse, "no higher Muse usage rows found")
	return pending, localToday, err
}

func loadMuseUsageEntries() ([]map[string]any, error) {
	roots, err := museSessionsRoots()
	if err != nil {
		return nil, err
	}

	byDate := map[string]*museDailyUsage{}
	seenRecords := map[string]bool{}
	var seenFiles []os.FileInfo
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
			if d.IsDir() || filepath.Base(path) != "session.jsonl" {
				return nil
			}
			// Overlapping XDG/default roots or symlinks can surface the
			// same file under two lexical paths: read each inode once.
			info, statErr := os.Stat(path)
			if statErr != nil {
				if os.IsPermission(statErr) || os.IsNotExist(statErr) {
					return nil
				}
				return statErr
			}
			for _, seen := range seenFiles {
				if os.SameFile(seen, info) {
					return nil
				}
			}
			seenFiles = append(seenFiles, info)
			return readMuseSession(path, byDate, seenRecords)
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
				// Contributor-plan logs carry no pricing, and ccusage
				// reports 0 for models it has no rate for, so Muse stays
				// token-only.
				"cost":   0.0,
				"source": "muse-session-jsonl",
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
			"source":                   "muse-session-jsonl",
		})
	}
	return entries, nil
}

func readMuseSession(path string, byDate map[string]*museDailyUsage, seenRecords map[string]bool) error {
	file, err := os.Open(path)
	if err != nil {
		if os.IsPermission(err) {
			return nil
		}
		return err
	}
	defer file.Close()

	// ReadBytes rather than a Scanner: session lines are unbounded (a
	// single 54MB retained_frame line killed the old 32MB-capped Scanner
	// with "token too long" and skipped Muse entirely), the way the grok
	// importer already reads its update files.
	// A 1MB read buffer: the store is gigabytes of small lines, and the
	// 4KB default would pay a syscall per handful of lines.
	reader := bufio.NewReaderSize(file, 1024*1024)
	for {
		raw, readErr := reader.ReadBytes('\n')
		// The marker check runs on the raw bytes, before trimming and
		// parsing: most lines cannot count and never pay for either.
		// Matching lines still go through full validation below, so a
		// mere mention of the marker in some other payload can't count.
		// Lines with a marker-hiding escape candidate parse as a fallback:
		// the kind may be \u-encoded without the contiguous literal.
		if museLineMayCount(raw) {
			if line := bytes.TrimSpace(raw); len(line) != 0 {
				var outer museSessionLine
				if err := json.Unmarshal(line, &outer); err == nil {
					for _, record := range museSessionRecords(outer) {
						accumulateMuseRecord(path, record, byDate, seenRecords)
					}
				}
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				return nil
			}
			return readErr
		}
	}
}

// museSessionRecords unwraps a log line into its records. Most lines are
// records; retained_frame lines bundle several as embedded JSON strings.
// The outer line is always included too: envelope outers carry no payload
// and filter out downstream, while a qualifying outer is counted. Record-id
// dedup keeps this free of double-counting either way.
func museSessionRecords(outer museSessionLine) []museSessionLine {
	if len(outer.Children) == 0 {
		return []museSessionLine{outer}
	}
	records := make([]museSessionLine, 0, len(outer.Children)+1)
	records = append(records, outer)
	for _, child := range outer.Children {
		raw := strings.TrimSpace(child.RecordJSON)
		if raw == "" {
			continue
		}
		var record museSessionLine
		if err := json.Unmarshal([]byte(raw), &record); err != nil {
			continue
		}
		records = append(records, record)
	}
	return records
}

func accumulateMuseRecord(path string, record museSessionLine, byDate map[string]*museDailyUsage, seenRecords map[string]bool) {
	if record.PayloadType != "runtime.session" || record.Payload == nil || record.Payload.Event == nil {
		return
	}
	event := record.Payload.Event
	if event.Kind != "model_completed" || event.Usage == nil {
		return
	}

	date := museUsageDate(record.RecordedAt)
	if date == "" {
		return
	}
	modelName := strings.TrimSpace(event.Model)
	if modelName == "" {
		modelName = "muse-unknown"
	}
	usage := event.Usage
	// cached_tokens is the portion of input served from cache (never larger
	// than input_tokens in observed logs), so split it back out to keep the
	// four buckets summing to the total, as ccusage rows do. reasoning_tokens
	// is already included in output_tokens (reasoning never exceeds output
	// across the observed store, even for tiny outputs), so output stands
	// as-is; adding reasoning again would double-count it. cache_write_tokens
	// is subtracted from input on the same subset assumption, extended by
	// symmetry: it is zero in every observed event, so the convention is
	// unobservable and this is currently a no-op. If Muse ever reports
	// nonzero writes from outside input, revisit with real data; the clamp
	// below keeps buckets non-negative either way.
	cacheRead := usage.CacheRead
	if cacheRead == 0 {
		cacheRead = usage.Cached
	}
	cacheCreation := usage.CacheWrite
	input := usage.Input - cacheRead - cacheCreation
	if input < 0 {
		input = 0
	}
	output := usage.Output
	total := input + output + cacheRead + cacheCreation
	if total == 0 {
		return
	}

	// Records with stable ids dedup globally, so a re-read session file
	// or overlapping roots can never double-count a call. Records without
	// stable ids always count: token-only fingerprints collapse distinct
	// equal calls, so re-read protection for them lives in the loader's
	// same-file dedup instead.
	if id := strings.TrimSpace(record.RecordID); id != "" {
		if seenRecords[id] {
			return
		}
		seenRecords[id] = true
	}

	day := byDate[date]
	if day == nil {
		day = &museDailyUsage{SessionFiles: map[string]bool{}, Models: map[string]*museModelUsage{}}
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
		modelUsage = &museModelUsage{}
		day.Models[modelName] = modelUsage
	}
	modelUsage.Input += input
	modelUsage.Output += output
	modelUsage.CacheRead += cacheRead
	modelUsage.CacheCreation += cacheCreation
	modelUsage.TotalTokens += total
}

// museUsageDate converts a Muse recorded_at timestamp to a local YYYY-MM-DD
// date. Timestamps are microseconds since the epoch; RFC 3339 strings are
// accepted the way piUsageDate accepts them.
func museUsageDate(raw any) string {
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
			return time.Unix(0, int64(value)*int64(time.Microsecond)).In(time.Local).Format("2006-01-02")
		}
	case int64:
		if value > 0 {
			return time.Unix(0, value*int64(time.Microsecond)).In(time.Local).Format("2006-01-02")
		}
	case int:
		if value > 0 {
			return time.Unix(0, int64(value)*int64(time.Microsecond)).In(time.Local).Format("2006-01-02")
		}
	case json.Number:
		if micros, err := value.Int64(); err == nil && micros > 0 {
			return time.Unix(0, micros*int64(time.Microsecond)).In(time.Local).Format("2006-01-02")
		}
	}
	return ""
}

func museSessionsRoots() ([]string, error) {
	if dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dataHome != "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		return []string{
			filepath.Join(dataHome, "muse", "sessions"),
			filepath.Join(home, ".local", "share", "muse", "sessions"),
		}, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return []string{
		filepath.Join(home, ".local", "share", "muse", "sessions"),
	}, nil
}
