---
name: read-chat
description: チャット/channels.json に登録したチャットチャンネル（Slack / Microsoft Teams）を MCP でライブ参照し、最近のやり取りや特定トピックの議論を取得する
---
`チャット/channels.json` に登録されたチャットチャンネル（Slack / Microsoft Teams）を、**MCP 経由でライブ参照**するスキルです。チャット内容はリポジトリにミラーしていないため、その都度チャットツールから取得します。各チャンネルの `platform`（`slack` | `teams`。省略時は `slack`）を見て取得手段を振り分けます。

## 前提

### Slack（`platform: slack`・既定）

- **Slack MCP が接続・認証済み**であること（cortexプラグインの `.mcp.json` の `slack` サーバ）。Slack MCP は **OAuth 2.0（ユーザートークン）** なので、接続できるのは **Slack ワークスペースに入っている社内メンバーのみ**。顧客は OAuth 認証できないため読めない（＝公開範囲の境界）。
- 未接続の場合は Claude Code の MCP 設定から Slack を認証する。顧客環境で読めないのは**正常**。

### Teams（`platform: teams`）

- **Teams には Slack のような公用ホスト型 OAuth MCP エンドポイントが無い**ため、cortexプラグインの `.mcp.json` には Teams サーバをハードコードしていない。**テナントごとに Azure AD アプリ登録＋Graph 権限＋テナント認証**を行い、各自の Claude Code の MCP 設定に Teams MCP を接続する必要がある。
- **接続済みの Teams MCP があれば、そのツール**（メッセージ取得・検索・スレッド取得等）で取得する。未接続なら、その旨と接続方法を案内して**停止**する（Slack と同じ「未接続なら停止」の作法）。
- 接続方法の選択肢（いずれも Azure AD アプリ登録＋Graph 権限＋テナント認証が前提。接続できるのは社内メンバーのみ＝公開範囲の境界。顧客は読めない）:
  - Microsoft 公式の Microsoft 365 / Graph 系 MCP（`github.com/microsoft/mcp`）
  - コミュニティ実装（例: `InditexTech/mcp-teams-server` — メッセージ読取/投稿/リプライ/メンション対応）

### 共通

- 対象チャンネルは `チャット/channels.json` に `{ "name": "...", "platform": "slack|teams", "url": "...", "description": "..." }` で列挙されている（`name` はラベル、`platform` は取得手段、`description` は任意でそのチャンネルの用途・性質。どのチャンネルを見るか／投稿先の判断に使う。例: 顧客閲覧チャンネルである旨など）。

## 手順

1. `チャット/channels.json` を読み、対象チャンネル（各 `name` / `platform` / `url` / `description`）を取得する（複数可）。複数ある場合は、ユーザーの依頼内容と各チャンネルの `name`・`description` から**どのチャンネルを見るかを判断**する（`description` に顧客向け等の注意があれば従う。曖昧なら確認する）。
2. 各チャンネルについて、その `platform` に応じて取得手段を振り分ける:
   - `platform: slack`（既定）: **Slack MCP（`https://mcp.slack.com/mcp`）** のツールで取得する。
   - `platform: teams`: **接続済みの Teams MCP のツール**で取得する。未接続なら上記「Teams」の接続方法を案内して停止する。
   目的に応じて:
   - 最近の状況把握 → 直近メッセージを取得
   - 特定トピック → キーワードで検索（Slack なら `search:read` 系、Teams なら該当する検索ツール）
3. 取得結果を要約・整理して提示する（必要に応じて発言者・日時・スレッドを保持）。

## 注意

- **取得した生のチャット内容はリポジトリに保存しない**（ミラーしない方針。Slack / Teams いずれも同一）。要約を Gold 層（Decision Log 等）に残す場合のみ、**内部限定情報（売上・工数・率直な評価等）が混ざらないよう取捨**してから記録する。
- MCP 未接続・権限なしの場合は、その旨を伝えて停止する。
