/**
 * デザイン画面の育成ノートを Gold 層のエンティティにする（`Cortex/デザイン/` の導入）。
 *
 * 案件リポに `Cortex/デザイン/`（README.md・template.md・records/）が無ければ、
 * エンジンの scaffold からコピーして作成する。既にあれば何もしない（冪等）。
 *
 * 目録（`デザイン/inventory/`）は sync-designs が同期ミラーとして毎回作り替える Silver 層。
 * こちらは画面の意味・意図を蓄積する Gold 層で、AI が draft 生成→人間がレビューして active にする。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 3,
  description: "Cortex/デザイン/ を導入（画面育成ノートのGold層化）",
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
  "デザイン",
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
  const dest = path.join(repoRoot, "Cortex", "デザイン");
  if (await exists(dest)) return; // 既にあれば何もしない
  await fs.cp(SCAFFOLD_SRC, dest, { recursive: true });
}
