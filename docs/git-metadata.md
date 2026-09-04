# Git Metadata Upload

This adds a personal, opt-in git activity layer to your profile.

## Generate an API token

1. Go to **Settings** → **Git Metadata**.
2. Click **Generate Token** and copy it (you will not see it again).

## Upload git metadata

Use the Go CLI (binary). It supports config-based repo discovery and can also upload local coding-agent usage.

Download the latest release:

- macOS arm64: `ccrank-git_darwin_arm64`
- Linux x64: `ccrank-git_linux_amd64`
- Windows x64: `ccrank-git_windows_amd64.exe`

Run:

```bash
./ccrank-git_darwin_arm64 --url https://your-worker.workers.dev --token YOUR_TOKEN
```

Usage upload is opt-in. Node.js is needed for the `ccusage` sources, but the native Kimi, Grok, and GLM imports do not require it:

```bash
./ccrank-git_darwin_arm64 --url https://your-worker.workers.dev --token YOUR_TOKEN --upload-usage
```

The usage upload combines `ccusage` output with local agent logs `ccusage` does not read, and uploads each agent under its own platform:

| Platform | Source |
| :-- | :-- |
| `claude` | `ccusage`, minus its `pi` and `kimi` agents |
| `pi` | `~/.pi/agent/sessions` |
| `kimi` | `~/.kimi/sessions`, `~/.kimi-code/sessions`, and Kimi models run through Pi |
| `grok` | `~/.grok/sessions` and Grok models run through Pi |
| `glm` | `~/.zcode/cli/rollout` (or `~/.zcode/rollout`) and GLM models run through Pi |
| `opencode` | `~/.local/share/opencode/opencode.db` (or `$XDG_DATA_HOME/opencode/opencode.db`), read read-only |
| `cursor` | Signed-in Cursor account (IDE Agent + CLI billed usage). Tab autocomplete is not counted. Uploaded under the fixed source `cursor-cloud` so two machines do not double-count |

`ccusage` imports Pi and Kimi natively, so ccrank holds those agents out of the combined `claude` bucket to keep them from being counted twice.

Before uploading, the CLI asks `GET /api/platforms` which platforms the leaderboard accepts and skips any it does not list. A leaderboard that predates a platform would otherwise reject the name, refile the rows as `claude` from their model names, and let the replacing upload overwrite your real combined totals — so deploy the Worker before rolling out the CLI. A model Pi merely fronts is credited to the vendor that owns it, so a Kimi, Grok, or GLM model run through Pi lands on that platform rather than on Pi. Duplicate records are counted once: Kimi sessions copied during the `.kimi` to `.kimi-code` migration, Grok turns replayed by a rewind, and retried Z Code requests. Cursor usage is read from the Cursor dashboard using the local desktop login; the Cursor session token is never sent to ccrank. If Node is missing, install `mise` and verify:

```bash
npx ccusage@latest daily --json --by-agent
```

Config-based repo discovery:

When the CLI runs and `~/.ccrank/repos.json` is missing, it creates the file and prints onboarding instructions (no upload happens until you add repos).

```bash
./ccrank-git_darwin_arm64 --url https://your-worker.workers.dev --token YOUR_TOKEN
```

Populate `~/.ccrank/repos.json` by adding repos from within each project:

```bash
./ccrank-git_darwin_arm64 --add-repo
```

If you run `--add-repo` outside a repo (e.g., a folder like `~/code`), the tool will scan recursively and add the 30 most recently active repos.

### Legacy Node script (optional)

From any git repo you want to track:

```bash
npm run git:upload -- --url https://your-worker.workers.dev --token YOUR_TOKEN
```

Add machine name:

```bash
npm run git:upload -- --url https://your-worker.workers.dev --token YOUR_TOKEN --all --machine laptop
```

Run with ccusage upload too (Node script only):

```bash
npm run git:upload -- --url https://your-worker.workers.dev --token YOUR_TOKEN --all
```

Single repo path:

```bash
./ccrank-git_darwin_arm64 --url https://your-worker.workers.dev --token YOUR_TOKEN --repo /path/to/repo
```

Machine name (defaults to hostname; can be changed on later uploads):

```bash
./ccrank-git_darwin_arm64 --url https://your-worker.workers.dev --token YOUR_TOKEN --machine laptop
```

JSON summary output:

```bash
./ccrank-git_darwin_arm64 --url https://your-worker.workers.dev --token YOUR_TOKEN --json
```

Build from source (optional):

```bash
cd cli/ccrank-git
go build -o ccrank-git .
```

Optional:

- `--description "My project"` to override the README title
- `--dry-run` to print the JSON payload without uploading

## What gets uploaded

Git metadata:

- Repo name and description
- Last 28 days of commit counts (daily)

Usage data with `--upload-usage`:

- Daily token and cost totals from `ccusage`
- Daily token and cost totals from Pi session usage in `~/.pi/agent/sessions`
- Daily Kimi Code token totals from `~/.kimi/sessions` and `~/.kimi-code/sessions` (native cost is recorded as unknown/zero)
- Daily Grok token totals from `~/.grok/sessions` (Grok bills through a weekly credit plan, so native cost is recorded as zero)
- Daily GLM token totals from `~/.zcode/cli/rollout` (Z Code logs carry no pricing, so cost is recorded as zero)
- Kimi, Grok, and GLM models run through Pi, added to those platforms and carrying the cost Pi recorded for them
- Model breakdowns where available

No raw commit messages, diffs, prompts, responses, or agent transcript content are uploaded.
