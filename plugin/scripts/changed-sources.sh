#!/usr/bin/env bash
# 前回実行以降に追加・更新されたソース(.md)を列挙する（夜間精製の対象判定）。
# ワークフローの差分ゲートと、精製スキル（update-decision-log-auto / update-glossary-auto）の
# ステップ1が共に本スクリプトを使う（判定の二重定義によるドリフト防止）。
#
# 使い方: changed-sources.sh <SINCE> [除外pathspec...]
#   $1: git log --since に渡す起点（空なら "25 hours ago"）
#   $2以降: 追加の除外パス（自出力のGold層。例: "Cortex/" や "Cortex/用語集/"）
# 出力: 対象ファイルを1行1件（コミット済み差分＋未コミットの作業ツリー変更の和集合）。
#       対象が無ければ出力なしで exit 0。
#
# 設計メモ（既存スキルの規約を踏襲・変えないこと）:
# - ソースのディレクトリ名は案件ごとに任意なので特定ディレクトリに絞らず「全部」を対象にする。
#   除外はエンジン（.cortex-engine/）と呼び出し側が指定する自出力Gold層のみ。
# - 日本語パスの8進エスケープによる .md$ 取りこぼし防止に core.quotepath=false を付ける。
set -euo pipefail
SINCE="${1:-25 hours ago}"
shift || true
EXCLUDES=(":(exclude).cortex-engine/")
for p in "$@"; do EXCLUDES+=(":(exclude)$p"); done
{
  git -c core.quotepath=false log --since="$SINCE" --name-only --pretty=format: -- . "${EXCLUDES[@]}" \
    | grep -E '\.md$' || true
  git -c core.quotepath=false status --porcelain -- . "${EXCLUDES[@]}" \
    | grep -E '\.md' | sed -E 's/^.{3}//' || true
} | sort -u | grep -v '^$' || true
