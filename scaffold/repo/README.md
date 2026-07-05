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
│   ├── 用語集/                  # 案件固有の用語・定義（毎晩draft自動追記→人間レビュー）
│   └── レポート/                 # 週次レポート（毎週金曜自動生成）
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

ディレクトリ名はツール非依存の抽象名です。同梱の仕組みは既定ツール（**Backlog / Google Meet / Slack / GitHub / Figma**）を前提に配管されています。別ツールの案件は `/customize-tooling` で置き換えます。使用ツールの宣言は `Cortex/Home.md` の識別カード（`tools:`）にあります。

## セットアップ

前提は **Claude Code と gh（GitHub CLI）だけ**です（Node や パッケージマネージャは不要）。

1. このリポジトリを Claude Code で開き、フォルダをトラストする → cortex プラグインのインストール案内に「はい」
2. `/setup-project` を実行し、対話に沿って進める（プレースホルダ記入・Secrets 登録・初回同期・会議bot登録）

新規参加メンバーは `/onboard-member` を実行してください（環境準備＋Gold起点のオリエン）。

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
| `/setup-status` | セットアップの進捗確認と次にやるべきことの提示 |
| `/onboard-member` | 新メンバーのローカル環境準備＋案件理解 |
| `/customize-tooling` | 既定ツール以外を使う場合の置き換え設計・実装 |
| `/clone-dev-repos` | 開発リポジトリを submodule としてクローン |
| `/backlog-pull` | 課題の手動同期（普段は自動同期済み。初回・障害時の非常口） |
| `/backlog-push` | 課題への返信・更新を Backlog に反映（要・個人APIキー） |
| `/create-minute` / `/post-meeting` | 文字起こしから議事録を生成 |
| `/update-decision-log` | 課題・議事録から Decision Log を更新 |
| `/update-glossary` | 案件固有の用語を用語集に登録・更新 |
| `/weekly-report` | 週次レポートを生成 |
| `/catch-up-recent-status` | 直近の状況をキャッチアップ |
| `/cortex-grep` | Gold起点で frontmatter を辿り関連レコードを一括取得 |
| `/sync-materials` | 共有資料を Markdown に変換して同期 |
| `/sync-designs` | Figma から画面インベントリを同期 |
| `/read-chat` | チャット（Slack）を channels.json＋Slack MCP でライブ参照 |
| `/git-save` `/git-pull` `/git-fix-push` | 非エンジニア向けの git 操作 |
| `/submit-feedback` | Cortex（エンジン）への要望・不具合を upstream に Issue 登録 |

> **PM・開発・デザイン・運用などの職能ハーネスは部カタログから導入します**（案件がプラグインを有効化していればトラスト時にまとめて案内されます）。

## コンテキストの流れ（すべて自動）

```
1. 会議     → cortex-notetaker が文字起こしを自動取り込み → 議事録を自動生成（repository_dispatch 即時＋夜間cron保険）
2. 課題管理 → Webhookリアルタイム同期（数十秒）＋平日毎時cron → 課題管理/ に同期
3. 精製     → 毎晩、議事録・課題から Decisions / 用語集を自動追記（用語はdraft→人間レビュー）
4. レポート → 毎週金曜、週次レポートを自動生成
5. 検証     → Cortex/ への変更はオントロジー規約で自動検証（validate-cortex）
```

手動で行うのは、資料の取り込み（`/sync-materials`）、課題への返信（`/backlog-push`）、Gold層のレビュー（用語のdraft確認等）だけです。
