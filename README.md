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
- **新規案件に導入したい** → 部カタログ（retail-app-harnesses 等）の導入手順 ＋ `/setup-project`
- **仕組みを知りたい・直したい** → 本リポジトリ。設計の全体像は [docs/architecture.md](docs/architecture.md)
- **要望・不具合を伝えたい** → 本リポジトリの Issue（案件リポから `/submit-feedback` でも起票可能）

## 原則

- **部署非依存**: 部署固有のコンテンツ（職能ハーネス・部のプロダクト前提）は置かない。依存方向は「ハーネス→エンジン」の一方向のみ
- **1 つの git ref で全構成要素の版が揃う**: プラグイン・workflows・スクリプト・マイグレーションを同一リポで管理する
- **独自の配布機構は作らない**: Claude Code プラグイン＋reusable workflows＋checkout という標準機構だけで配る

## 構成

```
cortex-engine/
├── .claude-plugin/marketplace.json   # カナリア/開発用マーケットプレイス（cortexのみ掲載）
├── plugin/                           # Claude Code プラグイン「cortex」
│   ├── .claude-plugin/plugin.json    # version は意図的に未設定（コミットSHA＝バージョン。bump忘れ事故を排除）
│   ├── skills/                       # スキル24本（旧テンプレから移設＋migrate-to-engine 追加。rulesync-generate / update-from-template は廃止）
│   ├── agents/  hooks/  .mcp.json
│   └── scripts/validate-cortex.mjs   # オントロジー検証（js-yaml は vendor 同梱・インストール不要）
├── .github/workflows/                # reusable workflows（案件リポのスタブから workflow_call で呼ばれる）
│   ├── sync-backlog / backlog-webhook-sync / ingest-minutes / update-decision-log /
│   │   update-glossary / weekly-report / sync-designs / fleet-status / validate-cortex /
│   │   engine-migrate                 # データスキーマ追随
│   └── release.yml                   # stable ブランチ＋v1 タグを同一コミットに前進（リリースは必ずこれ経由）
├── scripts/                          # GHA 用（fleet-status.mjs / engine-migrate.mjs）
├── migrations/                       # データスキーマのマイグレーション（migrations/README.md 参照）
└── docs/                             # 規約の正本（ontology.md / credentials.md）
```

> 案件リポの初期骨格（scaffold）は `plugin/scaffold/` にあり、**プラグインに同梱**される（`/setup-project` が手元で展開できるようにするため）。

## 配布とチャンネル

| チャンネル | 対象 | プラグイン | GHA |
| --- | --- | --- | --- |
| **安定** | 全案件リポ | 部カタログ（retail-app-harnesses 等）が `ref: stable` でピン | スタブが `@v1`（移動タグ） |
| **カナリア** | cortex-context | 本リポを直接マーケットプレイス参照（main 追従） | スタブが `@main` |

リリース手順: main で開発 → cortex-context で数日〜1週間検証 → Actions の「リリース（stable / v1 を前進）」を実行。

## 案件リポに必要なもの

- `.github/workflows/` に scaffold のスタブ（cron 時刻は案件で調整可）
- `.claude/settings.json`（plugin/scaffold/repo/.claude/settings.json 参照）
- Secrets（案件リポ側の **repo secret**。org secret は Free プランでは private リポに届かない）: `BACKLOG_*` / `AWS_ROLE_TO_ASSUME` / `FIGMA_TOKEN` ＋ **`ENGINE_REPO_TOKEN`**（本リポ read 権限。private エンジンの checkout 用）
- メンバーの手元: リポをトラスト → プラグインインストールの自動案内に「はい」（1人1回）。private マーケットプレイスの自動更新用トークンは `/onboard-member` が案内

## 既知の残作業

### Phase 3: セットアップ・ドキュメントの全面見直し（エンジン分離前提への書き換え）

**残り**: なし（下記完了済みに移動）


**完了済み（2026-07-06）**: setup-status のエンジン分離チェック対応／customize-tooling の eject 方式化／既存案件の移行手順のスキル化（/migrate-to-engine。cortex-context の移行実績 PR #8 を雛形化）／setup-project の scaffold 展開方式化（repo secret 前提・初回同期の Actions 化・notetaker 登録導線・Home.md 記入原則を含む。職能ハーネスの選択は部署側の運用としスキルでは扱わない）／backlog-pull の非常口化／onboard-member の新体験化／fleet-status.mjs のエンジン状態報告／scaffold（repo 一式＋シード README・USAGE・CLAUDE.md）のプラグイン同梱

### その他

- scaffold の `settings.json` の既定カタログは retail-app-harnesses を指している（現在の利用部署が1つのための暫定）。他部署展開時は `{{部カタログ}}` プレースホルダ化して setup-fill で埋める方式に変える
- 精製系ワークフローの schema_version 要求チェック（古いスキーマならスキップ）は未配線
- `autoApply: false` マイグレーションの PR 自動起票は将来拡張
- Team プラン承認後: secrets を org secret へ一元化（ENGINE_REPO_TOKEN・BACKLOG_API_KEY・FIGMA_TOKEN）
- ENGINE_REPO_TOKEN の有効期限 2027-07-07。期限前にローテーション（fleet-status の期限チェック項目化も検討）
