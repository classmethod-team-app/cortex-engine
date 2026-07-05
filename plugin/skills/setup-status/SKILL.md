---
name: setup-status
description: セットアップの現在の進捗状況を確認し、未完了の項目と次にやるべきことを提示する
---
コンテキストリポジトリのセットアップ（`/setup-project`）が**どこまで完了しているか**を点検し、未対応項目と次のアクションを提示します。**読み取り専用**で、いつでも・何度でも安全に実行できます。中断したセットアップの再開地点の把握や、新メンバーの「このリポジトリ準備できてる？」の確認に使います。

## 進め方

`setup-project` の各ステップに対応する信号を点検し、項目ごとに次のいずれかで報告します。

- ✅ **完了**
- ⬜ **未完**（→ 次にやること）
- ➖ **該当なし**（その案件では不要。理由を添える）

**ツール固有チェックの「該当」判定は `Cortex/Home.md` の `tools`（能力→ツール）に従う**（例: `課題管理: backlog` のときだけ BACKLOG_* を見る／`会議: teams` なら Google系チェックは ➖）。同じ定義で GitHub Actions の `fleet-status`（`scripts/fleet-status.mjs`）が毎日スコア付きで自動採点し `fleet-status.json` を出力する。このスキルはその人手・対話版。

最後に、未完項目を**優先順位付きの「次にやるべきこと」**としてまとめます。判定は推測せず、下記の信号を実際に確認してから行ってください。

## 点検項目（setup-project のステップに対応）

### 1. プレースホルダの展開（setup-fill）

既知トークンがリポジトリに残っていないか確認する。

```bash
grep -rn -E '\{\{(リポジトリ名|プロジェクト名|org|クライアント名|今日8?|今日-[0-9]+)\}\}' . \
  --include='*.md' --include='*.json' --include='*.ts' 2>/dev/null | grep -v node_modules
```

- 残っていれば未完（→ `/setup-project` ステップ2の setup-fill を該当値で再実行）。意図的な保留なら ➖。
- 手動記入用の `{{プロダクト名}}` `{{#______}}` `{{例: ...}}`（`デザイン/DESIGN.md` 等）は対象外。

### 2. Home.md 識別カード

`Cortex/Home.md` の frontmatter `kind` `lifecycle` `client` `tools` 等が埋まり、controlled vocabulary（`kind`: 案件|社内プロジェクト / `lifecycle`: active|archived）を守っているか。特に `tools`（能力→ツール）は以降のツール固有チェックの該当判定に使うので必ず記入する。

### 3. 概要

`CLAUDE.md` の「プロジェクト概要と目的」がシード初期文（空コメント）のままでないか。あわせて**エンジン管理ブロック**（`<!-- cortex-engine:begin/end -->`）が存在するか（無ければ旧方式のリポ → `/migrate-to-engine` を案内）。

### 4. エンジン分離構成

- `.github/workflows/` にエンジンのスタブ（`engine-migrate.yml` の存在で判定）があるか
- `.claude/settings.json` にマーケットプレイス参照（`extraKnownMarketplaces`）と `enabledPlugins` があるか
- `Cortex/Home.md` の `engine:`（`channel` / `schema_version`）が記入されているか
- **無ければ旧方式（テンプレ複製）のリポ** → `/migrate-to-engine` で移行を案内する

> 以下のツール固有チェック（5〜9）は `Cortex/Home.md` の `tools` 宣言で「該当」を判定する。該当しないツールは ➖。

### 5. 課題管理ツールとの同期

（`tools.課題管理 == backlog`）`課題管理/issues/` に同期済みデータがあるか（空なら → Secrets 登録後に `gh workflow run sync-backlog.yml` で初回同期。ローカル実行は非常口）。Backlog 以外なら ➖。

### 6. GitHub Actions Secrets

**`ENGINE_REPO_TOKEN`（エンジン checkout 用・必須）**、`AWS_ROLE_TO_ASSUME`（夜間AIジョブ/Bedrock用）と、`tools` に応じたツール用シークレットが設定済みか。`BACKLOG_API_KEY`/`BACKLOG_DOMAIN`/`BACKLOG_PROJECT_KEY`（`課題管理 == backlog`）、`FIGMA_TOKEN`（`デザイン == figma`）。いずれも **repo secret**（org secret は Free プランでは private リポに届かない）。CI 内では `secrets.X != ''` で有無を判定できる（`gh secret list` には権限が要る。確認できなければ「未確認」とする）。

### 7. 開発リポジトリ（submodule）

（`tools.開発 == github`）`git submodule status` で開発リポが submodule として初期化済みか。ソースコードを同梱しない案件は ➖（→ 作成後に `/clone-dev-repos`）。

### 8. デザイン（Figma）

（`tools.デザイン == figma`）`デザイン/figma.json` の `key` が設定済みか・`FIGMA_TOKEN` があるか・`デザイン/inventory` が同期済みか。Figma 以外/使わない案件は ➖。

### 9. 会議（文字起こしの自動取り込み）

（`tools.会議 == google-meet`）`会議/ingest-config.json` の `enabled` が `true` で、`会議/` に自動取り込みされた文字起こし・議事録があるか（cortex-notetaker 連携。中央の艦隊レジストリ登録は `/setup-project` ステップ12参照）。Teams 等なら ➖。

### 10. README の案件化

`README.md` に途中参加者向けの案内（`/onboard-member` への導線）があり、使用ツールのリンクが記入されているか（→ `/setup-project` ステップ13）。

### 11. スキーマ検証

`node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"`（プラグイン同梱リンター） が通るか（Gold 層 frontmatter がオントロジー規約に適合しているか）。

## 出力

- 上記をステップ順に ✅ / ⬜ / ➖ で一覧化する
- 「次にやるべきこと」を優先度付きで提示する（依存関係を考慮：例 setup-fill → tools記入 → 課題管理同期 → Secrets → submodule）
- `Cortex/Home.md` の `tools` が既定（`課題管理: backlog` / `会議: google-meet` / `共有資料: google-drive` / `チャット: slack` / `デザイン: figma` / `開発: github`）以外の場合はその値に更新し、必要なら `/customize-tooling` を案内する

## 注意事項

- このスキルは**読み取り専用**。状態を変更しない（チェックのみ）
- 「未完」と「該当なし」を必ず区別し、使わない機能を未完として誤報告しない
- 判定はファイル・コマンド出力の実確認に基づく（推測しない）
