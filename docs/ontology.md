## コンテキストのオントロジー（v1）

本リポジトリに蓄積されるコンテキストのうち、機械可読なメタデータ（frontmatter）を持つのは **Gold層（`Cortex/` 配下）だけ**である。Silver/Bronze（議事録・共有資料・デザインインベントリ・課題ミラー等）には frontmatter を付けず、Gold層から**規約ベースの安定ID文字列**で参照する。AIエージェントはこの定義を前提にコンテキストを読み書きする。

### Gold層エンティティ（frontmatter必須）

| type | 実体 | ID規則 | 例 |
| --- | --- | --- | --- |
| `decision` | 意思決定レコード（`Cortex/Decisions/records/`） | `YYYYMMDD-NNN` | `20260610-001` |
| `term` | 用語（`Cortex/Glossary/records/`） | `term:{slug}` | `term:コンテキスト` |
| `rule` | 継続的に守る制約・規約（`Cortex/Rules/records/`） | `rule:{slug}` | `rule:本番リリース-金曜禁止` |
| `open_question` | 未決事項（`Cortex/OpenQuestions/records/`） | `question:{YYYYMMDD}-{NNN}` | `question:20260724-001` |
| `member` | プロジェクト関係者（1人1ファイル、`Cortex/Members/records/`） | `member:{氏名（スペース無し）}` | `member:山田太郎` |
| `report` | レポート（`Cortex/レポート/`）。週次（週の振り返り・日次の集約）と日次（当日のGold昇格ダイジェスト＋概要。動きのない日は `status: skip`） | `report:{YYYYMMDD}-weekly` / `report:{YYYYMMDD}-daily` | `report:20260608-weekly` / `report:20260716-daily` |
| `overview` | Cortexのホームページ（1案件1ファイル） | `overview:home`（固定） | `overview:home` |

Gold層のエンティティは**判断材料**（decision・term・rule・open_question・report・overview）と**台帳的レコード**（member）に大別される。巡回エージェント・AISの横断走査は判断材料を優先し、台帳は人物を特定する必要が生じたときに辞書的に引く。

`rule` は Decision と役割が異なる。**Decision は「経緯のある一回の決定」**（過去の出来事・追記型）、**Rule は「継続的に守る制約」**（今も効いている規範）。Decision から蒸留された Rule は `derived_from` で元 Decision を指す。`open_question` は「内容は未確定だが、未決であること自体は確定した事実」を記録し、AI が未決を推測で補完する幻覚を防ぐ。決定で閉じる際は decision 側が `resolves` でその question を指し、question の `status` を `resolved` にする（この status 更新は人間または明示的スキル操作で行う）。

バリデーション（`validate-cortex`）はGold層のfrontmatterのみを検証し、`relations.target` の実在解決もGold型のID（上記7種）に限って行う。

### Silver/Bronzeへの参照ID（frontmatterなし・ID命名規約のみ）

Gold層の `source` / `relations.target` からSilver/Bronzeを参照するときは、以下の規約IDを使う。**参照先のファイルにfrontmatterは不要**で、実在のバリデーションも行わない。IDは「規約に従った名前」であり、`Cortex/Home.md` の `tools` 宣言とディレクトリ規約・正本ツールのURLから実体にたどり着ける。

| 参照先 | ID規則 | 例 | 実体への解決方法 |
| --- | --- | --- | --- |
| 議事録（`minute`） | `minute:{定例名}:{YYYYMMDD}` | `minute:営業ハーネス定例:20260604` | 会議ディレクトリのパス規約 `…/{定例名}/{YYYYMMDD}/YYYYMMDD_minutes.md` |
| 変換済み共有資料（`material`） | `material:{slug}` | `material:提案書-v2` | 共有資料ディレクトリの変換md（`{slug}.md`。元ファイルが同じstemで隣にある） |
| デザイン画面（`design`） | `design:{fileKey}:{nodeId}` | `design:abc123XYZ:1023:456` | 目録は `デザイン/inventory/`（Silverミラー・frontmatterなし）。1画面ノートは持たない。デザイン全体の指針は `デザイン/DESIGN.md`（sync-designsがフロントマターを、夜間AIが本文を育てる） |
| 課題（`issue`） | 課題管理ツールのネイティブ課題キー | `PJ_CORTEX-13` | 課題ミラー（`課題管理/issues/`）またはツールのURL |
| ドキュメント（`document`) | ツール側のドキュメントID | `019e686c77907a28...` | 課題管理ツールのドキュメントURL・ミラー |

### 参照IDの原則: 正本ツールのネイティブ識別子を使う

リポジトリ内の**ファイルパスは `relations` / `source` に書かない**（パスはフェーズ替え・同期・改名で変わる）。それ以外は、その情報の**正本ツールが持つ安定識別子をそのまま使う**。外部URLは正本側が安定性を保証する参照なので使用してよい。

| 正本ツール | IDの形 | 例 |
| --- | --- | --- |
| Backlog / Jira | 課題キー | `ACME_APP-12` / `PROJ-123` |
| GitHub Issues / PR | `owner/repo#番号`（GitHub標準のクロスリポ参照記法） | `acme-inc/product-web#239` |
| Slack | メッセージ・スレッドのpermalink URL | `https://….slack.com/archives/C…/p1234567890` |
| Google Drive / Box | ドキュメントID または URL | `019e686c77907a28...` |
| 会議（議事録・文字起こし） | `minute:{定例名}:{YYYYMMDD}`（文字起こしは同ディレクトリのファイル名） | `minute:合同定例:20251030` |
| Figma | `design:{fileKey}:{nodeId}` | `design:abc123XYZ:1023:456` |

