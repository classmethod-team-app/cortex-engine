/**
 * メンバー名簿を Gold 層のエンティティにする（`Cortex/メンバー/` の導入）。
 *
 * 案件リポに `Cortex/メンバー/`（README.md・template.md・records/）が無ければ、
 * エンジンの scaffold からコピーして作成する。既にあれば何もしない（冪等）。
 *
 * 既存のメンバー表（member.md ルールや CLAUDE.md の表）の変換・削除は、
 * 内容の解釈が必要なため本マイグレーションでは行わない（案件ごとに人間＋AIで実施する）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 2,
  description: "Cortex/メンバー/ を導入（名簿のGold層化）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCAFFOLD_SRC = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  "Cortex",
  "メンバー",
);

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(repoRoot) {
  const dest = path.join(repoRoot, "Cortex", "メンバー");
  if (await exists(dest)) return; // 既にあれば何もしない
  await fs.cp(SCAFFOLD_SRC, dest, { recursive: true });
}
