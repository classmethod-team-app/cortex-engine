---
name: migrate-to-engine
description: 旧テンプレ複製方式の案件コンテキストリポジトリをエンジン分離構成へ移行する（Phase 2。旧機構の撤去・scaffold部品の適用・Secrets登録・疎通確認まで）
---
旧方式（aidd-project-cortex テンプレートの複製。`.rulesync/` やワークフロー実体がリポ内にある）の案件コンテキストリポジトリを、**エンジン分離構成**（データ＋薄い設定のみ。仕組みは cortex-engine から配布）へ移行します。cortex-context の移行実績（PR #8）を雛形にした手順です。各ステップでユーザーに確認しながら進めてください。

## 前提

- 実行者の Claude Code に cortex プラグインが導入済みであること（本スキル自体がプラグイン。移行対象リポにはまだ設定が無くてよい）
- `gh` 認証済み・対象リポへの push 権限があること
- 対象リポのカレントで実行すること。**未コミットの作業（WIP）がある場合は内容を確認し、移行コミットに混ぜない**（git rm・commit は対象パスを明示して行う。WIP には触れない）

## ステップ1: 現状調査（リポごとの差異を先に把握する）

リポにより追跡状況・カスタマイズが異なるため、削除・適用の前に必ず調査する:

```bash
git status --short                          # WIPの有無
git ls-files | grep -E "^\.rulesync/" | wc -l   # 旧正本の追跡有無
git ls-files | grep -E "^(CLAUDE\.md|\.claude/|AGENTS\.md)"  # 生成物が追跡されているか（旧gitignore方式のリポでは未追跡）
ls .github/workflows/                       # ワークフロー一覧
cat .gitignore | head -20
```

**特に確認すること:**

- **テンプレ由来でない独自ワークフロー**（標準9本: sync-backlog / backlog-webhook-sync / ingest-minutes / update-decision-log / update-glossary / weekly-report / sync-designs / fleet-status / validate-cortex 以外）→ **撤去せず残す**
- **`.rulesync/skills/` に案件独自のカスタムスキル**が無いか → あればユーザーに確認し、退避（後で案件リポの `.claude/skills/` にローカルスキルとして復元＝eject 方式）
- 旧 `CLAUDE.md` の**案件固有の記述**（概要・体制・リポ構成・注意事項）→ ステップ4で新 CLAUDE.md に移植するため控えておく

## ステップ2: ロールバックアンカーとブランチ

```bash
git tag -a pre-engine-separation -m "エンジン分離移行前の状態。ロールバック用アンカー" && git push origin pre-engine-separation
git checkout -b feat/engine-migration origin/main
```

## ステップ3: 旧機構の撤去

ステップ1の調査結果に合わせて、**追跡されているものだけ** git rm する（存在しないパスを混ぜるとコマンド全体が失敗する）:

```bash
# 例（cortex-contextの場合。リポの実態に合わせて調整）
git rm -r .rulesync .githooks scripts
git rm rulesync.jsonc package.json pnpm-lock.yaml
git rm .github/workflows/<テンプレ由来の9本のみ>.yml
git commit -m "エンジン分離: 旧機構（rulesync・フック・ワークフロー・スクリプト・依存定義）を撤去"
```

未追跡の生成物の残骸もディスクから削除する（`.cursor/`、生成された `.claude/skills` 等・`CLAUDE.md`・`AGENTS.md`・ルート直下の `.mcp.json`）。**`.claude/settings.local.json`（個人設定）は消さない**。

## ステップ4: scaffold 部品の適用

プラグイン同梱の scaffold（`<SKILL_DIR>/../../scaffold/repo/`。`<SKILL_DIR>` は Skill 起動時に提示される Base directory）から**機構部品だけ**をコピーする。**データディレクトリ（Cortex/・課題管理/ 等）は絶対に上書きしない**:

```bash
S="<SKILL_DIR>/../../scaffold/repo"
mkdir -p .github .claude
cp -R "$S/.github/workflows" .github/workflows      # スタブ10本（@v1=安定チャンネル。そのまま使う）
cp "$S/.claude/settings.json" .claude/settings.json # プラグイン参照
cp "$S/.gitignore" .gitignore                       # 新方式（CLAUDE.md と .claude/settings.json を追跡対象にする）
```

`CLAUDE.md` はシード（`$S/CLAUDE.md`）をベースに新規作成し、**エンジン管理ブロック（`<!-- cortex-engine:begin/end -->`）はそのまま**、案件固有部分（概要・体制・リポ構成・コミットルール等）にステップ1で控えた旧 CLAUDE.md の内容を移植する。プレースホルダ（`{{ }}`）は案件の実値で埋めること。

