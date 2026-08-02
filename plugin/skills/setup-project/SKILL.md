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
| 開発リポ（任意） | `{{開発リポ}}` | **ヒアリング**: ソースコードのリポジトリがあれば `owner/repo`。無ければ保留し、後で開発リポの submodule 取り込み時に設定 | `my-org/my-app` |

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
| `tools` | **能力→ツールのマップ**（課題管理/会議/共有資料/チャット/デザイン/開発）。各能力で使うツールをユーザーに確認して記入。使わない能力は `none`。既定以外のツールを使う場合は差し替え設計が必要（cortex-engine の `docs/customize-tooling.md` 参照） |

あわせて:

- `CLAUDE.md` の「プロジェクト概要と目的」を案件に合わせて記入する（**エンジン管理ブロック `<!-- cortex-engine:begin/end -->` は触らない**）
- **`Cortex/Home.md` の「このプロジェクトが目指すもの」節をユーザーに聞いて記入する**（最重要。AIはここを読んで判断の方向を決め、人もここで案件の意味を掴む）。2項目とも埋める:
  - **解きたいこと**: 誰の・何の課題を・どう解くか。滅多に変わらない北極星として書く（例: 紙の会員証を運用している店舗スタッフと会員の手間をなくし、提示・確認を数秒で終わらせる）
  - **達成した状態**: どうなったら成功と言えるか（例: 全店舗でミニアプリの会員証が使われ、紙の発行を停止できている）
  - **日付・進捗・実績値は書かない**（変動するものの正本は課題管理ツール等の外部。ここには方向と完了条件だけを置く）
- `Cortex/Home.md` の「使用ツール」節に実ツールのリンクを記入する。**エンジン・プラグイン等「仕組み」への参照は書かない**（Home.md は Viewer の入口＝顧客も読む面。仕組みの参照は CLAUDE.md が持つ）

記入後 `node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"`（プラグイン同梱リンター）で検証します。

## ステップ5: プラグイン配布点の確認

`.claude/settings.json` が cortex をエンジンリポから安定チャンネルで参照しているか確認します（scaffold の既定＝マーケットプレイス `cortex-engine` を `ref: stable` で参照し、`cortex@cortex-engine` を有効化。**通常は変更不要**。エンジン開発の先行検証に使う案件だけ `ref` を外して main 追従にする）。

> cortex 以外のプラグイン（部署の職能ハーネス等）を案件で使うかどうかは**部署・案件側の運用**であり、本スキルでは扱わない。職能ハーネスは private の部カタログにあり社内メンバーしか入れられないため、**顧客が見る案件リポには宣言せず、使う人が各自で導入する**（手順は cortex-engine の `docs/onboarding.md`）——という運用だけをユーザーに伝えておく。

> **設定は宣言であり、自動インストールではない**: `.claude/settings.json` の `enabledPlugins` を宣言しても、外部ソースのプラグインは各メンバーが `claude plugin install` するまでロードされない（Claude Code の現行仕様）。セットアップ完了後、メンバーには `docs/onboarding.md` の導入手順を案内すること。

## ステップ6: GitHub Actions Secrets の登録

自動化（同期・精製）に必要な Secrets を**リポジトリの repo secret** として登録します（**org secret は Free プランでは private リポに届かない**ため使わない）。

| Secret | 用途 | 値の入手 |
| --- | --- | --- |
| `ENGINE_REPO_TOKEN` | エンジン（private）の checkout。**必須** | cortex-engine への read 専用 Fine-grained PAT（Resource owner=`classmethod-team-app` / Repository access=`cortex-engine` のみ / Permissions=Contents: Read-only）。チームで共有している既存トークンがあればそれを使う |
| `BACKLOG_DOMAIN` / `BACKLOG_PROJECT_KEY` | Backlog 同期の対象 | 下記のとおり URL から抽出 |
| `BACKLOG_API_KEY` | Backlog API | Backlog の個人設定 → API から発行（同期専用ユーザー推奨） |
| `AWS_ROLE_TO_ASSUME` | 夜間の AI 精製ジョブ（Bedrock/OIDC） | cortex-tools/infra のオンボーディングで発行される RoleArn（fleet 管理者に依頼） |
| `FIGMA_TOKEN` | デザイン同期（Figma 案件のみ） | ステップ9参照 |
| `EXTERNAL_SOURCES_TOKEN` | 外部ソース（GitHub Issues/Discussions）を Gold 昇格の抽出源にする案件のみ（ステップ11.5） | 対象リポの Contents/Issues: Read（Discussions を使うなら Discussions: Read）を持つ Fine-grained PAT。未設定なら case repo の github.token で読める範囲（公開/同一リポ）に限られる |
| `SLACK_BOT_TOKEN` | Slack を外部ソースにする案件のみ（ステップ11.5） | Slack App の Bot Token（`xoxb-`）。`conversations.history`/`groups:history`/`channels:read`/`users:read` スコープを付けてワークスペースにインストール。**Enterprise Grid では org 管理者の承認が要る場合あり**。中央 Bot を使う場合は `sync-fleet-secrets` で配布できる |

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

