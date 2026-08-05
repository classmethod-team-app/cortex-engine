/**
 * 案件スタブ `engine-migrate.yml` が `FLEET_WORKFLOW_TOKEN` をエンジンへ渡すようにする。
 *
 * なぜ要るか:
 *   `GITHUB_TOKEN` は `contents: write` を持っているのに `workflows` だけ持てない
 *   （ジョブの `permissions:` でも付与できないGitHubの仕様）。そのため
 *   `.github/workflows/` を触るマイグレーションだけ push できず、これまでは
 *   `autoApply: false`（人手適用）というゲートで逃げていた。
 *
 *   そのゲートは建前が「人間のレビュー」だったが、34件中2件にしか付いておらず、
 *   どちらも理由は上記の技術的制約だった。レビューする人は現れないまま、
 *   **人手待ちの後ろに積まれたマイグレーションが毎晩「適用しては捨てられ」、
 *   艦隊9案件が3週間止まった**（schema_version が進まないので Gold昇格まで沈黙した）。
 *
 *   ワークフローを push できるトークンを渡せば、この区別そのものが要らなくなる。
 *   ゲートは撤去し、engine-migrate は未適用のものを全部適用するようになった。
 *
 * **これがゲートを必要とする最後のマイグレーション**（スタブ＝ワークフローファイルを書き換えるため、
 * トークンが行き渡る前は自分自身を push できない）。手で1回配ったら、以降は自動で回る。
 *
 * 適用（Contents + Workflows の書き込み権を持つトークンが要る）:
 *   node scripts/apply-migration-manually.mjs 35 --push classmethod-internal/xxx-context ...
 *
 * 保守則: `secrets:` ブロックを持たないスタブ・既に渡しているスタブには触らない（冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 35,
  description: "スタブが FLEET_WORKFLOW_TOKEN をエンジンへ渡すようにする（ワークフロー変更を自動配布できるようにする）",
};

const STUB = path.join(".github", "workflows", "engine-migrate.yml");
const ANCHOR = "ENGINE_REPO_TOKEN: ${{ secrets.ENGINE_REPO_TOKEN }}";
const ADDED = [
  "      # `.github/workflows/` を含む変更を push するためのトークン。未設定でも動く",
  "      # （ワークフローを触るマイグレーションが来たときだけ push が失敗する）",
  "      FLEET_WORKFLOW_TOKEN: ${{ secrets.FLEET_WORKFLOW_TOKEN }}",
].join("\n");

function warn(message) {
  console.log(`::warning::migration 0035: ${message}`);
}

export async function run(repoRoot) {
  const p = path.join(repoRoot, STUB);
  const text = await fs.readFile(p, "utf8").catch(() => null);
  if (text === null) return; // スタブが無い案件（未導入）は触らない
  if (text.includes("FLEET_WORKFLOW_TOKEN")) return; // 適用済み

  if (!text.includes(ANCHOR)) {
    // secrets ブロックの形が想定と違う（案件が独自に書き換えている等）。**勝手に足さない。**
    warn(`${STUB} に想定の secrets 行が無いため追記しませんでした。手で確認してください。`);
    return;
  }
  await fs.writeFile(p, text.replace(ANCHOR, `${ANCHOR}\n${ADDED}`), "utf8");
  console.log("migration 0035: engine-migrate スタブに FLEET_WORKFLOW_TOKEN の受け渡しを追加しました");
}
