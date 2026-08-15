# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

## Data Invariant — Usage History (never break this)

**Usage totals may only ever go UP.** Local agent logs get pruned over time, so
the server's `daily_usage` rows hold historical peaks that no machine can
reproduce. Nothing may rewrite history downward through the upload path:
`/api/upload` always max-merges (`MAX(excluded.col, daily_usage.col)`) and the
`replace` flag is ignored (v1.2.1, after a replace=true migration destroyed
~27B tokens on 2026-08-15). A legit downward correction goes through an
audited admin process with a fresh export taken first — never a client flag.
`test/never-lower.test.mjs` fails any PR that reintroduces the lowering path.

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

