/**
 * 1画面デザインノート（`Cortex/デザイン/`）を廃止し、DESIGN.md本文の育成に一本化する。
 *
 * migration 0003 が導入した「1画面ごとの育成ノート」は、デザインMD自動育成の対象を
 * 画面単位に広げた拡大解釈だったため撤去する。以後、デザインの蓄積は
 * `デザイン/DESIGN.md`（sync-designsがフロントマターを、夜間AIが本文を育てる）に一本化する。
 *
 * 案件リポに `Cortex/デザイン/` が存在すれば、生成済みノートごと丸ごと削除する（承認済み）。
 * 存在しなければ何もしない（冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 6,
  description: "1画面デザインノートを廃止しDESIGN.md本文育成に一本化",
  autoApply: true,
};

export async function run(repoRoot) {
  // force: true により、存在しない場合は何もしない（2回実行しても壊れない）
  await fs.rm(path.join(repoRoot, "Cortex", "デザイン"), {
    recursive: true,
    force: true,
  });
}
