# cortex-engine — Cortex の仕組み（エンジン）中央リポジトリ

## Cortex とは

Cortex は、案件のコンテキスト（議事録・課題・共有資料・デザイン・意思決定・用語）を**案件ごとの1リポジトリに自動で蓄積・精製し、人と AI の両方が判断材料に使えるようにする仕組み**です。導入すると案件用のコンテキストリポジトリが作られ、同期・精製のエンジン（スキル・ワークフロー・スクリプト）は本リポジトリから自動配布・自動更新されます。

実体は3つの部品で構成されます。

| 部品 | 役割 | 所在 |
| --- | --- | --- |
| **cortex-engine（本リポ）** | 仕組みの正本。スキル・reusable workflows・scaffold・マイグレーションを一元版管理し全案件に配布 | `classmethod-team-app/cortex-engine` |
| **案件コンテキストリポジトリ** | データ（Bronze/Silver/Gold）＋薄い設定だけを持つ。`/setup-project` が生成 | 案件ごと（実例: `cortex-context`） |
| **cortex-tools** | 外付け基盤（AIS Viewer・CDK インフラ・cortex-notetaker） | `classmethod-team-app/cortex-tools` |

> かつては基盤テンプレートリポジトリ（aidd-project-cortex）を複製する方式でしたが、2026-07 のエンジン/データ分離（v1）で「テンプレの複製」から「エンジンの配布」に移行しました（旧テンプレはアーカイブ済み。改善は本リポで行えば全案件に自動で届きます）。

### 知りたいことに応じた入口

- **案件で Cortex を使いたい** → 自分の案件リポジトリの README / USAGE（scaffold 同梱）。生きた実例は cortex-context
- **新規案件に導入したい** → 本リポジトリをマーケットプレイスとして追加（下記「配布とチャンネル」）＋ `/setup-project`
- **参加メンバーに環境準備を案内したい** → [docs/onboarding.md](docs/onboarding.md)（環境の選び方・プラグイン導入・MCP 接続）
- **仕組みを知りたい・直したい** → 本リポジトリ。設計の全体像は [docs/architecture.md](docs/architecture.md)
- **要望・不具合を伝えたい** → 本リポジトリの Issue（案件リポから `/submit-feedback` でも起票可能）

## 原則

- **部署非依存**: 部署固有のコンテンツ（職能ハーネス・部のプロダクト前提）は置かない。依存方向は「ハーネス→エンジン」の一方向のみ
- **1 つの git ref で全構成要素の版が揃う**: プラグイン・workflows・スクリプト・マイグレーションを同一リポで管理する
- **独自の配布機構は作らない**: Claude Code プラグイン＋reusable workflows＋checkout という標準機構だけで配る

## 構成

```
cortex-engine/
├── .claude-plugin/marketplace.json   # cortex の配布点（cortexのみ掲載。参照するrefでチャンネルが決まる）
├── plugin/                           # Claude Code プラグイン「cortex」
│   ├── .claude-plugin/plugin.json    # version は意図的に未設定（コミットSHA＝バージョン。bump忘れ事故を排除）
│   ├── skills/                       # スキル群（取り込みの裏口・Gold手動書き込み口・読みプリミティブ・ライフサイクル・夜間cronの部品）
│   ├── agents/  hooks/  .mcp.json
│   └── scripts/validate-cortex.mjs   # オントロジー検証（js-yaml は vendor 同梱・インストール不要）
├── .github/workflows/                # reusable workflows（案件リポのスタブから workflow_call で呼ばれる）
│   ├── sync-backlog / backlog-webhook-sync / ingest-minutes / update-gold /
│   │   run-harness-skill / sync-designs / fleet-status / validate-cortex /
│   │   engine-migrate                 # run-harness-skill: ハーネススキル汎用ディスパッチ（日次/週次レポート等）
│   └── release.yml                   # stable ブランチ＋v1 タグを同一コミットに前進（リリースは必ずこれ経由）
├── scripts/                          # GHA 用（fleet-status.mjs / engine-migrate.mjs）
├── migrations/                       # データスキーマのマイグレーション（migrations/README.md 参照）
└── docs/                             # 規約の正本（ontology.md / credentials.md）
```

> 案件リポの初期骨格（scaffold）は `plugin/scaffold/` にあり、**プラグインに同梱**される（`/setup-project` が手元で展開できるようにするため）。

## 配布とチャンネル

cortex の配布点は**本リポジトリ 1 つ**（マーケットプレイス名 `cortex-engine`）。参照する `ref` がそのままチャンネルになります。

| チャンネル | 対象 | プラグイン | GHA |
| --- | --- | --- | --- |
| **安定** | 全案件リポ・顧客 | 本リポを `ref: stable` で参照 | スタブが `@v1`（移動タグ） |
| **カナリア** | cortex-context・エンジン開発者 | 本リポを `ref` 省略で参照（main 追従） | スタブが `@main` |

```bash
# 安定（一般の案件・顧客）
/plugin marketplace add classmethod-team-app/cortex-engine@stable

# カナリア（エンジン開発者・先行検証）
/plugin marketplace add classmethod-team-app/cortex-engine
```

案件リポの `.claude/settings.json`（scaffold 同梱）はマーケットプレイスとプラグインを**宣言**しますが、外部ソースのプラグインは各メンバーが `claude plugin install` するまでロードされません（Claude Code の現行仕様）。したがって上記は**各自の手元で1回だけ実行**します。部の職能ハーネスは別カタログ（retail-app-harnesses）から各自で入れます。詳しい案内は [docs/onboarding.md](docs/onboarding.md)。

リリース手順: main で開発 → cortex-context で数日〜1週間検証 → Actions の「リリース（stable / v1 を前進）」を実行。

## 案件リポに必要なもの

- `.github/workflows/` に scaffold のスタブ（cron 時刻は案件で調整可）
- `.claude/settings.json`（plugin/scaffold/repo/.claude/settings.json 参照）
- Secrets（案件リポ側の **repo secret**。org secret は Free プランでは private リポに届かない）: `BACKLOG_*` / `AWS_ROLE_TO_ASSUME` / `FIGMA_TOKEN` ＋ **`ENGINE_REPO_TOKEN`**（本リポ read 権限。private エンジンの checkout 用）
- メンバーの手元: `claude plugin marketplace add …@stable` → `claude plugin install cortex@cortex-engine` を各自1回（マシンごと）。**クラウド実行（Web版・デスクトップの Cloud セッション）ではプラグインが使えず、リポ同梱のもの（`.mcp.json`・`CLAUDE.md`・`.claude/`）だけが効く** → [docs/onboarding.md](docs/onboarding.md)

## 既知の残作業

### その他

- 精製系ワークフローの schema_version 要求チェック（古いスキーマならスキップ）は未配線
- `autoApply: false` マイグレーションの PR 自動起票は将来拡張
- Team プラン承認後: secrets を org secret へ一元化（ENGINE_REPO_TOKEN・BACKLOG_API_KEY・FIGMA_TOKEN）
- ENGINE_REPO_TOKEN の有効期限 2027-07-07。期限前にローテーション（fleet-status の期限チェック項目化も検討）
