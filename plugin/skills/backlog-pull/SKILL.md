---
name: backlog-pull
description: 課題管理ツール（Backlog等）の課題データを手元から同期する（普段は自動同期済みのため不要。初回・Webhook未設定・障害時の非常口）
---
課題管理ツール（Backlog / Jira 等）から課題データを取得し、`課題管理/` フォルダに同期します（Pull）。ローカルからBacklogへの反映（Push）は `/backlog-push` が担当します。

## ⚠️ まず確認: 普段このスキルは不要です

`課題管理/` のミラーは**自動で最新に保たれています**（Webhookリアルタイム同期＝数十秒＋平日毎時のcron）。「最新の課題が見たい」だけなら、必要なのは本スキルではなく **`/git-pull`（リポジトリの最新化）** です。

本スキルを使うのは次の場合だけです:

1. **セットアップ直後の初回全量同期** — ただし推奨はローカル実行ではなく、Secrets登録後に GitHub Actions で実行する方法（APIキーを手元に置かずに済む）:
   ```bash
   gh workflow run sync-backlog.yml
   ```
2. **Webhook・cronが未設定の案件**で今すぐ同期したいとき
3. **GitHub Actions の障害時**の非常口

## ローカル実行の手順

1. プロジェクトルートに移動
2. 以下のコマンドを実行（差分更新 + 不要ファイルの削除）

```bash
npx backlog-exporter@latest update --force --prune
```

`--prune` により、Backlog上で削除・移動されたドキュメントのローカルファイルも削除され、Backlogと同じ状態に揃います（削除対象はドキュメントの `.md` のみ。設定ファイルや `.md` 以外には触れません）。

3. 実行後に `git status` で差分を確認し、削除されたファイルがあればユーザーに報告する

## 注意事項

- ローカル実行には `DOMAIN`, `PROJECT_KEY`, `BACKLOG_API_KEY` が**環境変数として参照できる**必要があります（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数）。どこに入れるかは動作環境で変わる → `credentials` ルール参照
- 環境変数が未設定の場合、無理にキーを配布せず上記の Actions 実行（`gh workflow run sync-backlog.yml`）を第一に案内する
- `--prune` が「Nonexistent flag: --prune」エラーになる場合は、`--prune` を外して実行してください（その場合、削除・移動されたドキュメントの残留ファイルは手動で削除が必要です）
- Jira 等 Backlog 以外の場合は、案件に応じた同期コマンドに読み替えてください