**同じ `DOMAIN` をリポジトリの `.mcp.json` にも記入します。** ルートの `.mcp.json`（Backlog・GitHub の MCP サーバー定義を標準同梱）にあるプレースホルダ `<backlog-domain>` を、上で抽出した実スペース（例 `cm1.backlog.jp`）に置換してコミットしてください（`backlog-settings.json` と同じ値）。ドメインは秘密ではないのでリポジトリに置いて構いません。**利用者側の秘密は `BACKLOG_API_KEY` の1個だけ**で、各自の環境変数から参照します（`credentials` ルール参照）。

> Backlog を使わない案件（`tools.課題管理: none` 等）は BACKLOG_* をスキップしてください。`.mcp.json` の `backlog` エントリも削除して構いません（`github` は残す）。

## ステップ7: 初回同期の起動（Actions で実行）※忘れない

> ⚠️ **Secrets を登録しただけでは中身は入りません。** 各同期ワークフローを**1度だけ手動起動**して初回取り込みを行うこと（以後は cron / Webhook が自動で維持する）。「セットアップは終わったのにリポが空」の典型原因がこの起動漏れです。

**まず最初に、エンジンマイグレーションを1度起動してスキーマを現行版へ揃えます（Secrets 不要）。** 新規リポは `Cortex/Home.md` に `engine.schema_version` を持たず `0` 扱いで生まれます。これを現行版へ揃えるまで、精製系（議事録生成・Gold精製・週次レポート）は「古いスキーマのデータを現行規約で書いて Gold 層を壊さない」ための安全網により**サイレントにskip**されます。毎晩の `engine-migrate`（20:30 JST）でいずれ自動修復されますが、**セットアップ当日はその初回夜間実行がまだ来ておらず**、この窓の中で下の初回同期（特に `ingest-minutes` / `update-gold`）を打っても無言でskipされます。だから最初にここで一度、手で揃えておきます:

```bash
gh workflow run engine-migrate.yml
gh run watch $(gh run list --workflow=engine-migrate.yml --limit 1 --json databaseId --jq '.[0].databaseId')
git pull  # Cortex/Home.md に engine.schema_version が現行版で入る
```

**ローカルに API キーを置く必要はありません。** 続けて、Secrets 登録が済んだら Actions 側で初回同期を起動します:

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

> **環境変数なしで記票（`/backlog-push`）できるようにする場合（任意）**: fleet管理者に `cortex-tools` の `scripts/put-backlog-push-tokens.mjs` を実行してもらい、その出力を `課題管理/backlog-proxy.json`（雛形は `backlog-proxy.json.example`）に配置してコミットします。これで手元にAPIキーが無い利用者（PM・非エンジニア・顧客）も中央プロキシ経由で記票でき、書き込みはこの案件に強制されます。

## ステップ9: デザイン同期（Figma を使う案件のみ）

1. `デザイン/figma.json` の `key` に対象 Figma ファイルのキー（`figma.com/design/<この部分>/...`）を記入
2. `FIGMA_TOKEN` を repo secret に登録（`gh secret set FIGMA_TOKEN`）。トークンの Figma アカウントを**対象ファイルに閲覧者として招待**しておくこと（招待が無いとトークンが有効でも読めない）
3. 初回インベントリ生成: `gh workflow run sync-designs.yml` → `git pull`（**ローカルに Figma トークン不要**）

## ステップ10: 開発リポジトリのクローン（任意）

ソースコードリポジトリが既にあるなら、`開発/` フォルダに git submodule として取り込みます。まだ無ければスキップし、作成後に取り込むよう案内してください。

1. `.gitmodules` の URL がプレースホルダ（`{{開発リポ}}`）のままなら、実際のリポジトリ URL（`src` はソースコード、`wiki` はその `.wiki`）に書き換える。ステップ2で `--開発リポ` を渡していれば埋め込み済み
2. `git submodule update --init` で取得する（リポジトリ未作成なら取得は失敗する。作成後に再実行。認証エラーは `gh auth login` で解消）
3. `.gitmodules` を書き換えた場合はコミットする

## ステップ11: チャット（Slack / Teams）連携（任意）

