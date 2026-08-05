/**
 * `Cortex/Home.md` の「## この案件が目指すもの」を「## このプロジェクトが目指すもの」に改める。
 *
 * 背景: 0025 で追加した節の見出しが「案件」だったが、Cortex は顧客案件だけでなく社内プロジェクトでも
 * 使う（Home の識別カード `kind` が `案件 | 社内プロジェクト` の2値を取る）。「案件」だと社内利用時に
 * 語がずれるため、両方を含む「プロジェクト」に統一する。Viewer の「AIで編集」プロンプト・
 * `setup-project` の記入手順も同じ語に揃えた。
 *
 * 安全ガード（0013・0021・0024 と同じ保守則）:
 * - 見出し行だけを**完全一致**で置換する。節の中身（案件が記入した「解きたいこと」「達成した状態」）には
 *   触れないので、0025 の注意書きにある「本文差し替えで記入内容が消える」問題は起きない。
 * - 見出しが既に新しい文言なら何もしない（冪等）。案件側で見出しを書き換えている場合もそのまま残す。
 *
 * 冪等（見出し1行のテキスト置換のみ・非破壊・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 26,
  description:
    "Cortex/Home.md の「この案件が目指すもの」見出しを「このプロジェクトが目指すもの」に統一（社内プロジェクトでも語がずれないように）",
};

const OLD_HEADING = "## この案件が目指すもの";
const NEW_HEADING = "## このプロジェクトが目指すもの";

export async function run(repoRoot) {
  const target = path.join(repoRoot, "Cortex", "Home.md");
  let text;
  try {
    text = await fs.readFile(target, "utf8");
  } catch {
    return; // Home.md が無い案件では何もしない
  }
  if (!text.includes(OLD_HEADING)) return;
  await fs.writeFile(target, text.split(OLD_HEADING).join(NEW_HEADING));
}
