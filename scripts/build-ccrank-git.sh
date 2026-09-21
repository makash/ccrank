#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR/cli/ccrank-git"

mkdir -p dist

# Staged build + atomic rename so a failed build never leaves a truncated
# binary behind (and never truncates one that may be executing).
# NOTE: no `!` negation here -- under `!`, $? is 0 in the failure branch and
# a failed build would wrongly exit successfully.
build_one() {
  local out="$1"
  local tmp="$out.tmp.$$"
  if go build -ldflags "-s -w" -o "$tmp" .; then
    mv -f "$tmp" "$out"
  else
    local rc=$?
    rm -f "$tmp"
    exit "$rc"
  fi
}

GOOS=darwin GOARCH=arm64 build_one dist/ccrank-git_darwin_arm64
GOOS=linux GOARCH=amd64 build_one dist/ccrank-git_linux_amd64
GOOS=windows GOARCH=amd64 build_one dist/ccrank-git_windows_amd64.exe

echo "Built binaries in cli/ccrank-git/dist"
