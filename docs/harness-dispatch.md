# ハーネス連携（run-harness-skill）とサイドロードのパス契約

## 責務の線引き（構築 vs 消費）

Cortex（エンジン）の責務は「コンテキストレイヤーを**構築**する」まで。レイヤーを**消費**して価値を出す仕事はドメインの専門ハーネスの責務とする。判定基準は「それはコンテキストレイヤーの構築か、消費か」。

| ワークフロー | 帰属 |
| --- | --- |
| 同期ミラー・Gold昇格・fleet-status | エンジン（構築） |
| 日次/週次レポート | PMハーネス（消費） |
| デザインMD育成 | デザインハーネス（消費＋ドメイン専門の精製）※将来 |
| ドキュメント鮮度検知 | 運用保守ハーネス（消費）※将来 |

線引きの言語化: **汎用の型の精製（決定・用語）＝エンジン、ドメイン専門知が要る仕事＝当該ハーネス**。

## 境界の規律（最重要）

> **Gold層（`Cortex/`）に書き込めるのはエンジンの精製ワークフローだけ。ハーネスは自分の責務領域（Slack通知・デザイン/DESIGN.md・Issue起票等）にだけ書く。**

日次/週次レポートは **Slack 配信物**であって Gold レコードではない。ハーネススキルは案件リポジトリ（`Cortex/` 含む）にファイルを書かない。`run-harness-skill` も push しない。

## run-harness-skill（汎用ディスパッチ）

`.github/workflows/run-harness-skill.yml` は、案件リポ・エンジン・指定ハーネスを1つのランナーに揃え、ハーネスのスキルをヘッドレス実行する reusable workflow。ハーネス/用途ごとに案件リポ側の**薄いスタブ**（`pm-daily.yml` / `pm-weekly.yml` 等）が cron トリガーとスキル名を与えて呼ぶ。

- **スタブを用途ごとに分ける理由**: fleet-status の可視性（スタブごとに独立した workflow run で成否が個別に出る）・cron の個別調整・独立障害のため。
- **認証**: 呼び出し元（案件リポのスタブ）の `secrets: inherit` / OIDC をそのまま使う（新しい basis は不要）。スキルは `claude -p`（Bedrock）で走るため `AWS_ROLE_TO_ASSUME` が要る。Slack 投稿は `SLACK_BOT_TOKEN`（未設定ならスキルが無害終了）。
- **schema_version ガード**: 既存の精製系と同じく `schema-current.mjs` 判定で、案件のデータ版がエンジンより古ければスキップする。
- **増分窓（SINCE）**: 呼び出し元スタブの直近成功 run 時刻を `gh run list --workflow=<スタブのファイル名>` から機械導出する（スタブのファイル名は `github.workflow_ref` の basename から取る）。`since` 入力で上書き可（バックフィル）。取得できなければ空のまま各スキルの既定（daily=24h / weekly=7日）にフォールバックする。
- **将来のハーネス**: run-harness-skill は汎用なので、デザイン/運用ハーネスのスキルを足す時も stub を追加するだけで対応できる（`harness_repo` / `skill` を変える）。

### サイドロードのパス契約

ハーネスのスキルはエンジンの共有ユーティリティ（`notify-slack.sh` 等）を参照する。checkout 先のパスは**契約**として固定する。スキル側の探索とワークフロー側の checkout 先は、必ずこの表に一致させること。

| 何を | checkout 先パス | 用途 |
| --- | --- | --- |
| エンジン（cortex-engine） | `.cortex-engine/` | ハーネススキルが `.cortex-engine/plugin/scripts/notify-slack.sh` を**第一候補**として参照する。`schema-current.mjs` もここ |
| ハーネス（例: pm-harness） | `.harness/` | スキル本体 `.harness/skills/<skill>/SKILL.md`・アセット `.harness/skills/<skill>/assets/`・プレイブック `.harness/playbook/` |
| 実行時の cwd | 案件リポのルート | スキルは案件リポのルートで動く（差分は `git log --since` で読む） |

- **ハーネススキルの探索規約**: `notify-slack.sh` は `.cortex-engine/plugin/scripts/notify-slack.sh` を第一候補にし、見つからなければ**エラー案内で無害終了**する（ハードに失敗させない）。エンジンが同居している前提。
- **ref**: エンジンはワークフローと同一バージョン（`github.job_workflow_sha || engine_ref`、既定 `v1`）。ハーネスは `harness_ref`（移動タグ運用、既定 `v1`）。
- **Git管理外**: `.cortex-engine/` と `.harness/` は `.git/info/exclude` に入れ、案件リポのコミット対象にしない。

### スキルのヘッドレス前提

cron 起動されるスキルは、人に聞き返さず env（`SINCE` / `TARGET_DATE` / `SLACK_BOT_TOKEN`）と差分から全部を判断して走り切る。出力先は Slack 等の外部で、Gold 層（リポジトリ）には書かない。対話実行（人が `/daily-report` と打つ）でも同じ出力になる。
