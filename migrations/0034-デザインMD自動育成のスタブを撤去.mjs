/**
 * 案件スタブ `.github/workflows/update-design-notes.yml`（デザインMD自動育成）を撤去する。
 *
 * 経緯: DESIGN.md はデザインハーネスの `design-md` が育てる成果物になった。Cortex は同期も育成も
 * しない（0033 でトークン生成を撤去済み）ので、夜間にAIが本文を育てるワークフローは役目を終えた。
 *
 * **0033 と分けた理由**: `.github/workflows/` 配下は GITHUB_TOKEN では push できない
 * （`workflows` 権限が要り、ジョブの `permissions:` でも付与できない）。autoApply:true で触ると
 * 夜間の engine-migrate が毎晩 push で失敗し、しかも schema_version が前進しないので、
 * それをゲートにしている Gold昇格・議事録生成まで静かに止まる。0027・0031 が同じ理由で
 * 人手適用になっている。**一緒にすると 0033 の162MB回収まで人手待ちで止まる**ので分けた。
 *
 * **順序の注意**: エンジン側の reusable `.github/workflows/update-design-notes.yml` は、
 * このマイグレーションが**全案件に行き渡ってから**削除する。逆にすると、参照先を失ったスタブが
 * 夜間に起動時エラーになる。
 *
 * 適用（ワークフローを push できるトークンが要る。fine-grained PAT なら Workflows: Read and write）:
 *   node scripts/apply-migration-manually.mjs 34 classmethod-internal/xxx-context   # 差分の確認
 *   node scripts/apply-migration-manually.mjs 34 --push classmethod-internal/xxx-context
 *
 * autoApply: false（`.github/workflows/` を触るため）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 34,
  description: "デザインMD自動育成のスタブ（.github/workflows/update-design-notes.yml）を撤去",
  autoApply: false,
};

/**
 * スタブを消す。**デザイン設定の有無とは無関係**（figma.json が無い案件にも scaffold から
 * 配られている）。ファイル名で同定する——スタブ名は変えない約束になっている
 * （SINCE算出が `gh run list --workflow=update-design-notes.yml` に依存していた）。
 */
export async function removeDesignNotesStub(repoRoot) {
  const p = path.join(repoRoot, ".github", "workflows", "update-design-notes.yml");
  try {
    await fs.stat(p);
  } catch {
    return false; // 適用済み・未配布
  }
  await fs.rm(p, { force: true });
  return true;
}

export async function run(repoRoot) {
  if (await removeDesignNotesStub(repoRoot)) {
    console.log("migration 0034: update-design-notes.yml（デザインMD自動育成）のスタブを削除しました");
  }
}
