#!/usr/bin/env node

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

function getLastNDates(days) {
  const dates = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function readReadmeTitle() {
  const candidates = ['README.md', 'readme.md'];
  for (const file of candidates) {
    const full = path.join(process.cwd(), file);
    if (!fs.existsSync(full)) continue;
    const contents = fs.readFileSync(full, 'utf8');
    const line = contents.split('\n').find((l) => l.startsWith('# '));
    if (line) return line.replace(/^#\s+/, '').trim();
  }
  return '';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, description: '', url: '', token: '', all: false, machine: '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--all') opts.all = true;
    else if (arg === '--url') opts.url = args[++i] || '';
    else if (arg === '--token') opts.token = args[++i] || '';
    else if (arg === '--description') opts.description = args[++i] || '';
    else if (arg === '--machine') opts.machine = args[++i] || '';
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const repoName = path.basename(process.cwd());
  const repoSlug = toSlug(repoName);
  const description = opts.description || readReadmeTitle() || repoName;

  let datesRaw = '';
  try {
    datesRaw = run('git log --since="28 days ago" --pretty=format:%ad --date=short');
  } catch (err) {
    console.error('Failed to run git log. Are you in a git repo?');
    process.exit(1);
  }

  const counts = new Map();
  datesRaw.split('\n').filter(Boolean).forEach((d) => {
    counts.set(d, (counts.get(d) || 0) + 1);
  });

  const dates = getLastNDates(28);
  const days = dates.map((date) => ({ date, commitCount: counts.get(date) || 0 }));

  const payload = {
    machine: opts.machine || undefined,
    // Pinned floor for the server minimum-version gate (HTTP 426 below it).
    cli_version: '1.7.1',
    projects: [
      {
        repoName,
        repoSlug,
        description,
        descriptionOverride: Boolean(opts.description),
        days,
      },
    ],
  };

  if (opts.dryRun || !opts.url || !opts.token) {
    console.log(JSON.stringify(payload, null, 2));
    if (!opts.dryRun) {
      console.error('Missing --url or --token. Run with --dry-run to inspect output.');
    }
    return;
  }

  const res = await fetch(opts.url.replace(/\/$/, '') + '/api/git/upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    console.error('Upload failed:', data.error || res.statusText);
    process.exit(1);
  }

  console.log('Upload complete:', data);

  if (opts.all) {
    try {
      const ccusage = run('npx ccusage@latest daily --json');
      const res2 = await fetch(opts.url.replace(/\/$/, '') + '/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ json: ccusage, source: opts.machine || 'default', cli_version: '1.7.1' }),
      });
      const data2 = await res2.json().catch(() => ({}));
      if (!res2.ok || !data2.ok) {
        console.error('ccusage upload failed:', data2.error || res2.statusText);
        process.exit(1);
      }
      console.log('ccusage upload complete');
    } catch (err) {
      console.error('Failed to run ccusage:', err.message || err);
      process.exit(1);
    }
  }
}

main();
