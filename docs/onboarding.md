# 参加者オンボーディング（環境の選び方・プラグイン導入・MCP接続）

案件コンテキストリポジトリに参加する人が**最初に一度だけ**やることをまとめる。fleet 管理者・案件 PM は、新しく入るメンバーにこのページを案内すればよい。

## 1. 動かす場所（環境）を選ぶ

Claude Code は手元でもクラウドでも動くが、**プラグイン（cortex のスキル）が使えるのは手元で動かしたときだけ**。クラウド実行では、リポジトリに入っているものだけが効く。

| 経路 | プラグイン（`/コマンド`） | リポ同梱（`.mcp.json`・`CLAUDE.md`・`.claude/`） | 主な対象 |
| --- | --- | --- | --- |
| ターミナル（CLI） | ✅ | ✅ | エンジニア |
| VS Code 拡張 | ✅ | ✅ | エンジニア |
| デスクトップアプリ（**Local** セッション） | ✅ | ✅ | 非エンジニア（PM・デザイナー）の標準 |
| デスクトップアプリ（**Cloud** セッション） | ❌ | ✅ | 手軽な確認 |
| Web版（claude.ai/code） | ❌ | ✅ | 顧客・軽い用途 |

- クラウド実行（Web版・デスクトップの Cloud セッション）で `/create-minute` などのコマンドが候補に出ないのは**不具合ではない**。スキルを使う作業は手元（Local）で行う
- クラウド実行でも、リポジトリを読んで質問する・書く・コミットするといった通常の対話はできる（`CLAUDE.md` の探索戦略もリポ同梱の MCP も効く）
- 手元のセッションは開始時にリポジトリが自動で最新化される（`scripts/session-sync.sh`。未コミットの変更があるときは何もしない）

## 2. 参加者が1回だけやること（cortex プラグインの導入）

手元で使う人は、次の2行を1回だけ実行する（**マシンごとに1回**）。

```bash
claude plugin marketplace add classmethod-team-app/cortex-engine@stable
claude plugin install cortex@cortex-engine
```

- Claude Code のセッション内からは `/plugin marketplace add …` / `/plugin install …` でも同じ
- **デスクトップアプリは GUI で入れられる**: プロンプト欄の **＋** → **Plugins** → **Add plugin** で、マーケットプレイスに `classmethod-team-app/cortex-engine@stable` を追加し、`cortex` をインストールする
- エンジンは private リポなので、GitHub 認証（`gh auth login` など）が済んだ状態で実行する
- 入ったかどうかは `/plugin` の一覧、または `/catch-up-recent-status` 等が候補に出るかで確認する

> エンジン開発の先行検証をする人だけ `@stable` を外して main 追従（カナリア）で入れる。同じマーケットプレイスを ref 違いで併用することはできないため、通常は安定に統一する。

## 3. なぜ手動インストールが要るのか

案件リポの `.claude/settings.json` には `extraKnownMarketplaces` と `enabledPlugins` が宣言されているが、**宣言だけではインストールされない**。外部ソース（GitHub 等）のプラグインは、各メンバーが `claude plugin install` を実行するまでロードされない——というのが Claude Code の現行仕様（サプライチェーン対策として厳格化されたもので、公式ドキュメントにも明記されている）。

宣言自体は「この案件がどのプラグインを前提にしているか」の表明として意味がある。プラットフォーム側の扱いが変われば手動導入は不要になるので、それまでは本ページの手順を各自に案内する。

## 4. MCP の繋ぎ方

| 用途 | サーバー | 供給元 | 各自がやること |
| --- | --- | --- | --- |
| 課題管理（Backlog に**本人名義**で投稿） | `backlog` | 案件リポ同梱の `.mcp.json`（**全環境で効く**） | 自分の `BACKLOG_API_KEY` を環境変数に置く |
| チャット（Slack） | `slack` | cortex プラグイン同梱（**手元のみ**） | 初回に OAuth 承認 |
| デザイン（Figma） | `figma` | cortex プラグイン同梱（**手元のみ**） | 初回に OAuth 承認 |
| 開発（GitHub） | 配らない | — | 手元は `gh auth login`（ブラウザ承認だけ・キー発行不要）。クラウド実行はプラットフォームが提供する GitHub 連携を使う |

- 接続状態の確認・OAuth のやり直しは、手元なら `/mcp`。クラウド実行はセッションのコネクタ設定から
- **鍵の置き場所は動作環境で変わる**（CLI＝`.env`／デスクトップ＝ローカル環境エディタ／Web＝クラウド環境設定）。→ [credentials.md](credentials.md)
- Backlog MCP を繋がずに記票すると、共有ボット名義での投稿になる

## 5. 職能ハーネスを使う場合（社内メンバーのみ）

PM・デザイン・開発・運用・営業のハーネスは、cortex とは別の**部カタログ**から入れる。

```bash
claude plugin marketplace add classmethod-team-app/retail-app-harnesses
claude plugin install pm-harness@retail-app-harnesses
# design-harness / dev-harness / ops-harness / sales-harness も同様
```

- カタログもハーネスも private のため、**入れられるのは社内メンバーだけ**
- **顧客案件リポの `.claude/settings.json` には宣言しない**（顧客の手元では解決できない参照になる）。導入は使う人が各自で行う

## 6. 案件の理解を始める

- 日々の使い方 → 案件リポの `USAGE.md`（シナリオ早見表）
- 概要・フォルダ構成・コマンド一覧 → 案件リポの `README.md`
- 直近の状況 → `/catch-up-recent-status`（手元のセッションで実行）
