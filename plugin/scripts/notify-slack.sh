#!/usr/bin/env bash
# 案件リポのルートで実行し、チャット/channels.json の "notify": true チャンネルへ
# Slack メッセージ（chat.postMessage）を投稿する共有スクリプト。
# 議事録レビュー依頼(ingest-minutes)・Gold昇格サマリ(update-gold)の通知に使う。
#
# 使い方:
#   echo "<本文（mrkdwn）>" | notify-slack.sh [--mention-email <email>] [--post-at <unix秒>] [--thread-file <path>]
#   - 本文（親メッセージ）は stdin から受ける（クォート地獄回避）。
#   - --mention-email があれば users.lookupByEmail で <@Uxxxx> を解決し親本文の先頭行に付加。
#   - --post-at があれば chat.scheduleMessage で予約投稿する（例: 夜間生成の通知を翌朝9時に配達）。
#     不正値（過去時刻等）はチャンネル単位で warn スキップ（best-effort は不変）。
#   - --thread-file <path> があれば、各チャンネルで ①親（stdin本文）を即時投稿して .ts を取得 →
#     ②同チャンネルに thread_ts=<親ts> でスレッド本文（ファイル内容）を投稿、の2段で送る。
#     親tsが取れなければそのチャンネルはスレッド送信をスキップ（親だけは残す）し warn。
#     予約投稿ではスレッド化できないため、--post-at と併用不可（両方来たら --thread-file を優先し post-at は無視）。
#
# 認証: SLACK_BOT_TOKEN（xoxb-）を Bearer で Slack Web API に渡す。
#   スコープ chat:write（メンションには users:read.email）と、通知チャンネルへの bot 招待が前提。
#
# 設計メモ（重要・変えないこと）:
# - 通知は best-effort。本体ワークフローを絶対に落とさない。以下はすべて exit 0:
#   トークン未設定 / channels.json 無し・parse不能 / notify:true が1件も無い / URL不正 / API失敗。
# - チャンネル単位の失敗（not_in_channel/missing_scope/invalid_auth 等）は warn してスキップし他チャンネルは続行。
# - external-sources.sh の slack 実装の流儀（Bearer・タイムアウト・429リトライ）に合わせる。
set -uo pipefail

CONFIG="チャット/channels.json"

# 本文を stdin から取得（無ければ何もせず終了）。
BODY=$(cat)
if [ -z "$BODY" ]; then
  echo "::notice::notify-slack: 本文が空のため通知しません。" >&2
  exit 0
fi

# 引数（--mention-email / --post-at / --thread-file）をパース。
MENTION_EMAIL=""
POST_AT=""
THREAD_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mention-email)
      MENTION_EMAIL="${2:-}"; shift 2 ;;
    --post-at)
      POST_AT="${2:-}"; shift 2 ;;
    --thread-file)
      THREAD_FILE="${2:-}"; shift 2 ;;
    *)
      echo "::warning::notify-slack: 未知の引数 '$1' を無視します。" >&2; shift ;;
  esac
done
# --post-at は数値のみ受け付ける（不正なら即時投稿にフォールバック）。
if [ -n "$POST_AT" ] && ! printf '%s' "$POST_AT" | grep -qE '^[0-9]+$'; then
  echo "::warning::notify-slack: --post-at '$POST_AT' が不正なため即時投稿します。" >&2
  POST_AT=""
fi
# スレッド化は予約投稿と両立しない。両方来たら --thread-file を優先し post-at を無効化。
if [ -n "$THREAD_FILE" ] && [ -n "$POST_AT" ]; then
  echo "::warning::notify-slack: --post-at と --thread-file は併用不可。--thread-file を優先し予約投稿を無効化します。" >&2
  POST_AT=""
fi
# スレッド本文を読む（読めなければ親のみ送信＝best-effort）。
THREAD_BODY=""
if [ -n "$THREAD_FILE" ]; then
  if [ -f "$THREAD_FILE" ]; then
    THREAD_BODY=$(cat "$THREAD_FILE")
  else
    echo "::warning::notify-slack: --thread-file '$THREAD_FILE' が読めません。スレッド返信なしで親のみ送信します。" >&2
  fi
