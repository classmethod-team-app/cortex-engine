# Communications（顧客とのやり取り）

このディレクトリには、課題管理ツール（Backlog / Jira / Notion 等）からエクスポートされたプロジェクトデータが格納されています。

## ディレクトリ構成

```
課題管理/
├── issues/           # 課題（協議事項・依頼事項）
│   └── YYYY/        # 年別
├── documents/        # 要件定義書・IF仕様書等
├── wiki/            # 課題管理ツールのWiki
└── README.md        # このファイル
```

## 同期方法

### 自動同期（通常はこれだけで最新に保たれる）

- **リアルタイム**: Backlog の Webhook → `backlog-webhook-sync.yml` が課題・Wiki を**数十秒**で同期（Webhook 登録済み案件のみ。有効化手順は `/setup-project` の「Backlogリアルタイム同期を有効にする場合」参照）
- **定期実行**: `sync-backlog.yml` が平日日中1時間毎に課題・Wiki・ドキュメントを同期（リアルタイムの取りこぼしと、Webhook 非対応のドキュメント更新を回収する安全網）

以下は手動で同期したい場合のコマンドです。

### Backlog の場合

```bash
# 差分更新
npx --yes backlog-exporter@1 update --force
# Backlog上で削除・移動された課題・ドキュメント・Wikiのローカル残骸を掃除（削除を伴う独立コマンド。非TTYでは --force 必須）
npx --yes backlog-exporter@1 prune --force

# 初回の全件取得
npx --yes backlog-exporter@1 all \
  --domain $DOMAIN \
  --projectIdOrKey $PROJECT_KEY \
  --apiKey $BACKLOG_API_KEY \
  --output ./課題管理
```

### Jira / その他の場合

案件に応じたエクスポートコマンドに読み替えてください（`/backlog-pull` スキル内のコマンドを案件のツールに合わせて変更する）。

## Backlogへの反映（Push）

エディター上で作成した課題へのコメントや本文の更新は、コピペ不要でMCP経由で直接Backlogに反映できます。

```
/backlog-push
```

スキルが「反映内容のプレビュー提示 → ユーザー承認 → MCP経由で反映 → 該当課題のみ再取得して同期」までを一気通貫で実行します。詳細は cortex プラグインの `backlog-push` スキルを参照してください。

- 利用には `.mcp.json` の `backlog` MCPサーバーが有効であること（`.env` 設定済み）と、APIキーに課題の更新権限が必要です
- 取得（Pull）は `/backlog-pull`、反映（Push）は `/backlog-push` という役割分担です
