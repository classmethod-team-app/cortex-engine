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
  const cortex = path.join(repoRoot, "Cortex");
  const dest = path.join(cortex, "メンバー");
  if (await exists(dest)) return; // 既にあれば何もしない

  // **英語名（0010 適用後の形）が既にあるなら作らない。**
  // scaffold は現在 `Cortex/Members/` を同梱している。新規リポは schema 0 から全マイグレーションを
  // 順に適用するので、ここで `メンバー/` を作ると 0010 のリネームが「両方ある」で警告スキップし、
  // **空の `メンバー/` が残ってビューアにメンバータブが2つ出る**（実際に発生）。
  // このマイグレーションの目的は「名簿の区画をGold層に用意すること」なので、
  // 別名で既に用意されているなら何もしないのが正しい。
  if (await exists(path.join(cortex, "Members"))) return;

  await fs.cp(SCAFFOLD_SRC, dest, { recursive: true });
}
