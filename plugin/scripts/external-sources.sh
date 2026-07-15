#!/usr/bin/env bash
# Cortex/external-sources.json に登録された「外部ソース」（GitHub Issues/Discussions）から、
# SINCE 以降に更新されたコンテンツを取得し、ソース見出し付きテキストで stdout に出す。
# 夜間Gold昇格(update-gold)の差分ゲートと、精製スキル(update-gold-auto)のステップ1が
# 共に本スクリプトを使う（changed-sources.sh と同じ思想。判定の二重定義によるドリフト防止）。
#
# 使い方: external-sources.sh <SINCE-ISO8601>
#   $1: 起点（ISO8601。空なら約25時間前をデフォルト）。gh search は日付粒度なので日付部分を使う。
# 認証: GH_TOKEN 環境変数を使う（ワークフローが EXTERNAL_SOURCES_TOKEN || github.token を渡す）。gh 前提。
# 出力: 取得できた外部コンテンツをソース見出し付きテキストで stdout に。何も無ければ空出力・exit 0。
#
# 設計メモ（重要・変えないこと）:
# - 「登録する＝Gold昇格してよい」という人間の明示判断。record単位のvisibilityフラグは持たない。
#   ただしAI抽出時の公開範囲フィルタ（内部限定情報をDecisionに書かない）はスキル側で維持する。
# - 取得失敗（権限無し・graphql失敗等）はソース単位で warn してスキップし、他ソース・全体を止めない。
#   失敗＝「活動なし」として扱い出力しない（＝差分ゲートで changed に寄与させない。空振りAI実行を避ける）。
# - Cortex/external-sources.json が無ければ何も出力せず exit 0（未設定案件で無害）。
# - slack type は phase2。現状は notice を出してスキップ。
set -euo pipefail

CONFIG="Cortex/external-sources.json"
[ -e "$CONFIG" ] || exit 0

SINCE_RAW="${1:-}"
# gh search は日付粒度（YYYY-MM-DD）。SINCE の日付部分を使う。
if [ -n "$SINCE_RAW" ]; then
  SINCE_DATE="${SINCE_RAW%%T*}"
  SINCE_ISO="$SINCE_RAW"
else
  # デフォルト約25時間前（changed-sources.sh の "25 hours ago" と同思想）。GNU/BSD date 両対応。
  SINCE_DATE=$(date -u -d '25 hours ago' +%Y-%m-%d 2>/dev/null || date -u -v-25H +%Y-%m-%d)
  SINCE_ISO=$(date -u -d '25 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-25H +%Y-%m-%dT%H:%M:%SZ)
fi

TMPDIR_EXT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EXT"' EXIT

# 設定を "type<TAB>ref" 行に正規化（jq非依存でpython3を使う。CIランナー・macに標準搭載）。
SOURCES=$(CONFIG="$CONFIG" python3 <<'PY'
import json, os, sys
try:
    data = json.load(open(os.environ["CONFIG"], encoding="utf-8"))
except Exception:
    sys.exit(0)
for s in (data.get("sources") or []):
    t = s.get("type", "")
    ref = s.get("repo") or s.get("channel") or ""
    if t:
        print(f"{t}\t{ref}")
PY
)
[ -n "$SOURCES" ] || exit 0

emit_issues() {
  local repo="$1"
  local jsonf="$TMPDIR_EXT/issues.json"
  # SINCE 以降に更新された Issue を本文込みで取得。失敗（権限無し等）はソース単位でスキップ。
  if ! gh issue list --repo "$repo" --state all \
      --search "updated:>=${SINCE_DATE}" \
      --json number,title,updatedAt,body,url > "$jsonf" 2>/dev/null; then
    echo "::warning::external-sources: github-issues $repo の取得に失敗（権限/存在を確認）。スキップします。" >&2
    return 0
  fi
  # 各Issueを見出し付きで出力し、対象Issue番号を numbers ファイルに書き出す。
  REPO="$repo" python3 - "$jsonf" "$TMPDIR_EXT/numbers.txt" <<'PY'
import json, os, sys
repo = os.environ["REPO"]
data = json.load(open(sys.argv[1], encoding="utf-8"))
nums = open(sys.argv[2], "w", encoding="utf-8")
for it in data:
    num = it.get("number")
    title = it.get("title", "")
    updated = it.get("updatedAt", "")
    print(f'\n## [github-issues] {repo} #{num} {title} (updated {updated})')
    print(f'URL: {it.get("url", "")}')
    body = (it.get("body") or "").strip()
    if body:
        print(body)
    nums.write(f"{num}\n")
nums.close()
PY
  # コメント本文を追記（Issueごと。失敗は静かにスキップ）。
  [ -s "$TMPDIR_EXT/numbers.txt" ] || return 0
  while read -r n; do
    [ -n "$n" ] || continue
    local cmts
    if cmts=$(gh issue view "$n" --repo "$repo" --comments \
        --json comments --jq '.comments[] | "コメント(" + .author.login + "): " + .body' 2>/dev/null); then
      if [ -n "$cmts" ]; then
        echo "### [github-issues] $repo #$n のコメント"
        echo "$cmts"
      fi
    fi
  done < "$TMPDIR_EXT/numbers.txt"
}

emit_discussions() {
  local repo="$1"
  local owner name jsonf
  owner="${repo%%/*}"; name="${repo##*/}"
  jsonf="$TMPDIR_EXT/discussions.json"
  # best-effort: 更新降順で最大50件取得し、SINCE以降をスクリプト側で絞る。graphql失敗はスキップ。
  if ! gh api graphql -f owner="$owner" -f name="$name" -f query='
    query($owner:String!, $name:String!){
      repository(owner:$owner, name:$name){
        discussions(first:50, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes{ number title body url updatedAt
            comments(first:50){ nodes{ body author{ login } } } }
        }
      }
    }' > "$jsonf" 2>/dev/null; then
    echo "::warning::external-sources: github-discussions $repo の取得に失敗（権限/graphql）。スキップします。" >&2
    return 0
  fi
  SINCE_ISO="$SINCE_ISO" REPO="$repo" python3 - "$jsonf" <<'PY'
import json, os, sys
resp = json.load(open(sys.argv[1], encoding="utf-8"))
since = os.environ["SINCE_ISO"]
repo = os.environ["REPO"]
nodes = (((resp.get("data") or {}).get("repository") or {}).get("discussions") or {}).get("nodes") or []
for d in nodes:
    if (d.get("updatedAt") or "") < since:
        continue
    num = d.get("number")
    title = d.get("title", "")
    updated = d.get("updatedAt", "")
    print(f'\n## [github-discussions] {repo} #{num} {title} (updated {updated})')
    print(f'URL: {d.get("url", "")}')
    body = (d.get("body") or "").strip()
    if body:
        print(body)
    for c in ((d.get("comments") or {}).get("nodes") or []):
        cb = (c.get("body") or "").strip()
        if cb:
            login = ((c.get("author") or {}).get("login")) or "?"
            print(f'コメント({login}): {cb}')
PY
}

while IFS=$'\t' read -r type ref; do
  [ -n "$type" ] || continue
  case "$type" in
    github-issues)
      [ -n "$ref" ] && emit_issues "$ref" ;;
    github-discussions)
      [ -n "$ref" ] && emit_discussions "$ref" ;;
    slack)
      echo "::notice::external-sources: slack はphase2で対応予定。今回はスキップします（${ref}）。" >&2 ;;
    *)
      echo "::warning::external-sources: 未知のtype '$type' をスキップします。" >&2 ;;
  esac
done <<< "$SOURCES"
