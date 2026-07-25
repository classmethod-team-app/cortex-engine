# scaffold — 案件リポの初期骨格

案件コンテキストリポジトリ（データ＋薄い設定）の初期ファイル一式。**`repo/` の中身をそのまま新規リポジトリのルートに展開する**と案件リポが立ち上がる（`/setup-project` がこの展開とプレースホルダ記入を案内する）。既存案件のエンジン分離移行（Phase 2）でも、`repo/.github/workflows/`・`repo/.claude/settings.json`・`repo/CLAUDE.md` を差し替え部品として使う。

## repo/ の構成

| パス | 説明 |
| --- | --- |
| `CLAUDE.md` | 薄い AI 向け案内。**エンジン管理ブロック**（`<!-- cortex-engine:begin/end -->`）はマイグレーションが更新する |
| `README.md` / `USAGE.md` | シード文書（エンジン分離アーキテクチャ前提） |
| `.claude/settings.json` | マーケットプレイス参照＋プラグイン有効化の**宣言**（実際の導入は各メンバーが手元で `claude plugin install`。`docs/onboarding.md`） |
| `.mcp.json` | MCP サーバー定義（Backlog・GitHub）。**定義は共有・鍵は各自**（Backlog は `${BACKLOG_API_KEY}` 参照／GitHub は初回 OAuth で秘密ゼロ）。`<backlog-domain>` は `/setup-project` で実スペースに置換する |
| `.github/workflows/*.yml` | エンジンの reusable workflows を呼ぶスタブ（トリガー・cron 時刻は案件側で調整可） |
| `Cortex/` ほかデータディレクトリ | データ骨格（テンプレート・README・プレースホルダ付きシード） |

## スタブの注意

- `update-gold.yml`・`pm-daily.yml`・`pm-weekly.yml` は**ファイル名を変えない**こと（増分起点 SINCE の算出が `gh run list --workflow=<ファイル名>` に依存）
- private エンジンの checkout に `ENGINE_REPO_TOKEN`（cortex-engine への read 専用 PAT）が必要。**org が Free プランの間は repo secret として登録**（org secret は private リポに届かない）
- カナリア運用（cortex-context のみ）ではスタブの `@v1` を `@main` にし、`with: engine_ref: main` を渡し（エンジン checkout を伴う 8 本）、settings.json のマーケットプレイス `cortex-engine` から `ref: stable` を外す（＝main 追従）。**一般の案件はこの scaffold のまま（安定チャンネル）使う**

## 残作業

- `/setup-project` の scaffold 展開対応（エンジン README の Phase 3 要件参照）
