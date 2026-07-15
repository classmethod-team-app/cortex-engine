---
name: setup-project
description: 案件コンテキストリポジトリの新規セットアップを対話的に実行する（scaffold展開・プレースホルダ記入・Secrets登録・初回同期・自動取り込み設定）
---
案件コンテキストリポジトリの新規セットアップをステップごとに実行します。各ステップでユーザーに確認しながら進めてください。

## 前提条件

**Claude Code と gh（GitHub CLI・認証済み）だけ**が必要です。Node / pnpm / mise 等のランタイムは不要です（仕組みはすべて cortex プラグインと GitHub Actions が提供する）。`gh auth status` で認証を確認し、未認証なら `gh auth login` を案内してください。

> 既に運用中のリポジトリを旧方式（テンプレ複製）からエンジン分離構成へ**移行**する場合は、本スキルではなく移行手順（cortex-engine の Phase 2 手順）を使うこと。本スキルは**ゼロからの新規作成**用。

## ステップ0: 空リポジトリの作成と scaffold の展開

1. 空のprivateリポジトリを作成してクローンする（リポジトリ名は任意）:

```bash
gh repo create <GitHub Organization名>/<リポジトリ名> --private --clone
cd <リポジトリ名>
```

2. プラグイン同梱の scaffold（案件リポの初期骨格）を展開する。Skill 起動時に提示される **「Base directory for this skill」** の絶対パスを `<SKILL_DIR>` として使う:

```bash
cp -R "<SKILL_DIR>/../../scaffold/repo/." .
git add -A && git commit -m "cortex scaffoldを展開" && git push
```

これで、データディレクトリの骨格・ワークフロースタブ（`.github/workflows/`）・プラグイン参照（`.claude/settings.json`）・シード文書（CLAUDE.md / README.md / USAGE.md）が入ります。

## ステップ1: プロジェクト情報の取得

**リポジトリ名（`{{リポジトリ名}}`）と GitHub Organization名（`{{org}}`）は git remote から自動で導出し、そのまま使います**。

| 項目 | プレースホルダー | 取得方法 | 例 |
| --- | --- | --- | --- |
| リポジトリ名 | `{{リポジトリ名}}` | git remote から導出（自動） | `my-project-context` |
| GitHub Organization名 | `{{org}}` | git remote から導出（自動） | `my-org` |
| プロジェクト名 | `{{プロジェクト名}}` | **ヒアリング** | `XX様向けYYシステム開発` |
| クライアント名 | `{{クライアント名}}` | **ヒアリング** | `XX株式会社` |
| 開発リポ（任意） | `{{開発リポ}}` | **ヒアリング**: ソースコードのリポジトリがあれば `owner/repo`。無ければ保留し `/clone-dev-repos` 時に設定 | `my-org/my-app` |

## ステップ2: プレースホルダの一括埋め込み（setup-fill）

ステップ1で得た値で、リポジトリ全体のセットアップ用プレースホルダ（二重ブレース `{{ }}`）を一括置換します。

```bash
node "<SKILL_DIR>/scripts/setup-fill.mjs" \
  --リポジトリ名="<リポジトリ名>" \
  --プロジェクト名="<プロジェクト名>" \
  --org="<GitHub Organization名>" \
  --クライアント名="<クライアント名>" \
  --開発リポ="<owner/repo（任意・無ければ省略）>"
```

> このスクリプトの実行にだけ Node が要ります。無い環境では、Claude 自身が `{{ }}` を Grep して同じ置換ルール（下記）で手で埋めてもよい（対象は少数）。

このスクリプトが行うこと:

- `{{リポジトリ名}}` / `{{プロジェクト名}}` / `{{org}}` / `{{クライアント名}}` / `{{開発リポ}}` を指定値に置換（省略した引数は保留として警告）
- `{{今日}}`（YYYY-MM-DD）・`{{今日8}}`（YYYYMMDD）を**実行日**で置換し、Gold層サンプル（Decisions・レポート）の日付・ID・ファイル名を実行日に揃える

**答えられない項目は省略して保留にできます**（冪等なので、値が決まったらその項目だけ渡して再実行すれば埋まります）。**値が存在しない項目は空文字で埋めます**（例: 社内プロジェクトは `--クライアント名=""`）。

