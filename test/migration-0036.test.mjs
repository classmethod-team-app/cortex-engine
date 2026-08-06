/**
 * `Cortex/メンバー/` と `Cortex/Members/` の重複を解消すること。そして**実データを消さないこと**。
 *
 * なぜ必要か（実際に起きたこと）:
 *   scaffold は `Cortex/Members/`（英語）を同梱している。新規リポは schema 0 から全マイグレーションを
 *   順に適用するため、0002 が `メンバー/` を作り、0010 のリネームが「両方ある」で警告スキップして
 *   空の `メンバー/` が残った。ビューアは Cortex 直下のディレクトリをタブにするので、
 *   **メンバータブが2つ並ぶ**状態になった（グローバルエンジニアリング様の立ち上げで発覚）。
 *
 * **中身があるものは機械が消してはいけない。** 「両方ある」には別経路もありうる
 * （日本語名で運用していた案件に英語名が別途できた等）。そちらは実データなので、
 * 消すのではなく人に知らせて止まる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../migrations/0036-重複したメンバーディレクトリの残骸を除去.mjs";
import { run as run0002 } from "../migrations/0002-メンバー名簿ディレクトリの導入.mjs";

/** 案件リポを模した一時ディレクトリ。files のキーは Cortex からの相対パス */
function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "mig36-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, "Cortex", rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}
const has = (root, rel) => existsSync(path.join(root, "Cortex", rel));

test("[正常系] 空の日本語名ディレクトリを消す", () => {
  const root = repo({
    "Members/README.md": "英語側",
    "Members/records/.gitkeep": "",
    "メンバー/README.md": "テンプレのコピー",
    "メンバー/template.md": "テンプレ",
    "メンバー/records/.gitkeep": "",
  });
  return run(root).then(() => {
    assert.equal(has(root, "メンバー"), false, "残骸が消えていない");
    assert.equal(has(root, "Members/README.md"), true, "英語側まで消している");
  });
});

test("[異常系] 記録があれば消さない（実データを守る）", async () => {
  const root = repo({
    "Members/README.md": "英語側",
    "メンバー/records/山田太郎.md": "---\ntype: member\n---\n",
  });
  await run(root);
  assert.equal(has(root, "メンバー/records/山田太郎.md"), true, "実データを消している");
  assert.equal(has(root, "Members/README.md"), true);
});

test("[正常系] 片方しか無ければ何もしない", async () => {
  const en = repo({ "Members/README.md": "英語側" });
  await run(en);
  assert.equal(has(en, "Members/README.md"), true);

  // 日本語名だけの案件（0010 未適用の古いリポ）に触らない。触ると 0010 の仕事を奪う
  const ja = repo({ "メンバー/README.md": "日本語側", "メンバー/records/佐藤.md": "x" });
  await run(ja);
  assert.equal(has(ja, "メンバー/records/佐藤.md"), true);
});

test("[正常系] 2回走らせても壊れない（冪等）", async () => {
  const root = repo({ "Members/README.md": "英語側", "メンバー/records/.gitkeep": "" });
  await run(root);
  await run(root);
  assert.equal(has(root, "メンバー"), false);
  assert.equal(has(root, "Members/README.md"), true);
});

// ---- 再発を止める側（0002 の修正）----

test("[正常系] 0002は英語名が既にあれば日本語名を作らない", async () => {
  // **これが根本原因。** scaffold が Members/ を同梱しているのに 0002 が メンバー/ を作り、
  // 0010 が「両方ある」で止まって残骸になっていた
  const root = repo({ "Members/README.md": "scaffold同梱", "Members/records/.gitkeep": "" });
  await run0002(root);
  assert.equal(has(root, "メンバー"), false, "英語名があるのに日本語名を作っている");
});

test("[正常系] 0002はどちらも無ければ従来どおり作る", async () => {
  // 古いリポ（Gold層の名簿がまだ無い）への導入は今までどおり効くこと
  const root = repo({ "Decisions/README.md": "x" });
  await run0002(root);
  assert.equal(has(root, "メンバー/README.md"), true, "名簿の区画が作られていない");
  assert.match(readFileSync(path.join(root, "Cortex", "メンバー", "README.md"), "utf-8"), /\S/);
});
