# {{リポジトリ名}} — プロジェクトコンテキストリポジトリ

> **このリポジトリは開発用ではなく、プロジェクトのコンテキスト管理用です。**

案件のコンテキスト（議事録・顧客やり取り・共有資料・意思決定記録など）を蓄積し、AI エージェントと人間の両方が横断的に参照できるようにするためのリポジトリです。

> 📖 **日々の使い方は [USAGE.md](USAGE.md) を参照してください**（「こういう時はこうする」のシナリオ別ガイド）。本 README は概要・構成・コマンド一覧をまとめています。

## 背景

プロジェクトのコンテキストを蓄積する目的は、プロジェクト全体の情報を一元管理し、AI Ready な形で保存することにあります。このコンテキスト群はプロジェクトを進める上で活用され、AIS として顧客に開放されます。また最終的には Company Brain を実現するための巡回エージェントの watch 対象となります。

## アーキテクチャ: エンジンとデータの分離

本リポジトリには**データ（コンテキスト）と薄い設定だけ**を置きます。動かす仕組み（スキル・ワークフロー・スクリプト）は中央リポジトリ **[cortex-engine](https://github.com/classmethod-team-app/cortex-engine)** で版管理され、次の2経路で配布されます。

| 経路 | 中身 | 仕組み |
| --- | --- | --- |
| **Claude Code プラグイン** | スキル・エージェント・フック・MCP 設定 | `.claude/settings.json` のマーケットプレイス参照。リポジトリをトラストしたメンバーに自動でインストール案内が出る（1人1回） |
| **Reusable Workflows** | 同期・精製の自動化（GitHub Actions） | `.github/workflows/` の薄いスタブがエンジンの `@v1` を呼ぶ。エンジンのリリースで全案件に自動反映 |

エンジンの改善は自動で降ってくるため、**このリポジトリで仕組みのメンテナンスは不要**です（旧テンプレ複製方式の「テンプレ追従作業」は廃止されました）。

## フォルダ構成

```
{{リポジトリ名}}/
├── CLAUDE.md                     # AI向けの案内（探索戦略・運用原則・案件固有の注意）
├── README.md                     # このファイル
├── USAGE.md                      # 日々の使い方ガイド
├── .claude/settings.json         # プラグイン参照（cortex マーケットプレイス）
├── .github/workflows/            # エンジンを呼ぶ薄いスタブ（cron時刻は案件で調整可）
│
├── Cortex/                       # 精製済みコンテキスト（Gold層）— Viewerの表示対象
│   ├── Home.md                  # 案件の入口・識別カード
│   ├── Decisions/               # 意思決定記録（1決定1ファイル / 毎晩自動追記）
│   ├── Glossary/                # 案件固有の用語・定義（毎晩draft自動追記→人間レビュー）
│   ├── Members/                 # プロジェクト関係者の名簿
│   ├── Rules/                   # 継続的に守る制約・規約
│   └── レポート/                 # 日次/週次レポートの歴史（生成終了・凍結。以後のレポートはPMハーネスがSlack配信）
│
├── 課題管理/                     # 顧客とのやり取り（Backlog等の同期ミラー。手編集しない）
├── 会議/                         # MTG議事録・文字起こし（cortex-notetakerが自動取り込み）
├── チャット/                     # Slackチャンネルの参照設定（中身はミラーせずMCPでライブ参照）
├── 共有資料/                     # 共有資料（Markdown変換して蓄積）
├── 開発/                         # ソースコード・Wiki（git submodule）・GitHub Issuesへの道しるべ
├── デザイン/                     # 画面インベントリ（Figma同期。手編集しない）
└── tmp/                          # 一時ファイル・作業メモ
```

### 既定ツール

ディレクトリ名はツール非依存の抽象名です。同梱の仕組みは既定ツール（**Backlog / Google Meet / Slack / GitHub / Figma**）を前提に配管されています。別ツールを使う案件は差し替え設計が必要です（考え方は cortex-engine の `docs/customize-tooling.md`）。使用ツールの宣言は `Cortex/Home.md` の識別カード（`tools:`）にあります。

## セットアップ

前提は **Claude Code と gh（GitHub CLI）だけ**です（Node や パッケージマネージャは不要）。

1. このリポジトリを Claude Code で開き、フォルダをトラストする → cortex プラグインのインストール案内に「はい」
2. `/setup-project` を実行し、対話に沿って進める（プレースホルダ記入・Secrets 登録・初回同期・会議bot登録）

新規参加メンバーは、リポジトリを Claude Code で開いてトラストし、cortex プラグインのインストール案内に「はい」を押すだけです（1人1回）。案件の理解は `USAGE.md` と、AIS Viewer の「はじめに」チュートリアルから始められます（直近状況は `/catch-up-recent-status`）。

### リポジトリに必要な Secrets（`/setup-project` が案内）

| Secret | 用途 |
| --- | --- |
| `ENGINE_REPO_TOKEN` | エンジン（private）の取得。cortex-engine への read 専用 PAT |
| `BACKLOG_API_KEY` / `BACKLOG_DOMAIN` / `BACKLOG_PROJECT_KEY` | Backlog 自動同期 |
| `AWS_ROLE_TO_ASSUME` | 夜間の AI 精製ジョブ（Bedrock） |
| `FIGMA_TOKEN` | デザイン同期（Figma 利用案件のみ） |

> org が Free プランの間は **repo secret** として登録する（org secret は private リポに届かない）。

## コマンド一覧（cortex プラグインが提供）

| コマンド | 説明 |
| --- | --- |
| `/setup-project` | 環境構築（対話） |
| `/backlog-pull` | 課題の手動同期（普段は自動同期済み。初回・障害時の非常口） |
| `/backlog-push` | 課題への返信・更新を Backlog に反映（要・個人APIキー） |
| `/create-minute` | 文字起こしから議事録を生成 |
| `/update-decision` | 課題・議事録から決定事項を記録（訂正・変更は supersedes） |
| `/update-glossary` | 案件固有の用語を用語集に登録・更新 |
| `/update-member` | プロジェクト関係者を名簿に登録・更新 |
| `/update-rule` | 継続的に守る制約・規約を Rules に登録・更新 |
| `/catch-up-recent-status` | 直近の状況をキャッチアップ |
| `/cortex-grep` | Gold起点で frontmatter を辿り関連レコードを一括取得 |
| `/sync-materials` | 共有資料を Markdown に変換して同期 |
| `/sync-designs` | Figma から画面インベントリを同期 |
| `/read-chat` | チャット（Slack）を channels.json＋Slack MCP でライブ参照 |
| `/git-sync` | 非エンジニア向けの git 操作（保存・最新化・push失敗時の復旧） |
| `/submit-feedback` | Cortex（エンジン）への要望・不具合を upstream に Issue 登録 |

> **PM・開発・デザイン・運用などの職能ハーネスは部カタログから導入します**（案件がプラグインを有効化していればトラスト時にまとめて案内されます）。

## コンテキストの流れ（すべて自動）

```
1. 会議     → cortex-notetaker が文字起こしを自動取り込み → 議事録を自動生成（repository_dispatch 即時＋夜間cron保険）
2. 課題管理 → Webhookリアルタイム同期（数十秒）＋平日毎時cron → 課題管理/ に同期
3. 精製     → 毎晩、議事録・課題から Decisions / 用語集を自動追記（用語はdraft→人間レビュー）
4. レポート → 日次（毎朝）・週次（毎週金曜）の進捗レポートを Slack に配信（PMハーネス。リポジトリには書かない）
5. 検証     → Cortex/ への変更はオントロジー規約で自動検証（validate-cortex）
```

手動で行うのは、資料の取り込み（`/sync-materials`）、課題への返信（`/backlog-push`）、Gold層のレビュー（用語のdraft確認等）だけです。