## ステップ3: 初期コミット＆push

```bash
git add -A && git commit -m "セットアップ: プレースホルダを案件の値で埋める" && git push
```

## ステップ4: Home.md 識別カードと CLAUDE.md 概要の仕上げ

`Cortex/Home.md` の**識別カード**（巡回エージェントが横断走査時に最初に読む frontmatter）の選択値を記入します。controlled vocabulary を守ること（規約の正本は cortex-engine の `docs/ontology.md`）。

| frontmatterキー | 記入内容 |
| --- | --- |
| `kind` | `案件` \| `社内プロジェクト` |
| `org` | 部署（例: `リテールアプリ共創部`）※GitHub Organizationとは別物 |
| `team` | チーム（任意） |
| `lifecycle` | `active`（終了時に `archived`） |
| `adoption` | `new` / `existing` / `migration`。ユーザーに「新規案件で導入か／進行中の案件に後から導入か／旧Cortexから移行か」を確認 |
| `domains` / `platforms` | リスト（例: `[retail, 会員証]` / `[Web, LINE miniapp]`） |
| `tools` | **能力→ツールのマップ**（課題管理/会議/共有資料/チャット/デザイン/開発）。各能力で使うツールをユーザーに確認して記入。使わない能力は `none`。既定以外のツールは後で `/customize-tooling` |

あわせて:

- `CLAUDE.md` の「プロジェクト概要と目的」を案件に合わせて記入する（**エンジン管理ブロック `<!-- cortex-engine:begin/end -->` は触らない**）
- `Cortex/Home.md` の「使用ツール」節に実ツールのリンクを記入する。**エンジン・プラグイン等「仕組み」への参照は書かない**（Home.md は Viewer の入口＝顧客も読む面。仕組みの参照は CLAUDE.md が持つ）

記入後 `node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"`（プラグイン同梱リンター）で検証します。

## ステップ5: 部カタログの確認

`.claude/settings.json` のマーケットプレイス参照が、**この案件が属する部署のカタログ**になっているか確認します（scaffold には既定のカタログが入っている。別部署で使う場合は自部署のカタログリポに差し替える）。

> cortex 以外のプラグイン（部署の職能ハーネス等）を案件で使うかどうかは**部署・案件側の運用**であり、本スキルでは扱わない。必要になったら `enabledPlugins` に `"<プラグイン名>@<カタログ名>": true` を1行追記してコミットすれば、その案件の全メンバーに自動で行き渡る——という仕組みだけをユーザーに伝えておく。

## ステップ6: GitHub Actions Secrets の登録

自動化（同期・精製）に必要な Secrets を**リポジトリの repo secret** として登録します（**org secret は Free プランでは private リポに届かない**ため使わない）。

| Secret | 用途 | 値の入手 |
| --- | --- | --- |
| `ENGINE_REPO_TOKEN` | エンジン（private）の checkout。**必須** | cortex-engine への read 専用 Fine-grained PAT（Resource owner=`classmethod-team-app` / Repository access=`cortex-engine` のみ / Permissions=Contents: Read-only）。チームで共有している既存トークンがあればそれを使う |
| `BACKLOG_DOMAIN` / `BACKLOG_PROJECT_KEY` | Backlog 同期の対象 | 下記のとおり URL から抽出 |
| `BACKLOG_API_KEY` | Backlog API | Backlog の個人設定 → API から発行（同期専用ユーザー推奨） |
| `AWS_ROLE_TO_ASSUME` | 夜間の AI 精製ジョブ（Bedrock/OIDC） | cortex-tools/infra のオンボーディングで発行される RoleArn（fleet 管理者に依頼） |
| `FIGMA_TOKEN` | デザイン同期（Figma 案件のみ） | ステップ9参照 |

**Backlog の DOMAIN / PROJECT_KEY は URL から読み取れます**。ユーザーに Backlog のURL（プロジェクトトップ・課題・ボード等どれでも可）を1つ貼ってもらい、次のルールで抽出して確認を取ってください:

