// Rebuild-trigger tests for the `crank` wrapper.
//
// Handover gotcha: the wrapper only rebuilt when main.go/go.mod were newer
// than the binary, so a muse_usage.go-only fix never took effect until a
// manual rebuild. The wrapper must now rebuild when ANY Go source, go.mod,
// go.sum, or the repo build script is newer, skip the build when nothing
// changed, and leave the existing binary untouched when the build fails.
//
// These tests run the installed wrapper against a fake HOME (temp source
// tree + token) and a fake `go` on PATH, so they never touch the real
// checkout, toolchain, or credentials. Skips on machines without an
// installed wrapper (e.g. CI); override with CRANK_WRAPPER_UNDER_TEST.
//
// Also covers scripts/build-ccrank-git.sh: a failed build must exit nonzero
// (a `!`-negated check would mask it as success) and must leave stale dist
// binaries byte-identical.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const WRAPPER =
  process.env.CRANK_WRAPPER_UNDER_TEST ||
  path.join(os.homedir(), '.local/bin/crank');
const SKIP_REASON =
  process.platform === 'win32'
    ? 'crank wrapper is POSIX-only'
    : fs.existsSync(WRAPPER)
      ? false
      : `no crank wrapper installed at ${WRAPPER}`;

const OLD_BIN = '#!/usr/bin/env bash\necho OLD_BINARY\nexit 0\n';
const GO_STUB = 'package main\n';
const BUILD_SHIM = '#!/usr/bin/env bash\n';

function touch(file, when) {
  fs.utimesSync(file, when, when);
}

// Fake `go`: logs invocations, writes an executable stub for `-o <out>`,
// or fails when FAKE_GO_FAIL=1 to simulate a broken build.
const FAKE_GO = `#!/usr/bin/env bash
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
echo "go $*" >> "$FAKE_GO_LOG"
if [ "\${FAKE_GO_FAIL:-0}" = "1" ]; then echo "fake go: build failed" >&2; exit 1; fi
printf '#!/usr/bin/env bash\\necho "STUB_BINARY $@"\\nexit 0\\n' > "$out"
chmod +x "$out"
`;

function makeFixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crank-rebuild-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const home = path.join(tmp, 'home');
  const src = path.join(home, 'Projects/tools/ccrank/cli/ccrank-git');
  const scripts = path.join(home, 'Projects/tools/ccrank/scripts');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.join(home, '.ccrank'), { recursive: true });
  const watched = {
    'main.go': path.join(src, 'main.go'),
    'muse_usage.go': path.join(src, 'muse_usage.go'),
    'go.mod': path.join(src, 'go.mod'),
    'go.sum': path.join(src, 'go.sum'),
    'build_script': path.join(scripts, 'build-ccrank-git.sh'),
  };
  fs.writeFileSync(watched['main.go'], GO_STUB);
  fs.writeFileSync(watched['muse_usage.go'], GO_STUB);
  fs.writeFileSync(watched['go.mod'], 'module example.com/x\n');
  fs.writeFileSync(watched['go.sum'], 'example.com/x v0.0.0 h1:abc=\n');
  fs.writeFileSync(watched['build_script'], BUILD_SHIM);
  fs.writeFileSync(path.join(home, '.ccrank/token'), 't'.repeat(64));
  const bin = path.join(home, 'ccrank-git');
  fs.writeFileSync(bin, OLD_BIN, { mode: 0o755 });
  const bindir = path.join(tmp, 'bin');
  fs.mkdirSync(bindir);
  const fakeGo = path.join(bindir, 'go');
  fs.writeFileSync(fakeGo, FAKE_GO, { mode: 0o755 });
  const goLog = path.join(tmp, 'go.log');
  // Settle mtimes: binary at T, everything watched older except what a
  // scenario explicitly bumps. Wide separation avoids mtime granularity issues.
  const now = Date.now();
  const binTime = new Date(now - 120_000);
  const oldTime = new Date(now - 300_000);
  const newTime = new Date(now - 10_000);
  touch(bin, binTime);
  for (const f of Object.values(watched)) touch(f, oldTime);
  return {
    home,
    bin,
    watched,
    goLog,
    bindir,
    newTime,
    env(fail = false) {
      return {
        ...process.env,
        HOME: home,
        PATH: `${bindir}${path.delimiter}${process.env.PATH}`,
        FAKE_GO_LOG: goLog,
        FAKE_GO_FAIL: fail ? '1' : '0',
      };
    },
    goInvocations() {
      return fs.existsSync(goLog)
        ? fs.readFileSync(goLog, 'utf8').trim()
        : '';
    },
    tmpLeftovers() {
      return fs
        .readdirSync(home)
        .filter((f) => f.includes('.tmp.'));
    },
  };
}

