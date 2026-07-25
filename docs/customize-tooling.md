# 既定外ツールへの差し替えの考え方

Cortex は既定で **課題管理＝Backlog / デザイン＝Figma / 開発＝GitHub / 会議＝Google Meet / チャット＝Slack** を前提に配管が組まれている。案件が別ツール（Jira・Notion・Linear / Adobe XD・Penpot / GitLab 等）を使う場合に、**同じことを別ツールで実現する**ための設計指針をまとめる。

> かつては対話スキル（customize-tooling）で行っていたが、全案件が既定ツール構成で出番が無く、対話手順である必要が薄いため、考え方をこの1ページに集約した。実際の差し替えは案件の判断で fleet 管理者と相談して実施する。

## 大原則（差し替えてよいもの / 守るもの）

Cortex のメダリオン構造は **transport 非依存**。Bronze の取り込み経路が変わっても、Gold 層（コンテキストレイヤー）の価値は失われない。差し替えは最小限に閉じる。

**守る（変えない）**

- ディレクトリの抽象名（`課題管理/` `デザイン/` `開発/`）— ツール名は出さない設計を維持する
- オントロジーの型（`issue` `document` `design` …）と `relations`、Gold 層（`Cortex/`）、Gold 起点の探索戦略
- 「同期ミラーは手編集しない」「1レコード1ファイル」「関係は安定IDで張る」の各原則

**差し替える（ここだけ）**

- Bronze 取り込みの配管（同期スキル・ワークフロー・MCP・Secrets）
- 安定 ID の**導出規則**（型は維持し、ID の作り方だけツールに合わせる）
- ドキュメントのツール参照（`CLAUDE.md` / `README.md`）

## 実装方式は eject（能力単位のローカル上書き）

仕組みの正本は中央（cortex-engine）にあり案件から直接編集できない。差し替えは**案件リポ側にローカル実装を置く**形で行う。eject した能力はエンジンの自動更新の対象外になる（その能力だけ案件が自前で面倒を見る）。

- **スキル**: 案件リポの `.claude/skills/<新ツール>-pull/` 等にローカルスキルを新規作成する（例: `jira-pull`）。プラグイン側の既定スキル（`backlog-pull` 等）は消せないので、CLAUDE.md で「この案件は `/backlog-pull` ではなく `/jira-pull` を使う」ことを明示する
- **ワークフロー**: 該当能力のスタブ（例: `.github/workflows/sync-backlog.yml`）を案件リポ内で完結する自前実装に差し替える（エンジンの reusable workflow は呼ばない）。**ファイル名は据え置く**と fleet-status の run チェックがそのまま効く
- **設定・Secrets**: 案件リポの `.mcp.json`（必要なら新規作成。プラグインの MCP 設定と共存できる）・repo Secrets を新ツール用に登録する
- **Home.md の `tools` マップ**を新ツールの値に更新する（fleet-status の applicability 判定が変わる）
- **ID 規則**: 型（`issue` 等）は維持し、新ツールの ID 導出規則を**案件リポの CLAUDE.md（案件固有ブロック）に記載**する。他案件にも汎用なら `/submit-feedback` でエンジンへの取り込みを提案する

## 能力ごとの結合面（差し替えチェックリスト）

差し替え時はこの全項目を漏れなく対応する。

**課題管理（既定: Backlog）**: 同期スキル（`backlog-pull`/`backlog-push`）・`課題管理/` を読む参照スキル（`catch-up-recent-status`・`update-gold` 等）・ワークフロー（`sync-backlog.yml`・`backlog-webhook-sync.yml`）・Secrets（`BACKLOG_API_KEY`/`BACKLOG_DOMAIN`/`BACKLOG_PROJECT_KEY`）・MCP（Backlog MCP）・オントロジーID（`issue`＝課題キー / `document`＝ドキュメントID）・ディレクトリ（`課題管理/issues`・`documents`・`wiki`）・ドキュメント参照

**デザイン（既定: Figma）**: スキル（`sync-designs`）・ワークフロー（`sync-designs.yml`）・設定/Secret（`デザイン/figma.json` の `key`・`FIGMA_TOKEN`）・オントロジーID（`design`＝`design:{fileKey}:{nodeId}`）・ディレクトリ（`デザイン/inventory`・`resources`）

**開発（既定: GitHub）**: submodule（`.gitmodules` の `src`/`wiki`）・`開発/issues`（GitHub Issues のライブ参照）・CLI（`gh` の `--repo` 指定）・ドキュメント参照

> **開発領域の注意**: Cortex リポジトリ自身のホスティングと CI（GitHub Actions）は GitHub 前提。差し替えるのは**開発ソースの連携先**（submodule のリモート・Issues のライブ参照先・`gh`→`glab` 等）であり、コンテキストリポジトリ本体の移設は別問題。

## ターゲットツールの能力調査の観点

- **取り込み手段**: CLI / Exporter / 公式 API / MCP / 手動エクスポートのいずれで Markdown（AI フレンドリー形式）に落とせるか
- **安定 ID**: 同期で上書き・改名されても切れない ID が取れるか（例: Jira issue key、Notion ページ ID、Penpot board ID）
- **増分同期**: 「前回以降の更新（updated since）」を取れるか（取れなければフル取得に倒す）
- **自動化**: cron ＋ Secrets で無人同期できるか（できなければ手動同期スキルに留める）

取り込みが自動化できないツールでも、手動同期スキル＋ドキュメント整備までは行い「同等の運用」を成立させる。ディレクトリ抽象名とオントロジー型は変えない。変えるのは配管と ID 導出だけ。