- `DOMAIN` = ホスト名（例: `cm1.backlog.jp`）
- `PROJECT_KEY` = パスの `/projects/<KEY>`・`/view/<KEY>-<番号>`・クエリ `?projectKey=<KEY>` 等に現れるキー（英大文字・数字・`_`）
- 例: `https://cm1.backlog.jp/projects/PJ_CORTEX` → `DOMAIN=cm1.backlog.jp` / `PROJECT_KEY=PJ_CORTEX`

```bash
gh secret set ENGINE_REPO_TOKEN     # 以降、リポジトリ内で実行すれば対象リポは自動判定される
gh secret set BACKLOG_DOMAIN
gh secret set BACKLOG_PROJECT_KEY
gh secret set BACKLOG_API_KEY
gh secret set AWS_ROLE_TO_ASSUME    # 未発行なら保留可（夜間AIジョブは未設定を検知して安全にスキップする）
```

> Backlog を使わない案件（`tools.課題管理: none` 等）は BACKLOG_* をスキップしてください。

## ステップ7: 初回同期の起動（Actions で実行）※忘れない

> ⚠️ **Secrets を登録しただけでは中身は入りません。** 各同期ワークフローを**1度だけ手動起動**して初回取り込みを行うこと（以後は cron / Webhook が自動で維持する）。「セットアップは終わったのにリポが空」の典型原因がこの起動漏れです。

**ローカルに API キーを置く必要はありません。** Secrets 登録が済んだら、Actions 側で初回同期を起動します:

```bash
gh workflow run sync-backlog.yml
gh run watch $(gh run list --workflow=sync-backlog.yml --limit 1 --json databaseId --jq '.[0].databaseId')
git pull
```

`課題管理/` に課題・ドキュメント・Wiki が入っていれば成功です。以後は自動（Webhook＋毎時cron）で維持されます。

- **初回は自動で全量取得(`all`)されます**: `sync-backlog` は `backlog-settings.json` の有無を見て、無ければ全量 `all`・あれば増分 `update` を自動選択する。新規リポでも手動の全量取得は不要。
- **他の初回同期も同様に起動する**: Figma を使う案件は `gh workflow run sync-designs.yml`（ステップ9）。既存案件で過去分の議事録・課題からGold層(Decision/用語)をすぐ埋めたい場合は `gh workflow run update-gold.yml` も起動できる（任意・大きめのBedrock実行1回）。
- 非常口: どうしても Actions 経由で取れない場合のみ、ローカル実行（`export BACKLOG_API_KEY=…; npx backlog-exporter@1 all --domain $DOMAIN --projectIdOrKey $PROJECT_KEY --output ./課題管理` → commit/push）。この場合のみ手元にAPIキーが要る。

## ステップ8: Backlog リアルタイム同期の有効化（任意・推奨）

課題・Wiki の更新を**数十秒でリポジトリに反映**したい場合（受け側のスタブ `backlog-webhook-sync.yml` は展開済み）:

1. **（fleet管理者に依頼）** `cortex-tools/infra/config.ts` の該当案件エントリに `backlogSpace` / `backlogProjectKey` / `backlogRealtime: true` を追記し、`npx cdk deploy BacklogWebhook` を実行してもらう（Webhook URL＋秘密トークンを受け取る）
2. **（Backlogプロジェクト管理者）** Backlog のプロジェクト設定 → インテグレーション → Webhook に受け取った URL を登録。通知イベントは**課題の追加/更新/コメント/削除/まとめて更新＋Wikiの追加/更新/削除**にチェック

> ドキュメントは Backlog 側に更新イベントが無いため、毎時の定期同期が担当します。定期同期はリアルタイムの取りこぼしを回収する安全網として併走します。

## ステップ9: デザイン同期（Figma を使う案件のみ）

1. `デザイン/figma.json` の `key` に対象 Figma ファイルのキー（`figma.com/design/<この部分>/...`）を記入
2. `FIGMA_TOKEN` を repo secret に登録（`gh secret set FIGMA_TOKEN`）。トークンの Figma アカウントを**対象ファイルに閲覧者として招待**しておくこと（招待が無いとトークンが有効でも読めない）
3. 初回インベントリ生成: `gh workflow run sync-designs.yml` → `git pull`（**ローカルに Figma トークン不要**）

## ステップ10: 開発リポジトリのクローン（任意）

ソースコードリポジトリが既にあるなら `/clone-dev-repos` で submodule として取り込みます。まだ無ければスキップし、作成後に実行するよう案内してください。

