#!/usr/bin/env bash
# Cortex/external-sources.json に登録された「外部ソース」（GitHub Issues/Discussions/Slack）から、
# SINCE 以降に更新されたコンテンツを取得し、ソース見出し付きテキストで stdout に出す。
# 夜間Gold昇格(update-gold)の差分ゲートと、精製スキル(update-gold-auto)のステップ1が
# 共に本スクリプトを使う（changed-sources.sh と同じ思想。判定の二重定義によるドリフト防止）。
#
# 使い方: external-sources.sh <SINCE-ISO8601>
#   $1: 起点（ISO8601。空なら約25時間前をデフォルト）。gh search は日付粒度なので日付部分を使う。
# 認証: GH_TOKEN 環境変数を使う（ワークフローが EXTERNAL_SOURCES_TOKEN || github.token を渡す）。gh 前提。
#   Slack は SLACK_BOT_TOKEN（xoxb-）を Slack Web API に Bearer で渡す。curl + jq（CIランナー同梱）を使う。
# 出力: 取得できた外部コンテンツをソース見出し付きテキストで stdout に。何も無ければ空出力・exit 0。
#
# 設計メモ（重要・変えないこと）:
# - 「登録する＝Gold昇格してよい」という人間の明示判断。record単位のvisibilityフラグは持たない。
#   ただしAI抽出時の公開範囲フィルタ（内部限定情報をDecisionに書かない）はスキル側で維持する。
# - 取得失敗（権限無し・graphql失敗等）はソース単位で warn してスキップし、他ソース・全体を止めない。
#   失敗＝「活動なし」として扱い出力しない（＝差分ゲートで changed に寄与させない。空振りAI実行を避ける）。
# - Cortex/external-sources.json が無ければ何も出力せず exit 0（未設定案件で無害）。
# - slack type は SLACK_BOT_TOKEN と bot 招待済みチャンネルのみ無人読み取り。トークン未設定/未招待/権限不足は
#   「活動なし」として扱いスキップ（GHの権限エラーと同じ思想でゲートを膨らませない）。スレッド/ページングは安全上限付き。
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