チャットツール（`slack` | `teams` | `none`）をユーザーに確認し、`Cortex/Home.md` の `tools.チャット` に反映します（ステップの `tools` マップと整合させる）。`none` ならスキップ可。

参照したいチャンネル（複数可・チャンネル名とリンク）をユーザーに尋ね、`チャット/channels.json` の `channels` 配列に `{ "name": "...", "platform": "slack|teams", "url": "...", "gold": true|false }` 形式で登録します（各チャンネルに `platform` を付ける。省略時は `slack`。`gold` は下記のとおり必ず判断して明示する）。あわせて次を伝えてください:

- 内容は Claude Code から **MCP 経由でライブ参照**する（`/read-chat`）。**リポジトリには取り込まれない**ため顧客には見えない（MCP に接続できるのは社内メンバーだけ＝公開範囲の境界。Slack / Teams いずれも同一）
- **Slack**: cortexプラグインの `.mcp.json` の `slack` サーバに OAuth 接続する。
- **Teams**: 公用ホスト型 MCP が無いため、`.mcp.json` にはハードコードしていない。**テナントごとに Azure AD アプリ登録＋Graph 権限＋テナント認証**を行い、各自の Claude Code の MCP 設定に Teams MCP を接続する（接続方法は `/read-chat` の前提節を参照）。
- **⚠️ Gold昇格の宣言（チャンネルごとに必ず聞く）**: `"gold": true` を付けたチャンネルは、夜間の Gold昇格が内容を読み、**顧客も見る Decision・用語集へ蒸留**します。登録のたびに次を確認してください。
  - **聞くこと: 「このチャンネルに顧客はいますか？」**
  - **顧客がいる（社外）** → `"gold": true` を付けてよい。顧客は既にその場の会話を見ているので、Goldに上げても新しく見えるものは無い
  - **社内だけ（社内）** → `"gold": false` を明示する。**社内限定の議論・見積・工数・評価が顧客の目に触れる**
  - **迷ったら付けない**（宣言が無ければ対象外＝安全側。後から `true` にできるが、逆は履歴に残るため戻せない）
  - この宣言は `/read-chat` のライブ参照や `notify` とは**独立**。読むことと顧客に見せることは別の判断
- **自動通知の宣言**: チャンネルに `"notify": true` を付けると、Cortex の自動通知（議事録レビュー依頼・Gold昇格サマリ）がそのチャンネルへ届く（省略時は通知しない・現状 slack のみ）。
- **通知の前提**: Slack App（Bot）に `chat:write`（主催者メンションには `users:read.email`）スコープを付与し、通知チャンネルに bot を招待しておくこと（未設定・未招待でも通知がスキップされるだけで夜間ジョブは落ちない）。通知先は公開範囲を考慮して選ぶ。

## ステップ12: 会議の自動取り込み設定（任意）

> `tools` の `会議: google-meet` で、文字起こしの**自動取り込み**を使う案件のみ。手動運用（文字起こしをビューアの投入フォームに渡す・または `/create-minute` で都度議事録化）だけならスキップ可。

仕組みは「**cortex-notetaker bot を会議に招待 → bot に共有された文字起こしを中央 Apps Script が案件リポへ取り込む**」。**対象はクラスメソッド側が主催する Google Meet のみ**（顧客主催・Teams 等はビューアの投入フォーム、または `/create-minute` で手動取り込み）。

ルーティングの優先順: ①会議名に**案件キー**（艦隊レジストリの `key`）→ ②会議名に**クライアント名**（Home.md の `client`）→ ③`会議/ingest-config.json` の `meetingNamePatterns`。

セットアップ手順:

1. `会議/ingest-config.json` の `enabled` を `true` にする
2. **（fleet管理者に依頼・重要）** この案件を中央の艦隊レジストリ `cortex-tools/infra/config.ts` の `projects` に登録してもらう（リポ名・案件キー。Viewer 等のインフラと共通の1エントリ）。あわせて中央の `GITHUB_TOKEN`(PAT) の対象リポに本リポが含まれるかも確認
3. **⚠️ cortex-notetaker bot を本リポのコラボレーター（Write）に追加する。** bot は組織メンバーであっても、**個々の private リポには権限を持たない**（組織メンバーであることと private リポが見えることは別）。PAT が `All repositories` で承認済みでも、**bot 本人に権限が無ければトークンは何も見えない**（fine-grained PAT は持ち主の権限を超えられない）。結果、**そのリポだけ 404 になり文字起こしが未仕分け置き場に流れ続ける**
   ```bash
   gh api -X PUT repos/<org>/<repo>/collaborators/<bot-account> -f permission=push
   ```
   **本リポの admin であれば自分で完結する**（組織オーナーへの依頼は不要）。Admin 権限は渡さない——bot がやるのはファイルのコミットと dispatch の発火だけで、Write で足りる
