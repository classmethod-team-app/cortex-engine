---
name: cortex-grep
description: >-
  frontmatterを辿る「Cortex用grep」。Gold層でヒットさせた決定・用語・レポートを起点に、relations/source/references
  を辿って関連レコード（議事録・課題・資料）を一括で集約して返す
---
`cortex-grep` は、Cortex（Gold層）の探索戦略「**Gold を読む → 関係を辿って生データに降りる**」を1コマンドで実行する検索ツールです。

標準の `grep` は「ヒットしたファイル名」しか返さず、関連（出典・根拠・関係）は frontmatter を見て手で辿り直す必要があります（grep→読む→grep→読む の多段）。`cortex-grep` は **Gold層でseedをヒットさせ、そのfrontmatter（relations / source / references / 本文中のBacklogリンク）を N ホップ辿って、関連レコードを一括で集約**して返します（dedup・新しい順ランク・件数打ち切り付き）。

## いつ使うか

- 「この決定の根拠・経緯（元の議事録・課題）まで一気に欲しい」とき
- 「ある語に関係するGoldと、その出典の生データをまとめて把握したい」とき
- 多段の grep-read を繰り返してトークン・往復を浪費したくないとき

逆に、**全文を横断検索したいだけ**（Goldに無い未精製情報を探す）なら、通常の Grep でリポジトリ全体を検索してください（探索戦略のフォールバック段）。

## 実行手順

本スクリプトは**この Skill に同梱**されている（`scripts/cortex-grep.mjs`）。Skill 起動時に提示される **「Base directory for this skill」** の絶対パスを `<SKILL_DIR>` として使い、**リポジトリルートで**実行する（`--root` の既定はカレントディレクトリ）。

```bash
node "<SKILL_DIR>/scripts/cortex-grep.mjs" "<検索語>" --hops 1 --format json
```

オプション:

- `--hops N` … 関連を辿るホップ数（既定 `1`）。根拠の根拠まで欲しいときだけ `2`。増やすほど件数が膨らむ（後述）
- `--limit K` … 返す件数の上限（既定 `20`）
- `--format json|md` … `json`（AI向け・既定）/ `md`（人間が読む用）
- `--root DIR` … リポジトリルート（既定 `.`）

`pnpm cortex:grep "<検索語>"` でも実行できます。

## 返り値（bundle）

`json` は次の形です。`bundle` は seed（hop 0）＋辿った関連レコードを、近いホップ順・新しい順に並べたものです。

```json
{
  "query": "知見層",
  "hops": 1,
  "seedCount": 2,
  "total": 9,
  "shown": 9,
  "bundle": [
    { "id": "20260610-002", "type": "decision", "layer": "gold", "date": "2026-06-10",
      "hop": 0, "rel": "seed", "path": "Cortex/Decisions/records/…md",
      "title": "…", "content": "…(該当箇所のスライス)…" },
    { "id": "minute:巡回エージェント定例:20260616", "type": "minute", "layer": "context",
      "hop": 1, "rel": "based_on", "path": "会議/…/…minutes.md", "title": "…", "content": "…" }
  ]
}
```

- `layer`: `gold`（Cortexのレコード）/ `context`（議事録・課題・資料等の生データ）/ `pointer`（外部URL・未解決ID）
- `rel`: `seed` / `based_on` / `derived_from` / `relates_to` / `supersedes` / `source` / `reference` / `link`
- `content`: 該当箇所のスライス（生データは抜粋・上限あり）。`pointer` は空

## 注意事項

- **最小実装**です。意味検索（embedding）はせず、**部分一致**のみ（用語集の表記揺れが気になるときは `Cortex/用語集/` で語彙を確認してから検索語を選ぶと漏れが減る）。
- **ホップを増やすと件数が急増**します（seed数 × 各レコードの関係数）。既定の `--hops 1`・`--limit 20` から始め、足りなければ広げてください。
- frontmatter の関係（`relations`/`source`/`references`）に依存します。関係が張られていないレコードは辿れません（その場合は通常の Grep を併用）。
- seed は **Gold層（`Cortex/`）** に対して検索します。Gold に手掛かりが無いテーマは、通常の Grep でリポジトリ全体を探してください。
