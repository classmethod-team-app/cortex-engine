---
name: setup-project
description: コンテキストリポジトリの環境構築を対話的に実行する
---
コンテキストリポジトリの環境構築をステップごとに実行します。
各ステップでユーザーに確認しながら進めてください。

## 前提条件チェック

ツール（node / pnpm / gh / jq）は **mise で一括インストール**、リポジトリの依存（`js-yaml` 等。`lint:cortex` が使用）は **`pnpm install`** で入れます（README「前提条件」参照）。個別の存在確認は不要で、リポジトリルートで以下を実行すれば揃います。

```bash
mise install   # ツール（node/pnpm/gh 等）
pnpm install   # リポジトリの依存
```

> mise 自体が未導入の場合のみ、README「前提条件」の手順で mise をインストールしてから `mise install` を案内してください。

ツールのうち **gh だけは認証が別途必要**です（mise はインストールのみ）。`gh auth status` で確認し、未認証なら `gh auth login` を促してください（後回しも可）。

## 前提: テンプレートから新規リポジトリを作成済みであること

このリポジトリ（`aidd-project-cortex`）は **GitHub Template リポジトリ**です。案件用リポジトリは、テンプレートから新規作成してクローンした状態でこのスキルを実行してください。テンプレートから作ると**履歴を引き継がず、GitHub上のリポジトリ作成とリモート設定まで一度に済む**ため、`rm -rf .git` などの初期化は不要です。

```bash
# <リポジトリ名> は任意（リポジトリ名はユーザーが自由に決める）。--clone でローカルにも取得する
gh repo create <GitHub Organization名>/<リポジトリ名> \
  --template classmethod-internal/aidd-project-cortex --private --clone
cd <リポジトリ名>
```

> GitHub の「Use this template」ボタンからでも同じことができます。
> まだテンプレートから作っていない場合は、先にこの作成を案内してから実行手順に進んでください。

## 実行手順

### ステップ1: プロジェクト情報の取得

**このリポジトリ名（`{{リポジトリ名}}`）と GitHub Organization名（`{{org}}`）は git remote から自動で導出し、そのまま使います**（`-context` 等の接尾辞は付け外ししない）。

```bash
# git remote から org と リポジトリ名（＝リポジトリ名そのまま）を導出
# 例: github.com/my-org/my-project-context → org=my-org / リポジトリ名=my-project-context
git remote get-url origin
```


| 項目                  | プレースホルダー     | 取得方法                          | 例                       |
| --------------------- | -------------------- | --------------------------------- | ------------------------ |
| リポジトリ名                | `{{リポジトリ名}}`         | git remote から導出（＝リポジトリ名そのまま・自動） | `my-project-context`          |
| GitHub Organization名 | `{{org}}`            | git remote から導出（自動）       | `my-org`                 |
| プロジェクト名        | `{{プロジェクト名}}` | **ヒアリング**                    | `XX様向けYYシステム開発` |
| クライアント名        | `{{クライアント名}}` | **ヒアリング**                    | `XX株式会社`             |
| 開発リポ（任意）      | `{{開発リポ}}`       | **ヒアリング**：ソースコードのリポジトリがあれば `owner/repo` を教えてもらう。無ければ保留し `/clone-dev-repos` 時に設定 | `my-org/my-app` |


あわせて `Cortex/Home.md` の**識別カード**（巡回エージェント/company brainが横断走査時に最初に読むfrontmatter）に記入する値も確認します（オントロジー規約参照）。

| 項目       | frontmatterキー | 値                                      |
| ---------- | --------------- | --------------------------------------- |
| 種別       | `kind`          | `案件` または `社内プロジェクト`        |
| 部署       | `org`           | 例: `リテールアプリ共創部`              |
| チーム     | `team`          | 任意                                    |
| 顧客名     | `client`        | 案件のみ（`社内プロジェクト`は空）      |
| 進行状態   | `lifecycle`     | `active`（終了時に `archived`）         |
| 導入経緯   | `adoption`      | `new`（新規=開始時に導入） / `existing`（既存=進行中に後から導入） / `migration`（旧Cortexから移行） |
| 業務ドメイン | `domains`     | リスト。例: `[retail, 会員証]`          |
| 技術       | `platforms`     | リスト。例: `[Web, LINE miniapp]`       |

