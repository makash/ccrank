# Handoff — ccrank multi-platform usage tracking

**PR:** https://github.com/makash/ccrank/pull/9
**Branch:** `feat/grok-glm-pi-platforms` → `main`
**Commit:** `9484522` (single squashed commit, 12 files, +1906/−126)
**Worktree:** `/Users/arbaz/Projects/tools/ccrank/.claude/worktrees/prancy-stargazing-sketch`
**Status:** Complete, reviewed, tested, PR open. Nothing is half-finished.

---

## 1. What this change does

ccrank tracks daily AI coding-agent token usage on a leaderboard, bucketed by "platform". Before this change there were three: `claude` (a combined bucket fed by `npx ccusage@latest daily --json`), `codex`, and `kimi`.

This change adds `grok`, `glm`, and `pi`, and fixes a pre-existing double-count bug.

### The bug it fixes

`ccusage` added native `pi` support. ccrank was *also* merging its own Pi reader into the same combined report, and `mergeUsageEntry` **sums** same-date fields — so every Pi session was counted twice in the `claude` bucket. Proven by running both readers over the same `~/.pi/agent/sessions`:

```
ccusage pi  2026-08-14  in=164379  out=107756  cr=5054464  cost=0.1203
ccrank pi   2026-08-14  in=164379  out=107756  cr=5054464  cost=0.1203   ← added on top
```

### Platform → source map

| Platform | Source | Cost treatment |
| :-- | :-- | :-- |
| `claude` | `ccusage`, minus its `pi` and `kimi` agents | From `ccusage` |
| `pi` | `~/.pi/agent/sessions` | From Pi's own records |
| `kimi` | `~/.kimi/sessions`, `~/.kimi-code/sessions`, + Kimi models via Pi | Zero native; Pi's records for Pi-fronted share |
| `grok` | `~/.grok/sessions` + Grok models via Pi | Grok's reported list price |
| `glm` | `~/.zcode/cli/rollout` (or `~/.zcode/rollout`) + GLM models via Pi | Zero (Z Code logs carry no pricing) |

A model Pi merely fronts is credited to the vendor that owns it — `piPlatformForModel` routes kimi → grok → glm, else `pi`.

---

## 2. File map

### New (Go, `cli/ccrank-git/`)
- **`grok_usage.go`** — parses `~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/updates.jsonl`. Relevant lines are JSON-RPC events where `params.update.sessionUpdate == "turn_completed"`. Usage at `params.update.usage`, per-model breakdown under `.modelUsage`. Deduped on `params._meta.eventId`.
- **`glm_usage.go`** — parses `~/.zcode/cli/rollout/model-io-sess_*.jsonl`. Usage at `response.usage`, model at `model.modelId`, timestamp at `completedAt`. Deduped on `requestId`.
- **`grok_glm_usage_test.go`** — importer tests + capability-probe and permission-tolerance tests.

### Modified
- **`cli/ccrank-git/main.go`** — `--by-agent` ccusage call, `rebuildCombinedEntries`, `piPlatformForModel`, `runPiUsage`, capability probe (`loadSupportedPlatforms` / `resolveSupportedPlatforms` / `uploadDedicatedPlatform`), maxima version 3, permission tolerance.
- **`src/utils.ts`** — `Platform` union, frozen `PLATFORMS`, `isValidPlatform`.
- **`src/parser.ts`** — `detectPlatform` with grok/glm/pi.
- **`src/index.ts`** — `GET /api/platforms`, plus `days_active`/`last_active` SQL fix (14 sites).
- **`src/html.ts`** — `PLATFORM_META` entries; row dots and legend now derived from it.
- **`README.md`, `docs/git-metadata.md`** — platform tables, deploy-order note.
- **`test/grok-glm-pi-platforms.test.mjs`** — server/UI/routing tests.

---

## 3. Non-obvious invariants — do not break these

### 3.1 Cached reads are folded into `inputTokens` by both new CLIs
ccusage's convention is **additive**: `input + output + cacheCreation + cacheRead == total`. Grok and Z Code both report `inputTokens` *inclusive* of cached reads. The importers subtract them back out. Verified on 294/294 real Grok turns and 15/15 GLM records — the `if input < 0` clamp never fires, and recomputed totals exactly match each CLI's own reported total.

### 3.2 Grok cost is in "ticks"; the divisor is `1e10`
`grokCostTicksPerUSD = 1e10`. Pinned by fitting per-model rates against real logs: $1.77–$2.83/M fresh input, $0.39–$0.86/M cached reads — plausible xAI list prices. At `1e9` cached reads would price at $3.90–$8.60/M, which no provider charges. **Do not change without re-deriving.**

### 3.3 `replace=true` vs `replace=false` decides whether the migration works
Server-side (`src/index.ts`, the upload handler):

```js
const mergeValue = (column) => body.replace === true
  ? `excluded.${column}`                                // replaces — can LOWER a row
  : `MAX(excluded.${column}, daily_usage.${column})`;   // max-merge — never lowers
```

The combined upload passes `combinedComplete`, which is false if **any** local extra importer errors. This is why permission tolerance matters: one unreadable Antigravity transcript → `combinedComplete=false` → max-merge → the corrected smaller rows are **silently discarded** and the double-count is never fixed. Verified live: `replace=true` lowered 1200→600; `replace=false` ignored a 30-token upload.

