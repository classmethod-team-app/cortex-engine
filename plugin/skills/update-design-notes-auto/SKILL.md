---
name: update-design-notes-auto
description: >-
  前回実行以降に変更されたデザイン画面について、サムネイルを視覚AIで読み取り、画面の目的・主要要素の育成ノートを status:draft で Cortex/デザイン/ に自動生成/更新する（直コミット・事後レビュー方式・夜間cron想定）
---
デザイン画面の**育成ノート**（Gold層 `Cortex/デザイン/records/`）を自律更新するスキルです。前回実行以降に `デザイン/inventory/`・`デザイン/resources/` が変更された画面について、サムネイルPNGを視覚AIで読み取り、画面の目的・主要要素をまとめて `Cortex/デザイン/` へ直接コミットします（push はワークフロー側の責務）。

承認は**事後レビュー方式**です。AIが生成したノートは必ず `status: draft` を付け、人間が確認・修正して `status: active` に変えることでレビュー完了とします。

## 設計の要点

- **2層を混同しない**: 目録（`デザイン/inventory/`）は sync-designs の同期ミラー（Silver・手編集禁止）。このスキルが書くのは育成ノート（`Cortex/デザイン/records/`・Gold・蓄積層）。両者は同じ安定ID `design:{fileKey}:{nodeId}` を共有する
- **AI領域と人間領域をマーカーで分離**: 育成ノート本文の `<!-- cortex-auto:begin -->`〜`<!-- cortex-auto:end -->` の**内側だけ**をAIが再生成する。**マーカー外（人間の補足）は一切変更しない**（人間領域を壊すのが最悪の事故）
- **AI生成は必ず `status: draft`**: 人間がレビューするまで `active` にしない
- **増分方式・1回最大15画面**: 変更された画面だけを対象にし、1実行あたり最大15画面まで。超過分は翌晩に巻き取る（後述）
- **幻覚防止**: サムネイルから読み取れないことを断定しない。機械抽出テキスト（inventory md の「画面内テキスト」節）を根拠に書く
- **公開範囲**: 顧客が直接見る前提。内部限定情報（評価・単価・工数等）は書かない

## 実行手順

### ステップ 1: 変更画面の特定

環境変数 `DESIGN_DIR`（既定は `デザイン`）・`SINCE`（前回成功run時刻。ワークフローが渡す。手元実行では約25時間をデフォルト）を使う。ワークフローの差分ゲートと同一の git log で、変更された画面のソースを列挙する。

```bash
DESIGN_DIR="${DESIGN_DIR:-デザイン}"
git -c core.quotepath=false log --since="${SINCE:-25 hours ago}" --name-only --pretty=format: \
  -- "$DESIGN_DIR/inventory/" "$DESIGN_DIR/resources/" | grep -v '^$' | sort -u
```

- 列挙された `inventory/**/*.md`（画面1件=1md）と `resources/{fileKey}/{safeNodeId}.png` から、**変更された画面の集合**を作る。1画面は inventory md と resources png で表される（png だけ変わっても対象）
- 各対象画面について、対応する inventory md の本文にある `参照ID: \`design:{fileKey}:{nodeId}\`` 行と `[Figmaで開く](...)` 行を読み、**安定ID `design:{fileKey}:{nodeId}` と Figmaディープリンク**を確定する（これが正）
- **1回の実行で最大15画面**まで。対象が15を超える場合は先頭15画面だけを処理し、**残りの画面IDを `.design-notes-overflow`（リポジトリルート）に1行1件で書き出す**。ワークフローがこのフラグを見て本runを失敗（赤）で終え、SINCEを進めないため、翌晩の増分窓に未処理画面が再び入り巻き取られる。フラグは `Cortex/` の外に置くのでコミット対象に含まれない
- 対象が0件なら以降をスキップして正常終了（フラグも作らない）

### ステップ 2: 各画面の育成ノートを生成/更新

対象画面（最大15件）それぞれについて:

1. **inventory md を読む**: 画面名・機械抽出テキスト（`## 画面内テキスト（機械抽出）`）・使用コンポーネント（`## 使用コンポーネント（機械抽出）`）・Figmaディープリンク
2. **サムネイルを視覚AIで見る**: `"$DESIGN_DIR/resources/{fileKey}/{safeNodeId}.png"` を **Read（画像）で開く**。`safeNodeId` は nodeId の `:` を `-` に置換したもの（inventory と同じ規則）。PNGが無ければ機械抽出テキストのみで書く
3. **関連しそうな用語・Decisionを探す**（frontmatterのみ・全文Readしない）:
   ```bash
   grep -rhE '^(id|title):' Cortex/用語集/records/ Cortex/Decisions/records/ 2>/dev/null || true
   ```
   画面のテキスト・目的に明確に関連するものだけを `relations`（`rel: relates_to`・target は安定ID）に張る。確信が持てないものは張らない
4. **`Cortex/デザイン/records/{安全なファイル名}.md` を作成/更新**:
   - **ファイル名**は画面名を safe 化し、**末尾に safeNodeId を含めて衝突を避ける**（例: `ログイン画面-1023-456.md`）。safe 化は `\ / : * ? " < > | # 空白` を `-` に置換
   - **新規**: `Cortex/デザイン/template.md` をベースに作成。`id` を確定した `design:{fileKey}:{nodeId}`、`title` を画面名、`status: draft`、`source` に inventory の該当画面
   - **既存**: **`<!-- cortex-auto:begin -->`〜`<!-- cortex-auto:end -->` の内側だけ**を書き換える。マーカー外（`## 補足` 以下の人間の補足）は**1文字も変更しない**。frontmatter の `relations` は更新してよいが、`title`/`id`/`source` は既存を尊重する。auto 領域の内容が実質的に変化し、かつ `status` が `active` だった場合は `draft` に戻す（人間の再確認を促す）
   - **マーカーが見つからない既存ファイル**（人間が独自構成にした等）は、内側を安全に特定できないので**書き換えずスキップし、その旨をログに出す**（人間領域を壊さないため）
   - **auto 領域（マーカー内）に書く内容**:
     - 画面の目的（サムネイルと機械抽出テキストから読み取れる範囲で1〜2文）
     - 主要要素（画面上の主なUIブロック。読み取れる範囲で）
     - 主要テキスト（機械抽出テキストから代表的なものを抜粋）
     - Figmaディープリンク（inventory の `[Figmaで開く]` のURL）
     - 関連（用語・Decisionへのリンクがあれば）

### ステップ 3: 検証・コミット

- **コミット前に `node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"` を実行**し、規約違反があれば修正する（違反したままコミットしない）
- `git add Cortex/デザイン/`（Cortex/デザイン/ のみ。`.design-notes-overflow` はここに含まれない）
- 変更があれば `git commit` までを行う（push はワークフロー側）。コミットメッセージは日本語で簡潔に、箇条書きは使わず、AI署名は付けない
- 変更が0件なら何もコミットせず正常終了

## 注意事項

- **マーカー外（人間の補足）は絶対に変更しない**。マーカーを安全に特定できない場合はスキップ（最悪の事故は人間領域の破壊）
- **サムネイルから読み取れないことを断定しない**（幻覚防止）。機械抽出テキストを根拠にする
- **内部限定情報は書かない**（顧客開放の境界）
- inventory・resources（Silverミラー）は**読むだけで編集しない**（正本はFigma・sync-designsが再生成する）
- `Cortex/` 配下・`.cortex-engine/` 配下を編集源として自己参照しない（読むのは inventory・resources と 用語集/Decisions の frontmatter だけ）
