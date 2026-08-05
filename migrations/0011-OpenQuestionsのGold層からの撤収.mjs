/**
 * OpenQuestions（未決事項）を Gold 層から撤収する。migration 0010 が新設した
 * `Cortex/OpenQuestions/` を、空であれば畳む。
 *
 * 設計判断の変更: 未決事項は開閉が頻繁なフロー性の情報で、「Goldにある＝確定」という
 * 層の信頼を壊す（古びた open が逆にAIを誤らせる）。未決の正本は議事録TODO・課題管理ツールの
 * 協議中課題という生きた場所にあり、一覧が要るときはPMハーネス側のスキルが要求時に横断発見する。
 * よって Gold 層のエンティティとしては持たない（0010 で作成 → 本migrationで撤収の収束）。
 *
 * 安全ガード（最重要）: `records/` に実レコード（README.md / template.md / .gitkeep 以外のファイル）が
 * 1つでも存在する場合は削除せず、警告を出してディレクトリを残す（schema は進めてよい）。
 * 0010 が作った直後の空ディレクトリを畳むのが主目的で、人が起票した未決を消さないため。
 *
 * 冪等（2回実行しても壊れない）: ディレクトリが無ければ何もしない。実レコードがあれば毎回残す。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 11,
  description: "OpenQuestions（未決事項）をGold層から撤収（空なら畳む・実レコードがあれば残す）",
};

// 撤収してよい「足場ファイル」（これら以外がrecords配下にあれば人が起票したレコードとみなす）
const SCAFFOLD_FILES = new Set(["readme.md", "template.md", ".gitkeep"]);

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** ディレクトリツリーを走査し、足場ファイル以外（＝実レコード）が1つでもあれば true。 */
async function hasRealRecords(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (await hasRealRecords(path.join(dir, e.name))) return true;
      continue;
    }
    if (!SCAFFOLD_FILES.has(e.name.toLowerCase())) return true;
  }
  return false;
}

export async function run(repoRoot) {
  const dir = path.join(repoRoot, "Cortex", "OpenQuestions");
  if (!(await exists(dir))) return; // 既に無ければ何もしない（冪等）

  if (await hasRealRecords(dir)) {
    process.stderr.write(
      "::warning::migration 0011: Cortex/OpenQuestions/ に実レコードがあるため削除せず残しました（未決の内容は失わない）。設計判断の変更により未決はGold層で持たない方針です。内容を議事録TODO・課題管理ツール等の正本へ移し、確認のうえ手動でディレクトリを削除してください。\n",
    );
    return;
  }

  // 空（足場ファイルのみ）: ディレクトリごと撤収
  await fs.rm(dir, { recursive: true, force: true });
}
