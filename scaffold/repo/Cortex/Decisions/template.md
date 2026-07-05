---
type: decision
id: "YYYYMMDD-NNN"
title: "決定内容のタイトル"
date: YYYY-MM-DD
sprint: sprintN
category: 技術選定
deciders:
  - CM_氏名
  - {{クライアント名}}_氏名
summary: "決定内容の要約"
relations:
  - rel: based_on
    target: "minute:{定例名}:YYYYMMDD"
  - rel: based_on
    target: "{課題キー}"
references:
  - "会議/Ph.1/YYYYMMDD/minutes.md"
  - "[{{開発リポ}}#N](https://github.com/{{開発リポ}}/issues/N)"
---

# 決定内容のタイトル

## 背景

（なぜこの決定が必要になったか）

## 理由

（なぜその選択をしたか、他の選択肢との比較）
