/**
 * scaffold が配る JSON がすべて parse できること。
 *
 * なぜ必要か（実際に壊した）:
 *   `会議/ingest-config.json` の `_doc`（説明文）を書き直したとき、文中に半角ダブル
 *   クォートで `"[kc]"` と書いてしまい、そこで文字列が終わって **JSON が壊れた**。
 *
 *   壊れた scaffold から作られた案件は、`ingest-config.json` の解析に失敗して
 *   `cfg = null` → 会議取り込みが無効 → **その案件の会議が全部 INBOX へ落ちる**。
 *   しかも `/setup-project` の手順は「`enabled` を true にする」だけなので、
 *   そのとおりやっても直らない。誰も気づけないまま案件が増える。
 *
 * `_doc` は日本語の長文で、括弧・引用符・記号を書きたくなる場所なので**また起きる**。
 * CI がここで止めるのが唯一の防ぎ方（テストも scripts も scaffold の JSON を読まない）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = globSync("plugin/scaffold/**/*.json", { cwd: ROOT });

test("[正常系] scaffold の JSON がすべて parse できる", () => {
  assert.ok(files.length >= 3, `scaffold の JSON を見つけられていない（${files.length}件）`);
  for (const f of files) {
    const raw = readFileSync(path.join(ROOT, f), "utf-8");
    assert.doesNotThrow(() => JSON.parse(raw), `${f} が JSON として壊れている`);
  }
});

test("[正常系] 会議の設定が、案件が触るフィールドを持っている", () => {
  // 壊れていないだけでなく、手順書（setup-project ステップ12）が「ここを書き換える」と
  // 言っているフィールドが実在すること。`_doc` の書き直しでフィールドごと消した事故もありうる
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "plugin/scaffold/repo/会議/ingest-config.json"), "utf-8"));
  assert.equal(cfg.enabled, false, "既定で有効になっている（宣言していない案件が取り込まれる）");
  assert.equal(typeof cfg.transcriptDir, "string");
  // **廃止したフィールドを配らない。** 「ここに足せば拾われる」と読めるのに何も起きない
  assert.equal(cfg.meetingNamePatterns, undefined);
  // meetingKey は任意。既定は艦隊キーなので scaffold では持たない（空文字を配ると宣言済みに見える）
  assert.equal(cfg.meetingKey, undefined);
});
