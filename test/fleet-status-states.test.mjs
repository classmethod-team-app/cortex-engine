/**
 * 会議の取り込み・Drive資料同期の「現在の状態」が、理由まで区別されることを固定する。
 *
 * なぜ必要か:
 *   設定UIから ON/OFF を押せるようにする以上、画面が現在値を出せないと
 *   「押したのに変わらない」と読まれる。そして以前の実装は
 *     - 会議: 「OFF」「設定ファイルなし」「照合キーが空」がすべて同じ undefined
 *     - 資料: 「OFF」「設定ファイルなし」「フォルダ未登録」がすべて `driveSync: false`
 *   に潰れていた。`goldState` を三値にしたときと同じ問題（区別できないと
 *   正常なOFFにも警告が出て、警告そのものが無視されるようになる）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "fleet-status.mjs");

/** 案件リポを模した一時ディレクトリで fleet-status.mjs を走らせ、結果を返す */
function run(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-"));
  // Home.md は tools の宣言に使う（applicability のゲート）
  const home = [
    "---", "type: overview", 'id: "overview:home"', "kind: 案件", "lifecycle: active",
    "tools:", "  会議: google-meet", "  共有資料: google-drive", "---", "", "# Home",
  ].join("\n");
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  writeFileSync(path.join(dir, "Cortex", "Home.md"), home);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    writeFileSync(path.join(dir, p), body);
  }
  execFileSync("node", [SCRIPT], {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, FLEET_NOW: "2026-08-03T00:00:00Z", GITHUB_REPOSITORY: "org/kc-context" },
  });
  const out = JSON.parse(readFileSync(path.join(dir, "fleet-status.json"), "utf8"));
  const by = (kind) => (out.internalSources || []).find((s) => s.kind === kind) || {};
  return { meeting: by("会議"), materials: by("共有資料") };
}

const INGEST = (enabled) => JSON.stringify({ enabled, meetingNamePatterns: ["KC"] });
const MATERIALS = (enabled, ids) => JSON.stringify({ enabled, driveFolderIds: ids });

test("[会議] ON / OFF / 未設置 / 壊れている を区別する", () => {
  assert.equal(run({ "会議/ingest-config.json": INGEST(true) }).meeting.ingestState, "on");
  assert.equal(run({ "会議/ingest-config.json": INGEST(false) }).meeting.ingestState, "off");
  assert.equal(run({}).meeting.ingestState, "unset");
  assert.equal(run({ "会議/ingest-config.json": "{ 壊れ" }).meeting.ingestState, "broken");
});

test("[資料] ON / OFF / 未設置 / フォルダ未登録 を区別する", () => {
  const on = run({ "共有資料/materials-config.json": MATERIALS(true, ["1AbC"]) }).materials;
  assert.equal(on.driveState, "on");
  assert.equal(on.driveFolderCount, 1);
  assert.equal(on.url, "https://drive.google.com/drive/folders/1AbC");

  // **OFF でもフォルダ数は残す。** 「消したのか、止めただけなのか」が画面で分かるように。
  const off = run({ "共有資料/materials-config.json": MATERIALS(false, ["1AbC", "2DeF"]) }).materials;
  assert.equal(off.driveState, "off");
  assert.equal(off.driveFolderCount, 2);

  assert.equal(run({ "共有資料/materials-config.json": MATERIALS(true, []) }).materials.driveState, "empty");
  assert.equal(run({}).materials.driveState, "unset");
});

test("[資料] driveSync は後方互換のため残す（既存の読み手が見ている）", () => {
  const on = run({ "共有資料/materials-config.json": MATERIALS(true, ["1AbC"]) }).materials;
  assert.equal(on.driveSync, undefined, "ONのときは付けない（従来どおり）");
  for (const cfg of [MATERIALS(false, ["1AbC"]), MATERIALS(true, [])]) {
    assert.equal(run({ "共有資料/materials-config.json": cfg }).materials.driveSync, false);
  }
});

test("[資料] 設定ファイルの置き場が案件で違っても読める", () => {
  // 実データ: cortex-context は 共有資料/materials-config/materials-config.json に置いている
  const r = run({ "共有資料/materials-config/materials-config.json": MATERIALS(true, ["1AbC"]) });
  assert.equal(r.materials.driveState, "on");
});

test("[会議] 照合キーは ON のときだけ出す（従来どおり）", () => {
  assert.ok(run({ "会議/ingest-config.json": INGEST(true) }).meeting.matchKeys?.includes("KC"));
  assert.equal(run({ "会議/ingest-config.json": INGEST(false) }).meeting.matchKeys, undefined);
});
