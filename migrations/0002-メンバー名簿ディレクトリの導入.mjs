/**
 * メンバー名簿を Gold 層のエンティティにする（`Cortex/メンバー/` の導入）。
 *
 * 案件リポに `Cortex/メンバー/`（README.md・template.md・records/）が無ければ、
 * エンジンの scaffold からコピーして作成する。既にあれば何もしない（冪等）。
 *
 * 既存のメンバー表（member.md ルールや CLAUDE.md の表）の変換・削除は、
 * 内容の解釈が必要なため本マイグレーションでは行わない（案件ごとに人間＋AIで実施する）。
 *
 * 注: Gold層のディレクトリ名は後に英語へ統一され、scaffold 側の実体は `Cortex/Members/` に
 * リネームされた（migration 0010）。本マイグレーションは 0010 より前に走るため、当時のとおり
 * `Cortex/メンバー/`（日本語名）を作成する（英語へのリネームは 0010 が担う）。コピー元だけは
 * 実体のある scaffold の `Members/` を指す。
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
  "Members", // 英語統一で scaffold の実体は Members/ にリネーム済み（dest は 0010 まで日本語名のまま）
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