4. **運用ルールをユーザーに案内**: 対象の会議名の頭に**案件キーを付け**（例:「【KC】定例」）、**cortex-notetaker bot を会議の招待に追加**する（定例はシリーズに1回）。新しい定例を始めるPMに伝えることはこの2つだけ
5. ①②で当たらない場合のみ `meetingNamePatterns` に固有の会議名を足す（「定例」のような汎用語は他案件を誤って引き込むため入れない）

**設定できたら1件で実際に確かめる。** この経路は各段が独立に失敗し、しかも**どれも「静かに未仕分けへ流れる」という同じ症状**になる（艦隊レジストリへの未登録・bot の権限不足・`enabled: false`・パターン不一致）。文字起こしが案件リポの会議ディレクトリに入るところまで見て初めて完了とみなす。

> どの案件にも一致しなかった文字起こしは中央 inbox（未仕分け）に入り、データは失われません。ただし**未仕分けは放置すると気づかれない**ので、セットアップ直後に一度は中身を確認すること。

## ステップ11.5: 外部ソースの Gold 昇格（既定は自動導出・追加登録は任意）

夜間 Gold 昇格（update-gold）は、リポ内差分に加えて**外部ソース（GitHub Issues/Discussions・Slack）**からも決定・用語・ルールを抽出します。**GitHub は既存の宣言から自動導出されますが、Slack はチャンネルごとの明示宣言（`gold`）が必要です**（ステップ9で判断済みなら、ここでの追加作業はありません）:

- **Slack**: `チャット/channels.json` のうち **`"gold": true` を明示したチャンネルだけ**が読み取り対象（`Home.md` の `tools` でチャットが `slack` のとき）。**宣言が無いチャンネルは対象外**（opt-in）。※移行期の互換として、`Cortex/external-sources.json` に明示登録されたチャンネルだけは宣言が無くても対象になる（登録自体を人間の判断とみなすため）。
  - `channels.json` は `/read-chat` の参照先・通知先（`notify`）としても使う共用の宣言なので、**別の目的で足したチャンネルが無言で顧客可視のGoldに流れないよう**、昇格は必ず明示させる。
  - 「チャットを読みに行く」ことと「顧客が見るGoldに上げる」ことは重さの違う判断。**社内限定の議論をするチャンネルには付けない**（付けないのが既定なので、迷ったら書かない）。
  - 対象外のチャンネルはワークフローのログに `::warning::` で名前が出る。意図して外しているなら `"gold": false` を明示すると警告が消える。
- **開発リポ Issues**: `.gitmodules` の dev_dir（既定: `開発/`）配下 submodule（wiki＝path 末尾 `/wiki`・リポ名 `.wiki` は除外）の GitHub Issues が自動的に読み取り対象（`tools` の開発が `github` のとき）。開発 submodule の置き場が `開発/` 以外の案件は `Cortex/Home.md` のエンジン設定で `engine.dev_dir` を宣言する（例: `dev_dir: GitHub`）。

> **導出/登録＝Gold 昇格してよいという前提**です。中身は Decision/用語（顧客可視の Gold 層）に昇格されます。AI は抽出時に内部限定情報を除くフィルタを維持しますが、そもそも顧客に見せてよいソースだけを対象にしてください。**議事録・課題と同じ基準**で抽出されます（Decision=確定表現のみ・未確定は除外／用語=広く／未登録の発言者はメンバーdraft起票）。

**追加登録（任意）**: 既定の導出から外れる特殊ソースは `Cortex/external-sources.json` に登録します（github-discussions・導出対象外の追加リポ・channels.json に無い追加チャンネル等。既定は空でよい）:

- `{ "type": "github-discussions", "repo": "owner/repo" }`
- `{ "type": "github-issues", "repo": "owner/repo", "decisions": "none" }`（このソースからは Decision を作らない＝用語・参照のみ）
- `{ "type": "slack", "channel": "C0XXXX" }`（channels.json に無い追加チャンネルを足す場合）
- 導出された特定リポを Issues 抽出から外したいときは `"exclude": ["owner/repo"]` に列挙する。

認証と前提:

