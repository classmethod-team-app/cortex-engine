/**
 * 案件リポに「外部ソースの登録ファイル」（`Cortex/external-sources.json`）を配布する。
 *
 * 背景: このファイルは「既定の自動導出から外れる特殊ソースの追加登録＆除外」の宣言先で、
 * 無くても夜間Gold昇格は動く（読み手は無ければスキップする）。そのため scaffold に追加された後も
 * 既存案件に配られていなかった。**実測すると9案件中1案件にしかない。**
 *
 * ところが設定UIから「GitHubリポジトリを追加する」「読み取りをON/OFFする」を押せるようにすると、
 * このファイルが**書き込み先そのもの**になる。無い案件では操作が丸ごと使えない。
 * 0017（共有資料の Drive 同期設定）とまったく同じ状況で、同じ形で解く。
 *
 * 配るのは**空の雛形**（`sources: []` / `exclude: []`）。既定の自動導出（channels.json の
 * `gold: true` なチャンネル・`dev_dir` 配下の submodule）は従来どおり効くので、
 * **配っても取り込み対象は1件も変わらない**。
 *
 * 所有権モデル（0014・0016・0017 と同じ保守則）: エンジンが配るのは**未定義のときだけ**。
 * 既にファイルがあれば内容が何であれ触らない（案件が登録済みの設定を絶対に壊さない）。
 *
 * autoApply: true（新規追加のみ・既存値は不変・冪等。`.github/workflows/` を触らないので
 * GITHUB_TOKEN で push できる）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 32,
  description:
    "外部ソースの登録ファイル（Cortex/external-sources.json・空の雛形）を案件リポに配布（既存の設定は触らない）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_CONFIG = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  "Cortex",
  "external-sources.json",
);

// Gold層のディレクトリ名は固定（オントロジー規約）。無い案件は Cortex 未導入なので配らない。
const CORTEX_DIR = "Cortex";
const CONFIG_NAME = "external-sources.json";

function warn(message) {
  console.log(`::warning::migration 0032: ${message}`);
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(repoRoot) {
  const dir = path.join(repoRoot, CORTEX_DIR);
  if (!(await exists(dir))) return; // Cortex 未導入の案件では何もしない

  const target = path.join(dir, CONFIG_NAME);
  if (await exists(target)) return; // 既にある設定は内容を問わず尊重する

  const template = await fs.readFile(SCAFFOLD_CONFIG, "utf8").catch(() => null);
  if (template === null) {
    warn("scaffold の external-sources.json を読めなかったため、何もしませんでした。");
    return;
  }

  await fs.writeFile(target, template);
}
