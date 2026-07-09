---
name: backlog-push
description: >-
  エディター上で作成した課題コメント・課題本文・Wikiの更新やドキュメントの新規追加をBacklog REST
  API経由で反映し、該当の課題・Wiki・ドキュメントのみをローカルに再同期する
---
課題管理ツール（Backlog）への反映（Push）を行います。取得（Pull）は `/backlog-pull` が担当します。本スキルは「ローカルで作成した内容をBacklogへ反映 → 該当項目のみ再取得して同期」までを一気通貫で行います。

反映は **Backlog REST API（HTTP）を直接呼び出します**（MCP不要）。これにより課題・Wikiの両方を同じ仕組みで扱えます。

## 前提

- `DOMAIN`, `PROJECT_KEY`, `BACKLOG_API_KEY` が**環境変数として参照できる**こと（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数。どこに入れるかは動作環境で変わる → `credentials` ルール参照）
- APIキーに更新権限があること（読み取り専用キーでは反映できません）

すべての手順で、先頭に以下を実行して認証情報を読み込みます。**環境変数が既にあればそれを使い、無ければ `.env` にフォールバック**します（1Password連携のfifo対応のため `source` は使いません）。

```bash
set -a; [ -e .env ] && eval "$(grep -v '^#' .env)"; set +a
# 必須変数の検証（欠けていたら動作環境に応じた入れ場所を案内する。credentials ルール参照）
: "${DOMAIN:?未設定。動作環境に応じた環境変数の入れ場所は credentials ルール参照}"
: "${PROJECT_KEY:?未設定。同上}"
: "${BACKLOG_API_KEY:?未設定。同上}"
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

### 3. Backlog REST APIで反映

承認後、種別に応じて以下のいずれかを実行します。`BACKLOG_API_KEY` はクエリパラメータ `apiKey` で渡します。本文は `--data-urlencode` で安全にエンコードします。

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

### 4. 該当項目のみ再同期

反映後、更新した項目だけをローカルへ取り直します。`update` コマンドは対象ディレクトリの `backlog-settings.json` からドメイン・プロジェクト・APIキーを読み込みます。

```bash
# 課題（課題キーまたは課題ID。カンマ区切りで複数可）
pnpm dlx backlog-exporter@1 update --issueIdOrKey PROJ-123 --force ./課題管理/issues

# Wiki（Wiki ID）
pnpm dlx backlog-exporter@1 update --wikiId 12345 --force ./課題管理/wiki

# ドキュメント（ドキュメントID）※Backlog側で編集した内容をローカルへ取り直す用途
pnpm dlx backlog-exporter@1 update --documentId abc123 --force ./課題管理/documents
```

これらのID指定フラグは全件差分更新ではないため、設定ファイルの最終更新日時（`lastUpdated`）は更新されず、次回の通常の差分更新に影響を与えません。

### 5. 結果の確認と報告

`git diff` で該当項目のファイルのみが更新されたこと（他のファイルに影響がないこと）を確認し、結果を報告します。報告には手順3で控えた**書き込んだ課題・コメント・WikiのURL**を必ず含め、ユーザーがワンクリックでBacklog上の反映結果を確認できるようにします。

## 注意事項

- 外部サービスへの書き込みのため、「プレビュー → ユーザー承認 → 実行」のフローを必ず守ってください
- `--issueIdOrKey` / `--wikiId` / `--documentId` オプションは backlog-exporter **v1.0.0以降**で利用可能です。単体指定時は設定ファイルの最終更新日時（`lastUpdated`）が更新されないため、他項目の通常の差分同期に影響を与えません
- `.env` が1Password連携の場合は通常ファイルではなくfifo（名前付きパイプ）のため、`source .env` ではなく `eval "$(grep -v '^#' .env)"` で読み込んでください
- 認証情報の保存場所は動作環境（CLI／デスクトップ／Web）で変わります。`.env` が無くても環境変数があれば動きます（`credentials` ルール参照）。Web/デスクトップから使う場合の入れ場所もそこに記載
- Jira等Backlog以外の課題管理ツールを使う案件では、対応するAPI・同期コマンドに読み替えてください