fi

# トークン未設定 → notice して exit 0（best-effort）。
if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
  echo "::notice::notify-slack: SLACK_BOT_TOKEN 未設定。通知をスキップします。" >&2
  exit 0
fi

# channels.json が無ければ exit 0（未設定案件で無害）。
if [ ! -e "$CONFIG" ]; then
  echo "::notice::notify-slack: $CONFIG が無いため通知をスキップします。" >&2
  exit 0
fi

TMPDIR_NS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_NS"' EXIT

# notify:true かつ platform が slack（省略時 slack）のチャンネルIDを抽出（url の /archives/ID から）。
# parse不能・notify対象無しは空出力（呼び出し側で exit 0）。ID抽出不能のエントリは warn してスキップ。
CHANNELS=$(CONFIG="$CONFIG" python3 <<'PY'
import json, os, re, sys
try:
    data = json.load(open(os.environ["CONFIG"], encoding="utf-8"))
except Exception:
    sys.exit(0)
for c in (data.get("channels") or []):
    if not c.get("notify"):
        continue
    platform = (c.get("platform") or "slack").lower()
    if platform != "slack":
        continue
    url = c.get("url") or ""
    m = re.search(r"/archives/([A-Z0-9]+)", url)
    if not m:
        name = c.get("name") or url or "?"
        print(f"::warning::notify-slack: チャンネル '{name}' の url からIDを抽出できません。スキップします。", file=sys.stderr)
        continue
    print(m.group(1))
PY
)
if [ -z "$CHANNELS" ]; then
  echo "::notice::notify-slack: notify:true の Slack チャンネルが無いため通知をスキップします。" >&2
  exit 0
fi

# Slack Web API を叩く。$1=メソッド名、$2=method(GET|POST)、以降は curl 追加引数。
# GET は -G（--data-urlencode で params）、POST は JSON body（--data-binary @file）を渡す。
# 429 は Retry-After を軽く尊重して数回だけ再試行（external-sources.sh の slack_api と同思想）。
slack_api() {
  local method="$1"; local verb="$2"; shift 2
  local url="https://slack.com/api/${method}"
  local hdr="$TMPDIR_NS/slack_hdr"
  local attempt=0 body http retry
  while :; do
    attempt=$((attempt + 1))
    if [ "$verb" = "GET" ]; then
      body=$(curl -sS -G --max-time 30 "$url" \
        -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        -H "Accept: application/json" \
        -D "$hdr" "$@" 2>/dev/null) || true
    else
      body=$(curl -sS -X POST --max-time 30 "$url" \
        -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
        -H "Content-Type: application/json; charset=utf-8" \
        -H "Accept: application/json" \
        -D "$hdr" "$@" 2>/dev/null) || true
    fi
    http=$(awk 'NR==1{print $2}' "$hdr" 2>/dev/null || echo "")
    if [ "$http" = "429" ] && [ "$attempt" -le 3 ]; then
      retry=$(awk 'tolower($1)=="retry-after:"{print $2}' "$hdr" 2>/dev/null | tr -d '\r')
      [ -n "$retry" ] || retry=2
      if [ "$retry" -gt 10 ] 2>/dev/null; then retry=10; fi
      sleep "$retry"
      continue
    fi
    printf '%s' "$body"
    return 0
  done
}

