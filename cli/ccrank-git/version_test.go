package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func withTestVersion(t *testing.T, value string) {
	t.Helper()
	original := version
	version = value
	t.Cleanup(func() { version = original })
}

func TestCLIVersionDevFallback(t *testing.T) {
	// Default test binary is unstamped: an explicit dev fallback, never "".
	withTestVersion(t, "dev")
	if got := cliVersion(); got != "dev" {
		t.Fatalf("cliVersion() = %q, want dev", got)
	}
}

func TestCLIVersionNormalizesBlankToDev(t *testing.T) {
	for _, blank := range []string{"", "   "} {
		withTestVersion(t, blank)
		if got := cliVersion(); got != "dev" {
			t.Fatalf("cliVersion() with version %q = %q, want dev", blank, got)
		}
	}
}

func TestCLIVersionKeepsStampedTag(t *testing.T) {
	withTestVersion(t, "v9.9.9")
	if got := cliVersion(); got != "v9.9.9" {
		t.Fatalf("cliVersion() = %q, want v9.9.9", got)
	}
	withTestVersion(t, "  v9.9.9  ")
	if got := cliVersion(); got != "v9.9.9" {
		t.Fatalf("cliVersion() = %q, want trimmed v9.9.9", got)
	}
}

func TestPrintVersionIdentifiesBinary(t *testing.T) {
	withTestVersion(t, "v9.9.9")
	var buf bytes.Buffer
	printVersion(&buf)
	out := buf.String()
	for _, want := range []string{"ccrank-git", "v9.9.9"} {
		if !strings.Contains(out, want) {
			t.Fatalf("version output %q is missing %q", out, want)
		}
	}
}

func TestNewPayloadStampsCLIVersion(t *testing.T) {
	withTestVersion(t, "v9.9.9")
	payload := newPayload(" rig ")
	if payload.Machine != "rig" {
		t.Fatalf("machine = %q, want trimmed rig", payload.Machine)
	}
	if payload.CliVersion != "v9.9.9" {
		t.Fatalf("cli_version = %q, want v9.9.9", payload.CliVersion)
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["cli_version"] != "v9.9.9" {
		t.Fatalf("encoded cli_version = %v", decoded["cli_version"])
	}
}

func TestBuildPayloadStampsCLIVersion(t *testing.T) {
	withTestVersion(t, "v9.9.9")
	// A bogus path errors but still returns the stamped payload shell.
	payload, _, err := buildPayload([]string{"/does/not/exist"}, "", "rig")
	if err == nil {
		t.Fatal("expected an error for a non-repo path")
	}
	if payload.CliVersion != "v9.9.9" {
		t.Fatalf("cli_version = %q, want v9.9.9", payload.CliVersion)
	}
}

func TestUploadCcusageIncludesCLIVersion(t *testing.T) {
	withTestVersion(t, "v9.9.9")
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)

	if err := uploadCcusage(server.URL, "test-token", `{"daily":[]}`, "rig", "kimi"); err != nil {
		t.Fatal(err)
	}
	if payload["cli_version"] != "v9.9.9" {
		t.Fatalf("cli_version = %#v, want v9.9.9", payload["cli_version"])
	}
	if payload["platform"] != "kimi" || payload["source"] != "rig" {
		t.Fatalf("payload lost existing keys: %#v", payload)
	}
	if _, ok := payload["replace"]; ok {
		t.Fatal("must not send replace")
	}
}
