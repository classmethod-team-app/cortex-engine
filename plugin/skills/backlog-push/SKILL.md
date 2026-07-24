---
name: backlog-push
description: >-
  エディター上で作成した課題コメント・課題本文・Wikiの更新やドキュメントの新規追加をBacklog REST
  API経由で反映し、該当の課題・Wiki・ドキュメントのみをローカルに再同期する
---
課題管理ツール（Backlog）への反映（Push）を行います。取得（Pull）は `/backlog-pull` が担当します。本スキルは「ローカルで作成した内容をBacklogへ反映 → 該当項目のみ再取得して同期」までを一気通貫で行います。

反映は **Backlog REST API（HTTP）を直接呼び出します**（MCP不要）。これにより課題・Wikiの両方を同じ仕組みで扱えます。

## 前提

反映の前に、**どの経路で認証を解決するか**を次の順で判定します。

1. **環境変数（直接API経路・従来どおり）**: `DOMAIN` / `PROJECT_KEY` / `BACKLOG_API_KEY` が**環境変数として参照できる**（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数。どこに入れるかは動作環境で変わる → `credentials` ルール参照）なら、Backlog REST API を直接呼び出します（エンジニア向け・従来の経路）
2. **プロキシ経路**: 環境変数が無く、`課題管理/backlog-proxy.json` があれば、中央プロキシ（Lambda）経由でBacklogに記票します。**手元にBacklog APIキーは不要**で、リポジトリにアクセスできる人なら誰でも使えます（PM・非エンジニア・顧客向け）。書き込み先はファイル内の案件に強制されます
3. **どちらも無い場合**: 認証情報の入れ場所を案内します（`credentials` ルール参照）。動作環境（CLI／デスクトップ／Web）ごとに入れ場所が変わります

環境変数経路では、APIキーに更新権限があること（読み取り専用キーでは反映できません）。

### 環境変数経路の読み込み

環境変数経路では、すべての手順の先頭で以下を実行して認証情報を読み込みます。**環境変数が既にあればそれを使い、無ければ `.env` にフォールバック**します（1Password連携のfifo対応のため `source` は使いません）。

```bash
set -a; [ -e .env ] && eval "$(grep -v '^#' .env)"; set +a
# 必須変数の検証（欠けていたら動作環境に応じた入れ場所を案内する。credentials ルール参照）
: "${DOMAIN:?未設定。動作環境に応じた環境変数の入れ場所は credentials ルール参照}"
: "${PROJECT_KEY:?未設定。同上}"
: "${BACKLOG_API_KEY:?未設定。同上}"
```

### プロキシ経路の読み込み

プロキシ経路では、`課題管理/backlog-proxy.json`（接続先URL・案件キー・案件別トークン。配置方法はセットアップ手順参照）を読み込みます。手元にBacklog APIキーは不要です。

```bash
CONF=課題管理/backlog-proxy.json
URL=$(jq -r .url "$CONF"); PKEY=$(jq -r .projectKey "$CONF"); TOKEN=$(jq -r .token "$CONF")
```

## 対応範囲（重要）

種別ごとにBacklog APIの対応が異なります。**ドキュメントは新規追加のみ可能で、既存の本文更新はできません。**

| 種別 | Backlogへ反映（push） | 特定IDで再取得（pull） |
| --- | --- | --- |
| **課題** | ✅ コメント追加 `POST /issues/:id/comments` ／ 本文・属性更新 `PATCH /issues/:id` | ✅ `update --issueIdOrKey` |
| **Wiki** | ✅ 更新 `PATCH /wikis/:id` | ✅ `update --wikiId` |
| **ドキュメント** | ⚠️ **新規追加のみ** `POST /documents`（既存の本文更新はAPIなし） | ✅ `update --documentId` |

ドキュメントは依頼内容で扱いが分かれます。

- **新規ドキュメントの追加**: `POST /documents` で対応します（手順3）。
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

Backlogへの書き込みは顧客にも見える慎重な操作のため、承認を求める際は必ず 🚨 絵文字を使って以下の形式で確認してください。

```
🚨 **Backlogへの書き込み確認** 🚨

- 対象: PROJ-123「課題タイトル」（または Wiki: 12345「ページ名」）
- 操作: コメント追加（または 本文更新 / 属性変更 / Wiki更新）

--- 反映する内容 ---
（本文をそのまま提示）
---

この内容でBacklogに反映してよろしいですか？
```

