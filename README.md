# cortex-engine — Cortex エンジン（フレームワーク中央リポジトリ）

案件コンテキストリポジトリ（[Cortex](https://github.com/classmethod-internal/aidd-project-cortex)）を動かす**仕組みの正本**。案件リポには「データ＋薄い設定」だけを置き、スキル・ワークフロー・スクリプト・マイグレーションはここで一元的に版管理して全案件に配布する。

> 設計の全体像は設計書（aidd-project-cortex の `tmp/Cortex-エンジン分離-設計書.md`）を参照。

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
│   ├── skills/                       # スキル23本（旧テンプレの .rulesync/skills から移設。rulesync-generate / update-from-template は廃止）
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

**残り**

- `/setup-status`: チェック項目を新構成に更新（rulesync 生成物チェック→プラグイン/スタブ/ENGINE_REPO_TOKEN/engine.channel チェックへ。fleet-status.mjs は対応済みなので定義を揃える）
- `/customize-tooling`: リポ内スキル書き換え方式→eject（能力単位のローカル上書き）方式へ改修


**完了済み（2026-07-06）**: 既存案件の移行手順のスキル化（/migrate-to-engine。cortex-context の移行実績 PR #8 を雛形化）／setup-project の scaffold 展開方式化（repo secret 前提・初回同期の Actions 化・notetaker 登録導線・Home.md 記入原則を含む。職能ハーネスの選択は部署側の運用としスキルでは扱わない）／backlog-pull の非常口化／onboard-member の新体験化／fleet-status.mjs のエンジン状態報告／scaffold（repo 一式＋シード README・USAGE・CLAUDE.md）のプラグイン同梱

### その他

- scaffold の `settings.json` の既定カタログは retail-app-harnesses を指している（現在の利用部署が1つのための暫定）。他部署展開時は `{{部カタログ}}` プレースホルダ化して setup-fill で埋める方式に変える
- 精製系ワークフローの schema_version 要求チェック（古いスキーマならスキップ）は未配線
- `autoApply: false` マイグレーションの PR 自動起票は将来拡張
- Team プラン承認後: secrets を org secret へ一元化（ENGINE_REPO_TOKEN・BACKLOG_API_KEY・FIGMA_TOKEN）
- ENGINE_REPO_TOKEN の有効期限 2027-07-07。期限前にローテーション（fleet-status の期限チェック項目化も検討）