### リレーションシップ型

| rel | 意味 | 主な使用例 |
| --- | --- | --- |
| `based_on` | 〜を根拠とする | decision → minute / issue |
| `derived_from` | 〜から生成された | report → 集計元 |
| `relates_to` | 〜に関連する | 汎用 |
| `supersedes` | 〜を置き換える・無効化する | decision → decision（決定の変更履歴） |
| `resolves` | 〜を解決する（未決を閉じる） | decision → open_question |

### frontmatter共通フィールド

Gold層のMarkdown（Decisions・用語集・レポート・Home）は、種別ごとの固有フィールドに加えて以下を持つ。

```yaml
type: decision          # エンティティ型（必須）
id: "20260610-001"      # 安定ID（必須）
title: "……"             # 表示名（必須）
description: "……"       # 1文要約（必須。一覧・検索スニペット・frontmatter-first探索・外部消費で使う）
relations:              # 他エンティティとの関係（任意）
  - rel: based_on
    target: "minute:営業ハーネス定例:20260604"
```

> **OKF互換**: `type`（必須）＋`title`/`description` は Google の [Open Knowledge Format (OKF) v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) の必須・推奨フィールドに対応しており、Gold層はOKF準拠のナレッジバンドルとしても消費できる。`id`・型付き`relations`・スキーマ検証はCortex固有の上位互換部分（OKFは未知キーを許容）。

### overview（Home）の識別カード

`overview`（`Cortex/Home.md`）は案件Gold層の入口であり、巡回エージェント・company brainが横断走査時に**最初に読む**。本文を読まずfrontmatterだけで案件を分類・ルーティングできるよう、共通フィールドに加えて以下の「識別カード」を持つ。値はフィルタに使うため**controlled vocabularyを守る**（`setup-project` が記入する）。

| フィールド | 必須 | 値 | 用途 |
| --- | --- | --- | --- |
| `kind` | ○ | `案件` \| `社内プロジェクト` | 顧客案件か社内か（**公開範囲ルールのゲートも兼ねる**） |
| `org` | | 部署名（例: リテールアプリ共創部） | 所有・ルーティング |
| `team` | | チーム名 | 同上（任意） |
| `project` | | 案件の表示名（例: XX様向けYYシステム開発） | 何のプロジェクトか（識別・表示用） |
| `client` | | 顧客名（案件のみ。社内は空） | 案件の相手先 |
| `lifecycle` | ○ | `active` \| `archived` | 進行中か終了か（巡回が終了案件を減点/スキップできる） |
| `adoption` | | `new`（新規） \| `existing`（既存） \| `migration`（移行） | Cortex導入の経緯。`new`=案件開始時に導入しゼロから蓄積／`existing`=進行中の案件に後から導入（Backlog・ソース等から開始しDecision等の履歴が薄い）／`migration`=旧Cortexから乗り換え（移行前の履歴が揃わない）。ViewerがDecisionの薄さを読み手に注記する根拠に使う |
| `domains` | | リスト（例: `[retail, 会員証]`） | 類似案件の発見・機能アセット蒸留 |
| `platforms` | | リスト（例: `[Web, LINE miniapp]`） | 技術での横断検索 |
| `tools` | | マップ（能力→ツール）。能力: `課題管理`/`会議`/`共有資料`/`チャット`/`デザイン`/`開発`。値の例: `課題管理: backlog\|jira\|none` / `会議: google-meet\|teams\|none` / `共有資料: google-drive\|box\|local\|none` / `チャット: slack\|teams\|none` / `デザイン: figma\|none` / `開発: github\|none` | 各能力でどのツールを使うかの宣言。セットアップ状況の自己チェック（`fleet-status`）が、ツール固有チェックの対象（applicability）を判定する。既定以外は `customize-tooling` で差し替え |
| `viewer_url` | | AIS Viewer のURL（例: `https://main.xxxx.amplifyapp.com`） | 任意。Slack通知（Gold昇格サマリ）のリンク先等に使う。ビューアデプロイ後に記入 |
| `engine` | | マップ。`schema_version`: 整数（データスキーマ版。**マイグレーションが管理し手編集しない**）/ `channel`: `stable`（全案件の既定） \| `canary`（cortex-context のみ。エンジンの main に追従）/ `dev_dir`: 文字列（任意。開発submoduleの置き場ディレクトリ。**省略時は `開発`**。外部ソース導出（github-issues）が「dev_dir 配下のsubmodule」を対象範囲にする。置き場が `開発/` 以外の旧構造リポ等で宣言する） | エンジン分離アーキテクチャの設定。schema_version は `engine-migrate` がデータ追随の適用判定に使う（schema_version 1 で導入） |

### 運用原則

- **frontmatterはGold層の生成スキルだけが付与する**: Silver/Bronze（同期ミラー・議事録・変換資料・デザインinventory・`課題管理/` `開発/` 等）にはfrontmatterを付けない・後から書き足さない。Silver/Bronzeの参照IDはパス・ファイル名の規約から導出される
- **関係は安定IDで張る**: `relations` の `target` にはファイルパスではなく上記の安定ID（Gold型ID・規約ID・正本ツールのネイティブ識別子）を使う。同期による上書き・ファイル名変更に耐えるため
- **派生物は再生成可能にする**: 横断インデックス等はfrontmatterから機械生成し、手では編集しない
