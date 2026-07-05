# migrations — データスキーマのマイグレーション

エンジンの更新が**案件リポのデータ側**（frontmatter・ディレクトリ構造・CLAUDE.md のエンジン管理ブロック）の変更を要する場合、ここにマイグレーションを追加する。エンジン（コード）は中央で上がるが、各案件リポに散在するデータは自動では変わらない——その結合点を機構で解くのがこのディレクトリの役割。

## ファイル規約

- ファイル名: `NNNN-説明.mjs`（NNNN は 4 桁連番）
- 必須エクスポート:

```js
export const meta = {
  to: 2,                          // 適用後の schema_version
  description: "何をする変更か",
  autoApply: true,                // true: 機械的・可逆・追記系 → cron が自動適用して直コミット
                                  // false: 既存レコードの書き換え・非可逆 → 人間レビュー必須（自動適用しない）
};

export async function run(repoRoot) {
  // 冪等に書くこと（2回実行しても壊れない）
};
```

## 動作

- 案件リポの `Cortex/Home.md` frontmatter `engine.schema_version` が現在値（未宣言は 0）
- `engine-migrate.yml`（案件リポのスタブから夜間 cron）が `scripts/engine-migrate.mjs` を実行し、未適用分を番号順に適用して schema_version を書き進める
- `autoApply: false` に当たったらそこで停止して警告を出す（手動適用が必要。PR 自動起票は将来拡張）
- 夜間の精製系ワークフローは schema_version がエンジンの要求より古い場合スキップする（半端なスキーマで走らせない）※要求版チェックは Phase 1 で配線

## 原則

- Gold 層運用原則との整合: 自動適用（autoApply: true）は追記・機械変換のみ。既存レコードの意味を変える書き換えは必ず false にする
- 1 マイグレーション = 1 スキーマ版。まとめない
