---
name: backlog-push
description: >-
  エディター上で作成した課題コメント・課題本文・Wikiの更新やドキュメントの新規追加をBacklog
  MCPまたはREST API経由で反映し、該当の課題・Wiki・ドキュメントのみをローカルに再同期する
---
課題管理ツール（Backlog）への反映（Push）を行います。取得（Pull）は `/backlog-pull` が担当します。本スキルは「ローカルで作成した内容をBacklogへ反映 → 該当項目のみ再取得して同期」までを一気通貫で行います。

反映は **Backlog MCP**（接続されていれば最優先）または **Backlog REST API（HTTP）の直接呼び出し**で行います。どの経路でも課題・Wiki・ドキュメントを同じ流れ（プレビュー → 承認 → 実行 → URL報告）で扱えます。

## 前提

反映の前に、**どの経路で認証を解決するか**を次の順で判定します。経路によってBacklog上の**投稿者名義**が変わるため、判定結果は必ず手順2のプレビューに明記します。

| 優先 | 経路 | 使える条件 | Backlog上の名義 |
| --- | --- | --- | --- |
| ① | **Backlog MCP** | `mcp__backlog__` 系のツールが利用可能（手元のAPIキー不要） | **本人**（あなたのアカウント） |
| ② | **環境変数（REST直叩き）** | `DOMAIN` / `PROJECT_KEY` / `BACKLOG_API_KEY` が**環境変数として参照できる** | **本人**（キーの持ち主） |
| ③ | **プロキシ** | `課題管理/backlog-proxy.json` がある | **bot**（共有ボット・本文に記名） |
| ④ | 案内 | ①②③のいずれも無い | — |

- ①: 接続中のツール一覧に `mcp__backlog__` で始まるツールがあれば、**最優先で使います**。手元にBacklog APIキーを置かずに本人名義で反映できます
- ②: 従来の経路（エンジニア向け）。Backlog REST API を直接呼び出します。環境変数の入れ場所は動作環境で変わります（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数 → `credentials` ルール参照）。APIキーに更新権限があること（読み取り専用キーでは反映できません）
- ③: 中央プロキシ（Lambda）経由でBacklogに記票します。**手元にBacklog APIキーは不要**で、リポジトリにアクセスできる人なら誰でも使えます（PM・非エンジニア・顧客向け）。書き込み先はファイル内の案件に強制されます
- ④: 認証情報の入れ場所を案内します（`credentials` ルール参照）

### 名義の原則（重要）

**名義は「発話の主」で決まります。** 人間の意思表示は本人名義で残るのが望ましく、**bot名義への降格を黙って行ってはいけません。**

①②が使えず③（プロキシ）しか無い場合は、実行前に必ず次の内容を確認し、同意を得てから使います。

```
Backlogのキーが見つかりません。bot名義（本文に記名付き）で投稿しますか？
自分名義で投稿するには、Backlog MCP の接続、または APIキーの設定が必要です（credentials ルール参照）。
```

本人名義で投稿したい場合は **Backlog MCP を接続**してください（案件リポジトリの `.mcp.json` に標準定義を同梱していく想定です。APIキーは各自の環境変数として持ちます）。

### ①MCP経路の確認

接続中のツール一覧に `mcp__backlog__` で始まるツール（課題のコメント追加・課題更新・Wiki更新・ドキュメント作成等）があるかを確認します。**ツール名と引数名はサーバーのバージョンで異なるため、呼び出す前に必ずツール一覧の説明で確認**してください。

### ②環境変数経路の読み込み

環境変数経路では、すべての手順の先頭で以下を実行して認証情報を読み込みます。**環境変数が既にあればそれを使い、無ければ `.env` にフォールバック**します（1Password連携のfifo対応のため `source` は使いません）。

```bash
set -a; [ -e .env ] && eval "$(grep -v '^#' .env)"; set +a
# 必須変数の検証（欠けていたら動作環境に応じた入れ場所を案内する。credentials ルール参照）
: "${DOMAIN:?未設定。動作環境に応じた環境変数の入れ場所は credentials ルール参照}"
: "${PROJECT_KEY:?未設定。同上}"
: "${BACKLOG_API_KEY:?未設定。同上}"
```

### ③プロキシ経路の読み込み

プロキシ経路では、`課題管理/backlog-proxy.json`（接続先URL・案件キー・案件別トークン。配置方法はセットアップ手順参照）を読み込みます。手元にBacklog APIキーは不要です。

