/**
 * 案件リポに「共有資料の Drive 同期設定」（`共有資料/materials-config.json`）を配布する。
 *
 * 背景: Drive フォルダを 共有資料/ へ自動ミラーする仕組み（中央 Apps Script が30分ごとに走査 → 新規/更新
 * ファイルを commit → `material-ingested` を発火 → sync-materials が Markdown 化）は既に稼働しているが、
 * その案件側の宣言ファイルが scaffold に追加されたのは既存案件の複製後だったため、どの案件にも存在しない。
 * 仕組みがあるのに設定ファイルが無いせいで使えない状態を、このマイグレーションが解く。
 *
 * 配るのは**既定無効**の雛形（`enabled: false` / `driveFolderIds: []`）。有効化は案件側の作業:
 *   1. `enabled: true` と対象フォルダIDを記入する
 *   2. **その Drive フォルダに取り込み用アカウントを閲覧者として招待する**
 *      （招待が無いフォルダは読めずスキップされる＝招待そのものが公開範囲の境界）
 *
 * 所有権モデル（0014・0016 と同じ保守則）: エンジンが配るのは**未定義のときだけ**。既にファイルがあれば
 * 内容が何であれ触らない（案件が有効化・フォルダIDを記入済みの設定を絶対に壊さない）。
 *
 * autoApply: true（新規追加のみ・既存値は不変・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 17,
  description:
    "共有資料の Drive 同期設定（materials-config.json・既定無効）を案件リポに配布（既存の設定は触らない）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_CONFIG = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  "共有資料",
  "materials-config.json",
);

// 資料ディレクトリの既定名。案件がディレクトリを改名している場合は配らない（自己記述の設定のため）。
const MATERIALS_DIR = "共有資料";
const CONFIG_NAME = "materials-config.json";

function warn(message) {
  console.log(`::warning::migration 0017: ${message}`);
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
  const dir = path.join(repoRoot, MATERIALS_DIR);
  if (!(await exists(dir))) return; // 資料ディレクトリが無い（改名済み・未使用）案件では何もしない

  const target = path.join(dir, CONFIG_NAME);
  if (await exists(target)) return; // 既にある設定は内容を問わず尊重する（有効化済みを壊さない）

  const template = await fs.readFile(SCAFFOLD_CONFIG, "utf8").catch(() => null);
  if (template === null) {
    warn("scaffold の materials-config.json を読めなかったため、何もしませんでした。");
    return;
  }

  await fs.writeFile(target, template);
}