# Slack API の oldest は Unix 秒。SINCE を秒に変換（GNU/BSD 両対応。失敗時は 0＝安全上限内で全量）。
if [ -n "$SINCE_RAW" ]; then
  SINCE_EPOCH=$(date -u -d "$SINCE_ISO" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$SINCE_ISO" +%s 2>/dev/null || echo 0)
else
  SINCE_EPOCH=$(date -u -d '25 hours ago' +%s 2>/dev/null || date -u -v-25H +%s 2>/dev/null || echo 0)
fi

TMPDIR_EXT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EXT"' EXIT

# 設定を "type<TAB>ref<TAB>decisions" 行に正規化（jq非依存でpython3を使う。CIランナー・macに標準搭載）。
# decisions は任意フィールド（"label:<name>" / "none" / 省略）。省略・未知値は空文字で出す（＝従来挙動）。
SOURCES=$(CONFIG="$CONFIG" python3 <<'PY'
import json, os, sys
try:
    data = json.load(open(os.environ["CONFIG"], encoding="utf-8"))
except Exception:
    sys.exit(0)
for s in (data.get("sources") or []):
    t = s.get("type", "")
    ref = s.get("repo") or s.get("channel") or ""
    dec = (s.get("decisions") or "").strip()
    if t:
        print(f"{t}\t{ref}\t{dec}")
PY
)
[ -n "$SOURCES" ] || exit 0

emit_issues() {
  local repo="$1"
  local decisions="${2:-}"
  local jsonf="$TMPDIR_EXT/issues.json"
  # decisions が "label:<name>" のときは取得をそのラベルに限定（＝チームの決定規約の宣言。
  # ラベル無しitemは取り込まない＝ライブ参照どまり）。"none"・省略・未知値は従来どおり updated 窓の全件。
  local label=""
  case "$decisions" in
    label:*) label="${decisions#label:}" ;;
  esac
  # SINCE 以降に更新された Issue を本文込み・state/labelsメタ付きで取得。失敗（権限無し等）はソース単位でスキップ。
  # --label と --search は AND で交差する（gh 仕様で確認済み）。
  local args=(--repo "$repo" --state all --search "updated:>=${SINCE_DATE}" \
    --json number,title,updatedAt,state,labels,body,url)
  [ -n "$label" ] && args+=(--label "$label")
  if ! gh issue list "${args[@]}" > "$jsonf" 2>/dev/null; then
    echo "::warning::external-sources: github-issues $repo の取得に失敗（権限/存在/ラベルを確認）。スキップします。" >&2
    return 0
  fi
  # 各Issueを見出し付き（state/labelsメタ入り。AIがシグナル判定に使う）で出力し、対象Issue番号を numbers ファイルに書き出す。
  REPO="$repo" python3 - "$jsonf" "$TMPDIR_EXT/numbers.txt" <<'PY'
import json, os, sys
repo = os.environ["REPO"]
data = json.load(open(sys.argv[1], encoding="utf-8"))
nums = open(sys.argv[2], "w", encoding="utf-8")
for it in data:
    num = it.get("number")
    title = it.get("title", "")
    updated = it.get("updatedAt", "")
    state = (it.get("state") or "").lower()
    labels = ", ".join(l.get("name", "") for l in (it.get("labels") or []) if l.get("name"))
    meta = f"state: {state}" if state else ""
    if labels:
        meta = f"{meta}, labels: {labels}" if meta else f"labels: {labels}"
    head = f'\n## [github-issues] {repo} #{num} {title}'
    if meta:
        head += f' ({meta})'
    print(f'{head} (updated {updated})')
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
  local decisions="${2:-}"
  local owner name jsonf
  owner="${repo%%/*}"; name="${repo##*/}"
  jsonf="$TMPDIR_EXT/discussions.json"
  # decisions が "label:<name>" のときは対象をそのラベルに絞る（issues と同じ思想）。
  # discussions はラベルフィルタを graphql に持たず、取得後にスクリプト側で交差させる（best-effort）。
  local label=""
  case "$decisions" in
    label:*) label="${decisions#label:}" ;;
  esac
  # best-effort: 更新降順で最大50件取得し、SINCE以降をスクリプト側で絞る。graphql失敗はスキップ。
  # category/labels は AI のシグナル判定用メタとしてヘッダに出す。
  if ! gh api graphql -f owner="$owner" -f name="$name" -f query='
    query($owner:String!, $name:String!){
      repository(owner:$owner, name:$name){
        discussions(first:50, orderBy:{field:UPDATED_AT, direction:DESC}){
          nodes{ number title body url updatedAt
            category{ name }
            labels(first:20){ nodes{ name } }
            comments(first:50){ nodes{ body author{ login } } } }
        }
      }
    }' > "$jsonf" 2>/dev/null; then
    echo "::warning::external-sources: github-discussions $repo の取得に失敗（権限/graphql）。スキップします。" >&2
    return 0
  fi
  SINCE_ISO="$SINCE_ISO" REPO="$repo" LABEL="$label" python3 - "$jsonf" <<'PY'
import json, os, sys
resp = json.load(open(sys.argv[1], encoding="utf-8"))
since = os.environ["SINCE_ISO"]
repo = os.environ["REPO"]
want_label = os.environ.get("LABEL", "")
nodes = (((resp.get("data") or {}).get("repository") or {}).get("discussions") or {}).get("nodes") or []
for d in nodes:
    if (d.get("updatedAt") or "") < since:
        continue
    labels = [l.get("name", "") for l in (((d.get("labels") or {}).get("nodes")) or []) if l.get("name")]
    # decisions: label:X 指定時はそのラベルを持つ discussion だけ取り込む（無ければライブ参照どまり）。
    if want_label and want_label not in labels:
        continue
    num = d.get("number")
    title = d.get("title", "")
    updated = d.get("updatedAt", "")
    category = ((d.get("category") or {}).get("name")) or ""
    meta = f"category: {category}" if category else ""
    if labels:
        lbl = ", ".join(labels)
        meta = f"{meta}, labels: {lbl}" if meta else f"labels: {lbl}"
    head = f'\n## [github-discussions] {repo} #{num} {title}'
    if meta:
        head += f' ({meta})'
    print(f'{head} (updated {updated})')
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

# ---- Slack（Bot Token + Web API・MCPは使わない） --------------------------------
# 認証は SLACK_BOT_TOKEN（xoxb-）を Bearer で渡す。bot が招待済みのチャンネルだけ読める
# （Figma/Drive の中央アカウント招待と同じ公開範囲境界）。読めないチャンネルは warn してスキップ。

