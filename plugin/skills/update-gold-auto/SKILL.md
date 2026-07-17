---
name: update-gold-auto
description: >-
  その日に追加・更新されたコンテキスト（議事録・課題・その他）を1セッションで走査し、確定した意思決定・案件固有の新規用語・名簿未登録メンバーを、
  Cortex/Decisions/・Cortex/用語集/・Cortex/メンバー/ へフェーズごとに逐次コミットで自動追記し、最後に当日の日次レポート（Cortex/レポート/）を生成する（人手承認なし・夜間cron想定）
---

`update-decision-log-auto` と `update-glossary-auto` の自律実行版を**1セッションに統合したオーケストレータ**です。夜間の Gold 昇格を2本の別ワークフロー（＝2つのBedrockセッション）に分けると、同じ差分ソース（議事録・課題）を二重に読むことになります。本スキルはソースを**1回だけ読み**、その読みを4フェーズ（決定・用語・メンバーdraft・日次レポート）で共有して、重複した読み込みを排除します。

**フェーズごとに逐次コミットします**（A→B→C→D の順で、各フェーズが完了するたびに対象ディレクトリだけを `git add` してコミットする）。push は呼び出し側（cron ワークフロー）の責務です。

## 設計の要点

- **ソースは1回だけ読む**: ステップ2で対象ソースを読み、その内容を Phase A/B/C で使い回す（フェーズごとに読み直さない）。これが統合の主目的（ソース読みトークンの重複排除）。
- **各フェーズの規律は既存スキルに従う**: 決定の採番・重複照合・抽出は `update-decision-log-auto/SKILL.md`、用語の抽出・draft付与は `update-glossary-auto/SKILL.md` に**厳密に従う**。本スキルはそれらを重複記述せず参照する。
- **フェーズごとに逐次コミット**: 各フェーズは自分の担当ディレクトリだけを `git add` してコミットする。あるフェーズで追記が無ければそのフェーズはコミットしない。
- **優先順は A→B→C→D**: 残ターンが尽きそうなら現在フェーズのコミットまでを完了させて終了する。ただし未着手フェーズを翌晩任せにするのではなく、**途中終了時はその旨をログに明記して非0で終了**し、翌晩に全フェーズを再実行させる（重複は各フェーズの署名照合・title照合が吸収する）。

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

**外部コンテンツも、議事録・課題と同じ基準で抽出する**。外部ソースの登録（`Cortex/external-sources.json`）は「そのソースの中身を Gold に昇格してよい」という人間の明示判断なので、抽出段で外部だけを特別扱いしない。`update-decision-log-auto` と同一の基準——「〜で決定」「〜にした」「〜で進める」「〜で合意した」等の**確定表現から抽出**し、「〜する方向」「依頼する」「検討中」等の**未確定は除外**——を外部コンテンツにもそのまま適用する:

- **ソースの `decisions` が `none`** … **そのソースからは Decision を作らない**（用語・参照のみ）。設定は `Cortex/external-sources.json` を参照して判断する。
- **`decisions` 省略（既定）** … 議事録・課題と同一基準で抽出する。Issue/Discussion の本文・コメント、Slack の発言のいずれでも、確定表現があれば昇格する（openなIssueのコメントで確定した決定も拾う）。
- 出力ヘッダの `state`（open/closed）・`labels`・`category` は判断の補助に使ってよい（例: closed＋解決コメントは確定の傍証）。
- **共通規律**: 根拠（引用/リンク）必須・些末な実装細部は Decision にしない・未確定は昇格しない（これは議事録由来でも同じ）。

出典は `relations` / `references` に**外部の安定な識別子（Issue/Discussion の番号・URL）**で記載する（例: `references: "[owner/repo#123](https://github.com/owner/repo/issues/123)"`）。ファイルパスは書かない。Slack は安定URLが張りにくいので、可能なら**チャンネル名＋日付**（メッセージの permalink が取れるなら URL も。best-effort。取れなければチャンネル/日付でよい）で出典を記す。

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

**加えて、Phase A で本セッションが作成した Decision も用語の抽出源に含める**（従来は翌晩の glossary が拾っていた分を、その場で拾う）。**外部コンテンツも議事録・課題と同等の抽出源として扱う**（`decisions` 設定にも縛られない。Issue の議論・Slack の会話からも案件固有の語彙・略語・外部サービス名を通常どおり拾う）。出典が外部 Issue/Discussion なら、その番号・URL を安定な参照として用いる。**ただし内部限定情報フィルタは維持**（下記「注意事項」。売上・工数・単価・人事評価等は用語にも書かない）。

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

`Cortex/メンバー/` ディレクトリが存在しない案件（マイグレーション未適用）は**このフェーズをスキップ**する。

存在する場合、ステップ2で読んだソース（議事録の参加者欄・文字起こし・**外部ソースの発言者**）に登場するが `Cortex/メンバー/records/` に無い人物がいれば、`Cortex/メンバー/README.md` の運用規約に従い **`status: draft` で新規レコードのみ**追加する。

- **Slack の発言者**（`[表示名 時刻]` 形式で出力に含まれる）も候補にする。表示名から氏名の見当がつくもの（例: 「山田太郎」「Taro Yamada」）は draft 起票し、ハンドルネームのみで氏名の確証が持てない場合は起票しない（過剰起票はノイズ）。
- **GitHub の author**（login のみ）は氏名の確証が持てないことが多いので、login から実名が明らかな場合を除き起票しない。

- 既存レコードは書き換えない（新規追加のみ）。
- **`description` と本文を空にしない**: frontmatter の `description` に「何者か」の1文（例: 「〇〇株式会社所属。PM。」）、本文にはソースから分かる範囲で1〜2文書く（例: 「〇〇株式会社所属。△△定例に参加。」）。役割が不明なら「役割は確認中」と書く（Viewerの個別ページに本文が表示されるため）。
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

