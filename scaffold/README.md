# scaffold — 案件リポの初期骨格

案件コンテキストリポジトリ（データ＋薄い設定）の初期ファイル一式。新規案件のセットアップ（`/setup-project`）と、既存案件のエンジン分離移行（Phase 1〜2）で使う。

## 中身

| パス | 案件リポでの配置先 | 説明 |
| --- | --- | --- |
| `workflows/*.yml` | `.github/workflows/` | エンジンの reusable workflows を呼ぶスタブ（トリガー・cron 時刻は案件側で調整可） |
| `claude-settings.json` | `.claude/settings.json` | マーケットプレイス参照＋プラグイン有効化（トラスト時に自動案内） |

## スタブの注意

- `update-decision-log.yml`・`update-glossary.yml`・`weekly-report.yml` は**ファイル名を変えない**こと（増分起点 SINCE の算出が `gh run list --workflow=<ファイル名>` に依存）
- private エンジンの checkout に org secret `ENGINE_REPO_TOKEN`（cortex-engine への read 権限）が必要
- カナリア運用（cortex-context）ではスタブの `@v1` を `@main` にし、`with: engine_ref: main` を渡し（エンジンcheckoutを伴う8本）、settings.json のマーケットプレイスを `cortex-canary`（cortex-engine 直接参照）に差し替える

## TODO（Phase 3）

データディレクトリの骨格（`Cortex/`・`課題管理/` 等の README・テンプレート）を aidd-project-cortex から移設し、`/setup-project` がここから展開する方式に切り替える。
