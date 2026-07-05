---
name: customize-tooling
description: 課題管理/デザイン/開発で既定ツール（Backlog/Figma/GitHub）以外を使う場合に、同等の仕組みを設計・改善提案し実装まで行う
---
Cortex は既定で **課題管理＝Backlog / デザイン＝Figma / 開発＝GitHub** を前提に配管が組まれています。案件が別ツール（例: Jira・Notion・Linear / Adobe XD・Penpot / GitLab 等）を使う場合に、**同じことを別ツールで実現する「設計 → 改善提案 → 実装」**までを対話的に行うスキルです。

> **実装方式は eject（能力単位のローカル上書き）**: 仕組みの正本は中央（cortex-engine）にあり案件から直接編集できないため、差し替えは**案件リポ側にローカル実装を置く**形で行います。eject した能力はエンジンの自動更新の対象外になる（その能力だけ案件が自前で面倒を見る）ことをユーザーに伝えて合意を取ってください。

## 大原則（差し替えてよいもの / 守るもの）

Cortex のメダリオン構造は **transport 非依存**。Bronze の取り込み経路が変わっても、Gold 層（コンテキストレイヤー）の価値は失われません。したがって差し替えは最小限に閉じます。

**守る（変えない）**

- ディレクトリの抽象名（`課題管理/` `デザイン/` `開発/`）— ツール名は出さない設計を維持する
- オントロジーの型（`issue` `document` `design` …）と `relations`、Gold 層（`Cortex/`）、Gold 起点の探索戦略
- 「同期ミラーは手編集しない」「1レコード1ファイル」「関係は安定IDで張る」の各原則

**差し替える（ここだけ）**

- Bronze 取り込みの配管（同期スキル・ワークフロー・MCP・Secrets）
- 安定 ID の**導出規則**（型は維持し、ID の作り方だけツールに合わせる）
- ドキュメントのツール参照（`CLAUDE.md` / `README.md` / `setup-project`）

## 手順

### 1. 対象の特定（ヒアリング）

- どの領域か：`課題管理` / `デザイン` / `開発` /（その他の新領域）
- 既定ツール → 置き換え先ツール（例: Backlog → Jira）
- その案件での使われ方（URL、エクスポート手段の有無、MCP の有無、自動化したいか）

### 2. 既定ツールの結合面を棚卸し（差し替えチェックリスト）

領域ごとに、現在ツールに結合している箇所は以下。実装時はこの全項目を漏れなく対応する。

**課題管理（既定: Backlog）**

| 種別           | 対象                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| スキル         | `backlog-pull`（取り込み）/ `backlog-push`（反映）                      |
| 参照スキル     | `catch-up-recent-status` `update-decision-log(-auto)` 等が `課題管理/` を読む |
| ワークフロー   | `.github/workflows/sync-backlog.yml`（cron 同期）/ `backlog-webhook-sync.yml`（Webhookリアルタイム同期の受け側。送信側は cortex-tools の BacklogWebhook Lambda） |
| Secrets        | `BACKLOG_API_KEY` `BACKLOG_DOMAIN` `BACKLOG_PROJECT_KEY`                |
| MCP            | cortexプラグインの `.mcp.json` の Backlog MCP（push 用）                          |
| オントロジーID | `issue` ＝課題キー / `document` ＝ドキュメントID                        |
| ディレクトリ   | `課題管理/issues` `documents` `wiki`                                    |
| ドキュメント   | `CLAUDE.md` / `README.md` / `setup-project`（課題管理同期・Secrets）    |

**デザイン（既定: Figma）**

| 種別           | 対象                                                          |
| -------------- | ------------------------------------------------------------- |
| スキル         | `sync-designs`                                                |
| ワークフロー   | `.github/workflows/sync-designs.yml`                          |
| 設定 / Secret  | `デザイン/figma.json` の `key` / `FIGMA_TOKEN`                |
| オントロジーID | `design` ＝ `design:{fileKey}:{nodeId}`                       |
| ディレクトリ   | `デザイン/inventory`（自動同期・手編集禁止）/ `resources`     |
| ドキュメント   | `setup-project`（デザイン同期セクション）/ `README.md`        |

**開発（既定: GitHub）**

| 種別           | 対象                                                                  |
| -------------- | --------------------------------------------------------------------- |
| スキル         | `clone-dev-repos`（submodule）/ `git-save` `git-pull` `git-fix-push`（`gh`） |
| Issues         | `開発/issues`（GitHub Issues をライブ参照する道しるべ）                |
| submodule      | `.gitmodules`（`src` / `wiki`）                                        |
| CLI            | `gh`（`--repo` 指定）                                                  |
| ドキュメント   | `CLAUDE.md` / `README.md` / `setup-project`（開発リポジトリ）          |