```bash
CONF=課題管理/backlog-proxy.json
URL=$(jq -r .url "$CONF"); PKEY=$(jq -r .projectKey "$CONF"); TOKEN=$(jq -r .token "$CONF")
```

## 対応範囲（重要）

種別ごとにBacklog側の対応が異なります。**ドキュメントは新規追加のみ可能で、既存の本文更新はできません**（更新用のAPIが存在しないためで、①②③どの経路でも同じです）。

| 種別 | ①MCP経路 | ②③REST経路（直叩き・プロキシ） | 特定IDで再取得（pull） |
| --- | --- | --- | --- |
| **課題** | ✅ コメント追加 ／ 本文・属性更新 ／ 新規作成 | ✅ コメント追加 `POST /issues/:id/comments` ／ 本文・属性更新 `PATCH /issues/:id` | ✅ `update --issueIdOrKey` |
| **Wiki** | ✅ 更新 | ✅ 更新 `PATCH /wikis/:id` | ✅ `update --wikiId` |
| **ドキュメント** | ⚠️ **新規追加のみ**（既存の本文更新はAPIなし） | ⚠️ **新規追加のみ** `POST /documents`（既存の本文更新はAPIなし） | ✅ `update --documentId` |

**削除系の操作（課題・コメント・Wiki・ドキュメント・プロジェクト等の削除）は本スキルの対応範囲外です。** ①MCP経路には削除ツールが存在しますが、依頼されても**AIからは実行せず**、Backlogの画面で操作してもらうよう案内してください（削除は取り消せず、オントロジーの安定IDが指す先も失われるため、人の手と目を通します）。

ドキュメントは依頼内容で扱いが分かれます。

- **新規ドキュメントの追加**: 判定した経路（①ならドキュメント作成ツール、②③なら `POST /documents`）で対応します（手順3）。
- **既存ドキュメントの本文更新**: APIが無いため本スキルでは行いません。`delete`→`POST`での作り直しは、ドキュメントIDが変わってオントロジーの安定ID（`document` の参照）が壊れ、コメント・添付・履歴も失われるため**行いません**。代わりに次のように**案内**します。
  1. 該当ドキュメントを **Backlog上で直接編集（貼り付け）して保存**してもらう（編集先のURLは `課題管理/documents/` の該当ファイル冒頭の `Backlog Document Link` から辿れます）
  2. 保存できたら、手順4の `update --documentId` で**ローカルへ取り直す**

## 実行手順

### 1. 対象と更新内容の特定

ユーザーの依頼から対象（課題キー / Wiki ID / ドキュメントID）と更新種別を特定します。

- 課題: 課題キー（例: `PROJ-123`）と更新種別（コメント追加 / 本文更新 / 属性変更）。課題キーが不明な場合は `課題管理/issues/` 配下の該当ファイル内「基本情報 > 課題キー」を確認します
- Wiki: Wiki ID（数値）。`課題管理/wiki/` の該当ファイル冒頭の `Backlog Wiki Link`（`/alias/wiki/{ID}`）から確認できます
- ドキュメント: **新規追加**なら作成内容（タイトル・本文・配置先の `parentId` があれば）を特定。**既存の本文更新**は、Backlogで直接編集してもらい取り直す案内に切り替えます（上記「対応範囲」参照）

### 2. プレビューと承認（必須）

Backlogへ反映する内容（対象・更新種別・本文）をそのまま提示し、ユーザーの承認を得ます。**承認なしに書き込みを実行してはいけません。**

Backlogへの書き込みは顧客にも見える慎重な操作のため、承認を求める際は必ず 🚨 絵文字を使って以下の形式で確認してください。**「投稿者名義」の行は必須**で、「前提」で判定した経路に応じて記載します。

```
🚨 **Backlogへの書き込み確認** 🚨

- 対象: PROJ-123「課題タイトル」（または Wiki: 12345「ページ名」）
- 操作: コメント追加（または 本文更新 / 属性変更 / Wiki更新 / ドキュメント新規追加）
- 投稿者名義: あなた（Backlog MCP）

--- 反映する内容 ---
（本文をそのまま提示）
---

この内容でBacklogに反映してよろしいですか？
```

「投稿者名義」の書き分けは次のとおりです。

