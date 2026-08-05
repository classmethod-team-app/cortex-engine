---
name: sync-designs
description: Figmaから画面インベントリ（全画面の一覧・安定ID・ディープリンク）を デザイン/inventory/ に同期する
---
Figmaファイルの**画面インベントリ（目録）**を `デザイン/inventory/` に同期します。デザインの絵そのものではなく「どんな画面が存在し、どこにあり、何と関係しうるか」をAIが辿れる形（1画面1md）にするのが目的です。

**画像は取りません。** 目的は地図であって絵ではありません。画面の中身を見たいときは Figma MCP で当該フレームを直接開きます（閲覧権限の境界がFigma側にあるので、そのほうが正しい）。

**`デザイン/DESIGN.md` にも触りません。** DESIGN.md はデザインハーネスの `design-md` が育てる成果物です。

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

`デザイン/inventory/{ファイル名}/{画面名}-{nodeId}.md` の1画面1ファイルだけです。本文に画面名・参照ID `design:{fileKey}:{nodeId}`・Figmaディープリンク・更新日・機械抽出節（画面内テキスト・使用コンポーネント）を持ちます（frontmatterは付けない。frontmatterを持つのはGold層のみ＝オントロジー規約）。

## 注意事項

- **`デザイン/inventory/` は同期ミラー**（正本はFigma）。手編集しない。毎回全消し再生成され、Figma側の削除・改名に追従する
- 課題・議事録・Decisionsからは安定ID（`design:{fileKey}:{nodeId}`）で `relations` を張れる（オントロジー規約参照）。nodeIdはフレームの改名・移動に耐える
- **`デザイン/resources/` には書き込まない。** あそこは人がスクリーンショット等を置く場所で、同期の対象外
- 夜間ワークフロー（`.github/workflows/sync-designs.yml`）が毎晩自動実行する。手動で最新化したいときだけこのスキルを使う
