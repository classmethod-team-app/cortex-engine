---
name: update-gold-auto
description: >-
  その日に追加・更新されたコンテキスト（議事録・課題・その他）を1セッションで走査し、確定した意思決定・案件固有の新規用語・名簿未登録メンバーを、
  Cortex/Decisions/・Cortex/用語集/・Cortex/メンバー/ へフェーズごとに逐次コミットで自動追記する（人手承認なし・夜間cron想定）
---

`update-decision-log-auto` と `update-glossary-auto` の自律実行版を**1セッションに統合したオーケストレータ**です。夜間の Gold 昇格を2本の別ワークフロー（＝2つのBedrockセッション）に分けると、同じ差分ソース（議事録・課題）を二重に読むことになります。本スキルはソースを**1回だけ読み**、その読みを3フェーズ（決定・用語・メンバーdraft）で共有して、重複した読み込みを排除します。

**フェーズごとに逐次コミットします**（A→B→C の順で、各フェーズが完了するたびに対象ディレクトリだけを `git add` してコミットする）。push は呼び出し側（cron ワークフロー）の責務です。

## 設計の要点

- **ソースは1回だけ読む**: ステップ2で対象ソースを読み、その内容を Phase A/B/C で使い回す（フェーズごとに読み直さない）。これが統合の主目的（ソース読みトークンの重複排除）。
- **各フェーズの規律は既存スキルに従う**: 決定の採番・重複照合・抽出は `update-decision-log-auto/SKILL.md`、用語の抽出・draft付与は `update-glossary-auto/SKILL.md` に**厳密に従う**。本スキルはそれらを重複記述せず参照する。
- **フェーズごとに逐次コミット**: 各フェーズは自分の担当ディレクトリだけを `git add` してコミットする。あるフェーズで追記が無ければそのフェーズはコミットしない。
- **優先順は A→B→C**: 残ターンが尽きそうなら現在フェーズのコミットまでを完了させて終了する。ただし未着手フェーズを翌晩任せにするのではなく、**途中終了時はその旨をログに明記して非0で終了**し、翌晩に全フェーズを再実行させる（重複は各フェーズの署名照合・title照合が吸収する）。

## 実行手順

### ステップ 1: その日の差分ソースを特定

**前回成功実行以降**（環境変数 `SINCE`。ワークフローが「直近の成功run時刻」を渡す＝失敗が続いても次の成功時に失敗分まで遡って巻き取る）に追加・更新された、Gold 昇格の対象になりうるファイルを特定する。`SINCE` が無い手元実行では約 25 時間をデフォルトにする。除外は**エンジン（`.cortex-engine/`）と `Cortex/` 全体**だけ（Gold を Gold から抽出する自己参照ループを防ぐ）。

```bash
# ワークフローの差分ゲートと同一スクリプトで判定する（二重定義によるドリフト防止）。
# 除外は .cortex-engine/ と Cortex/ 全体。コミット済み差分＋未コミットの作業ツリー変更の和集合を1行1件で出力。
bash "<SKILL_DIR>/../../scripts/changed-sources.sh" "${SINCE:-}" "Cortex/"
```

- 出力された各行を「当日の対象リポ差分ソース」とする。

**外部ソースの取得**: `Cortex/external-sources.json` に登録された外部ソース（GitHub Issues/Discussions/Slack）から、`SINCE` 以降に更新されたコンテンツを取得する。差分ゲートと同一スクリプトを共有する（二重定義防止）。

```bash
# 出力（ソース見出し付きテキスト）を「当日の外部コンテンツ」とする。未登録・活動なしなら空出力。
# 認証は環境変数 GH_TOKEN（ワークフローが EXTERNAL_SOURCES_TOKEN || github.token を渡す）と SLACK_BOT_TOKEN（slack用）。
bash "<SKILL_DIR>/../../scripts/external-sources.sh" "${SINCE:-}"
```

- 外部ソースへの登録は「そのソースの中身を Gold に昇格してよい」という人間の明示判断である（record単位のvisibilityフラグは無い）。**ただし公開範囲フィルタは維持する**（下記「注意事項」）。
- Slack も外部ソースとして扱われる（`SLACK_BOT_TOKEN` と bot 招待済みチャンネルが前提。未設定/未招待/権限不足はスクリプトが「活動なし」としてスキップする）。**公開範囲フィルタは Slack にも適用する**（下記「注意事項」）。
- **リポ差分ソースも外部コンテンツも 0 件なら**、以降をスキップして「昇格なし」で正常終了する。ワークフロー経由の実行では、両方0件ならそもそもAI実行前にスキップされている。

### ステップ 2: 対象ソースを読む（1回だけ）

ステップ1で特定した対象リポ差分ソース（.md）と外部コンテンツの**和集合**を読む。**この読みを Phase A/B/C で共有する**（各フェーズで読み直さない）。外部コンテンツは既に `external-sources.sh` の出力として手元にあるので、追加の取得は不要。

