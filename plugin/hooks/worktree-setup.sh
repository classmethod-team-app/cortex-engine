#!/usr/bin/env bash
# Worktree setup: 親リポの .env を worktree にコピーする
# （gitignored・各メンバー手元にある想定。Backlog 同期等の対話実行で使用）
set -uo pipefail

MAIN_REPO=$(dirname "$(git rev-parse --git-common-dir)")

if [ -f "$MAIN_REPO/.env" ]; then
  cp "$MAIN_REPO/.env" .env
fi

exit 0
