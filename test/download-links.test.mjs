// CLI download links must point at the canonical repo releases.
//
// The /upload page and settings page hand users the ccrank-git binaries;
// stale links to the pre-rename repo would 404. Pins the canonical
// makash/ccrank release URLs and bans the old release path. (The footer
// "Open Source" repo-root link is intentionally out of scope here.)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const htmlSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'html.ts'),
  'utf8'
);

test('no stale release-binary URLs in html.ts', () => {
  assert.doesNotMatch(
    htmlSource,
    /claude-leaderboard-using-ccusage\/releases/,
    'binary download links must not point at the pre-rename repo'
  );
});

test('all three platform binaries link at canonical release URLs', () => {
  for (const asset of [
    'ccrank-git_darwin_arm64',
    'ccrank-git_linux_amd64',
    'ccrank-git_windows_amd64.exe',
  ]) {
    assert.ok(
      htmlSource.includes(`https://github.com/makash/ccrank/releases/latest/download/${asset}`),
      `missing canonical download URL for ${asset}`
    );
  }
});
