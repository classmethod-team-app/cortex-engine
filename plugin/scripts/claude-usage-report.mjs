#!/usr/bin/env node
// claude -p --output-format json の出力から、応答本文と使用量を run ログへ出す。
// claude-with-usage.sh から呼ばれる（単体でも `node claude-usage-report.mjs <file>` で使える）。
//
// 出力する「LLM使用量:」の書式は update-gold-pipeline.mjs と揃えている。案件別コストの集計側は
// 両者を同じ正規表現で拾うので、**書式を変えるときは両方あわせて変えること**。
//
// 終了コード: 解析できなければ 1（呼び出し側が生の出力にフォールバックする）。

import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("使い方: node claude-usage-report.mjs <claudeのJSON出力ファイル>");
  process.exit(1);
}

let json;
try {
  json = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(1);
}

// 応答本文。--output-format json は最終JSONだけを stdout に出すため、これを出さないと
// 実行中の様子が run ログから完全に消える（障害調査ができなくなる）。
if (json.result) console.log(String(json.result));

const u = json.usage || {};
const input = u.input_tokens || 0;
const output = u.output_tokens || 0;
const cacheWrite = u.cache_creation_input_tokens || 0;
const cacheRead = u.cache_read_input_tokens || 0;
const billed = input + cacheWrite + cacheRead;
const saved = billed > 0 ? Math.round((cacheRead / billed) * 100) : 0;

// ターン数・申告コストは claude 側が出す場合のみ添える（欠けても壊れない）。
const turns = json.num_turns != null ? `${json.num_turns}ターン` : "?ターン";
const cost = json.total_cost_usd != null ? ` / 申告コスト $${json.total_cost_usd}` : "";

console.log(
  `LLM使用量: ${turns} / 入力 ${input} / 出力 ${output} / ` +
    `キャッシュ書込 ${cacheWrite} / キャッシュ読込 ${cacheRead}（入力側の${saved}%がキャッシュ読込）${cost}`,
);