# Slack Web API を GET で叩く。$1=メソッド名、以降は curl の追加引数（--data-urlencode 等）。
# 429 は Retry-After を軽く尊重して数回だけ再試行し、それでも駄目なら本文を返す（呼び出し側が ok:false で判定）。
slack_api() {
  local method="$1"; shift
  local url="https://slack.com/api/${method}"
  local hdr="$TMPDIR_EXT/slack_hdr"
  local attempt=0 body http retry
  while :; do
    attempt=$((attempt + 1))
    body=$(curl -sS -G --max-time 30 "$url" \
      -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
      -H "Accept: application/json" \
      -D "$hdr" "$@" 2>/dev/null) || true
    http=$(awk 'NR==1{print $2}' "$hdr" 2>/dev/null || echo "")
    if [ "$http" = "429" ] && [ "$attempt" -le 3 ]; then
      retry=$(awk 'tolower($1)=="retry-after:"{print $2}' "$hdr" 2>/dev/null | tr -d '\r')
      [ -n "$retry" ] || retry=2
      # 無人ジョブを長時間ブロックしないよう待機は 10 秒で頭打ち
      if [ "$retry" -gt 10 ] 2>/dev/null; then retry=10; fi
      sleep "$retry"
      continue
    fi
    printf '%s' "$body"
    return 0
  done
}

# Slack ts（"1717488000.000200"）→ ISO8601。整数秒だけ使う。GNU/BSD 両対応。
slack_ts_to_iso() {
  local ts="$1" sec="${1%%.*}"
  [ -n "$sec" ] || { printf '%s' "$ts"; return; }
  date -u -d "@$sec" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -r "$sec" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || printf '%s' "$ts"
}

# user ID → 表示名。同一run内はディスクにキャッシュして再取得しない。解決失敗は ID のまま。
slack_user_name() {
  local uid="$1"
  [ -n "$uid" ] || { printf '%s' "?"; return; }
  local cache="$TMPDIR_EXT/slack_users"; mkdir -p "$cache"
  local f="$cache/$uid"
  if [ -f "$f" ]; then cat "$f"; return; fi
  local resp name=""
  resp=$(slack_api users.info --data-urlencode "user=$uid")
  if [ "$(printf '%s' "$resp" | jq -r '.ok // false')" = "true" ]; then
    name=$(printf '%s' "$resp" | jq -r '.user.profile.display_name // .user.real_name // .user.name // empty')
  fi
  [ -n "$name" ] || name="$uid"
  printf '%s' "$name" > "$f"
  printf '%s' "$name"
}

# reply_count>0 の親メッセージのスレッド返信を取得して出力（親は履歴側で出力済みなのでスキップ）。
emit_slack_replies() {
  local ch="$1" parent="$2" chname="$3"
  local resp ok err
  resp=$(slack_api conversations.replies \
    --data-urlencode "channel=$ch" --data-urlencode "ts=$parent" --data-urlencode "limit=200")
  ok=$(printf '%s' "$resp" | jq -r '.ok // false')
  if [ "$ok" != "true" ]; then
    err=$(printf '%s' "$resp" | jq -r '.error // "unknown"')
    echo "::warning::external-sources: slack #$chname (replies $parent) 取得失敗: ${err}。スレッドをスキップします。" >&2
    return 0
  fi
  printf '%s' "$resp" | jq -c '.messages[]?' | while IFS= read -r line; do
    local ts user text uname iso
    ts=$(printf '%s' "$line" | jq -r '.ts // empty')
    [ "$ts" = "$parent" ] && continue
    text=$(printf '%s' "$line" | jq -r '.text // ""')
    [ -n "$text" ] || continue
    user=$(printf '%s' "$line" | jq -r '.user // .bot_id // empty')
    uname=$(slack_user_name "$user")
    iso=$(slack_ts_to_iso "$ts")
    echo "  └ [$uname $iso] $text"
  done
}

