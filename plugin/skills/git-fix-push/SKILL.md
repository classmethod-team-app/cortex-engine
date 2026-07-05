---
name: git-fix-push
description: git pushがnon-fast-forward（リモートと分岐）で失敗した際に、rebaseで統合してpushを成功させる
---
`git push` が **non-fast-forward**（リモートとローカルの分岐）で失敗した場合に、リモートの変更を `rebase` で取り込んでからpushし直します。

## 適用条件

push時に以下のようなエラーが出た場合に使用します。

```
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to '...'
hint: Updates were rejected because the tip of your current branch is behind
```

これは、ローカルがコミットを進めている間に、リモートにも別のコミット（別マシンからのBacklog同期など）が積まれて履歴が枝分かれした状態です。

## 実行手順

1. `git fetch origin` でリモートの最新を取得
2. `git status -sb` で `ahead / behind` を確認し、分岐していること（behind が1以上）を把握
3. `git log --oneline --graph --all -15` で分岐点と両側のコミットを確認
4. `git rebase origin/main` でリモートの上にローカルコミットを乗せ直す
5. 競合が発生した場合は **下記の競合解決ルール** に従って解決し、`git add <file>` 後に `GIT_EDITOR=true git rebase --continue` で続行
6. `grep -rn "<<<<<<<\|>>>>>>>\|=======" .` で競合マーカーの消し残しがないことを確認
7. `git push` を実行して成功を確認

## 競合解決ルール（Backlog同期の自動生成ファイル）

本リポジトリでは複数人がBacklog同期を実行するため、以下の自動生成ファイルが頻繁に競合します。内容を理解した上で機械的に解決してください。

### `課題管理/*/backlog-settings.json`

- `lastUpdated`: **新しい方のタイムスタンプ**を採用する
- `outputDir`: 開発者ごとのローカル絶対パス。競合した場合は**リモート側の値をそのまま残す**（churnを減らすため。どちらでも動作に影響なし）

### `課題管理/*/backlog-update.log`

- 追記専用のログ。**両方の行をすべて残す（union）** こと。一方を捨てるとログが消失するため不可

## 重要な制約

- `git pull`（マージコミットを作る）ではなく **`rebase`** を使い、履歴を一直線に保つ
- 競合解決でログや課題データの**行を消失させない**
- rebase中に判断に迷う競合（手書きのドキュメントや課題本文など、自動生成でないファイル）が出た場合は、勝手に解決せず**ユーザーに内容を提示して確認**する
- `--force` / `--force-with-lease` での強制pushは**行わない**（リモートの他人のコミットを消す恐れがあるため）
- やり直したい場合は `git rebase --abort` で元の状態に戻せることを念頭に置く
