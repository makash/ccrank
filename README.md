<div align="center">

# AI Coding Token Leaderboard

### Who gets the most leverage from AI coding tokens?

[![Live Demo](https://img.shields.io/badge/demo-ccrank.dev-8B5CF6?style=for-the-badge)](https://ccrank.dev)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![Hono](https://img.shields.io/badge/Hono-E36002?style=flat-square&logo=hono&logoColor=white)](https://hono.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind%20CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Track, compare, and compete on Claude Code, Codex CLI, and Kimi Code token usage.**
Install the ccrank CLI (powered by [ccusage](https://github.com/ryoppippi/ccusage) plus native session importers). See the leaderboard. Earn titles. Talk trash.

Deploy to Cloudflare Workers in under 10 minutes. Free tier. Zero cost.

<br />

<a href="https://ccrank.dev/leaderboard?sort=output_per_dollar">
  <img src="docs/images/leaderboard-top10.png" alt="Claude Leaderboard Top 10" width="600" />
</a>

<br />
<br />

[Live Demo](https://ccrank.dev) &nbsp;&middot;&nbsp; [Quick Start](#-quick-start) &nbsp;&middot;&nbsp; [Features](#-features) &nbsp;&middot;&nbsp; [API](#-api-routes)

</div>

---

## Origin Story

It started with a WhatsApp message:

> *"Code a Leaderboard Vivek? Let everyone submit their ccusage :)"*

The entire app was built on a phone using [Claude Code](https://claude.ai), deployed to Cloudflare Workers in minutes, and has been running at [ccrank.dev](https://ccrank.dev) ever since. No laptop required. Just vibes and Claude.

---

## Features

| | Feature | Description |
|---|---|---|
| :trophy: | **Live Leaderboard** | Ranked by total tokens, with estimated cost and activity as supporting stats |
| :medal_sports: | **Gamified Titles** | Apprentice, Practitioner, Power User, Token Whale, Token Maximalist |
| :clock3: | **Time-Travel History** | Browse daily, weekly, and monthly snapshots with date navigation |
| :computer: | **Multi-Machine Tracking** | Aggregate usage across laptops, desktops, and cloud instances |
| :frame_with_picture: | **Shareable Social Cards** | OG-image-ready SVG cards with your stats for Twitter/LinkedIn |
| :lock: | **Google OAuth** | One-click sign-in, no passwords |
| :busts_in_silhouette: | **Public Registration** | Anyone with a Google account can join |
| :gear: | **Admin Panel** | Bulk invite generation, platform-wide stats |
| :new_moon: | **Dark Theme** | Beautiful dark UI, fully responsive on mobile |
| :moneybag: | **Zero Cost Hosting** | Runs entirely on Cloudflare Workers + D1 free tier |

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org) v18+
- [Cloudflare](https://cloudflare.com) account (free tier)
- [Google Cloud](https://console.cloud.google.com) project (for OAuth)

### 1. Clone and install

```bash
git clone https://github.com/makash/claude-leaderboard-using-ccusage.git
cd claude-leaderboard-using-ccusage
npm install
```

### 2. Create D1 database

```bash
npx wrangler login
npx wrangler d1 create claude-leaderboard-db
```

Copy the `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "claude-leaderboard-db"
database_id = "YOUR_DATABASE_ID_HERE"
```

### 3. Run migrations

```bash
npm run db:migrate
npm run db:seed
```

### 4. Configure Google OAuth

1. Create an **OAuth 2.0 Client ID** at [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Add redirect URI: `https://your-worker.workers.dev/auth/google/callback`
3. Update `wrangler.toml`:
   ```toml
   [vars]
   GOOGLE_CLIENT_ID = "your-client-id.apps.googleusercontent.com"
   ADMIN_EMAIL = "you@gmail.com"
   ```
4. Set secrets:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET    # use: openssl rand -hex 32
   ```

### 5. Deploy

```bash
npm run deploy
```

Share the URL. Start competing.

---

## Usage

### Install the CLI

Sign in at your leaderboard URL, go to **Install**, generate a token in **Settings**, and run the CLI from your project folder. The Install page includes OS-specific one-liners.

### Git metadata (optional)

Use the Go CLI (binary) to upload git activity. It auto-creates `~/.ccrank/repos.json` and uses it for uploads.

Add a repo (from inside a project folder):

```bash
ccrank-git --add-repo
```

If you run `--add-repo` outside a repo (e.g., `~/code`), it scans recursively and adds the 30 most recently active repos.

Then upload git metadata:

```bash
ccrank-git --url https://your-worker.workers.dev --token YOUR_TOKEN
```

Include local coding-agent usage from ccusage, Pi, Kimi Code, and other supported sources:

```bash
ccrank-git --url https://your-worker.workers.dev --token YOUR_TOKEN --upload-usage
```

Pi usage is imported automatically from `~/.pi/agent/sessions`, with Moonshot/Kimi models attributed to Kimi. Native Kimi Code usage is imported from both `~/.kimi/sessions` and `~/.kimi-code/sessions`, with migrated duplicate records counted once. Only aggregated usage is uploaded; raw prompts and responses stay local. See `docs/git-metadata.md` for OS-specific downloads and details.

Generate your token in **Settings → Git Metadata**.

### Join the leaderboard

Registration is public. Sign in with Google and your account is created automatically.

---

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | Optional | Landing / dashboard |
| `GET` | `/leaderboard` | No | Public leaderboard |
| `GET` | `/history` | No | Time-travel history |
| `GET` | `/about` | No | Origin story |
| `GET` | `/card/:slug` | No | Public stats card |
| `GET` | `/card/:slug/image.svg` | No | OG image (SVG) |
| `GET` | `/settings` | Yes | Sharing settings |
| `GET` | `/upload` | Yes | Install page |
| `GET` | `/invites` | Yes | Manage invites |
| `GET` | `/admin` | Admin | Admin panel |
| `POST` | `/api/upload` | Yes | Upload ccusage JSON (used by CLI) |
| `POST` | `/api/settings/sharing` | Yes | Save sharing prefs |
| `GET` | `/api/leaderboard` | No | Leaderboard JSON |
| `GET` | `/api/me` | Yes | Current user + stats |
| `GET` | `/api/me/usage` | Yes | Current user's daily/weekly/monthly usage stats |
| `POST` | `/api/invites/create` | Yes | Generate invite code |
| `POST` | `/api/admin/invites` | Admin | Bulk invite codes |

---

## Project Structure

```
src/
  index.ts        Hono routes, middleware, API endpoints
  auth.ts         HMAC-SHA256 sessions + Google OAuth
  parser.ts       ccusage JSON parser (daily/weekly/session)
  html.ts         Dark-themed HTML templates (Tailwind CSS)
  utils.ts        Shared types and utilities
  card.ts         Social card SVG generation (satori)
  images.ts       Base64 screenshots for About page
migrations/
  0001_initial.sql         Database schema
  0002_seed_invites.sql    Seed invite codes
  0003_add_source.sql      Multi-machine tracking
  0004_drop_old_index.sql  Index cleanup
  0005_add_sharing.sql     Social card sharing
```

---

## Local Development

```bash
npm run db:migrate:local
npm run db:seed:local

# Create .dev.vars for local secrets
cat > .dev.vars << 'EOF'
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
SESSION_SECRET=dev-secret-change-me
ADMIN_EMAIL=you@gmail.com
EOF

npm run dev
```

Add `http://localhost:8787/auth/google/callback` as an authorized redirect URI in Google Cloud Console.

---

## Built With

<table>
  <tr>
    <td align="center" width="140">
      <a href="https://hono.dev">
        <img src="https://hono.dev/images/logo-small.png" width="40" /><br />
        <b>Hono</b>
      </a><br />
      <sub>Web framework</sub>
    </td>
    <td align="center" width="140">
      <a href="https://workers.cloudflare.com">
        <img src="https://www.svgrepo.com/show/353564/cloudflare.svg" width="40" /><br />
        <b>CF Workers</b>
      </a><br />
      <sub>Serverless compute</sub>
    </td>
    <td align="center" width="140">
      <a href="https://developers.cloudflare.com/d1/">
        <img src="https://www.svgrepo.com/show/354428/sqlite.svg" width="40" /><br />
        <b>D1 (SQLite)</b>
      </a><br />
      <sub>Edge database</sub>
    </td>
    <td align="center" width="140">
      <a href="https://tailwindcss.com">
        <img src="https://www.svgrepo.com/show/374118/tailwind.svg" width="40" /><br />
        <b>Tailwind CSS</b>
      </a><br />
      <sub>Styling via CDN</sub>
    </td>
    <td align="center" width="140">
      <a href="https://github.com/ryoppippi/ccusage">
        <img src="https://github.githubassets.com/favicons/favicon-dark.svg" width="40" /><br />
        <b>ccusage</b>
      </a><br />
      <sub>Usage tracking CLI</sub>
    </td>
  </tr>
</table>

---

## Deploying

Deployments are triggered by **release tags** — pushing code or merging PRs does not deploy automatically.

To deploy a new version:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Or create a release via GitHub:

```bash
gh release create v1.0.0 --title "v1.0.0" --notes "What changed"
```

A GitHub Actions workflow picks up the tag, runs `wrangler deploy`, and pushes to Cloudflare Workers.

---

## Contributing

Contributions are welcome! Feel free to open issues and pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

---

## Author

**Akash Mahajan** ([@makash](https://github.com/makash))

[![GitHub](https://img.shields.io/badge/GitHub-makash-181717?style=flat-square&logo=github)](https://github.com/makash)
[![Twitter](https://img.shields.io/badge/Twitter-@makash-1DA1F2?style=flat-square&logo=twitter&logoColor=white)](https://x.com/makash)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-akashm-0A66C2?style=flat-square&logo=linkedin)](https://www.linkedin.com/in/akashm/)
[![YouTube](https://img.shields.io/badge/YouTube-@makash-FF0000?style=flat-square&logo=youtube)](https://www.youtube.com/@makash)

If you deploy this for your team, I would love to hear about it -- [tweet at me](https://x.com/makash)!

---

## License

MIT

---

<div align="center">
  <sub>Built with Claude Code. Deployed from a phone. Powered by <a href="https://github.com/ryoppippi/ccusage">ccusage</a> by <a href="https://github.com/ryoppippi">ryoppippi</a>.</sub>
</div>
