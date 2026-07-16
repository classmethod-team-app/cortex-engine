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
# 既定以外を使う場合は値を変更（customize-tooling 参照）。使わない能力は none。
tools:
  課題管理: backlog # backlog | jira | none
  会議: google-meet # google-meet | teams | none
  共有資料: google-drive # google-drive | box | local | none
  チャット: slack # slack | teams | none
  デザイン: none # figma | none
  開発: none # github（ソースをsubmodule同梱） | none
viewer_url: "" # AIS Viewer のURL（任意。ビューアデプロイ後に記入。Slack通知のリンク先等に使う）
---

# Home

本サイトは{{プロジェクト名}}のコンテキストの入口です。新メンバー・顧客・AIエージェントは、まずこのページから全体を辿れます。

## AISについて

このプロジェクトでは、議事録・課題・共有資料・意思決定といった**プロジェクトの全コンテキストを1か所に蓄積**しています。人とAIの両方がここを参照して作業することで、経緯の確認・引き継ぎ・横断的な分析にかかる手間を恒久的に減らすことが目的です。

コンテキストの見方は2つあります。

- **AIS Viewer（このサイト）**: 蓄積したコンテキストのうち、**整理済みの決定情報**（決定・用語・レポート）を見る
- **[Claude Code](https://claude.ai/code/)**: リポジトリを選択すると、議事録・課題・資料の元の生データを含む**すべてのコンテキスト**についてAIに質問・調査ができる

## このサイトで見られるもの

蓄積したコンテキストの中から、**あとで判断のよりどころになる情報だけを整理して集めたもの**です。

- **Decisions**: 意思決定の記録（1つの決定＝1ページ）。議事録や課題でのやり取りから毎晩自動で追加されます
- **用語集**: このプロジェクト固有の用語と定義。言葉のゆれをなくし、人とAIの語彙を揃えます。新しい用語は毎晩自動で「AI生成・未確認」として追加されるので、内容を確認して正しい定義に直してください
- **レポート**: 週ごとの進捗まとめ。自動で作られます

> 個別のドキュメント（要件・仕様・打ち合わせメモ等）はここには置きません。原本は課題管理ツール（Backlog / GitHub Wiki等）にあり、その写しがこのリポジトリに自動で同期されます。


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
