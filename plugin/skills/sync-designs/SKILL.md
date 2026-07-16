---
name: sync-designs
description: Figmaから画面インベントリ（全画面の一覧・安定ID・ディープリンク・サムネイル）を デザイン/inventory/ に同期し、DESIGN.mdのデザイントークン（YAMLフロントマター）を自動生成する
---
Figmaファイルの**画面インベントリ（目録）**を `デザイン/inventory/` に同期します。デザインの絵そのものではなく「どんな画面が存在し、どこにあり、何と関係しうるか」をAIが辿れる形（1画面1md）にするのが目的です。

あわせて、`デザイン/DESIGN.md` の**デザイントークン（YAMLフロントマター）**をFigmaの実データ（published styles・頻度集計）から自動生成します。フロントマター＝機械可読トークン（このスキルが上書き）／Markdown本文＝人間+AIの設計判断（バイト単位で保全・触らない）の分業です。

## 実行手順

```bash
set -a; [ -e .env ] && eval "$(grep -v "^#" .env)"; set +a
python3 "<SKILL_DIR>/scripts/sync_designs.py"
```

`<SKILL_DIR>` はSkill起動時に提示される「Base directory for this skill」の絶対パス。

## 前提条件

- `デザイン/figma.json` に対象ファイルが設定されていること:

```json
{
  "files": [{ "key": "FigmaのファイルキーをURLから", "name": "メモ（任意）" }]
}
```

- 環境変数 `FIGMA_TOKEN`（read権限のPersonal Access Token）。`.env` が無くても環境変数があれば動く。保存場所は動作環境で変わる（ローカルCLIなら `.env`、デスクトップはローカル環境エディタ、Webはクラウド環境設定の環境変数 → `credentials` ルール参照）

## 生成されるもの

- `デザイン/inventory/{ファイル名}/{画面名}-{nodeId}.md` — 1画面1ファイル。本文に画面名・参照ID `design:{fileKey}:{nodeId}`・Figmaディープリンク・更新日・サムネイル（frontmatterは付けない。frontmatterを持つのはGold層のみ＝オントロジー規約）
- `デザイン/resources/{fileKey}/{nodeId}.png` — サムネイル
- `デザイン/DESIGN.md` のYAMLフロントマター — デザイントークン（colors / typography / rounded / spacing）。published stylesの名前と実値から生成し、無ければツリーの頻度集計にフォールバックする（意味名の推測はしない）。`figma.json` に複数ファイルがある場合は先頭ファイルのみが源。本文は変更しない。DESIGN.mdが無ければscaffoldテンプレをベースに新規作成する

## 注意事項

- **`デザイン/inventory/` は同期ミラー**（正本はFigma）。手編集しない。毎回全消し再生成され、Figma側の削除・改名に追従する
- 課題・議事録・Decisionsからは安定ID（`design:{fileKey}:{nodeId}`）で `relations` を張れる（オントロジー規約参照）。nodeIdはフレームの改名・移動に耐える
- 夜間ワークフロー（`.github/workflows/sync-designs.yml`）が毎晩自動実行する。手動で最新化したいときだけこのスキルを使う