| 経路 | 記載 |
| --- | --- |
| ①MCP | `あなた（Backlog MCP）` |
| ②環境変数 | `あなた（APIキー）` |
| ③プロキシ | `bot（本文に記名: {利用者名}）` |

③になる場合は、「名義の原則」の確認文を添えて **bot名義への降格に同意を得てから**実行します。

### 3. Backlog へ反映

承認後、判定した認証経路に応じて実行します。**MCP経路は 3-A**、**環境変数経路は 3-B**、**プロキシ経路は 3-C** を使います。いずれの経路でも「プレビュー → 承認 → 実行 → URL報告」の流れは同じです。

#### 3-A. MCP経路（Backlog MCP・本人名義）

接続中の `mcp__backlog__` 系ツールで実行します。本人のアカウントで投稿されるため、**本文への記名は付けません**（記名は 3-C 専用の措置です）。

| 操作 | 使うツール |
| --- | --- |
| 課題にコメントを追加 | コメント追加系のツール（課題キーと本文を渡す） |
| 課題の本文・属性を更新 | 課題更新系のツール（件名・本文・状態・担当等） |
| 課題を新規作成 | 課題作成系のツール（件名必須） |
| Wikiを更新 | Wiki更新系のツール（Wiki IDと本文） |
| ドキュメントを新規追加 | ドキュメント作成系のツール（タイトル・本文。配置先は任意） |

ツール名・引数名はサーバーのバージョンで異なるため、**ツール一覧の説明を確認してから**呼び出してください。既存ドキュメントの**本文更新**はMCPでも行いません（APIなし・「対応範囲」参照）。

実行後、レスポンス（課題キー・ID等）からURLを組み立てて控えておきます（組み立て規則は 3-B と同じ）。ドメインが分からない場合は、`課題管理/` 配下の `backlog-settings.json`、または既存ミラーのファイル冒頭のリンク行から確認できます。

#### 3-B. 環境変数経路（Backlog REST API を直接呼び出す）

種別に応じて以下のいずれかを実行します。`BACKLOG_API_KEY` はクエリパラメータ `apiKey` で渡します。

> ⚠️ **本文はコマンドラインに直接書かず、必ずファイルに書いてから `@ファイルパス` で渡してください。**
> Linux には1引数あたり **131,072バイト**の上限（`MAX_ARG_STRLEN`。`ulimit` では緩められない）があり、
> 長いWikiページや仕様ドキュメントを本文に直接書くと `Argument list too long` で失敗します。
> **macOS にはこの上限が無いため手元では通り、Claude Code Web や CI（Linux）でだけ落ちます。**
> 切り分けが難しい形で出るので、短い本文でも例外なくファイル経由にしてください。

```bash
# まず本文をファイルに書く（以降の各コマンドはこれを参照する）
BODY_FILE="$(mktemp)"
cat > "$BODY_FILE" <<'EOF'
コメント本文
EOF
```

**課題にコメントを追加**

```bash
curl -sS -X POST "https://$DOMAIN/api/v2/issues/PROJ-123/comments?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "content@$BODY_FILE"
```

**課題の本文・属性を更新**（`summary`=件名 / `description`=本文 / `statusId`・`assigneeId` 等）

```bash
curl -sS -X PATCH "https://$DOMAIN/api/v2/issues/PROJ-123?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "description@$BODY_FILE"
```

**Wikiを更新**（`name`=ページ名 / `content`=本文。いずれも任意）

```bash
curl -sS -X PATCH "https://$DOMAIN/api/v2/wikis/12345?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "content@$BODY_FILE"
```

**ドキュメントを新規追加**（`projectId`=数値のプロジェクトID が必須。`title`=タイトル / `content`=本文(Markdown) / `parentId`=配置先フォルダ・親ドキュメントのID は任意）

```bash
# projectIdは数値が必要。PROJECT_KEYから解決する
PROJECT_ID=$(curl -sS "https://$DOMAIN/api/v2/projects/$PROJECT_KEY?apiKey=$BACKLOG_API_KEY" | jq -r .id)

curl -sS -X POST "https://$DOMAIN/api/v2/documents?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "projectId=$PROJECT_ID" \
  --data-urlencode "title=新規ドキュメントのタイトル" \
  --data-urlencode "content@$BODY_FILE"
```

投稿が終わったら `rm -f "$BODY_FILE"` で消します（本文には顧客とのやり取りが入るため手元に残さない）。