### 3.4 Maxima cache version 3
`~/.ccrank/usage-maxima-*.json` is a monotonic cache — only rows *higher* than cached get uploaded. Removing Pi makes combined rows smaller, so `usageMaximaVersion = 3` resets the combined cache once. The gate is `cacheName == "combined"` only, so the kimi cache is correctly *not* reset. **Bump this version any time a change makes correct rows smaller than already-uploaded ones.**

### 3.5 Zero rows are load-bearing
`rebuildCombinedEntries` emits a `totalTokens: 0` row for any date whose usage came entirely from held-out agents. This is deliberate — it overwrites a stale inflated row rather than leaving it ranked. Because of this, `days_active`/`last_active` SQL must exclude zero-token days (`COUNT(DISTINCT CASE WHEN total_tokens > 0 THEN date END)`), or zero rows invent phantom activity that gates the efficiency rankings.

### 3.6 The capability probe prevents data loss
`GET /api/platforms` exists so the CLI can withhold platforms a deployment does not know. Without it: an old server rejects `platform: "grok"`, falls back to `detectPlatform(['grok-4.6-build'])` → `'claude'`, and the `replace=true` upload **overwrites the user's real combined Claude/Codex row with Grok-only numbers.**

`resolveSupportedPlatforms` falls back to `legacyPlatforms = {claude, codex, kimi}` when the probe 404s. **Do not "simplify" this to an empty fallback** — that would regress Kimi tracking on every server not yet updated.

### 3.7 `detectPlatform` ordering
Vendor checks (kimi → grok → glm) run **before** the Pi prefix check, which runs **before** the Codex checks. This mirrors `piPlatformForModel` in the CLI. If Codex ran before Pi, `pi-openai-gpt-5-2` → `codex` while `[pi] gpt-5.2` → `pi` — the same usage on different platforms depending on naming form. (This was a real review finding, already fixed.)

---

## 4. Verification already done

| Check | Result |
| :-- | :-- |
| Go tests | 30 pass |
| JS tests | 20 pass |
| `go vet`, `gofmt -l`, `tsc --noEmit` | clean |
| Grok token arithmetic | 294/294 real turns |
| GLM token arithmetic | 15/15 real records |
| Combined rebuild vs ccusage | 49/49 real daily rows |
| Maxima migration | simulated all 4 directions |
| End-to-end upload | local `wrangler dev` + D1, all 3 platforms |

**Cross-validation worth knowing:** ccusage's held-out pi+kimi slices total 69,114,294 tokens. Minus the 50,762 GLM-via-Pi tokens rerouted to `glm` = 69,063,532 — exactly the Pi platform total from ccrank's native reader.

Two independent reviews (Fable) covered the Go ingest and the TS/server/UI/docs. All findings were fixed or consciously accepted; see §6.

### Reproducing the end-to-end test
```bash
npm run db:migrate:local
# seed a user + api_token (token_hash = sha256 hex of the plaintext token)
npx wrangler dev --local --port 8787
# drive importers + uploadUsageReport from a Go test using t.Setenv("HOME", fixtureDir)
```
Use a **fixture HOME** — never the real one. The CLI writes to `~/.ccrank`, which is the user's live upload cache.

---

## 5. Deploy order — required

**Deploy the Worker before rolling out the CLI.** See §3.6. This is now self-enforcing (the CLI holds back unadvertised platforms and says so), but shipping the Worker first is still the correct sequence.

No DB migration needed — `platform` is TEXT with no CHECK constraint.

---

## 6. Known open items / accepted risks

1. **Grok cost is list price, not spend.** Grok bills on a weekly credit plan (`onDemandUsed: 0`), so ~$294 of "cost" appears on cost-sorted views that nobody paid. Consistent with how ccusage prices everything else, but it's a **product decision worth revisiting**. Changing it means setting cost to `0.0` in `grok_usage.go` (as `kimi`/`glm` do).
2. **Hard dependency on ccusage `--by-agent`.** A stale npx cache while offline fails the flag and skips the combined upload for that run. Recoverable, nothing corrupted — loud failure was chosen over silent double-counting.
3. **`cacheCreationTokens` folding is unverified.** Every real sample has `0` there, so whether it's inside `inputTokens` can't be confirmed. The clamp is defensive only. If a future CLI reports creation *outside* input, fresh input would be understated.
4. **`days_active` change affects all users**, not just this feature — anyone with genuinely zero-token days sees a slightly lower count. Correct semantics, but a visible behavioral change.
5. **Existing uploaded rows stay inflated** until each machine's next `--upload-usage` run after updating. Corrections are per `(user, date, source, platform)`, so they land per machine.

---

## 7. If you're picking this up

The PR is ready to review/merge as-is. Likely next tasks:

- Act on the Grok cost decision (§6.1) if the product call goes the other way.
- Deploy Worker → verify `GET /api/platforms` returns all six → roll out CLI binaries.
- After rollout, confirm a real user's combined rows corrected downward (the version-3 reset fires once per machine).
- If ccusage later adds `grok`/`glm` importers, add them to `ccusageDedicatedAgents` in `main.go` or they'll be double-counted — this is the one silent-failure seam left in the design.
