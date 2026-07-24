# OpenQuestions

案件の**未決事項（まだ決まっていないこと）**を構造化して管理するディレクトリ。**1問1ファイル**で管理する。

**内容は未確定だが、「未決である」こと自体は確定した事実**である。これを Gold 層のエンティティにする理由は、AI エージェントが**未決を勝手に補完して幻覚を起こす**のを防ぐため。「決済方式は未定」という事実がレコードとして存在すれば、AI は「決済は Stripe で確定」と推測で埋めずに「未決」と正しく扱える。

## 命名規則

実データは `records/` 配下に置き、ファイル名は `records/{YYYYMMDD}-{NNN}.md`（起票日ベース。同日内で連番）。ID は `question:{YYYYMMDD}-{NNN}` となる（例: `question:20260724-001`）。

## スキーマ

```yaml
---
type: open_question
id: "question:20260724-001"
title: "決済方式（Stripe / PAY.JP）を確定する"
description: "決済プロバイダの選定が未決。手数料と入金サイクルの比較待ち"
status: open            # open（未決） | resolved（決定で閉じた）
relations:              # 任意。関連する議事録・課題等
  - rel: relates_to
    target: "minute:定例:20260724"
---

（本文。下の template.md の構成に従う）
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| type | ✅ | 常に `open_question` |
| id | ✅ | `question:{YYYYMMDD}-{NNN}` |
| title | ✅ | 何を決める必要があるかの1行表現 |
| description | ✅ | 未決事項の1文要約（一覧・検索・外部消費で使う） |
| status | ✅ | `open`（未決）/ `resolved`（決定で閉じた） |
| relations | - | 論点が出た議事録・課題を `relates_to` で指す（任意） |

## 解決（決定で閉じる）

未決事項が決まったら、**決定側（Decision）から `resolves` 関係でこの question を指し**、この question の `status` を `resolved` に更新する。

- Decision の `relations` に `- rel: resolves / target: "question:20260724-001"` を追加する
- この question の `status` を `open` → `resolved` に変える
- **この status 更新は人間または明示的なスキル操作で行う**（用語の draft→active と同じ）。夜間の自動処理は status を勝手に書き換えない

これにより「いつ・どの決定で・この未決が閉じたか」が機械可読につながり、`resolved` になった question は AI の補完対象から外れる。

## 運用

- 起票は人間または明示的なスキル操作で行う（現時点で夜間の自動抽出は行わない）
- 未決のまま古くなった question も削除しない（未決であること自体が情報）。不要になったものはレビューで扱いを決める
- push 前にスキーマ検証（エンジンの `validate-cortex`）が走るため、規約違反のレコードが main に入ることはない