describe('crank wrapper rebuild', { skip: SKIP_REASON }, () => {
  it('rebuilds on a muse_usage.go-only change (the handover gotcha)', async (t) => {
    const fx = makeFixture(t);
    touch(fx.watched['muse_usage.go'], fx.newTime);
    const { stdout } = await run(WRAPPER, ['--machine', 'testbox-muse7'], {
      env: fx.env(),
    });
    assert.notEqual(
      fx.goInvocations(),
      '',
      'expected the wrapper to invoke go build',
    );
    assert.match(
      fs.readFileSync(fx.bin, 'utf8'),
      /STUB_BINARY/,
      'binary must be replaced by the fresh build output',
    );
    assert.deepEqual(fx.tmpLeftovers(), [], 'no staged tmp files left behind');
    // Flags, identity passthrough, and endpoint must be preserved.
    assert.ok(stdout.includes('STUB_BINARY'), 'fresh binary must execute');
    assert.ok(stdout.includes('--upload-usage'), 'must keep --upload-usage');
    assert.ok(
      stdout.includes('https://ccrank.dev'),
      'must keep the upload URL',
    );
    assert.ok(
      stdout.includes('--machine') && stdout.includes('testbox-muse7'),
      'must forward caller args (machine identity)',
    );
  });

  it('rebuilds when go.sum alone is newer', async (t) => {
    const fx = makeFixture(t);
    touch(fx.watched['go.sum'], fx.newTime);
    await run(WRAPPER, [], { env: fx.env() });
    assert.notEqual(fx.goInvocations(), '', 'go.sum change must rebuild');
    assert.match(fs.readFileSync(fx.bin, 'utf8'), /STUB_BINARY/);
  });

  it('rebuilds when the repo build script alone is newer', async (t) => {
    const fx = makeFixture(t);
    touch(fx.watched['build_script'], fx.newTime);
    await run(WRAPPER, [], { env: fx.env() });
    assert.notEqual(
      fx.goInvocations(),
      '',
      'build-script change must rebuild',
    );
    assert.match(fs.readFileSync(fx.bin, 'utf8'), /STUB_BINARY/);
  });

  it('skips the build when nothing changed', async (t) => {
    const fx = makeFixture(t);
    const { stdout } = await run(WRAPPER, [], { env: fx.env() });
    assert.equal(fx.goInvocations(), '', 'no rebuild expected');
    assert.equal(
      fs.readFileSync(fx.bin, 'utf8'),
      OLD_BIN,
      'binary bytes must be identical',
    );
    assert.ok(stdout.includes('OLD_BINARY'), 'existing binary must execute');
  });

  it('failed build preserves the existing binary', async (t) => {
    const fx = makeFixture(t);
    touch(fx.watched['muse_usage.go'], fx.newTime);
    await assert.rejects(run(WRAPPER, [], { env: fx.env(true) }), /exit|failed/i);
    assert.notEqual(fx.goInvocations(), '', 'build must have been attempted');
    assert.equal(
      fs.readFileSync(fx.bin, 'utf8'),
      OLD_BIN,
      'failed build must not touch the binary',
    );
    assert.deepEqual(
      fx.tmpLeftovers(),
      [],
      'failed build must clean up staged tmp files',
    );
  });
});

const BUILD_SCRIPT =
  process.env.CRANK_BUILD_SCRIPT_UNDER_TEST ||
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'build-ccrank-git.sh',
  );
const DIST_NAMES = [
  'ccrank-git_darwin_arm64',
  'ccrank-git_linux_amd64',
  'ccrank-git_windows_amd64.exe',
];
const STALE_BIN = 'STALE_DIST_BINARY\n';

describe(
  'build-ccrank-git.sh failure handling',
  { skip: process.platform === 'win32' ? 'POSIX-only script' : false },
  () => {
    it('failed build exits nonzero and leaves stale dist binaries intact', async (t) => {
      assert.ok(
        fs.existsSync(BUILD_SCRIPT),
        `build script under test must exist: ${BUILD_SCRIPT}`,
      );
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crank-build-'));
      t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
      // Skeleton repo: the script resolves ROOT_DIR from its own path, so the
      // current repo script is copied into the fixture (no drift).
      const scriptsDir = path.join(tmp, 'repo', 'scripts');
      const pkgDir = path.join(tmp, 'repo', 'cli', 'ccrank-git');
      const distDir = path.join(pkgDir, 'dist');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(distDir, { recursive: true });
      const scriptCopy = path.join(scriptsDir, 'build-ccrank-git.sh');
      fs.copyFileSync(BUILD_SCRIPT, scriptCopy);
      fs.chmodSync(scriptCopy, 0o755);
      for (const n of DIST_NAMES) fs.writeFileSync(path.join(distDir, n), STALE_BIN);
      const bindir = path.join(tmp, 'bin');
      fs.mkdirSync(bindir);
      const fakeGo = path.join(bindir, 'go');
      fs.writeFileSync(fakeGo, FAKE_GO, { mode: 0o755 });
      const goLog = path.join(tmp, 'go.log');
      const env = {
        ...process.env,
        PATH: `${bindir}${path.delimiter}${process.env.PATH}`,
        FAKE_GO_LOG: goLog,
        FAKE_GO_FAIL: '1',
      };
      await assert.rejects(
        run('bash', [scriptCopy], { env, cwd: tmp }),
        /Command failed/,
        'a failed build must exit nonzero (masked-zero is the bug)',
      );
      assert.ok(
        fs.existsSync(goLog) && fs.readFileSync(goLog, 'utf8').trim() !== '',
        'build must have been attempted',
      );
      for (const n of DIST_NAMES) {
        assert.equal(
          fs.readFileSync(path.join(distDir, n), 'utf8'),
          STALE_BIN,
          `stale ${n} must be byte-identical after a failed build`,
        );
      }
      assert.deepEqual(
        fs.readdirSync(distDir).filter((f) => f.includes('.tmp.')),
        [],
        'failed build must clean up staged tmp files',
      );
    });
  },
);
