# Cortex/ — 精製済みコンテキスト（Gold層）

このディレクトリは、案件の**精製された判断材料（Gold層）**を集約する場所です。リポジトリ全体が経験の総体（コンテキスト）であるのに対し、ここには構造化・精製済みのデータだけを置きます。

- **巡回エージェントの読み取り入口**: 横断走査はまずこの配下を読む
- **AISの顧客開放単位**: 顧客と共有する精製コンテキストの境界
- **人間承認ゲートの境界**: この配下への書き込みは必ず人間の承認を通す

## 構成

```
Cortex/
├── Decisions/        # 意思決定レコード（type: decision）
├── 用語集/           # 案件固有の用語・定義（type: term）
├── レポート/          # 週次レポート等（type: report）
└── Home.md           # Cortexの入口（type: overview / 唯一の単独ページ）
```

### 直下に自由にページを増やさない

Cortex直下の単独ページは **`Home.md` のみ**とする。「とりあえずここに置く」を許すとCortex自体が作業場・ゴミ捨て場化し、Gold層の信頼が崩れるため。個別のドキュメント（要件・仕様・メモ等）の正本は課題管理ツールのドキュメント機能等に置き、`課題管理/` への同期で取り込む。Homeに収まらない恒常的なページが本当に必要になった場合は、チームで合意してから追加する。

各ディレクトリは「`README.md`（規約）＋ `template.md`（雛形）＋ `records/`（実データ）」の構成で統一する。スキル・ツールは `records/*.md` だけを読み書きする。

### ⚠️ このディレクトリ構造を変更してはいけない

`Cortex/` 配下の構造（ディレクトリ名・`records/` の階層）は、リポジトリ内外の多くの仕組みから**パスとして参照されている**。安易に移動・改名するとそれらが壊れる。

| 依存しているもの | 壊れ方 |
| --- | --- |
| 生成スキル（update-decision-log系 / update-glossary系 / weekly-report） | 書き込み先・重複照合のパスがズレ、誤った場所に生成される |
| 夜間cron（`.github/workflows/` の自動更新3本） | 走査・コミット対象が空になり、静かに何も生成されなくなる |
| AIS Viewer（`@takagaki/cortex-decisions-viewer`） | 自動検出（`Cortex/Decisions/records` → `Cortex/Decisions` → `Decisions`）から外れ、Amplifyのビルドが失敗する |
| 巡回エージェント・AIS | Gold層の読み取り入口・顧客開放単位として本構造を前提とする |

変更が必要な場合は、テンプレート（aidd-project-cortex）・[cortex-tools](https://github.com/classmethod-team-app/cortex-tools)（viewer / infra）・各案件リポジトリへの展開をセットで計画すること（経緯と移行例: [#37](https://github.com/classmethod-team-app/aidd-project-cortex/pull/37) / [cortex-tools#1](https://github.com/classmethod-team-app/cortex-tools/pull/1)）。

## 運用原則

- frontmatterのスキーマは**リンターで機械検証される**（`pnpm run lint:cortex`）。pre-commitとCI（PR・mainへのpush）で自動実行され、規約違反はマージできない

- 配下のすべてのMarkdownはオントロジー規約（`.rulesync/rules/ontology.md`）に従ったfrontmatterを持つ
- 手で直接書くのではなく、原則としてスキル（`/update-decision-log` `/update-glossary` `/weekly-report` 等）経由で生成・更新する
- 生データ（課題管理/・会議/の文字起こし等）はここに置かない