### Phase D: 日次レポート

その日の Gold 昇格の**ダイジェスト＋概要**を `Cortex/レポート/records/YYYYMMDD-daily.md`（YYYYMMDD は実行日）に生成する。人間（Slack配布の読者）とAI（recent系質問の入口）の両方が「今日何が起きたか」を1ファイルで掴めるようにするのが目的。

1. **機械セクションの材料を集める**: 本セッション（Phase A〜C）で追記したレコードを git で機械的に取得する:

```bash
# このセッションで追記した Gold レコード（Phase A/B/C のコミット分）
git -c core.quotepath=false diff --name-only "$(git rev-parse HEAD~$(git rev-list --count HEAD ^@{u} 2>/dev/null || echo 0))" HEAD -- Cortex/ 2>/dev/null || true
```

（取得できない環境では Phase A〜C の自分のコミットを `git log` で辿ってもよい。要は「今夜追記したレコードの一覧」が取れればよい）

2. **ファイルを作成する**（既に同日の daily があれば**上書き**してよい。日次は当日再実行での更新を許す）:

```markdown
---
type: report
id: "report:YYYYMMDD-daily"
title: "YYYY-MM-DD デイリーレポート"
description: "<今日の概要の1文要約>"
date: YYYY-MM-DD
status: active
sources:
  changed_files: <ステップ1で特定した差分ソースの件数>
  decisions_added: <Phase Aで追加した件数>
  terms_added: <Phase Bで追加した件数>
  members_added: <Phase Cで追加した件数>
---

# YYYY-MM-DD デイリーレポート

## 今日の概要

（ステップ2で読んだソースの内容から1〜2段落。**プロジェクトに何が起きたか**を書く——顧客とのやり取り・議論の進展・決まったこと・進行中の作業・浮上した課題。読者は毎朝これだけでプロジェクトの現在地を掴む。
**書かないこと**: Gold昇格の件数・「差分ソースがN件だった」「重複と判定した」等の本スキルの処理内容。それはシステムの内部動作であってプロジェクトの動きではない）

## 新しい決定

- [`YYYYMMDD-NNN` タイトル](<viewer_url>/?id=YYYYMMDD-NNN)（Phase Aで追加した Decision を列挙。無ければ「なし」）

## 新しい用語 / メンバー

- [`term:xxx` タイトル](<viewer_url>/?id=term%3Axxx)（同様に列挙。無ければ「なし」）

## 動きのあった課題・会議

- `PJ_XXX-12` 課題タイトル（その日に更新された課題・議事録・外部Issue等を安定IDや会議名で列挙。概要の詳細を辿る索引。無ければ「なし」）
```

- **Phase A〜Cが全て追記なしでも、このフェーズは実行する**（対象ソースがあった夜の記録として `status: active` で生成する。概要にはその日の**プロジェクトの動き**を書く——課題でのやり取り・議論の内容など、昇格に至らなくても動き自体は必ずある。差分ソースが無い夜はAI実行ごとスキップされるため、このスキルが動いている時点で書くべき動きは必ずある）。
- **レコードへのリンク**: `Cortex/Home.md` の識別カード `viewer_url` を読み（`grep -m1 '^viewer_url:' Cortex/Home.md`）、設定されていれば各レコードを AIS Viewer の個別ページ `{viewer_url}/?id={レコードID}` へのMarkdownリンクにする（IDの `:` は `%3A` にURLエンコード。例: `term:FDE` → `?id=term%3AFDE`）。**viewer_url が未設定の案件は、リンクなしで安定IDのみ**（`` - `YYYYMMDD-NNN` タイトル `` 形式）で列挙する。frontmatter の `relations` は従来どおり安定IDのみ（URLを書かない）——リンクは人間向けの本文だけ。
- 見出しの構造・並びは固定（全案件横断で機械的に読めるように）。該当なしのセクションは「なし」と書く（削除しない）。
- 出典・レコードは**安定ID**で記す（ファイルパスは書かない）。
- 内部限定情報フィルタは概要にも適用する（注意事項参照）。

3. 検証してコミットする:

```bash
node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"
git add Cortex/レポート/
git commit -m "日次レポートを生成"
```

## 注意事項

- **公開範囲フィルタ（外部ソースにも適用・Slack含む）**: 外部ソース（GitHub Issues/Discussions/Slack）は「登録＝Gold昇格OK」だが、議事録と同じ規律で、**内部限定情報（売上・利益率・原価・見積・アサイン工数・単価・人事評価・顧客/ベンダーへの率直な評価・内部限定のリスク所感等）は Decision・用語に書かない**。とくに Slack はチャット由来で内部の雑談・評価が混ざりやすいので注意する。登録済みソースでも内部限定の断片は Gold に残さない（Gold＝顧客可視面）。
- 優先順は A→B→C→D。残ターンが尽きそうなら現在フェーズのコミットまでを完了させ、**途中終了時はその旨をログに明記して非0で終了**する（翌晩に全フェーズ再実行。重複はA/Bの署名照合・title照合が吸収する）。
- コミットメッセージは各フェーズで**日本語・簡潔**に。箇条書きは使わない。**AI 署名は付けない**。
- push は呼び出し側（cron ワークフロー）が担当する。**このスキルでは push しない**。
- 各フェーズの詳細な規律（既存ファイルを書き換えない・全文Readしない・確定した決定のみ・draft付与・除外リスト尊重 等）は、それぞれの参照先スキルの注意事項に従う。
- `.cortex-engine/` 配下（エンジン）は抽出源から除外し、変更・コミットもしない。