### Phase A: 決定（Decisions）

`update-decision-log-auto/SKILL.md` の**ステップ2〜5**（採番・重複照合・抽出・ファイル作成）に**厳密に従って** `Cortex/Decisions/records/` に新規 Decision を作成する。ソースの読みはステップ2の結果を使う（`update-decision-log-auto` のステップ1は本スキルのステップ1で済んでいる）。

**外部コンテンツ（GitHub Issues/Discussions/Slack）からも確定した決定を抽出する**。出典は `relations` / `references` に**外部の安定な識別子（Issue/Discussion の番号・URL）**で記載する（例: `references: "[owner/repo#123](https://github.com/owner/repo/issues/123)"`）。ファイルパスは書かない。Slack は安定URLが張りにくいので、可能なら**チャンネル名＋日付**（メッセージの permalink が取れるなら URL も。best-effort。取れなければチャンネル/日付でよい）で出典を記す。

作成後、コミット前に検証してからコミットする：

```bash
node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"
git add Cortex/Decisions/
if git diff --staged --quiet; then
  echo "Decisions: 追記なし"
else
  git commit -m "Decisionsに当日の決定事項を自動追記"
fi
```

### Phase B: 用語（用語集）

`update-glossary-auto/SKILL.md` の**ステップ2〜4**（既存用語・除外リストの読み込み・新規用語候補の抽出・ファイル作成/synonyms追記）に従って `Cortex/用語集/records/` に `status: draft` で新規用語を追加、または既存用語へ synonyms を追記する。ソースの読みはステップ2の結果を使う。

**加えて、Phase A で本セッションが作成した Decision も用語の抽出源に含める**（従来は翌晩の glossary が拾っていた分を、その場で拾う）。**外部コンテンツからも案件固有の新規用語を抽出する**（出典が外部 Issue/Discussion なら、その番号・URL を安定な参照として用いる）。

作成後、コミット前に検証してからコミットする：

```bash
node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"
git add Cortex/用語集/
if git diff --staged --quiet; then
  echo "用語集: 追記なし"
else
  git commit -m "用語集に新規用語をdraftで自動追記"
fi
```

### Phase C: メンバーdraft

**外部ソースは Phase C の対象外**（外部の author→案件メンバーの対応付けは複雑なため Phase1 では扱わない）。メンバー抽出は従来どおりリポ差分ソース（議事録の参加者欄・文字起こし）だけを見る。

`Cortex/メンバー/` ディレクトリが存在しない案件（マイグレーション未適用）は**このフェーズをスキップ**する。

存在する場合、ステップ2で読んだソース（議事録の参加者欄・文字起こし）に登場するが `Cortex/メンバー/records/` に無い人物がいれば、`Cortex/メンバー/README.md` の運用規約に従い **`status: draft` で新規レコードのみ**追加する。

- 既存レコードは書き換えない（新規追加のみ）。
- 氏名の確証が持てない場合は追加しない（過剰起票はノイズ）。
- 既存メンバーの照合は frontmatter の grep で行う（全文 Read しない）：

```bash
grep -hE '^(title|aliases):' Cortex/メンバー/records/*.md 2>/dev/null || true
```

作成後、コミット前に検証してからコミットする：

```bash
node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"
git add Cortex/メンバー/
if git diff --staged --quiet; then
  echo "メンバー: 追記なし"
else
  git commit -m "メンバー名簿に新規参加者をdraftで自動追記"
fi
```

## 注意事項

- **公開範囲フィルタ（外部ソースにも適用・Slack含む）**: 外部ソース（GitHub Issues/Discussions/Slack）は「登録＝Gold昇格OK」だが、議事録と同じ規律で、**内部限定情報（売上・利益率・原価・見積・アサイン工数・単価・人事評価・顧客/ベンダーへの率直な評価・内部限定のリスク所感等）は Decision・用語に書かない**。とくに Slack はチャット由来で内部の雑談・評価が混ざりやすいので注意する。登録済みソースでも内部限定の断片は Gold に残さない（Gold＝顧客可視面）。
- 優先順は A→B→C。残ターンが尽きそうなら現在フェーズのコミットまでを完了させ、**途中終了時はその旨をログに明記して非0で終了**する（翌晩に全フェーズ再実行。重複はA/Bの署名照合・title照合が吸収する）。
- コミットメッセージは各フェーズで**日本語・簡潔**に。箇条書きは使わない。**AI 署名は付けない**。
- push は呼び出し側（cron ワークフロー）が担当する。**このスキルでは push しない**。
- 各フェーズの詳細な規律（既存ファイルを書き換えない・全文Readしない・確定した決定のみ・draft付与・除外リスト尊重 等）は、それぞれの参照先スキルの注意事項に従う。
- `.cortex-engine/` 配下（エンジン）は抽出源から除外し、変更・コミットもしない。