ステップ1で退避したカスタムスキルがあれば `.claude/skills/<名前>/` に復元する（プラグインスキルと共存できる。CLAUDE.md の案件固有ブロックにその旨を明記）。

```bash
git add .github/workflows .claude/settings.json .gitignore CLAUDE.md
git commit -m "エンジン分離: 安定チャンネル構成を導入（スタブ@v1・プラグイン参照・薄いCLAUDE.md・gitignore更新）"
```

## ステップ5: Home.md にエンジン設定を追記

`Cortex/Home.md` の frontmatter 末尾（`---` の直前）に追記する:

```yaml
# エンジン設定（cortex-engine が参照。schema_version はマイグレーションが管理する）
engine:
  schema_version: 1 # データスキーマ版。マイグレーションが更新する（手編集しない）
  channel: stable # stable | canary（一般案件は stable）
```

> `schema_version: 1` の直書きは移行時のブートストラップのみ（マイグレーション 0001 の内容そのものであるため）。以後の更新は夜間の engine-migrate に任せ、手編集しない。

検証してコミット:

```bash
node "<SKILL_DIR>/../../scripts/validate-cortex.mjs"
git add Cortex/Home.md && git commit -m "Home.md識別カードにエンジン設定を追加（channel: stable・schema_version: 1）"
```

このとき Home.md にプレースホルダ（`{{ }}`）が残っているとバリデータがスキップするので、残っていれば実値に直す（使用ツール欄に**エンジン等「仕組み」への参照は書かない**こと）。

## ステップ6: Secrets の確認と ENGINE_REPO_TOKEN 登録

```bash
gh secret list   # BACKLOG_* / AWS_ROLE_TO_ASSUME / FIGMA_TOKEN の有無を確認
gh secret set ENGINE_REPO_TOKEN   # cortex-engine への read 専用 PAT（チーム共有トークン。1Password の環境から）
```

- **repo secret として登録する**（org secret は Free プランでは private リポに届かない）
- ENGINE_REPO_TOKEN が無いままマージすると、エンジン checkout を伴う夜間ワークフローが失敗する（Backlog同期系2本はエンジン不要のため動く）

## ステップ7: push と PR

```bash
git push -u origin feat/engine-migration
```

PR を作成する。本文には: 変更概要（撤去/導入）・**マージ前の前提**（ENGINE_REPO_TOKEN 登録済みか）・マージ後の疎通確認手順・ロールバックタグ名、を記載する。

> **注意: 疎通確認（workflow_dispatch）はマージ後に行う。** 移行ブランチ上でワークフローを実行すると fleet-status.json 等がブランチにコミットされ、main と競合する（cortex-context 移行で実際に発生）。

## ステップ8: マージ後の疎通確認

マージ後、main 上で**1本ずつ**実行して確認する（同時に dispatch すると同一ファイルへの push が競合し rebase 衝突で失敗することがある。冪等なので失敗しても再実行で回復するが、避けられる）:

```bash
gh workflow run fleet-status.yml    # エンジンcheckout＋スクリプト実行の最短経路
gh run watch <run-id>
gh workflow run engine-migrate.yml  # スキーマ追随機構の疎通
gh workflow run sync-backlog.yml    # Backlog同期（Secrets確認を兼ねる）
```

- fleet-status が success なら、`git pull` して `fleet-status.json` の `engine.migrated: true` / `channel: stable` を確認
- Webhook リアルタイム同期を使っている案件は、Backlog 側で課題を1件更新して数十秒で同期されることも確認
- AI 精製系（decision-log 等）は夜間 cron に任せてよい（AWS_ROLE_TO_ASSUME 未設定なら安全にスキップされる）

## ステップ9: メンバーへの周知

移行完了後、案件メンバーに以下を伝える:

- **次にこのリポを Claude Code で開いたとき、「cortex プラグインをインストールしますか」と案内が出るので「はい」を押す**（1回だけ。以後は今までどおりスキルが使える）
- 旧方式のセットアップ（mise / pnpm / rulesync generate）は不要になった
- 課題の最新化は `/git-pull` だけでよい（Backlog の同期は自動）。エディタから課題に返信する人だけ、従来どおり個人の API キーが必要

## 注意事項

- データ（`Cortex/`・`課題管理/`・`会議/` 等）には一切触れない移行であること。差分にデータ変更が混ざっていたら止まって確認する
- ユーザーの WIP（未コミット変更）を移行コミットに巻き込まない。rebase が必要な場面では `git pull --rebase --autostash` を使う
- 案件ごとのカスタマイズ（独自ワークフロー・カスタムスキル・cron 時刻の変更等）は**尊重して残す**。判断に迷ったらユーザーに確認する
