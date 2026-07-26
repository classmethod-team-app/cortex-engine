---
type: overview
id: "overview:home"
title: "Home"
description: "{{プロジェクト名}}のコンテキストリポジトリの入口（Gold層）"
status: active

# プロジェクト識別カード（巡回エージェント/company brainが横断走査時に最初に読む）
kind: 案件 # 案件 | 社内プロジェクト
org: リテールアプリ共創部 # 部署
team: "" # チーム（任意）
project: "{{プロジェクト名}}" # 案件の表示名（例: XX様向けYYシステム開発）
client: "{{クライアント名}}" # 案件のみ。社内プロジェクトは空にする
lifecycle: active # active | archived
adoption: new # new=新規(開始時に導入・ゼロから蓄積) | existing=既存(進行中に後から導入。Decision等の履歴が薄い) | migration=移行(旧Cortexから乗り換え)
domains: [] # 業務ドメイン（例: retail, 会員証, EC）。類似案件の発見に使う
platforms: [] # 技術（例: Web, LINE miniapp, Flutter）
# この案件が各能力で使うツール。セットアップ状況チェック（fleet-status）の対象を決める。
# 既定以外を使う場合は値を変更する（別ツールへの差し替えには設計が必要）。使わない能力は none。
tools:
  課題管理: backlog # backlog | jira | none
  会議: google-meet # google-meet | teams | none
  共有資料: google-drive # google-drive | box | local | none
  チャット: slack # slack | teams | none
  デザイン: none # figma | none
  開発: none # github（ソースをsubmodule同梱） | none
viewer_url: "" # AIS Viewer のURL（任意。ビューアデプロイ後に記入。Slack通知のリンク先等に使う）
# エンジン設定（schema_version はマイグレーションが管理し手編集しない。dev_dir は任意・必要時のみ宣言）
# engine:
#   dev_dir: 開発 # 開発submoduleの置き場が「開発/」以外の場合に宣言（例: GitHub）。外部ソース導出（github-issues）の対象範囲になる
---

# Home

本サイトは{{プロジェクト名}}のコンテキストの入口です。新メンバー・顧客・AIエージェントは、まずこのページから全体を辿れます。

## この仕組みについて

議事録・課題・共有資料・デザイン・ソースコードといった案件の情報は、普段使っているツールに散らばっています。Cortexはそれらを自動で集め、**「あとで判断のよりどころになる確定した情報」だけを抽出した層**を毎晩育てます。人もAIも、まずここを読めば案件を誤らずに把握できる、という状態を作るのが目的です。

情報の見方は2つあります。

- **このサイト（AIS Viewer）**: 精製された確定情報を読む
- **[Claude Code](https://claude.ai/code/)**: 議事録・課題・資料の生データまで含めて、AIに質問・調査する

## このサイトで見られるもの

- **決定事項**: 何が決まったか（1決定＝1ページ）。議事録や課題から毎晩自動で追加されます
- **用語集**: この案件固有の言葉の意味。人とAIの語彙を揃えます
- **メンバー**: 誰が関わっているか。人名の表記ゆれを解決する名簿でもあります
- **ルール**: この案件で継続的に守る約束事（例:「本番リリースは金曜禁止」）

自動で追加されたものには「**AI生成・未確認**」と表示されます。内容を確認して直したら、その印は外れます。各ページの「AIで編集」から直せます。

> 要件・仕様・議事録などの個別ドキュメントはここに置きません。正本は普段お使いのツール（Backlog・Google Drive・GitHub 等）にあり、その写しが自動で同期されます。**Cortexのために新しく書く場所は増えません。**

## 使用ツール

<!-- 案件で使用するツールのリンクを箇条書きで列挙する（セットアップ時に記入） -->

- ソースコード: https://github.com/{{開発リポ}}
- 課題（GitHub Issues）: https://github.com/{{開発リポ}}/issues
- コンテキスト管理: https://github.com/{{org}}/{{リポジトリ名}} （このリポジトリ）
- 課題管理: （Backlog / Jira 等のURL）
- ドキュメント: （Backlogドキュメント / Notion 等のURL）
- デザイン: （Figma等のURL）
- 共有ドライブ: （Google Drive等のURL）
- チャット: （Slack / Teams のチャンネル）
- クラウド: （AWS / GCP コンソール等）

> 認証情報そのものはここに書かない（`.env`・GitHub Actions Secrets等の参照先のみ）。