既存ドキュメントの**本文更新**はこの手順では行いません（APIなし）。依頼された場合はBacklog上で直接編集してもらい、手順4の取り直しのみ行います（「対応範囲」参照）。

レスポンス（JSON）からURLを組み立てて控えておきます（手順5で報告するため）。

- 課題: `https://{DOMAIN}/view/{課題キー}`
- コメント: `https://{DOMAIN}/view/{課題キー}#comment-{コメントID}`（コメントIDはレスポンスの `id`）
- Wiki: `https://{DOMAIN}/alias/wiki/{Wiki ID}`
- ドキュメント（新規追加時）: `https://{DOMAIN}/document/{PROJECT_KEY}/{ドキュメントID}`（ドキュメントIDはレスポンスの `id`）

#### 3-C. プロキシ経路（中央プロキシ Lambda 経由）

プロキシ経由の投稿は、Backlog上の投稿者が**共有ボットアカウント**になります。誰の記票かを残すため、**本文末尾に `---` 区切りの記名を必ず付け**、`author` フィールドにも同じ名前を入れます（監査ログ用）。利用者名は `git config user.name` 等から推定し、**手順2の🚨承認プレビューで確認**してください。

> ⚠️ **本文はコマンドラインに直接書かず、必ずファイル経由で扱ってください。**
> `jq --arg` と `curl -d` の二重で argv に載るため、Linux の1引数 **131,072バイト**上限
> （`MAX_ARG_STRLEN`・`ulimit` 不可）に長い本文で抵触します。**macOS では通り Linux でだけ落ちる**ので、
> Claude Code Web や CI からのみ失敗するという切り分けにくい形で出ます。

```bash
AUTHOR="$(git config user.name)"   # 推定した利用者名。承認プレビューで確認する
BODY_FILE="$(mktemp)"; REQ_FILE="$(mktemp)"
cat > "$BODY_FILE" <<'EOF'
コメント本文
EOF
# 本文末尾に記名を付す（ファイル上で行う）
printf '\n\n---\n_投稿: %s（Cortex経由）_' "$AUTHOR" >> "$BODY_FILE"
```

各アクションは JSON ボディを**ファイルに組み立ててから** `?op=backlog&t=${TOKEN}` に POST します（`jq --rawfile` で本文を読み、`curl -d @ファイル` で送る）。`projectKey` は必ず添え、`projectId` はプロキシ側が案件から解決・強制注入するため送りません（送っても案件に強制されます）。`projectKey` は必ず添え、`projectId` はプロキシ側が案件から解決・強制注入するため送りません（送っても案件に強制されます）。

**課題にコメントを追加**（`comment`）

```bash
jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --rawfile content "$BODY_FILE" \
  '{projectKey:$pk, author:$author, action:"comment", issueKey:"PROJ-123", content:$content}' > "$REQ_FILE"

curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d @"$REQ_FILE"
```

**課題の本文・属性を更新**（`issue-update`。`params` に `summary`/`description`/`statusId`/`assigneeId` 等を透過で渡す）

```bash
jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --rawfile desc "$BODY_FILE" \
  '{projectKey:$pk, author:$author, action:"issue-update", issueKey:"PROJ-123", params:{description:$desc}}' > "$REQ_FILE"

curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d @"$REQ_FILE"
```

**課題を新規作成**（`issue-create`。`params.summary` 必須・`description` 等任意。`issueTypeId`/`priorityId` 未指定はプロキシが補完）

```bash
jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg summary "新規課題の件名" --rawfile desc "$BODY_FILE" \
  '{projectKey:$pk, author:$author, action:"issue-create", params:{summary:$summary, description:$desc}}' > "$REQ_FILE"

curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d @"$REQ_FILE"
```

**Wikiを更新**（`wiki-update`。`params` に `name`/`content` を渡す。いずれも任意）

```bash
jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --rawfile content "$BODY_FILE" \
  '{projectKey:$pk, author:$author, action:"wiki-update", wikiId:"12345", params:{content:$content}}' > "$REQ_FILE"

curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d @"$REQ_FILE"
```

**ドキュメントを新規追加**（`document-create`。`params.title`/`content` を渡す。`parentId` は任意。`projectId` はプロキシが解決）

