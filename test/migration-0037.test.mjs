/**
 * 0037 が、既存案件の会議設定の説明文だけを差し替えること。
 *
 * `_doc` はこのファイルを開いた人が真っ先に読む唯一の説明で、旧文面は
 * 「meetingNamePatterns に会議名を足せ」と指示している——足しても何も起きず、
 * 何も起きないこと自体に気づけない。艦隊9案件がこの状態で残っている。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../migrations/0037-会議設定の説明を新しい振り分け方式に差し替える.mjs";

const OLD_DOC = "顧客会議の文字起こしを…判定の優先順は ①案件キー → ②Cortex/Home.md の client 名 → ③この meetingNamePatterns。";

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "mig37-"));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    writeFileSync(path.join(root, f), body);
  }
  return root;
}
/** console.log を捕まえてマイグレーションを走らせる */
async function apply(root) {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  try { await run(root); } finally { console.log = orig; }
  return logs;
}
const read = (root, f) => JSON.parse(readFileSync(path.join(root, f), "utf-8"));

test("[正常系] 旧文面を差し替える", async () => {
  const root = repo({ "会議/ingest-config.json": JSON.stringify({ _doc: OLD_DOC, enabled: true, transcriptDir: "会議" }, null, 2) });
  const logs = await apply(root);
  const cfg = read(root, "会議/ingest-config.json");
  assert.doesNotMatch(cfg._doc, /meetingNamePatterns|優先順|client 名/, "旧文面が残っている");
  assert.match(cfg._doc, /\[合図\]/, "新しい振り分け方式が書かれていない");
  assert.equal(logs.length, 1, "何をしたか記録していない");
});

test("[正常系] 案件の意思（enabled / transcriptDir / meetingKey）に触らない", async () => {
  // **説明文だけを直す。** ここを書き換えると、案件の取り込みが勝手に止まる／会議が別案件へ行く
  const root = repo({ "会議/ingest-config.json": JSON.stringify({ _doc: OLD_DOC, enabled: true, transcriptDir: "議事録", meetingKey: "stvv", 独自: 1 }) });
  await apply(root);
  const cfg = read(root, "会議/ingest-config.json");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.transcriptDir, "議事録");
  assert.equal(cfg.meetingKey, "stvv");
  assert.equal(cfg.独自, 1, "案件が足したフィールドを落としている");
});

test("[正常系] ディレクトリ名が違う案件でも見つける", async () => {
  // 2案件が `会議/` を `MTG/` にリネームしている
  const root = repo({ "MTG/ingest-config.json": JSON.stringify({ _doc: OLD_DOC, enabled: true }) });
  await apply(root);
  assert.match(read(root, "MTG/ingest-config.json")._doc, /\[合図\]/);
});

test("[正常系] 説明が無い案件にも書く", async () => {
  // 艦隊に1件、`_doc` ごと消えているものがある。旧文面より害は小さいが、
  // このファイルを開いた人に手がかりが何も無い状態になる
  const root = repo({ "会議/ingest-config.json": JSON.stringify({ enabled: true, transcriptDir: "会議" }) });
  await apply(root);
  assert.match(read(root, "会議/ingest-config.json")._doc, /\[合図\]/);
});

test("[正常系] 設定が深い場所にあっても見つける", async () => {
  // **探索範囲は scripts/fleet-status.mjs の findConfigPath と揃える。**
  // ここだけ浅いと、画面が読んでいるファイルをこちらが直せない
  const root = repo({ "a/b/ingest-config.json": JSON.stringify({ _doc: OLD_DOC, enabled: true }) });
  await apply(root);
  assert.match(read(root, "a/b/ingest-config.json")._doc, /\[合図\]/);
});

test("[異常系] 既に新文面なら何もしない", async () => {
  // 再実行やscaffold直後に無駄な差分を出さない（マイグレーションのログも汚れる）
  const body = JSON.stringify({ _doc: "判定は**会議名に [合図] または 【合図】 が入っているか**だけを見る", enabled: false }, null, 2);
  const root = repo({ "会議/ingest-config.json": body });
  const logs = await apply(root);
  assert.equal(readFileSync(path.join(root, "会議/ingest-config.json"), "utf-8"), body, "同じ内容を書き直している");
  assert.deepEqual(logs, []);
});

test("[異常系] 壊れたJSONを書き換えない（案件が手で書いた内容を失わない）", async () => {
  const broken = '{ "_doc": "優先順は…", enabled: true }';
  const root = repo({ "会議/ingest-config.json": broken });
  const logs = await apply(root);
  assert.equal(readFileSync(path.join(root, "会議/ingest-config.json"), "utf-8"), broken, "壊れたファイルを上書きした");
  assert.ok(logs.some((l) => /warning/.test(l)), "黙って諦めている（誰も直せない）");
});

test("[異常系] 会議の設定が無い案件で落ちない", async () => {
  const root = repo({ "Cortex/Home.md": "---\ntype: overview\n---\n" });
  await assert.doesNotReject(apply(root));
  assert.ok(!existsSync(path.join(root, "会議")), "設定を勝手に作っている");
});

test("[正常系] scaffold と同じ説明文を書く", async () => {
  // **2箇所に同じ文面がある。** ズレると「新規案件と既存案件で説明が違う」状態になる
  const scaffold = JSON.parse(readFileSync(new URL("../plugin/scaffold/repo/会議/ingest-config.json", import.meta.url), "utf-8"));
  const root = repo({ "会議/ingest-config.json": JSON.stringify({ _doc: OLD_DOC, enabled: true }) });
  await apply(root);
  assert.equal(read(root, "会議/ingest-config.json")._doc, scaffold._doc, "scaffold と文面がズレている");
});
