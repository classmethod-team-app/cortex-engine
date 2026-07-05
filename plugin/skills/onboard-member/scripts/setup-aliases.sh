#!/bin/sh
# 日本語ディレクトリに英語の別名(symbolic link)を張り、ターミナルでの移動を楽にする。
#
# 設計意図:
#   - 正本は日本語のまま（リポは日本語を保ち、非エンジニア・顧客に分かりやすい形を崩さない）。
#   - 英語別名は「ローカルのみ」。git の info/exclude に追加するので **コミットされない**。
#   - 各自のクローンで、希望する人だけ任意で実行する（強制しない）。
#
# 使い方:  sh scripts/setup-aliases.sh   （リポジトリルートで実行）
# 例:      cd Meetings / cd Chat  などで日本語ディレクトリへ移動できるようになる。

set -e

GITDIR=$(git rev-parse --git-dir 2>/dev/null) || {
  echo "エラー: git リポジトリ内（ルート）で実行してください" >&2
  exit 1
}
EXCLUDE="$GITDIR/info/exclude"
mkdir -p "$GITDIR/info"

# 正本(日本語) → 別名(英語)。存在するディレクトリだけ別名を張る（案件で構成が違ってもOK）。
link() {
  src="$1"
  dst="$2"
  [ -d "$src" ] || return 0 # 無いディレクトリはスキップ
  if [ ! -e "$dst" ]; then
    ln -s "$src" "$dst"
    echo "  + $dst -> $src"
  fi
  # ローカルの除外に追加（重複は足さない・コミットしない）
  grep -qx "/$dst" "$EXCLUDE" 2>/dev/null || echo "/$dst" >>"$EXCLUDE"
}

echo "英語別名(symlink)を作成します（ローカルのみ・コミットされません）"
link チャット Chat
link デザイン Design
link 会議 Meetings
link 共有資料 Materials
link 課題管理 Issues
link 開発 Dev
echo "完了。例: cd Meetings / cd Chat で移動できます。"
echo "元に戻すには英語別名を rm し、$EXCLUDE の該当行を削除してください。"
