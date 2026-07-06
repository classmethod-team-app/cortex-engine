# Decisions

プロジェクトの意思決定を記録・追跡するディレクトリ。

## 構成

1決定1ファイルで管理する。命名規則は `YYYYMMDD-NNN-決定内容の要約.md`。

```
Cortex/Decisions/
├── README.md       # この規約
├── template.md     # 雛形
└── records/        # 実データ（1決定1ファイル）
    ├── 20260320-001-フレームワークにnextjsを採用.md
    ├── 20260322-001-認証方式にcognitoを採用.md
    └── ...
```

## テンプレート

新しいDecisionを作成するときは [`template.md`](./template.md) をコピーし、`records/YYYYMMDD-NNN-決定内容の要約.md` として記入する。

## サンプル

### 技術選定

```markdown
---
type: decision
id: "20260325-001"
title: "フロントエンドフレームワークにNext.jsを採用"
date: 2026-03-25
sprint: sprint1
category: 技術選定
deciders:
  - CM_鈴木花子
  - {{クライアント名}}_田中太郎
summary: "フロントエンドフレームワークにNext.jsを採用する"
relations:
  - rel: based_on
    target: "minute:定例:20260325"
references:
  - "会議/Ph.1/20260325/minutes.md"
  - "[{{開発リポ}}#1](https://github.com/{{開発リポ}}/issues/1)"
---

# フロントエンドフレームワークにNext.jsを採用

## 背景

新規Webアプリのフロントエンド開発にあたり、フレームワークを選定する必要があった。SEO要件（SSR）と開発チームの習熟度の両面から候補を比較した。

## 理由

- SSR/SSGを標準でサポートしており、SEO要件を満たせる。
- 開発チームがReactに習熟しており、学習コストが低い。
- 比較対象としてNuxt.js（Vue）も検討したが、チームのスキルセットとエコシステムの広さからNext.jsを選定した。
```

### ビジネス（機能要件に関する意思決定）

```markdown
---
type: decision
id: "20260402-001"
title: "プレゼント応募は1ユーザーにつき1回までとする"
date: 2026-04-02
sprint: sprint2
category: ビジネス
deciders:
  - CM_鈴木花子
  - {{クライアント名}}_田中太郎
summary: "キャンペーンのプレゼント応募は、不正・重複応募を防ぐため1ユーザーにつき1回までに制限する"
relations:
  - rel: based_on
    target: "minute:定例:20260402"
references:
  - "会議/Ph.1/20260402/minutes.md"
  - "[{{開発リポ}}#42](https://github.com/{{開発リポ}}/issues/42)"
---

# プレゼント応募は1ユーザーにつき1回までとする

## 背景

キャンペーン機能のプレゼント応募について、1ユーザーが何回まで応募できるかの仕様が未確定だった。応募回数の上限は当選確率の公平性・抽選運用・不正対策に直結するため、機能要件として確定させる必要があった。

## 理由

- 同一ユーザーによる重複応募を許すと当選の公平性が損なわれ、景品表示法・キャンペーン規約上のリスクが生じる。
- 複数回応募を可能にする案（応募ごとに当選確率が上がる方式）も検討したが、抽選ロジックと当選通知の運用が複雑になり、初回リリースのスコープに対して過剰と判断した。
- まず1回制限のシンプルな仕様でリリースし、効果測定後に複数回応募の導入を別途検討する方針とした。
```

## フィールド

> エンティティ型・ID規則・関係型の全体定義は、オントロジー規約（cortex-engine の `docs/ontology.md`）を参照。

### 必須