## ステップ11: チャット（Slack / Teams）連携（任意）

チャットツール（`slack` | `teams` | `none`）をユーザーに確認し、`Cortex/Home.md` の `tools.チャット` に反映します（ステップの `tools` マップと整合させる）。`none` ならスキップ可。

参照したいチャンネル（複数可・チャンネル名とリンク）をユーザーに尋ね、`チャット/channels.json` の `channels` 配列に `{ "name": "...", "platform": "slack|teams", "url": "..." }` 形式で登録します（各チャンネルに `platform` を付ける。省略時は `slack`）。あわせて次を伝えてください:

- 内容は Claude Code から **MCP 経由でライブ参照**する（`/read-chat`）。**リポジトリには取り込まれない**ため顧客には見えない（MCP に接続できるのは社内メンバーだけ＝公開範囲の境界。Slack / Teams いずれも同一）
- **Slack**: cortexプラグインの `.mcp.json` の `slack` サーバに OAuth 接続する。
- **Teams**: 公用ホスト型 MCP が無いため、`.mcp.json` にはハードコードしていない。**テナントごとに Azure AD アプリ登録＋Graph 権限＋テナント認証**を行い、各自の Claude Code の MCP 設定に Teams MCP を接続する（接続方法は `/read-chat` の前提節を参照）。

## ステップ12: 会議の自動取り込み設定（任意）

> `tools` の `会議: google-meet` で、文字起こしの**自動取り込み**を使う案件のみ。手動運用（`/post-meeting` を都度実行）だけならスキップ可。

仕組みは「**cortex-notetaker bot を会議に招待 → bot に共有された文字起こしを中央 Apps Script が案件リポへ取り込む**」。**対象はクラスメソッド側が主催する Google Meet のみ**（顧客主催・Teams 等は `/post-meeting` で手動取り込み）。

ルーティングの優先順: ①会議名に**案件キー**（艦隊レジストリの `key`）→ ②会議名に**クライアント名**（Home.md の `client`）→ ③`会議/ingest-config.json` の `meetingNamePatterns`。

セットアップ手順:

1. `会議/ingest-config.json` の `enabled` を `true` にする
2. **（fleet管理者に依頼・重要）** この案件を中央の艦隊レジストリ `cortex-tools/infra/config.ts` の `projects` に登録してもらう（リポ名・案件キー。Viewer 等のインフラと共通の1エントリ）。あわせて中央の `GITHUB_TOKEN`(PAT) の対象リポに本リポが含まれるかも確認
3. **運用ルールをユーザーに案内**: 対象の会議名の頭に**案件キーを付け**（例:「【KC】定例」）、**cortex-notetaker bot を会議の招待に追加**する（定例はシリーズに1回）。新しい定例を始めるPMに伝えることはこの2つだけ
4. ①②で当たらない場合のみ `meetingNamePatterns` に固有の会議名を足す（「定例」のような汎用語は他案件を誤って引き込むため入れない）

> どの案件にも一致しなかった文字起こしは中央 inbox（未仕分け）に入り、データは失われません。

## ステップ13: README の仕上げ

シードの README は案件リポ前提で書かれているため、大きな書き換えは不要です。以下だけ確認・記入します:

- 冒頭に途中参加者向けの案内（「新しく参加した方はまず `/onboard-member` を実行」）を目立つ位置に置く
- 案件で実際に使うツールの URL を記載し、`Cortex/Home.md` の「使用ツール」と齟齬がないようにする

## 仕上げ: セットアップ状況の確認

最後に `/setup-status` を実行し、全ステップの完了状況と未対応項目を確認します。中断して後日再開する場合も、まず `/setup-status` で現在地を把握してから続きを進められます。

## 注意事項

- 各ステップで実行前にユーザーに確認を取ってください
- APIキー等の機密情報は**リポジトリにコミットしない**。自動化は GitHub Actions Secrets（ステップ6）、手元実行用の認証情報は環境変数（保存場所は動作環境で変わる → `credentials` ルール参照）
- メンバー個人のローカル環境準備（プラグイン導入・push 用の個人 API キー等）は本スキルの対象外。`/onboard-member` に委譲する
