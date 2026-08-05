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
 * 冪等（新規追加のみ・既存値は不変・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 17,
  description:
    "共有資料の Drive 同期設定（materials-config.json・既定無効）を案件リポに配布（既存の設定は触らない）",
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


/** リポジトリ内のどこかに同名のファイルが在るか（読み手と同じく探索する。深さ3まで） */
async function findAnywhere(root, name, depth = 3) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name === name) return path.join(dir, e.name);
      if (e.isDirectory() && d < depth && !e.name.startsWith(".") && e.name !== "node_modules") {
        stack.push([path.join(dir, e.name), d + 1]);
      }
    }
  }
  return null;
}

export async function run(repoRoot) {
  const dir = path.join(repoRoot, MATERIALS_DIR);
  if (!(await exists(dir))) return; // 資料ディレクトリが無い（改名済み・未使用）案件では何もしない

  const target = path.join(dir, CONFIG_NAME);
  if (await exists(target)) return; // 既にある設定は内容を問わず尊重する（有効化済みを壊さない）

  // **別の場所に在るなら配らない。** 資料の変換が設定ファイルを
  // `共有資料/materials-config/` へ move してしまう事故があり、
  // 「既定の場所に無い」を理由にここが空の雛形を作り直した結果、
  // **設定済みの2案件で資料同期が数週間止まった**。
  // 読み手は探索して見つけるので、どこかに在るなら配ってはいけない。
  if (await findAnywhere(repoRoot, CONFIG_NAME)) {
    warn(`${CONFIG_NAME} が既定の場所以外にあるため配布しませんでした（移動されている可能性があります）。`);
    return;
  }

  const template = await fs.readFile(SCAFFOLD_CONFIG, "utf8").catch(() => null);
  if (template === null) {
    warn("scaffold の materials-config.json を読めなかったため、何もしませんでした。");
    return;
  }

  await fs.writeFile(target, template);
}