# メンション解決（best-effort）。解決できればメールを Slack ID に置換して本文先頭行に付加。
if [ -n "$MENTION_EMAIL" ]; then
  resp=$(slack_api users.lookupByEmail GET --data-urlencode "email=$MENTION_EMAIL")
  uid=$(printf '%s' "$resp" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
if d.get("ok"):
    print((d.get("user") or {}).get("id") or "")
' 2>/dev/null)
  if [ -n "$uid" ]; then
    # 先頭行の末尾に <@Uxxxx> を付加。
    BODY=$(MENTION="<@${uid}>" python3 -c 'import os,sys
body=sys.stdin.read()
mention=os.environ["MENTION"]
lines=body.split("\n")
lines[0]=lines[0]+" "+mention
sys.stdout.write("\n".join(lines))
' <<< "$BODY")
  else
    echo "::notice::notify-slack: $MENTION_EMAIL のSlack ID解決に失敗。メンション無しで通知します。" >&2
  fi
fi

# レスポンスから ok / error / ts を1回のpythonで取り出す（tab区切り "ok\terror\tts"）。
parse_resp() {
  printf '%s' "$1" | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("false\tunknown\t"); sys.exit(0)
print(("true" if d.get("ok") else "false")+"\t"+(str(d.get("error") or "unknown"))+"\t"+(str(d.get("ts") or "")))
' 2>/dev/null || printf 'false\tunknown\t'
}

# 各チャンネルへ投稿（POST JSON: channel, text）。--post-at があれば chat.scheduleMessage で予約投稿。
# --thread-file 時は親を即時投稿→.tsを取得→thread_tsでスレッド本文を投稿の2段。ok:false はチャンネル単位で warn スキップ。
METHOD="chat.postMessage"
[ -z "$POST_AT" ] || METHOD="chat.scheduleMessage"
payloadf="$TMPDIR_NS/payload.json"
threadf="$TMPDIR_NS/thread.json"
while IFS= read -r ch; do
  [ -n "$ch" ] || continue
  # 親: channel/text（＋予約時は post_at）を JSON payload に組み立て（本文のエスケープを python に任せる）。
  PAYLOAD="$payloadf" CH="$ch" POST_AT="$POST_AT" python3 -c 'import json,os,sys
body=sys.stdin.read()
p={"channel": os.environ["CH"], "text": body}
if os.environ.get("POST_AT"):
    p["post_at"]=int(os.environ["POST_AT"])
json.dump(p, open(os.environ["PAYLOAD"], "w", encoding="utf-8"))
' <<< "$BODY" 2>/dev/null || { echo "::warning::notify-slack: payload組み立て失敗（$ch）。スキップします。" >&2; continue; }
  resp=$(slack_api "$METHOD" POST --data-binary "@$payloadf")
  IFS=$'\t' read -r ok err ts <<< "$(parse_resp "$resp")"
  if [ "$ok" != "true" ]; then
    echo "::warning::notify-slack: チャンネル $ch への投稿に失敗: ${err}。スキップします。" >&2
    continue
  fi
  # スレッド返信（--thread-file 指定時のみ）。親tsが無ければこのチャンネルはスレッドを送らず親のみ残す。
  [ -n "$THREAD_BODY" ] || continue
  if [ -z "$ts" ]; then
    echo "::warning::notify-slack: チャンネル $ch の親メッセージ ts が取得できずスレッド返信をスキップします（親は投稿済み）。" >&2
    continue
  fi
  PAYLOAD="$threadf" CH="$ch" TS="$ts" python3 -c 'import json,os,sys
body=sys.stdin.read()
p={"channel": os.environ["CH"], "text": body, "thread_ts": os.environ["TS"]}
json.dump(p, open(os.environ["PAYLOAD"], "w", encoding="utf-8"))
' <<< "$THREAD_BODY" 2>/dev/null || { echo "::warning::notify-slack: スレッドpayload組み立て失敗（$ch）。親のみ残します。" >&2; continue; }
  tresp=$(slack_api chat.postMessage POST --data-binary "@$threadf")
  IFS=$'\t' read -r tok terr _tts <<< "$(parse_resp "$tresp")"
  if [ "$tok" != "true" ]; then
    echo "::warning::notify-slack: チャンネル $ch へのスレッド返信に失敗: ${terr}。親は投稿済みです。" >&2
  fi
done <<< "$CHANNELS"

exit 0
