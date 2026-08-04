/**
 * 資料の変換が、**仕組みの設定ファイルを触らない**こと。
 *
 * なぜ必要か（実際に起きた事故）:
 *   `共有資料/materials-config.json`（Drive同期の設定）が資料と誤認され、
 *   `共有資料/materials-config/` へ **move** された。元の場所から消えたので、後日
 *   マイグレーションが「無い」と判断して空の雛形を作り直し、読み手はその空ファイルを見た。
 *   結果、**2案件の資料同期が数週間止まっていた**（東京ヴェルディ様・東急様）。
 *
 *   move してしまうため、影響は「余計な .md が増える」では済まない。設定そのものが消える。
 *
 * 一方で、**資料としてのJSONは今までどおり変換する**（拡張子で一律に弾くと機能が減る）。
 * 判定は名前で行う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "plugin", "skills", "sync-materials", "scripts", "convert.py");

/** 共有資料ディレクトリを作って変換を走らせ、結果のファイル一覧を返す */
function convert(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "mat-"));
  const base = path.join(dir, "共有資料");
  mkdirSync(base, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(base, name), body);
  }
  try {
    execFileSync("python3", [SCRIPT, base, "--organize"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    // markitdown が無い環境では変換自体は失敗しうるが、**移動したかどうか**は判定できる
  }
  return { dir, base, exists: (p) => existsSync(path.join(base, p)) };
}

const CONFIG = JSON.stringify({ enabled: true, driveFolderIds: ["1S1W9wxMiPc6x0h"] });

test("[異常系] 設定ファイルを移動しない（これが事故の本体）", () => {
  const r = convert({ "materials-config.json": CONFIG, "提案書.txt": "本物の資料" });
  assert.equal(r.exists("materials-config.json"), true, "元の場所から消えている＝設定が失われる");
  assert.equal(r.exists("materials-config/materials-config.json"), false, "移動してはいけない");
  assert.equal(r.exists("materials-config/materials-config.md"), false, "変換してはいけない");
  // 設定の中身が変わっていないこと
  assert.equal(readFileSync(path.join(r.base, "materials-config.json"), "utf8"), CONFIG);
});

test("[異常系] 他の設定ファイルも触らない", () => {
  // 共有資料/ に置かれうる仕組みのファイルは materials-config.json だけではない
  const files = {
    "ingest-config.json": "{}",
    "figma.json": "{}",
    "channels.json": "{}",
    "external-sources.json": "{}",
    "backlog-settings.json": "{}",
    "fleet-status.json": "{}",
  };
  const r = convert(files);
  for (const name of Object.keys(files)) {
    assert.equal(r.exists(name), true, `${name} が移動されている`);
    assert.equal(r.exists(`${name.replace(/\.json$/, "")}/${name}`), false, `${name} が資料として整理されている`);
  }
});

test("[正常系] 資料としてのJSONは今までどおり変換する", () => {
  // 拡張子で一律に弾くと、資料として渡されたJSONが変換できなくなる
  const r = convert({ "実データ.json": '{"data":[1,2,3]}' });
  assert.equal(r.exists("実データ/実データ.json"), true, "資料は整理される");
  assert.equal(r.exists("実データ.json"), false, "元の場所には残らない（整理済み）");
});

test("[正常系] 通常の資料は今までどおり", () => {
  const r = convert({ "提案書.txt": "本物の資料" });
  assert.equal(r.exists("提案書/提案書.txt"), true);
});
