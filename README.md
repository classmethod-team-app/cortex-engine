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
├── docs/                             # 規約の正本（ontology.md / credentials.md）
└── scaffold/                         # 案件リポの初期骨格（スタブ・settings.json）
```

## 配布とチャンネル

| チャンネル | 対象 | プラグイン | GHA |
| --- | --- | --- | --- |
| **安定** | 全案件リポ | 部カタログ（retail-app-harnesses 等）が `ref: stable` でピン | スタブが `@v1`（移動タグ） |
| **カナリア** | cortex-context | 本リポを直接マーケットプレイス参照（main 追従） | スタブが `@main` |

リリース手順: main で開発 → cortex-context で数日〜1週間検証 → Actions の「リリース（stable / v1 を前進）」を実行。

## 案件リポに必要なもの

- `.github/workflows/` に scaffold のスタブ（cron 時刻は案件で調整可）
- `.claude/settings.json`（scaffold/claude-settings.json 参照）
- Secrets（従来どおり案件リポ側）: `BACKLOG_*` / `AWS_ROLE_TO_ASSUME` / `FIGMA_TOKEN` ＋ **`ENGINE_REPO_TOKEN`**（本リポ read 権限。org secret 推奨。private エンジンの checkout 用）
- メンバーの手元: リポをトラスト → プラグインインストールの自動案内に「はい」（1人1回）。private マーケットプレイスの自動更新用トークンは `/onboard-member` が案内

## 既知の残作業

### Phase 3: セットアップ・ドキュメントの全面見直し（エンジン分離前提への書き換え）

セットアップ導線・スキル・README/USAGE は旧テンプレ複製方式（rulesync・mise・pnpm・ローカル同期前提）の記述が残っている。scaffold 方式への改修時に以下をまとめて見直す。

**setup-project の改修**
- rulesync / mise / pnpm のセットアップ手順を全廃（Claude Code＋プラグインのみで完結させる）
- scaffold 展開方式へ: データ骨格＋スタブ＋`.claude/settings.json` を空リポに展開
- repo secrets の登録ガイドを組み込む: `BACKLOG_*`・`AWS_ROLE_TO_ASSUME`・`FIGMA_TOKEN`・`ENGINE_REPO_TOKEN`（org は Free プランのため **repo secret 必須**）
- **初回の Backlog 全量同期はローカルで pull しない**: secrets 登録後に `gh workflow run sync-backlog.yml` で Actions 側に実行させる（API キーをメンバーのマシンに置かずに済む）
- **ローカル BACKLOG_API_KEY は「/backlog-push を使う人だけのオプション」に格下げ**: 読みは自動同期＋/git-pull で足りる。閲覧中心のメンバーへのキー配布を廃止（クレデンシャル露出面の縮小）
- **会議 bot（cortex-notetaker）のセットアップ手順を明記**: (a) cortex-tools の艦隊レジストリ（config.ts）へ案件（リポ＋案件キー）を登録、(b) `会議/ingest-config.json` に取り込みパターンを記入、(c) 運用ルール（会議名の頭に案件キー・bot を招待）の案内。(a) はリポ外の作業なので導線が特に重要

**スキルの改修**
- `/backlog-pull`: 説明を「普段は不要（Webhook＋cron で自動同期済み）。セットアップ初回・Webhook 未設定案件・Actions 障害時の非常口」に書き換え
- `/onboard-member`: mise/pnpm 手順を削除。プラグインインストール（トラスト時 1 クリック）＋自動更新トークン設定（1Password）＋「push を使うか」ヒアリングによる Backlog キー配布の要否判定に変更
- `/setup-status`・`scripts/fleet-status.mjs`: チェック項目を新構成に更新（rulesync 生成物チェック→プラグイン/スタブ/ENGINE_REPO_TOKEN/engine.channel チェックへ。engineVersion・schema_version の報告は fleet-status.yml で環境変数まで配線済み・スクリプト側の出力対応が未了）
- `/customize-tooling`: リポ内スキル書き換え方式→eject（能力単位のローカル上書き）方式へ改修

**Home.md（Viewer 表面）の記入原則を setup-project・シードに明文化**
- `Cortex/Home.md` は AIS Viewer の入口（顧客・部外者が読む面）。**エンジン・ハーネス・スタブ等「仕組み」への参照を書かない**。使用ツール欄に載せるのは読者の判断材料になるもの（課題管理・ドキュメント・デザイン等の実ツール）だけ
- 仕組みの参照（cortex-engine・プラグイン・ワークフロー）は CLAUDE.md（AI・メンバー向け）と README が持つ

**README / USAGE（scaffold 同梱のシード文書）の全面書き換え**
- 「テンプレートから複製」→「scaffold から展開」への前提変更
- コマンド一覧をプラグイン配布前提に（`.rulesync/` 関連の記述を全廃）
- セットアップ前提条件から mise / pnpm / Node を削除
- コンテキストの流れ図を Webhook リアルタイム同期・エンジン分離後の姿に更新

### その他

- 精製系ワークフローの schema_version 要求チェック（古いスキーマならスキップ）は未配線
- `autoApply: false` マイグレーションの PR 自動起票は将来拡張
- Team プラン承認後: secrets を org secret へ一元化（ENGINE_REPO_TOKEN・BACKLOG_API_KEY・FIGMA_TOKEN）
- ENGINE_REPO_TOKEN の有効期限 2027-07-07。期限前にローテーション（fleet-status の期限チェック項目化も検討）
