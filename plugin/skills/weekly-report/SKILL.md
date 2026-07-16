---
name: weekly-report
description: >-
  直近1週間のコンテキスト（日次レポート・議事録・課題・Decisions・開発コミット/PR）から、単一案件の週次レポートを標準フォーマットで
  Cortex/レポート/records/ に生成する（日次レポートの集約＋週の振り返り）
---
直近1週間に動いたコンテキストを走査し、**単一案件の週次レポート**を標準フォーマットで `Cortex/レポート/records/YYYYMMDD.md` に生成します。

**役割分担**: 日々の動きのダイジェストは日次レポート（`records/YYYYMMDD-daily.md`・夜間update-goldが生成）が担います。週次は**日次レポートの集約＋週の振り返り**——週単位の傾向・リスク・来週の計画という一段上の視点——に役割を置きます。対象週に日次レポートがあれば（`status: active` のもの）、**まずそれを主要な入力として読み**、生ソースの再走査は日次でカバーされない部分（デザイン更新・開発コミット/PR等）に絞ってトークンを節約します。

このリポジトリは案件ごとに複製されるため、**全案件が同一フォーマットのレポートを持つ**ことを最重視します（巡回エージェントが横断で機械的に読めるよう、frontmatter と見出し構造を固定する）。横断集約・分析は巡回エージェント側の責務で、本スキルは**1案件分の生成のみ**を担います。

## 対象期間

- 既定は**直近7日**（実行日を期間末とし、その6日前を期間始とする）。
- `$ARGUMENTS` に `YYYY-MM-DD` の期間末日が指定された場合はその日を末日として7日間にする。
- **失敗週の巻き取り**: 環境変数 `SINCE`（前回成功実行以降。ワークフローが「直近の成功run時刻」を渡す）が設定され、複数週ぶんさかのぼる場合は、`SINCE` 以降の各週のうち**レポートファイルが未生成の週**もそれぞれ生成する（1週=1ファイル）。既存ファイルがある週は再生成しない（レビュー済みを壊さない）。

## 実行手順

### ステップ 1: 生成対象の週を確定

```bash
date +%Y-%m-%d            # 実行日（既定の period_end）
```

1. 既定の `period_end` = 実行日（または `$ARGUMENTS`）。
2. **巻き取り判定**: `SINCE` があれば、SINCE の日から実行日まで7日刻みでさかのぼって各週の `period_end` 候補を列挙し、`Cortex/レポート/records/<period_end をYYYYMMDDにした値>.md` が**まだ無い**週だけを対象集合に加える（既存はスキップ）。`SINCE` が無い手元実行では既定の1週のみ。
3. 各 `period_end` について `period_start` = period_end の6日前。出力ファイル名は `Cortex/レポート/records/<period_end をYYYYMMDDにした値>.md`。
4. 以降のステップ2〜を **対象の period_end ごとに繰り返す**（1週=1ファイル）。

### ステップ 2: その週の差分ソースを収集

対象週のウィンドウ（`period_start`〜`period_end`）に追加・更新された情報を集める。巻き取りで過去週を生成する場合は、その週の範囲に限定する（`--since="$period_start" --until="$period_end 23:59"`）。当日週は末端の作業ツリー変更も含める。

```bash
# 追加・更新された議事録・課題・Decisions（対象週の範囲に限定）
# ★ソースのディレクトリ名は案件ごとに任意なので特定ディレクトリに絞らず、その週に入った変更を全部集計対象にする。
#   除外はエンジン（.cortex-engine/）と自分の生成物（Cortex/レポート/）だけ（Cortex/Decisions・用語集等のGold活動は集計対象に含む）。
#   日本語パスの取りこぼし防止に core.quotepath=false を付ける（8進エスケープで .md$ を外さないため）。
git -c core.quotepath=false log --since="$period_start" --until="$period_end 23:59" --name-only --pretty=format: -- \
  . ':(exclude).cortex-engine/' ':(exclude)Cortex/レポート/' \
  | sort -u | grep -E '\.md$' || true

# まだコミットされていない作業ツリーの変更も対象に含める（当日週のみ）
git -c core.quotepath=false status --porcelain -- . ':(exclude).cortex-engine/' ':(exclude)Cortex/レポート/' | grep -E '\.md' || true

# 開発リポジトリ（submodule）があれば、その週のコミット・マージ済みPRも対象にする（best-effort）
git -C 開発/src log --since="$period_start" --until="$period_end 23:59" --pretty="%h %s (%an)" 2>/dev/null || echo "（開発submoduleなし。スキップ）"

# その週に追加・更新されたデザイン画面（sync-designsの同期差分）
git log --since="$period_start" --until="$period_end 23:59" --name-only --pretty=format: -- デザイン/inventory/ \
  | sort -u | grep -E '\.md$' || echo "（デザイン更新なし）"
```

- 上記の和集合を「その週の対象」とする。
- このリポジトリは案件ごとに構成が異なるため、上記以外にも意思決定・進捗が記録されるディレクトリ（Slack/Teamsエクスポート等）があれば同様に含める（パスをハードコードしない）。

### ステップ 3: 各情報源から内容を抽出

- **議事録**（`会議/` の新規 `*_minutes.md`）: 決定事項・TODO・論点
- **課題**（`課題管理/issues/`）: 新規・更新・回答があったもの、ステータス変化、ブロッカー
- **Decisions**（`Cortex/Decisions/` の新規ファイル）: その週に追加された決定（`title` / `summary`）
- **開発**（あれば）: コミット件数、マージ済みPRの概要
- **デザイン**（あれば）: 追加・更新された画面名（inventoryのmdのfrontmatter `title` とFigmaリンク）
- **数値**: 更新課題数 / 新規議事録数 / 新規Decisions数 / デザイン更新画面数 / コミット数 / マージPR数 を数える

### ステップ 4: 標準フォーマットでレポートを生成

`Cortex/レポート/template.md` を**正本の雛形**として `Cortex/レポート/records/YYYYMMDD.md` を作成する。frontmatter と見出しの**並び・文言は固定**（巡回エージェントが横断パースするため、独自の見出しを足さない・該当が無いセクションは「なし」と記す）。フィールドの説明は `Cortex/レポート/README.md` を参照。

### ステップ 5: 保存（手動実行時は確認）

- 手動実行（`/weekly-report`）の場合は、生成内容を提示してから `Cortex/レポート/` に保存する。
- 保存後に `node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"`（プラグイン同梱リンター） を実行し、規約違反があれば修正する（違反したまま保存・コミットしない）。
- cron（無人）実行の場合は確認せず保存し、コミットまで行う（push は呼び出し側ワークフロー）。

## 注意事項

- **見出し構造・frontmatterは固定**。案件ごとに独自項目を足さない（横断パースが壊れる）。該当が無いセクションは削除せず「なし」と書く。
- 推測で埋めない。差分に根拠が無い項目は「なし」とする。
- 同一週で再実行した場合は同名ファイルを**上書き**（1週1ファイル）。
- 機密の生データ（APIキー等）はレポートに含めない。