### ステップ2: プレースホルダの一括埋め込み（setup-fill）

ステップ1で得た値で、リポジトリ全体のセットアップ用プレースホルダ（二重ブレース `{{ }}`）を一括置換します。`CLAUDE.md`・`README.md`・`package.json`・`.gitmodules`・ルール・スキル・Gold層サンプルまでまとめて埋まります。

埋め込みスクリプトは**この Skill に同梱**されている（`scripts/setup-fill.mjs`）。Skill 起動時に提示される **「Base directory for this skill」** の絶対パスを `<SKILL_DIR>` として使う。実行はリポジトリルート（カレントディレクトリ）で行うこと。

```bash
node "<SKILL_DIR>/scripts/setup-fill.mjs" \
  --リポジトリ名="<リポジトリ名>" \
  --プロジェクト名="<プロジェクト名>" \
  --org="<GitHub Organization名>" \
  --クライアント名="<クライアント名>" \
  --開発リポ="<owner/repo（任意・無ければ省略）>"
```

このスクリプトが行うこと:

- `{{リポジトリ名}}` / `{{プロジェクト名}}` / `{{org}}` / `{{クライアント名}}` / `{{開発リポ}}` を指定値に置換（`{{開発リポ}}` は任意。省略時は保留）
- `{{今日}}`（YYYY-MM-DD）・`{{今日8}}`（YYYYMMDD）・`{{今日-N}}`（N日前）を**実行日**で置換
- Gold層サンプル（Decisions・レポート）の日付・IDを実行日に揃え、**ファイル名もリネーム**
- 渡されなかった項目の埋め残しを検出し、**保留として警告**（後述）

**答えられない項目があってもOK**: その引数を省略すれば、該当の `{{ }}` は埋めずに残し、実行末尾に「未入力（保留）」として明示します（失敗扱いにはしません）。値が決まったら、**その項目だけを渡して同じスクリプトを再実行**すれば埋まります（埋め済みの値には `{{ }}` が残らないため再実行しても変化しない＝冪等）。ヒアリングで答えが出ない項目は、無理に仮の値を入れず保留して先へ進めてください。

**値が存在しない項目は空文字で埋める**: 例えば社内プロジェクトでクライアントが居ない場合は `--クライアント名=""` を渡します（空文字は「意図的に空」という回答として置換されます）。

> 日付を実行日以外にしたい場合のみ `--date=YYYY-MM-DD` を付けます（通常は不要）。
> `デザイン/DESIGN.md` 等にある手動記入用の `{{ }}`（`{{プロダクト名}}`・`{{#______}}` 等）は対象外で、触れません。

### ステップ3: セットアップ内容を初期コミット＆push

テンプレートから作成済みなので、リポジトリ・履歴・リモートは既に整っています（`rm -rf .git` 等は不要）。ステップ2で埋めた内容をコミットして push します。

```bash
git add -A
git commit -m "セットアップ: プレースホルダを案件の値で埋める"
git push
```

> もしテンプレートからではなく `git clone` で取得した場合のみ、先に履歴を切り離してください（`rm -rf .git && git init` → リモート作成 → push）。テンプレート作成済みなら不要です。

### ステップ4: Home.md 識別カードと概要の仕上げ

`Cortex/Home.md` の**識別カード**（巡回エージェント/company brainが横断走査時に最初に読むfrontmatter）のうち、setup-fill で埋まらない**選択値**を記入します。`client`（クライアント名）はステップ2で埋め済みです。

