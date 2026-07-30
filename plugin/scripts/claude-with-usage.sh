#!/usr/bin/env bash
# claude -p を実行し、応答本文とあわせて **LLM使用量を1行で出す**共有ラッパ。
#
# なぜ要るか: 案件別のAIコストを出すには、AIを呼ぶ経路すべてが使用量を申告している必要がある。
# CloudWatch の Bedrock メトリクスは夜間に9案件が同時実行されて混ざるため、run単位の切り分けには
# ツール自身の申告しか使えない。抽出処理を各ワークフローにコピペすると必ずズレるので1本に集約する。
# 出力書式は update-gold-pipeline.mjs の「LLM使用量:」と揃えてあり、集計側は同じ正規表現で拾える。
#
# 使い方（プロンプトは stdin。引数長の上限とクォート地獄を避けるため）:
#   printf '%s' "$PROMPT" | bash .cortex-engine/plugin/scripts/claude-with-usage.sh --max-turns 60
#   - 追加の引数はそのまま claude へ渡す
#   - `--dangerously-skip-permissions` と `--output-format json` は本スクリプトが付ける
#
# 終了コード: claude のものをそのまま返す（呼び出し側の失敗判定・always()での救出を変えない）。
# 使用量の抽出に失敗しても終了コードは変えない（観測のために生の出力を出すだけ）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$(mktemp)"
OUT_FILE="$(mktemp)"
cleanup() { rm -f "$PROMPT_FILE" "$OUT_FILE"; }
trap cleanup EXIT

cat > "$PROMPT_FILE"

claude -p "$(cat "$PROMPT_FILE")" --dangerously-skip-permissions --output-format json "$@" > "$OUT_FILE"
CODE=$?

# 応答本文と使用量を出す。JSON が壊れていても観測性を落とさないよう生の出力にフォールバックする。
if ! node "$SCRIPT_DIR/claude-usage-report.mjs" "$OUT_FILE"; then
  echo "::warning::使用量の抽出に失敗しました（応答の形式が想定と異なる）。生の出力を出します。"
  cat "$OUT_FILE" || true
fi

exit "$CODE"
