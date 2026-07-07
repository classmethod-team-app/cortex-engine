#!/usr/bin/env node
/**
 * 案件リポの schema_version が、エンジンの最新スキーマ版に追いついているかを判定する。
 *
 * 用途: 精製系の夜間ワークフロー（update-decision-log / update-glossary / weekly-report /
 * ingest-minutes）が、AI 生成に入る前に本スクリプトで前提チェックする。案件リポのスキーマが
 * 古い（＝未適用マイグレーションが保留中。engine-migrate が autoApply:false で停止した、または
 * 失敗した等）状態で AI 精製を走らせると、旧スキーマのデータに対して現行の生成規約で書き込み、
 * Gold 層を壊す恐れがある。そのため、追いついていなければその夜の精製をスキップする安全網。
 *
 * 判定:
 *   - 案件リポの現在版 = Cortex/Home.md の frontmatter engine.schema_version（未宣言なら 0）
 *   - エンジンの最新版   = migrations/NNNN-*.mjs の meta.to の最大値（migrations が無ければ 0）
 *   - 現在版 >= 最新版 → 追いついている（exit 0。精製を実行してよい）
 *   - 現在版 <  最新版 → 保留中のマイグレーションあり（::notice:: を出して exit 1。精製をスキップ）
 *
 * フェイルオープン: 判定に必要な情報が読めない等の想定外時は、フリート全体を沈黙させないため
 * exit 0（精製を止めない）にし、::warning:: で知らせる。チェックのバグで夜間精製が全案件停止する
 * 事態を避ける（安全網は「明確に古いと分かるときだけ止める」）。
 *
 * カレントディレクトリ = 案件リポのルート。エンジンは本スクリプトの1つ上（scripts/ の親）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = process.cwd();
const HOME_MD = path.join(REPO_ROOT, "Cortex", "Home.md");

async function readRepoSchemaVersion() {
  // engine-migrate.mjs と同じ素朴な読み取り（YAML依存を避ける）。Home.md が無ければ 0。
  try {
    const text = await fs.readFile(HOME_MD, "utf8");
    const m = text.match(/^\s*schema_version:\s*(\d+)\s*(#.*)?$/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function readEngineLatestVersion() {
  const dir = path.join(ENGINE_ROOT, "migrations");
  const files = (await fs.readdir(dir)).filter((f) => /^\d{4}-.*\.mjs$/.test(f));
  let max = 0;
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    if (mod.meta && typeof mod.meta.to === "number" && mod.meta.to > max) max = mod.meta.to;
  }
  return max;
}

async function main() {
  let repo, latest;
  try {
    repo = await readRepoSchemaVersion();
    latest = await readEngineLatestVersion();
  } catch (err) {
    // 想定外（migrations が読めない等）はフェイルオープン
    console.log(`::warning::schema_version チェックに失敗したため精製を続行します: ${err.message}`);
    process.exit(0);
  }

  if (repo >= latest) {
    console.log(`schema_version は最新です（案件: ${repo} / エンジン最新: ${latest}）。精製を実行します。`);
    process.exit(0);
  }

  console.log(
    `::notice::案件リポの schema_version が古いため精製をスキップします（案件: ${repo} / エンジン最新: ${latest}）。` +
      `未適用のマイグレーションが保留中です。engine-migrate の適用（autoApply:false なら手動適用）を先に完了してください。`,
  );
  process.exit(1);
}

main();
