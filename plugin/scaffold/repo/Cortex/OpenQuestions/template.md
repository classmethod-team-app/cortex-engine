---
type: open_question
id: "question:{YYYYMMDD}-{NNN}"
title: "{何を決める必要があるか}"
description: "{未決事項の1文要約}"
status: open            # open（未決） | resolved（決定で閉じた）
relations:              # 任意。論点が出た議事録・課題を指す
  - rel: relates_to
    target: "minute:{定例名}:YYYYMMDD"
---

## 何が決まっていないか

（決める必要がある論点を具体的に書く）

## なぜ決まっていないか

（保留理由。前提が揃っていない・関係者の合意待ち・優先度が低い 等）

## 決めるために必要なこと

（この未決を閉じるために揃える情報・必要な判断・待っている条件）

## 出典

（この論点が浮上した議事録・課題の安定ID。frontmatter の relations と対応させる）