| フィールド | 説明 |
|-----------|------|
| type | エンティティ型。Decisionレコードは常に `decision` |
| id | 日付ベースの連番（`YYYYMMDD-NNN` 形式、例: `20260326-001`）。同日内で連番を振る |
| title | 決定内容のタイトル |
| date | 決定日（YYYY-MM-DD） |
| sprint | スプリント（例: `sprint1`）。スプリント運用していない場合はフェーズ（例: `Ph.1`）を記載 |
| deciders | 決定に関わった人のリスト（`組織_名前` の形式、例: `CM_鈴木花子`, `{{クライアント名}}_田中太郎`） |
| category | カテゴリー（下記「カテゴリー一覧」から選択） |
| summary | 決定内容の要約 |
| references | 決定が行われた場所への参照（人間向けの自由記述リンク）。ローカルファイルはリポジトリルートからの相対パス（例: `"会議/Ph.1/20260325/minutes.md"`）、外部リンクはMarkdownリンク形式（例: `"[{{開発リポ}}#1](https://github.com/{{開発リポ}}/issues/1)"`）で記載 |

### 任意

| フィールド | 説明 |
|-----------|------|
| relations | 他エンティティとの型付き関係（機械可読）。`rel`（`based_on`=根拠 / `relates_to`=関連 / `supersedes`=過去の決定の置き換え）と `target`（安定ID。例: `minute:営業ハーネス定例:20260604`、課題キー `PROJ-123`、決定ID `20260528-002`）の組で記載する。**ファイルパスは使わない** |

`references`（人間向け）と `relations`（機械向け）は併存させる。決定の根拠がある場合は `relations` の `based_on` を、過去の決定を変更する場合は `supersedes` を必ず記載する。

上記以外のフィールドは追加しない。

## カテゴリー一覧

新しいカテゴリーが必要な場合はここに追記する。

| カテゴリー | 説明 |
|-----------|------|
| ビジネス | 要件、仕様、スコープに関する決定 |
| 技術選定 | フレームワーク、ライブラリ、ツールの選定 |
| 設計方針 | アーキテクチャ、データモデル、API設計などの方針 |
| 運用ルール | 開発フロー、ブランチ戦略、レビュー方針など |
| インフラ | クラウドサービス、環境構成、デプロイ方式の決定 |
| デザイン | 画面構成、UI/UX、ビジュアルに関する決定 |


## 同期方法

手動で作成・編集する。`update-decision-log` スキルで、課題のコメントや議事録から決定事項を抽出して記録する。

## 閲覧・編集（Viewer）

`Cortex/Decisions/` は、`@takagaki/cortex-decisions-viewer` で静的サイトにビルドし、AWS Amplify Hosting（Basic認証付き）で閲覧できる。

- **閲覧**: AmplifyのViewer（一覧・検索・期間/カテゴリーでフィルタ、`?id=<id>` で個別リンク）
- **編集**: Viewer詳細画面の「✏️ GitHubで編集」ボタンから該当mdを直接編集 → コミットでViewerが自動再デプロイ
- **新規作成**: `template.md` をコピーしてファイルを追加（前述の手順）

ビューアの実装・デプロイ手順（Amplifyのインフラ定義・案件オンボーディング）は [`cortex-tools`](https://github.com/classmethod-team-app/cortex-tools) リポジトリ側で管理する（`viewer/` と `infra/` の README を参照）。本リポジトリに必要なのは `Cortex/Decisions/` の中身だけ。

### ⚠️ このディレクトリの場所を変更してはいけない

`Cortex/Decisions/` の配置は、リポジトリ内のスキル・ワークフローだけでなく**外部ツールからも参照されている**。

- Viewer（`@takagaki/cortex-decisions-viewer` v0.2.0以降）は `Cortex/Decisions/records` → `Cortex/Decisions` → `Decisions` の順で自動検出する。**これ以外の場所への移動・改名はViewerのビルドを壊す**
- AmplifyのビルドコマンドはAmplifyアプリ側に焼き込まれているため、ディレクトリ構成を変更した場合は cortex-tools 側の追従（viewerの探索候補の更新・`npm publish`）と、各案件の `cdk deploy DecisionsViewer-<key>` の再実行が必要になる

どうしても変更が必要な場合は、cortex-tools のviewer・infraとセットで計画すること（経緯: [aidd-project-cortex#37](https://github.com/classmethod-team-app/aidd-project-cortex/pull/37) / [cortex-tools#1](https://github.com/classmethod-team-app/cortex-tools/pull/1)）。