| frontmatterキー | 記入内容                                                          |
| --------------- | --------------------------------------------------------------- |
| `kind`          | `案件` または `社内プロジェクト`（controlled vocabulary）        |
| `org`           | 部署（例: `リテールアプリ共創部`）※GitHub Organizationとは別物   |
| `team`          | チーム（任意）                                                   |
| `lifecycle`     | `active`（終了時に `archived`）（controlled vocabulary）         |
| `adoption`      | `new` / `existing` / `migration`（controlled vocabulary）。導入経緯。ユーザーに確認する |
| `domains`       | 業務ドメインのリスト（例: `[retail, 会員証]`）                   |
| `platforms`     | 技術のリスト（例: `[Web, LINE miniapp]`）                        |

`kind`・`lifecycle`・`adoption` は controlled vocabulary（`kind`: `案件`|`社内プロジェクト` / `lifecycle`: `active`|`archived` / `adoption`: `new`|`existing`|`migration`）なので値を守ること。`adoption` はユーザーに「Cortex導入は新規案件か／進行中の既存案件か／旧Cortexからの移行か」を確認して記入する（既存・移行は Decision 等の履歴が薄くなる前提を Viewer が読み手に伝える）。あわせて `.rulesync/rules/overview.md` の「プロジェクト概要と目的」も案件に合わせて記入します。記入後 `node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"`（プラグイン同梱リンター） で検証されます。

### ステップ5: ルールファイルの自動生成

```bash
pnpm dlx rulesync@latest generate
```

### ステップ6: 課題管理ツールとの同期

ユーザーに課題管理ツール（Backlog / Jira / その他）を確認し、該当する同期手順を実行します。

#### Backlogの場合

ユーザーには **Backlog の URL を1つ貼ってもらうだけ**でよく、そこから `DOMAIN`（ドメイン）と `PROJECT_KEY`（プロジェクトキー）を自動抽出します。**APIキーだけ**は URL から取得できないので別途確認します。

プロジェクトトップ・課題・ボード等、どのURLでも構いません。次のコマンドで抽出します（`<URL>` に貼られたURLを入れる）:

```bash
node -e 'const u=new URL(process.argv[1]);const m=u.pathname.match(/\/(?:projects|view|find|board|wiki|gantt|git|file)\/([A-Za-z0-9_]+)/);console.log("DOMAIN="+u.hostname);console.log("PROJECT_KEY="+(u.searchParams.get("projectKey")||(m&&m[1])||""))' "<URL>"
```

- `DOMAIN` = ホスト名（例: `cm1.backlog.jp` / `*.backlog.com` / `*.backlogtool.com`）
- `PROJECT_KEY` = `/projects/<KEY>`・`/view/<KEY>-<番号>`・`?projectKey=<KEY>` 等から抽出したキー（英大文字・数字・`_`）
- 抽出例: `https://cm1.backlog.jp/projects/PJ_CORTEX` → `DOMAIN=cm1.backlog.jp` / `PROJECT_KEY=PJ_CORTEX`

抽出した `DOMAIN` / `PROJECT_KEY` をユーザーに提示して確認を取り、`BACKLOG_API_KEY`（APIキー）を聞いてから同期します。

```bash
pnpm dlx backlog-exporter@latest all \
  --domain $DOMAIN \
  --projectIdOrKey $PROJECT_KEY \
  --apiKey $BACKLOG_API_KEY \
  --output ./課題管理
```

#### Jira等の場合

案件に応じたエクスポートコマンドへの読み替えを案内します（`/backlog-pull` スキル内のコマンドを案件のツールに合わせて変更する）。

### ステップ7: GitHub Actions Secrets の設定

Backlog自動同期ワークフローを有効にするため、コンテキストリポジトリに Secrets を設定します。

**APIキー（`BACKLOG_API_KEY`）は原則 organization secret（`classmethod-team-app` の Cortex 中央キー）が既定で継承される**ため、通常は per-repo で設定する必要はありません。設定するのは案件固有の `BACKLOG_DOMAIN` / `BACKLOG_PROJECT_KEY`（ステップ6で URL から抽出した値）だけです。

```bash
# リポジトリ内で実行すれば gh が対象リポを自動判定する（--repo 指定は不要）
gh secret set BACKLOG_DOMAIN
gh secret set BACKLOG_PROJECT_KEY
```

