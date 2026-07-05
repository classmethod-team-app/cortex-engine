## コンテキストのオントロジー（v0）

本リポジトリに蓄積されるコンテキストは、以下のオントロジーに従って機械可読なメタデータ（frontmatter）を持つ。AIエージェントはこの定義を前提にコンテキストを読み書きする。

### エンティティ型とID規則

| type | 実体 | ID規則 | 例 |
| --- | --- | --- | --- |
| `decision` | 意思決定レコード（`Cortex/Decisions/records/`） | `YYYYMMDD-NNN` | `20260610-001` |
| `minute` | 議事録 | `minute:{定例名}:{YYYYMMDD}` | `minute:営業ハーネス定例:20260604` |
| `issue` | 課題管理ツールの課題 | 課題キー | `PJ_CORTEX-13` |
| `document` | 課題管理ツールのドキュメント | ツール側のドキュメントID | `019e686c77907a28...` |
| `material` | 変換済み共有資料 | `material:{slug}` | `material:提案書-v2` |
| `term` | 用語 | `term:{slug}` | `term:コンテキスト` |
| `report` | 週次レポート | `report:{YYYYMMDD}-weekly` | `report:20260608-weekly` |
| `design` | デザイン画面（Figmaのトップレベルフレーム） | `design:{fileKey}:{nodeId}` | `design:abc123XYZ:1023:456` |
| `overview` | Cortexのホームページ（1案件1ファイル） | `overview:home`（固定） | `overview:home` |

### リレーションシップ型

| rel | 意味 | 主な使用例 |
| --- | --- | --- |
| `based_on` | 〜を根拠とする | decision → minute / issue |
| `derived_from` | 〜から生成された | minute → 文字起こし、report → 集計元 |
| `relates_to` | 〜に関連する | 汎用 |
| `supersedes` | 〜を置き換える・無効化する | decision → decision（決定の変更履歴） |

### frontmatter共通フィールド

自前で生成・編集するMarkdown（Decisions・議事録・レポート・用語集等）は、種別ごとの固有フィールドに加えて以下を持つ。

```yaml
type: decision          # エンティティ型（必須）
id: "20260610-001"      # 安定ID（必須）
relations:              # 他エンティティとの関係（任意）
  - rel: based_on
    target: "minute:営業ハーネス定例:20260604"
```

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

### 運用原則

- **frontmatterは生成者が付与する**: エクスポート等で上書きされる生データ（`課題管理/` `開発/` 等）に後からfrontmatterを書き足さない。生成スキル・変換スキルがテンプレートとして出力する
- **関係は安定IDで張る**: `relations` の `target` にはファイルパスではなく上記の安定IDを使う。同期による上書き・ファイル名変更に耐えるため
- **派生物は再生成可能にする**: 横断インデックス等はfrontmatterから機械生成し、手では編集しない
