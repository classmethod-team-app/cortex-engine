/**
 * 未使用（`tools` が `none`）の能力でも、**後から設定できるかどうかの材料**は出すこと。
 *
 * なぜ必要か（実際に起きたこと）:
 *   グローバルエンジニアリング様で「共有資料を後から設定しようとしたのに、セットできないと言われた」。
 *
 *   設定UIは `driveState`（`materials-config.json` の有無）を見て追加フォームを出すか決めている。
 *   ところが fleet-status は `tools.共有資料 = none` の能力について
 *   `{ kind, tool:"none", enabled:false }` だけを出して **extra を丸ごと飛ばしていた**ので、
 *   `driveState` が無く、フォームが出ない＝**未使用の案件は永久に設定できない**状態だった。
 *
 * **実績値と設定状態は性質が違う。** `lastSync`・`matchKeys` は「動いた結果」なので未使用なら
 * 無いのが正しい。`driveState` は「設定ファイルが置かれているか」という静的な事実で、
 * 使っているかどうかとは独立している。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fleet-status.mjs");

/** 案件リポを模した一時ディレクトリで fleet-status を走らせ、internalSources を返す */
function run({ tools, materials }) {
  const dir = mkdtempSync(path.join(tmpdir(), "fs-setup-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cortex", "Home.md"),
    ["---", "type: overview", "tools:", ...Object.entries(tools).map(([k, v]) => `  ${k}: ${v}`), "---", "", "# Home"].join("\n"),
  );
  if (materials !== undefined) {
    mkdirSync(path.join(dir, "共有資料"), { recursive: true });
    writeFileSync(path.join(dir, "共有資料", "materials-config.json"), materials);
  }
  execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf-8", stdio: "pipe" });
  return JSON.parse(readFileSync(path.join(dir, "fleet-status.json"), "utf-8")).internalSources;
}
const pick = (list, kind) => list.find((s) => s.kind === kind);

test("[正常系] 共有資料が未使用でも driveState を出す（後から設定できる）", () => {
  // **ここが落ちると、未使用の案件は共有資料を永久に設定できない**（UIにフォームが出ない）
  const s = pick(run({ tools: { 共有資料: "none" }, materials: JSON.stringify({ driveFolderIds: [] }) }), "共有資料");
  assert.equal(s.enabled, false, "未使用のまま扱われていない");
  assert.ok(s.driveState, `driveState が落ちている: ${JSON.stringify(s)}`);
});

test("[正常系] 設定ファイルが無ければ unset を出す（フォームではなく案内を出させる）", () => {
  const s = pick(run({ tools: { 共有資料: "none" } }), "共有資料");
  assert.equal(s.driveState, "unset");
});

test("[正常系] 使用中の共有資料は従来どおり詳細が付く", () => {
  const s = pick(
    run({ tools: { 共有資料: "google-drive" }, materials: JSON.stringify({ driveFolderIds: ["abc"] }) }),
    "共有資料",
  );
  assert.notEqual(s.enabled, false);
  assert.ok(s.driveState);
  assert.deepEqual(s.driveFolderIds, ["abc"]);
});

test("[異常系] 未使用の能力に実績値まで載せない", () => {
  // 「動いた結果」は未使用なら無いのが正しい。設定状態と混ぜない
  const list = run({ tools: { 共有資料: "none", 会議: "none", デザイン: "none" }, materials: "{}" });
  for (const kind of ["共有資料", "会議", "デザイン"]) {
    const s = pick(list, kind);
    assert.equal(s.enabled, false);
    assert.equal(s.lastSync, undefined, `${kind} に lastSync が載っている`);
    assert.equal(s.url, undefined, `${kind} に url が載っている`);
    assert.equal(s.matchKeys, undefined, `${kind} に matchKeys が載っている`);
  }
});

test("[異常系] 壊れた設定ファイルは broken として出す（フォームを出させない）", () => {
  const s = pick(run({ tools: { 共有資料: "none" }, materials: "{ 壊れたJSON" }), "共有資料");
  assert.equal(s.driveState, "broken");
});