**APIキーを案件側で上書きしたい場合**（例: 顧客が自前の Backlog スペースを使っていて、中央の Cortex ユーザーをそのスペースに追加できない案件）は、repo secret で `BACKLOG_API_KEY` を設定すると organization の既定を上書きします（org secret と repo secret は共存し、repo 側が優先）。

```bash
# 中央キーが使えない/使いたくない案件だけ実行（org既定を上書き）
gh secret set BACKLOG_API_KEY
```

> Backlog を使わない案件の場合はこのステップをスキップしてください。
> organization secret が未整備の環境では、`BACKLOG_API_KEY` も per-repo で設定してください。

#### Backlogリアルタイム同期を有効にする場合（任意）

Secrets を設定すると定期同期（`sync-backlog.yml`・平日日中1時間毎）が動きます。さらに課題・Wiki の更新を**数十秒でリポジトリに反映**したい場合は、Webhook 経由のリアルタイム同期を有効化します（受け側の `backlog-webhook-sync.yml` はテンプレートに同梱済み）。

1. **（fleet管理者に依頼）** `cortex-tools/infra/config.ts` の該当案件エントリに `backlogSpace` / `backlogProjectKey` / `backlogRealtime: true` を追記し、`npx cdk deploy BacklogWebhook` を実行してもらう（Lambda のルーティング表に案件が追加される。Webhook URL＋秘密トークンを受け取る）
2. **（Backlogプロジェクト管理者）** Backlog のプロジェクト設定 → インテグレーション → Webhook に、受け取った URL（`https://…lambda-url….on.aws/?t=<秘密トークン>`）を登録する。通知イベントは**課題の追加／更新／コメント／削除／まとめて更新＋Wikiの追加／更新／削除**にチェック

> ドキュメントには Backlog 側に更新イベントが無いため、ドキュメント同期は定期実行が担当します（リアルタイム対象は課題・Wiki のみ）。定期同期はリアルタイムの取りこぼしも回収する安全網として併走します。

#### デザイン同期（Figma）を使う場合

Figmaの画面インベントリ自動同期（`sync-designs.yml` の cron / `/sync-designs` スキル）を有効にするには:

1. `デザイン/figma.json` の `key` に対象Figmaファイルのキー（`figma.com/design/<この部分>/...`）を記入する（案件ごとに必須）
2. **`FIGMA_TOKEN` は原則 organization secret（Cortex 中央 Figma アカウントの PAT）が既定で継承される**ため、通常 per-repo 設定は不要。ただし**中央 Figma アカウントを対象 Figma ファイルに閲覧者として招待**しておくこと（招待が無いとトークンが有効でもそのファイルは読めない）。

中央キーを使わない/使えない案件だけ、repo secret で上書きします（org既定を上書き）:

```bash
gh secret set FIGMA_TOKEN
```

初回インベントリの生成は、figma.json 記入・secret・ファイル招待が済んだら **`gh workflow run sync-designs.yml` → `git pull`** で行えます（**ローカルにFigmaトークン不要**。または翌日の cron で自動生成）。`sync-designs` はステートレス（毎回 `デザイン/inventory/` を全再生成）なので、初回も通常実行も挙動は同じです。

> Figma/デザインを使わない案件はスキップしてください。ローカルで同期したい場合は `/sync-designs` を実行します（その場合はFigmaトークンが手元に必要）。
> organization secret が未整備の環境では、`FIGMA_TOKEN` も per-repo で設定してください。

### ステップ8: 開発リポジトリのクローン

ソースコードリポジトリが既に作成されている場合は、`/clone-dev-repos` スキルを実行して submodule をクローンします。

まだリポジトリが作成されていない場合は、このステップをスキップし、リポジトリ作成後に `/clone-dev-repos` を実行するようユーザーに案内してください。

### ステップ9: チャット（Slack）連携の設定