```bash
jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg title "新規ドキュメントのタイトル" --rawfile content "$BODY_FILE" \
  '{projectKey:$pk, author:$author, action:"document-create", params:{title:$title, content:$content}}' > "$REQ_FILE"

curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d @"$REQ_FILE"
```

既存ドキュメントの**本文更新**はプロキシ経路でも行いません（APIなし・「対応範囲」参照）。プロキシは削除系アクションを持ちません（記票のみ）。

投稿が終わったら `rm -f "$BODY_FILE" "$REQ_FILE"` で消します（本文には顧客とのやり取りが入るため手元に残さない）。

レスポンスは `{ "result": …Backlogレスポンス…, "url": "…閲覧URL…" }` の形で返り、`url` はプロキシが組み立て済みです。手順5の報告ではこの `url` をそのまま使います。

### 4. 該当項目のみ再同期

再同期は認証経路で分岐します。

**MCP経路（3-A）**: 手元での再同期は原則**不要**です。Backlog の Webhook → リアルタイム同期が自動でミラーに反映します（通常1分前後）。環境変数（`DOMAIN` / `PROJECT_KEY` / `BACKLOG_API_KEY`）も揃っている場合や、Webhookが未設定の案件では、下の 3-B 用のコマンドで取り直します。

**環境変数経路（3-B）**: 反映後、更新した項目だけをローカルへ取り直します。`update` コマンドは対象ディレクトリの `backlog-settings.json` からドメイン・プロジェクト・APIキーを読み込みます。

```bash
# 課題（課題キーまたは課題ID。カンマ区切りで複数可）
pnpm dlx backlog-exporter@1 update --issueIdOrKey PROJ-123 --force ./課題管理/issues

# Wiki（Wiki ID）
pnpm dlx backlog-exporter@1 update --wikiId 12345 --force ./課題管理/wiki

# ドキュメント（ドキュメントID）※Backlog側で編集した内容をローカルへ取り直す用途
pnpm dlx backlog-exporter@1 update --documentId abc123 --force ./課題管理/documents
```

これらのID指定フラグは全件差分更新ではないため、設定ファイルの最終更新日時（`lastUpdated`）は更新されず、次回の通常の差分更新に影響を与えません。

**プロキシ経路（3-C）**: 手元での再同期は**行いません**。プロキシ経由の書き込みは Backlog の Webhook → リアルタイム同期が**自動でミラーに反映**します（通常1分前後）。読み取りキーを持たない利用者でも、起票からミラー反映まで完結します。

### 5. 結果の確認と報告

結果を報告します。報告には手順3で控えた**書き込んだ課題・コメント・WikiのURL**を必ず含め、ユーザーがワンクリックでBacklog上の反映結果を確認できるようにします。

- **MCP経路（3-A）**: 再同期しなかった場合、手元のファイルは変わりません。報告には「ミラー（`課題管理/`）へは約1分で自動反映されます」と添えます。再同期した場合は 3-B と同様に `git diff` で確認します。
- **環境変数経路（3-B）**: `git diff` で該当項目のファイルのみが更新されたこと（他のファイルに影響がないこと）を確認してから報告します。
- **プロキシ経路（3-C）**: 手元のファイルは変わりません。報告には「ミラー（`課題管理/`）へは約1分で自動反映されます」と添えます。

## 注意事項

- 外部サービスへの書き込みのため、「プレビュー → ユーザー承認 → 実行」のフローを必ず守ってください
- **名義を黙って変えないでください**。①②が使えずプロキシ（bot名義）へ落とす場合は、必ず事前に確認して同意を得ます。承認プレビューには常に「投稿者名義」を明記します
- `--issueIdOrKey` / `--wikiId` / `--documentId` オプションは backlog-exporter **v1.0.0以降**で利用可能です。単体指定時は設定ファイルの最終更新日時（`lastUpdated`）が更新されないため、他項目の通常の差分同期に影響を与えません
- `.env` が1Password連携の場合は通常ファイルではなくfifo（名前付きパイプ）のため、`source .env` ではなく `eval "$(grep -v '^#' .env)"` で読み込んでください
- 認証情報の保存場所は動作環境（CLI／デスクトップ／Web）で変わります。`.env` が無くても環境変数があれば動きます（`credentials` ルール参照）。Web/デスクトップから使う場合の入れ場所もそこに記載
- Jira等Backlog以外の課題管理ツールを使う案件では、対応するAPI・同期コマンドに読み替えてください