### 3. Backlog へ反映

承認後、判定した認証経路に応じて実行します。**環境変数経路は 3-A**、**プロキシ経路は 3-B** を使います。

#### 3-A. 環境変数経路（Backlog REST API を直接呼び出す）

種別に応じて以下のいずれかを実行します。`BACKLOG_API_KEY` はクエリパラメータ `apiKey` で渡します。本文は `--data-urlencode` で安全にエンコードします。

**課題にコメントを追加**

```bash
curl -sS -X POST "https://$DOMAIN/api/v2/issues/PROJ-123/comments?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "content=コメント本文"
```

**課題の本文・属性を更新**（`summary`=件名 / `description`=本文 / `statusId`・`assigneeId` 等）

```bash
curl -sS -X PATCH "https://$DOMAIN/api/v2/issues/PROJ-123?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "description=新しい本文"
```

**Wikiを更新**（`name`=ページ名 / `content`=本文。いずれも任意）

```bash
curl -sS -X PATCH "https://$DOMAIN/api/v2/wikis/12345?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "content=新しいWiki本文"
```

**ドキュメントを新規追加**（`projectId`=数値のプロジェクトID が必須。`title`=タイトル / `content`=本文(Markdown) / `parentId`=配置先フォルダ・親ドキュメントのID は任意）

```bash
# projectIdは数値が必要。PROJECT_KEYから解決する
PROJECT_ID=$(curl -sS "https://$DOMAIN/api/v2/projects/$PROJECT_KEY?apiKey=$BACKLOG_API_KEY" | jq -r .id)

curl -sS -X POST "https://$DOMAIN/api/v2/documents?apiKey=$BACKLOG_API_KEY" \
  --data-urlencode "projectId=$PROJECT_ID" \
  --data-urlencode "title=新規ドキュメントのタイトル" \
  --data-urlencode "content=本文（Markdown）"
```

既存ドキュメントの**本文更新**はこの手順では行いません（APIなし）。依頼された場合はBacklog上で直接編集してもらい、手順4の取り直しのみ行います（「対応範囲」参照）。

レスポンス（JSON）からURLを組み立てて控えておきます（手順5で報告するため）。

- 課題: `https://{DOMAIN}/view/{課題キー}`
- コメント: `https://{DOMAIN}/view/{課題キー}#comment-{コメントID}`（コメントIDはレスポンスの `id`）
- Wiki: `https://{DOMAIN}/alias/wiki/{Wiki ID}`
- ドキュメント（新規追加時）: `https://{DOMAIN}/document/{PROJECT_KEY}/{ドキュメントID}`（ドキュメントIDはレスポンスの `id`）

#### 3-B. プロキシ経路（中央プロキシ Lambda 経由）

プロキシ経由の投稿は、Backlog上の投稿者が**共有ボットアカウント**になります。誰の記票かを残すため、**本文末尾に `---` 区切りの記名を必ず付け**、`author` フィールドにも同じ名前を入れます（監査ログ用）。利用者名は `git config user.name` 等から推定し、**手順2の🚨承認プレビューで確認**してください。

```bash
AUTHOR="$(git config user.name)"   # 推定した利用者名。承認プレビューで確認する
# 本文末尾に記名を付す（実際の本文を BODY に入れる）
BODY="コメント本文"
CONTENT="$(printf '%s\n\n---\n_投稿: %s（Cortex経由）_' "$BODY" "$AUTHOR")"
```

各アクションは JSON ボディを組み立て、`?op=backlog&t=${TOKEN}` に POST します。`projectKey` は必ず添え、`projectId` はプロキシ側が案件から解決・強制注入するため送りません（送っても案件に強制されます）。

**課題にコメントを追加**（`comment`）

```bash
curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg content "$CONTENT" \
    '{projectKey:$pk, author:$author, action:"comment", issueKey:"PROJ-123", content:$content}')"
```

**課題の本文・属性を更新**（`issue-update`。`params` に `summary`/`description`/`statusId`/`assigneeId` 等を透過で渡す）

```bash
curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg desc "$CONTENT" \
    '{projectKey:$pk, author:$author, action:"issue-update", issueKey:"PROJ-123", params:{description:$desc}}')"
```