チャット（Slack）を参照する案件では、対象チャンネルのリンクをユーザーに尋ね、`チャット/channels.json` に登録します。

1. ユーザーに **「参照したい Slack チャンネルを教えてください（複数可。チャンネル名とリンク）」** と尋ねる。
2. 受け取ったチャンネルを `チャット/channels.json` の `channels` 配列に **`{ "name": "...", "url": "..." }` 形式**で追記する（複数可。`name` は「どのチャンネルか」が分かるラベル）。

   ```json
   {
     "channels": [
       { "name": "顧客共有", "url": "https://<workspace>.slack.com/archives/C0XXXXX" },
       { "name": "社内連絡", "url": "https://<workspace>.slack.com/archives/C0YYYYY" }
     ]
   }
   ```

3. 次のことをユーザーに伝える。
   - これらのチャンネルの内容は、Claude Code から **Slack MCP 経由でライブ参照**できる（`/read-chat`）。
   - **Slack の内容はこのコンテキストリポジトリには取り込まれない（ミラーしない）**。`channels.json` に置くのはリンクだけ。
   - したがって **顧客には見えない**。Slack MCP に接続できるのは社内メンバーだけで、その場で読みに行くだけ（＝公開範囲の境界）。

> Slack を使わない案件はこのステップをスキップしてください。

### ステップ10: プロジェクト固有の設定

以下の設定をユーザーと相談しながら進めます。

1. `.rulesync/rules/overview.md` を案件の概要に書き換える
2. cortexプラグインの `.mcp.json` に案件で使うMCPサーバーを設定する
3. `.rulesync/skills/` に案件で使うスキルを設定・修正する
4. `pnpm dlx rulesync@latest generate` で各ツール向け設定を再生成する

### ステップ11: README を案件用に更新する

`README.md` は**テンプレート（aidd-project-cortex）の説明**として書かれており、複製した案件リポジトリの実態とは合いません。最後に、案件リポジトリの README として整えます。setup-fill（ステップ2）でプレースホルダは埋め済みなので、ここでは**構造と文面の案件化**を行います。

- **タイトル・冒頭**: 「〜テンプレート」という表現を外し、この案件のコンテキストリポジトリである旨に書き換える（`Cortex/Home.md`・`.rulesync/rules/overview.md` の概要と整合させる）
- **冒頭に途中参加者向けの案内を置く**: README の**上の方の目立つ位置**に、後から参加するメンバー向けの一文を置く。例: 「このプロジェクトに新しく参加した方は、まず `/onboard-member` を実行してください（ローカル環境の準備と案件理解を案内します）」。途中参加は随時起こるため、入口を最初に見える場所に固定する
- **セットアップ節の整理**: 「テンプレートから新規リポジトリを作成」「`/setup-project` を実行」等の**複製・初期構築の手順は削除する**（すでに完了しているため案件リポジトリには不要）。途中参加者向けの環境準備手順も README に長々と書かず、**`/onboard-member` に委譲する**（README には上記の入口案内だけを置く）
- **残すもの**: フォルダ構成・コマンド一覧・コンテキストの流れ（案件メンバーが日常的に参照する部分）
- **使用ツールのリンク**: 案件で実際に使うツール（課題管理・デザイン・ソースコード等）のURLを記載し、`Cortex/Home.md` の「使用ツール」と齟齬がないようにする

更新後、コミットして push します。

```bash
git add README.md
git commit -m "READMEを案件用に更新"
git push
```

> テンプレート側（aidd-project-cortex）の README はテンプレート説明のままで正しいため、**このステップで行う変更は複製先の案件リポジトリでのみ**実施します。

### ステップ12: 会議の自動取り込み設定（任意）

> `tools` の `会議: google-meet` で、文字起こしの**自動取り込み**を使う案件のみ。手動運用（`/post-meeting` を都度叩く）だけならスキップ可。

仕組みは「**`cortex-notetaker` bot を会議に招待 → bot に共有された文字起こしを中央 Apps Script が案件リポへ取り込む**」です。**取り込むか否かは bot を招待したかどうかで決まる**ため、会議をここで絞り込む必要はありません。このステップで決めるのは「**どの案件リポへ入れるか（ルーティング）**」だけです。