emit_slack() {
  local ch="$1"
  # 認証チェック: トークン未設定なら notice（1回だけ）して活動なし扱い。ゲートを膨らませない。
  if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
    if [ -z "${SLACK_TOKEN_NOTICED:-}" ]; then
      echo "::notice::external-sources: SLACK_BOT_TOKEN 未設定。slackソースをスキップします（活動なし扱い）。" >&2
      SLACK_TOKEN_NOTICED=1
    fi
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "::warning::external-sources: jq が見つからないため slack をスキップします。" >&2
    return 0
  fi

  # チャンネル名を解決（見出し用・best-effort。失敗時は ID）。
  local infoj chname=""
  infoj=$(slack_api conversations.info --data-urlencode "channel=$ch")
  if [ "$(printf '%s' "$infoj" | jq -r '.ok // false')" = "true" ]; then
    chname=$(printf '%s' "$infoj" | jq -r '.channel.name // empty')
  fi
  [ -n "$chname" ] || chname="$ch"

  # 履歴取得（oldest=SINCE_EPOCH）。ページングは安全上限で打ち切り。
  local cursor="" page=0 total=0
  local histf="$TMPDIR_EXT/slack_hist"
  : > "$histf"
  local MAX_PAGES=5 MAX_MSGS=500
  while :; do
    page=$((page + 1))
    local args=(--data-urlencode "channel=$ch" --data-urlencode "oldest=$SINCE_EPOCH" --data-urlencode "limit=200")
    [ -n "$cursor" ] && args+=(--data-urlencode "cursor=$cursor")
    local resp ok err
    resp=$(slack_api conversations.history "${args[@]}")
    ok=$(printf '%s' "$resp" | jq -r '.ok // false')
    if [ "$ok" != "true" ]; then
      err=$(printf '%s' "$resp" | jq -r '.error // "unknown"')
      echo "::warning::external-sources: slack #$chname (history) 取得失敗: ${err}。スキップします。" >&2
      return 0
    fi
    printf '%s' "$resp" | jq -c '.messages[]?' >> "$histf"
    total=$(wc -l < "$histf" | tr -d ' ')
    cursor=$(printf '%s' "$resp" | jq -r '.response_metadata.next_cursor // empty')
    [ -n "$cursor" ] || break
    if [ "$page" -ge "$MAX_PAGES" ] || [ "$total" -ge "$MAX_MSGS" ]; then
      echo "::notice::external-sources: slack #$chname が安全上限(${MAX_PAGES}ページ/${MAX_MSGS}件)に達したため以降を打ち切りました。" >&2
      break
    fi
  done

  [ -s "$histf" ] || return 0

  echo ""
  echo "## [slack] #$chname ($total messages since ${SINCE_ISO})"

  # Slack 履歴は新しい順。読みやすさのため古い順に並べ替えて出力。
  local ordf="$TMPDIR_EXT/slack_ord"
  awk '{a[NR]=$0} END{for(i=NR;i>=1;i--) print a[i]}' "$histf" > "$ordf"

  local thread_calls=0 MAX_THREADS=20
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    local ts user text rc uname iso
    ts=$(printf '%s' "$line" | jq -r '.ts // empty')
    text=$(printf '%s' "$line" | jq -r '.text // ""')
    user=$(printf '%s' "$line" | jq -r '.user // .bot_id // empty')
    rc=$(printf '%s' "$line" | jq -r '.reply_count // 0')
    if [ -n "$text" ]; then
      uname=$(slack_user_name "$user")
      iso=$(slack_ts_to_iso "$ts")
      echo "[$uname $iso] $text"
    fi
    # スレッド返信（決定はスレッドに続くことが多い）。安全上限までしか辿らない。
    if [ "$rc" != "0" ] && [ "$rc" != "null" ] && [ "$thread_calls" -lt "$MAX_THREADS" ]; then
      thread_calls=$((thread_calls + 1))
      emit_slack_replies "$ch" "$ts" "$chname"
    fi
  done < "$ordf"
  if [ "$thread_calls" -ge "$MAX_THREADS" ]; then
    echo "::notice::external-sources: slack #$chname のスレッド取得が安全上限(${MAX_THREADS}件)に達しました。" >&2
  fi
}

while IFS=$'\t' read -r type ref decisions; do
  [ -n "$type" ] || continue
  case "$type" in
    github-issues)
      [ -n "$ref" ] && emit_issues "$ref" "${decisions:-}" ;;
    github-discussions)
      [ -n "$ref" ] && emit_discussions "$ref" "${decisions:-}" ;;
    slack)
      [ -n "$ref" ] && emit_slack "$ref" ;;
    *)
      echo "::warning::external-sources: 未知のtype '$type' をスキップします。" >&2 ;;
  esac
done <<< "$SOURCES"