**課題を新規作成**（`issue-create`。`params.summary` 必須・`description` 等任意。`issueTypeId`/`priorityId` 未指定はプロキシが補完）

```bash
curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg summary "新規課題の件名" --arg desc "$CONTENT" \
    '{projectKey:$pk, author:$author, action:"issue-create", params:{summary:$summary, description:$desc}}')"
```

**Wikiを更新**（`wiki-update`。`params` に `name`/`content` を渡す。いずれも任意）

```bash
curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg content "$CONTENT" \
    '{projectKey:$pk, author:$author, action:"wiki-update", wikiId:"12345", params:{content:$content}}')"
```

**ドキュメントを新規追加**（`document-create`。`params.title`/`content` を渡す。`parentId` は任意。`projectId` はプロキシが解決）

```bash
curl -sS -X POST "${URL}?op=backlog&t=${TOKEN}" \
  -H "content-type: application/json" \
  -d "$(jq -n --arg pk "$PKEY" --arg author "$AUTHOR" --arg title "新規ドキュメントのタイトル" --arg content "$CONTENT" \
    '{projectKey:$pk, author:$author, action:"document-create", params:{title:$title, content:$content}}')"
```

既存ドキュメントの**本文更新**はプロキシ経路でも行いません（APIなし・「対応範囲」参照）。プロキシは削除系アクションを持ちません（記票のみ）。

レスポンスは `{ "result": …Backlogレスポンス…, "url": "…閲覧URL…" }` の形で返り、`url` はプロキシが組み立て済みです。手順5の報告ではこの `url` をそのまま使います。

### 4. 該当項目のみ再同期

再同期は認証経路で分岐します。

**環境変数経路（3-A）**: 反映後、更新した項目だけをローカルへ取り直します。`update` コマンドは対象ディレクトリの `backlog-settings.json` からドメイン・プロジェクト・APIキーを読み込みます。

```bash
# 課題（課題キーまたは課題ID。カンマ区切りで複数可）
pnpm dlx backlog-exporter@1 update --issueIdOrKey PROJ-123 --force ./課題管理/issues

# Wiki（Wiki ID）
pnpm dlx backlog-exporter@1 update --wikiId 12345 --force ./課題管理/wiki

# ドキュメント（ドキュメントID）※Backlog側で編集した内容をローカルへ取り直す用途
pnpm dlx backlog-exporter@1 update --documentId abc123 --force ./課題管理/documents
```

これらのID指定フラグは全件差分更新ではないため、設定ファイルの最終更新日時（`lastUpdated`）は更新されず、次回の通常の差分更新に影響を与えません。

**プロキシ経路（3-B）**: 手元での再同期は**行いません**。プロキシ経由の書き込みは Backlog の Webhook → リアルタイム同期が**自動でミラーに反映**します（通常1分前後）。読み取りキーを持たない利用者でも、起票からミラー反映まで完結します。

### 5. 結果の確認と報告

結果を報告します。報告には手順3で控えた**書き込んだ課題・コメント・WikiのURL**を必ず含め、ユーザーがワンクリックでBacklog上の反映結果を確認できるようにします。

- **環境変数経路（3-A）**: `git diff` で該当項目のファイルのみが更新されたこと（他のファイルに影響がないこと）を確認してから報告します。
- **プロキシ経路（3-B）**: 手元のファイルは変わりません。報告には「ミラー（`課題管理/`）へは約1分で自動反映されます」と添えます。

## 注意事項

- 外部サービスへの書き込みのため、「プレビュー → ユーザー承認 → 実行」のフローを必ず守ってください
- `--issueIdOrKey` / `--wikiId` / `--documentId` オプションは backlog-exporter **v1.0.0以降**で利用可能です。単体指定時は設定ファイルの最終更新日時（`lastUpdated`）が更新されないため、他項目の通常の差分同期に影響を与えません
- `.env` が1Password連携の場合は通常ファイルではなくfifo（名前付きパイプ）のため、`source .env` ではなく `eval "$(grep -v '^#' .env)"` で読み込んでください
- 認証情報の保存場所は動作環境（CLI／デスクトップ／Web）で変わります。`.env` が無くても環境変数があれば動きます（`credentials` ルール参照）。Web/デスクトップから使う場合の入れ場所もそこに記載
- Jira等Backlog以外の課題管理ツールを使う案件では、対応するAPI・同期コマンドに読み替えてください