1. **対象リポが非公開、または case repo と別リポ**なら、`EXTERNAL_SOURCES_TOKEN`（対象リポの Issues/Discussions: Read を持つ Fine-grained PAT）を repo secret に登録する（ステップ6の表）。未設定なら case repo の `github.token` で読める範囲（公開/同一リポ）に限られます。将来は `sync-fleet-secrets` の共有シークレット候補に載せてチーム配布することも可能です。
2. **Slack を対象にする場合**は `SLACK_BOT_TOKEN`（ステップ6の表・上記スコープ）を repo secret に登録し、**対象の各チャンネルに bot を招待**しておく（bot 招待済みチャンネルだけ読める＝公開範囲の境界）。中央 Bot Token を使う場合は `sync-fleet-secrets` で配布できます。未設定・未招待のチャンネルは「活動なし」として安全にスキップされます。
3. 動作確認は `gh workflow run update-gold.yml`（外部に更新があれば差分ゲートが `changed=true` になり精製が走る）。

## ステップ13: README の仕上げ

シードの README は案件リポ前提で書かれているため、大きな書き換えは不要です。以下だけ確認・記入します:

- 冒頭に途中参加者向けの案内（「新しく参加した方は、手元で cortex プラグインを入れてから `USAGE.md` で使い方を把握してください」）を目立つ位置に置く
- 案件で実際に使うツールの URL を記載し、`Cortex/Home.md` の「使用ツール」と齟齬がないようにする

## ステップ14: GitHub 側の認可を通す（承認待ちで静かに止まる箇所）※忘れない

> ⚠️ **ここまでの作業が全て正しくても、GitHub 側でリポジトリ単位の認可が下りていないと一部の機能が無言で止まります。** 症状がどれも「設定ミス」に見えるため原因究明で時間を溶かします。認可はリポジトリ作成やデプロイの副作用では下りないので、セットアップの最後に必ず通してください。

| 認可 | 対象 | 下りていないときの症状 |
| --- | --- | --- |
| **Claude GitHub App** にこのリポを追加 | 全案件 | Claude Code の Web / デスクトップでリポジトリ選択肢に出てこない |
| **Amplify GitHub App** にこのリポを追加 | ビューアを配信する案件 | Amplify のビルドが `Unable to assume specified IAM Role` で失敗（IAM とは無関係。実体はリポジトリを読めていない） |

どちらも **案件ごとに毎回必要**（リポジトリ単位の認可のため）。

### 手順

1. **Claude Code でこのリポジトリが選べるか確かめる**（Web / デスクトップのリポジトリ選択）。出てこなければ GitHub App への追加をリクエストする
2. **組織がリポジトリ単位の承認制なら、承認者へ依頼を出す。** 宛先・依頼文テンプレ・組織の承認条件は fleet 管理者向けの private ドキュメント（`cortex-tools/infra/README.md` の「GitHub 側の認可」節）にある。**Org 一括の事前承認は原則できない**ため、案件を立ち上げるたびに依頼が発生する前提で進める
3. 依頼をチャットで送るときは、**下書きをユーザーに見せて承認を取ってから送る**（社内他チームへの発信のため。`tools.チャット` が `slack` なら `slack` MCP で送れる）
4. **承認は即時ではない。** 下りるまでこのリポは Claude Code から見えないことをユーザーに伝え、待たずに他のステップを進める

### 依頼文に必ず書くこと

承認者が判断するのに必要な情報は3つ。これが欠けると往復が増える。

- **対象リポジトリ**（Org 全体ではなく**リポジトリ指定である**ことを明示する）
- **申請者が対象リポの admin であること**（申請者とリポジトリオーナーが同一なら承認が早い）
- **用途**（案件コンテキストの参照・編集）

## 仕上げ: セットアップ状況の確認

最後にセットアップ状況を確認します。`gh workflow run fleet-status.yml` を実行して `git pull` すると、`fleet-status.json` に完了度（score）と未対応項目（nextActions）が出力されます。中断して後日再開する場合も、まずこれで現在地（未完チェック項目）を把握してから続きを進められます。

## 注意事項

- 各ステップで実行前にユーザーに確認を取ってください
- APIキー等の機密情報は**リポジトリにコミットしない**。自動化は GitHub Actions Secrets（ステップ6）、手元実行用の認証情報は環境変数（保存場所は動作環境で変わる → `credentials` ルール参照）
- メンバー個人のローカル環境準備（プラグイン導入・push 用の個人 API キー等）は本スキルの対象外。各メンバーは手元で `claude plugin marketplace add classmethod-team-app/cortex-engine@stable` → `claude plugin install cortex@cortex-engine` を1回実行し、`USAGE.md`・`README.md` で使い方を把握する（詳しくは cortex-engine の `docs/onboarding.md`。`/backlog-push` を使う人だけ個人の Backlog API キーを設定する）
