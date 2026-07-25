#!/usr/bin/env bash
# セッション開始時に、このリポジトリを安全に最新化する（.claude/settings.json の SessionStart hook から呼ばれる）。
#
# 狙い: 同期ミラー（課題管理・デザイン・Gold昇格）はサーバー側が毎晩コミットするため、手元のクローンは
# 放っておくと古くなる。古いまま作業するとAIが古い前提で判断してしまうので、pull を人の記憶やAIの判断に
# 委ねず機械的に行う。
#
# 原則（変えないこと）:
# - セッションを絶対に止めない（何が起きても exit 0。失敗は警告1行のみ）
# - 作業中の変更に触れない（未コミットの変更があれば何もしない。stash も rebase もしない）
# - 出力は最小限（更新があったときだけ1行）
# - submodule には触れない（重く、別サイクルで管理する）
set -uo pipefail

# クラウド実行（Web版）は毎回新しい clone なので最新化は不要
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# 未コミットの変更があるときは触らない（作業中の内容を巻き込む事故を防ぐ）
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "未コミットの変更があるため自動最新化をスキップしました"
  exit 0
fi

before="$(git rev-parse HEAD 2>/dev/null || true)"

# 認証待ちで固まらないよう対話プロンプトを無効化する（hook はユーザーが入力できない）
export GIT_TERMINAL_PROMPT=0
if ! git pull --ff-only --no-recurse-submodules --quiet >/dev/null 2>&1; then
  echo "自動最新化に失敗しました（ネットワークまたは履歴の分岐の可能性）。必要なら /git-sync で最新化してください"
  exit 0
fi

after="$(git rev-parse HEAD 2>/dev/null || true)"
if [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]; then
  count="$(git rev-list --count "$before..$after" 2>/dev/null || true)"
  echo "リモートの最新を取り込みました（${count:-?} 件のコミット）"
fi

exit 0
