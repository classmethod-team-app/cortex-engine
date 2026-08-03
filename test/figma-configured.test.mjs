/**
 * figma.json の「使える状態か」の判定。
 *
 * ここが緩いと、scaffold のプレースホルダのままの案件が「設定済み」と判定され、
 * トークンさえ入れば無駄な同期が毎晩走る。実際に、設定UIからトークンを入れた瞬間に
 * カナリア（figma.json はプレースホルダ）で同期が走った。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasRealFigmaKey } from "../scripts/figma-configured.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "figma-configured.mjs");
const SCAFFOLD = path.join(HERE, "..", "plugin", "scaffold", "repo", "デザイン", "figma.json");

test("[正常系] 実際のファイルキーがあれば使える状態と判定する", () => {
  assert.equal(hasRealFigmaKey('{"files":[{"key":"abc123XYZdef456GHI789","name":"アプリUI"}]}'), true);
  assert.equal(hasRealFigmaKey('{ "files": [ { "key" : "AbCdEfGh" } ] }'), true, "空白があっても読む");
});

test("[異常系] scaffold のプレースホルダを「設定済み」にしない", () => {
  // ここが今回の実バグ。`"key"` という文字列の有無だけを見ると通ってしまう。
  const placeholder = '{"files":[{"key":"{FigmaのURL figma.com/design/この部分/... をここに}","name":"{メモ}"}]}';
  assert.equal(hasRealFigmaKey(placeholder), false);
  assert.match(placeholder, /"key"/, "（文字列としては key の宣言を含んでいる）");
});

test("[異常系] 空・短すぎる・波括弧つきの値を弾く", () => {
  for (const bad of [
    '{"files":[{"key":""}]}',
    '{"files":[{"key":"short"}]}',
    '{"files":[{"key":"{{FIGMA_KEY}}"}]}',
    '{"files":[{"key":"ここにキー"}]}',
    "",
    null,
    undefined,
  ]) {
    assert.equal(hasRealFigmaKey(bad), false, `入力: ${JSON.stringify(bad)}`);
  }
});

test("[正常系] scaffold が配る figma.json は未設定と判定される", () => {
  // 新規案件がセットアップ前に同期を走らせないための不変条件
  assert.equal(hasRealFigmaKey(readFileSync(SCAFFOLD, "utf8")), false);
});

test("[正常系] スクリプトとして呼ぶと終了コードで答える（ワークフローが使う形）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "figma-"));
  const ok = path.join(dir, "ok.json");
  const ng = path.join(dir, "ng.json");
  writeFileSync(ok, '{"files":[{"key":"abc123XYZdef456"}]}');
  writeFileSync(ng, '{"files":[{"key":"{ここに入れる}"}]}');

  const run = (p) => {
    try { execFileSync("node", [SCRIPT, p], { stdio: "ignore" }); return 0; }
    catch (e) { return e.status; }
  };
  assert.equal(run(ok), 0);
  assert.equal(run(ng), 1);
  assert.equal(run(path.join(dir, "missing.json")), 1, "ファイルが無ければ未設定扱い");
});