> **開発領域の注意**: Cortex リポジトリ自身のホスティングと CI（GitHub Actions）は GitHub 前提です。ここで差し替えるのは**開発ソースの連携先**（submodule のリモート・Issues のライブ参照先・`gh`→`glab` 等）であり、コンテキストリポジトリ本体の移設は別問題として切り分ける。

### 3. ターゲットツールの能力調査

同等を実現できるかを次の観点で評価する。不明点はユーザーに質問するか、必要に応じて Web 検索で公式ドキュメント（API・CLI・MCP・エクスポート仕様）を確認する。

- **取り込み手段**: CLI / Exporter / 公式 API / MCP / 手動エクスポートのいずれで Markdown（AI フレンドリー形式）に落とせるか
- **安定 ID**: 同期で上書き・改名されても切れない ID が取れるか（例: Jira issue key `PROJ-123`、Notion ページ ID、Penpot の board ID）
- **増分同期**: 「前回以降の更新（updated since）」を取れるか（取れなければフル取得に倒す）
- **自動化**: cron ＋ Secrets で無人同期できるか（できなければ手動同期スキルに留める）

### 4. 設計と改善提案（実装前にレビュー）

調査結果をもとに、次をまとめてユーザーに提示し、**承認を得てから実装する**。

- **同等設計**: 上記チェックリストの各項目を新ツールでどう実現するか
- **安定 ID 規則**: `issue` 等の型は維持し、ID 導出だけを新ツール向けに定義（`ontology.md` に追記）
- **ギャップと改善提案**: 既定構成より良くできる点／できない点（できない場合のフォールバック＝手動運用・代替 ID を明示）
- **影響範囲**: 変更するファイルの一覧

### 5. 実装（eject 方式）

承認後、チェックリストの全項目を**案件リポ側への追加**として反映する（中央のエンジン・プラグインは変更しない）。

- **スキル**: 案件リポの `.claude/skills/<新ツール>-pull/` 等に**ローカルスキルを新規作成**する（例: `jira-pull`）。プラグイン側の既定スキル（`backlog-pull` 等）は消せないため、ローカルスキルの説明文とCLAUDE.mdで「この案件は /backlog-pull ではなく /jira-pull を使う」ことを明示する。実装は既定スキルの構造を参考にし、器の最小主義に従って不要な作り込みはしない
- **ワークフロー**: 該当能力のスタブ（例: `.github/workflows/sync-backlog.yml`）を、**案件リポ内で完結する自前実装のワークフローに差し替える**（エンジンの reusable workflow は呼ばない）。ファイル名は据え置くと fleet-status の run チェックがそのまま効く
- **設定・Secrets**: 案件リポの `.mcp.json`（必要なら新規作成。プラグインのMCP設定と共存できる）・repo Secrets を新ツール用に登録する
- **Home.md の `tools` マップ**を新ツールの値に更新する（fleet-status の applicability 判定が変わる）
- **ID 規則**: 型（`issue` 等）は維持し、新ツールの ID 導出規則を**案件リポの CLAUDE.md（案件固有ブロック）に記載**する。エンジンの `docs/ontology.md`（中央の正本）は案件から直接編集できないため、その規則が他案件にも汎用なら `/submit-feedback` でエンジンへの取り込みを提案する
- `CLAUDE.md` / `README.md` のツール参照・手順を更新する
- `node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"`（プラグイン同梱リンター）で検証する

### 6. 後始末

- 置き換えで不要になった既定ツールのスタブ・Secrets の扱い（削除 or 無効化）をユーザーに確認する
- **eject した能力の一覧を CLAUDE.md の案件固有ブロックに明記する**（「この案件は課題管理を Jira でローカル実装している。エンジン更新の対象外」等。将来のメンバー・巡回エージェントが把握できるように）
- 同期で得た生データは Bronze（手編集しない）である点を新ツールでも徹底する
- 変更を要約し、案件にとって重要な選択であれば `update-decision-log` での記録を提案する

## 注意事項

- **ディレクトリ抽象名とオントロジー型は変えない。変えるのは配管と ID 導出だけ。**
- 取り込みが自動化できないツールでも、手動同期スキル＋ドキュメント整備までは行い「同等の運用」を成立させる
- 機密情報（API キー等）は `.env` / GitHub Secrets に置き、リポジトリにコミットしない
