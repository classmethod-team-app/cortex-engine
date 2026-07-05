---
name: backlog-pull
description: 課題管理ツール（Backlog等）から最新の課題データを取得してローカルに同期する
---
課題管理ツール（Backlog / Jira 等）から最新の課題データを取得し、`課題管理/` フォルダに同期します（Pull）。ローカルからBacklogへの反映（Push）は `/backlog-push` が担当します。

## 実行手順

1. プロジェクトルートに移動
2. 以下のコマンドを実行（差分更新 + 不要ファイルの削除）

```bash
pnpm dlx backlog-exporter@latest update --force --prune
```

`--prune` により、Backlog上で削除・移動されたドキュメントのローカルファイルも削除され、Backlogと同じ状態に揃います（削除対象はドキュメントの `.md` のみ。設定ファイルや `.md` 以外には触れません）。

3. 実行後に `git status` で差分を確認し、削除されたファイルがあればユーザーに報告する

## 注意事項

- Backlog の場合は `DOMAIN`, `PROJECT_KEY`, `BACKLOG_API_KEY` が**環境変数として参照できる**必要があります（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数）。`.env` が無くても環境変数があれば動きます。どこに入れるかは動作環境で変わる → `credentials` ルール参照
- 初回はまだ課題が無いため、`/setup-project` の課題同期ステップで全件取得してから本スキルで差分更新してください
- `--prune` は backlog-exporter の [PR](https://github.com/ryuhei202/backlog-exporter/tree/feature/add-prune-option) で追加されたオプションです。未リリースのバージョンで「Nonexistent flag: --prune」エラーになる場合は、`--prune` を外して実行してください（その場合、削除・移動されたドキュメントの残留ファイルは手動で削除が必要です）
- Jira 等 Backlog 以外の場合は、案件に応じた同期コマンドに読み替えてください