> **対象はクラスメソッド側が主催する Google Meet の会議のみ**（Gemini 文字起こしは主催者の Workspace で生成・共有されるため）。**顧客側が主催する会議（先方の Google Meet / Teams / Zoom 等）は自動では入らない**ので、その運用の案件には「文字起こしファイルを `/post-meeting`（または `/create-minute`）で手動取り込みする」と案内すること。

ルーティングは次の優先順で自動判定されます（上で当たれば下は見ない）:

| 優先 | 照合キー | どこで決まるか |
| --- | --- | --- |
| ① | **案件キー**（例 `KC`）が会議名に含まれる | 中央の艦隊レジストリ `cortex-tools/infra/config.ts` の `key` |
| ② | **クライアント名**が会議名に含まれる | `Cortex/Home.md` の `client`（ステップ4で記入済み） |
| ③ | `meetingNamePatterns` | `会議/ingest-config.json`（任意・原則触らない） |

セットアップ手順:

1. `会議/ingest-config.json` の `enabled` を `true` にする（この案件で自動取り込みを使う宣言）。
2. **会議名の運用をユーザーに案内する（これが基本）**: 対象の会議名の頭に**案件キーを付ける**（例:「**【KC】定例**」）。人間もカレンダーで「bot取り込み対象」と一目で分かる。会議名にクライアント名が自然に入る運用（例「◯◯様 定例」）なら②で当たるため、リネームは不要。
3. ①も②も会議名に入らない場合（社内プロジェクトで client が空、既存の会議名を変えられない等）**のみ**、`meetingNamePatterns` に固有の会議名を足す（例: `["全体定例", "ハーネス定例"]`）。**「定例」のような汎用語は他案件の会議を誤って引き込むため入れない**こと。
4. 取り込みを実際に動かす残作業をユーザーに伝える:
   - `cortex-notetaker` bot を、対象の顧客会議（特に**定例はシリーズに1回**）の**招待に追加**する（招待されていれば参加なしで文字起こしが共有される）。**これが唯一の継続的な手作業**。
   - この案件が中央の艦隊レジストリ（`cortex-tools/infra/config.ts` の `projects`）に登録済みか確認する（**ビューア等のインフラと共通の1エントリ**。インフラのオンボーディング時に登録済みのはず）。あわせて中央の `GITHUB_TOKEN`(PAT) の対象リポにこのリポが含まれるかも確認。
   - 手順とアカウント作成依頼メモ: `cortex-tools/apps-script/`

> **新しい定例を始めるPMに伝えることは「会議名の頭に【案件キー】を付ける」「botを招待する」の2つだけ**（設定ファイルは原則触らない）。

> どの案件にも一致しなかった文字起こしは中央 inbox（未仕分け）に入り、**データは失われません**。会議名がパターンから外れても、後から人が割り当てられます。
> Google Meet 以外（Teams 等）や自動取り込みを使わない案件は、このステップをスキップし `enabled` を `false` のままにしてください。手動取り込みは従来どおり `/post-meeting`（モードB）で行えます。

### 仕上げ: セットアップ状況の確認

最後に `/setup-status` を実行し、全ステップの完了状況と未対応項目（次にやるべきこと）を確認します。中断して後日再開する場合も、まず `/setup-status` で現在地を把握してから続きを進められます。

## 注意事項

- 各ステップで実行前にユーザーに確認を取ってください
- エラーが発生した場合は原因を調査し、ユーザーに報告してください
- APIキー等の機密情報は**リポジトリにコミットしない**。手元で skill を手動実行する際の認証情報は環境変数で渡し、**保存場所は動作環境で変わる**（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数）。自分の実行環境を認識してユーザーに正しい入れ場所を案内すること → `credentials` ルール参照。なお夜間 cron の自動同期はこれとは別系統で、GitHub Actions Secrets（ステップ7）を使う
