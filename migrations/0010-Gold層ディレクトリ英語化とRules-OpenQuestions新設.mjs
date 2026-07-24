/**
 * Gold層のディレクトリ名を frontmatter の type 値（英語）に揃え、Rules / OpenQuestions を新設する。
 *
 * Gold層は機械可読のオントロジー層であり、ディレクトリ名を type（英語）と一致させる:
 *   - `Cortex/用語集/`  → `Cortex/Glossary/`      （type: term）
 *   - `Cortex/メンバー/` → `Cortex/Members/`       （type: member）
 *   - `Cortex/Rules/`         を新設              （type: rule）
 *   - `Cortex/OpenQuestions/` を新設              （type: open_question）
 *
 * 機械的なリネーム＋新設のみで、既存レコードの frontmatter（type/id）は一切変更しない。
 * type/id はディレクトリ名に依存しない設計なので、リネームだけでオントロジー整合が保たれる。
 * Bronze/Silver のトップレベル日本語ディレクトリ（課題管理/会議/等）は対象外（人間の整理箱として日本語のまま）。
 *
 * 冪等（2回実行しても壊れない）:
 *   - リネームは「旧が存在し新が無い」ときだけ行う。移動済み（新がある）ならスキップ。
 *     旧・新が両方あるという想定外の状態では、既存を壊さないようスキップして警告する。
 *   - Rules/OpenQuestions は無ければ scaffold からコピー。あれば何もしない。
 *
 * 注意: 旧パスの GitHub URL（Backlog 等に貼られた外部リンク）は壊れるが許容する（過去の 0002 と同種）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 10,
  description:
    "Gold層ディレクトリを英語化（用語集→Glossary・メンバー→Members）しRules/OpenQuestionsを新設",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCAFFOLD_CORTEX = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  "Cortex",
);

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 旧名→新名のリネーム（冪等・非破壊）。 */
async function renameDir(cortex, from, to) {
  const src = path.join(cortex, from);
  const dest = path.join(cortex, to);
  const srcExists = await exists(src);
  const destExists = await exists(dest);
  if (srcExists && !destExists) {
    await fs.rename(src, dest);
    return;
  }
  if (srcExists && destExists) {
    // 想定外（両方ある）: 既存を壊さないようリネームしない
    process.stderr.write(
      `::warning::migration 0010: ${from} と ${to} が両方存在するためリネームをスキップしました（手動確認が必要）。\n`,
    );
  }
  // それ以外（新のみ／どちらも無い）はスキップ＝冪等
}

/** scaffold の Cortex 直下ディレクトリを、案件リポに無ければコピーして新設する（冪等）。 */
async function scaffoldDir(cortex, name) {
  const dest = path.join(cortex, name);
  if (await exists(dest)) return; // 既にあれば何もしない
  await fs.cp(path.join(SCAFFOLD_CORTEX, name), dest, { recursive: true });
}

export async function run(repoRoot) {
  const cortex = path.join(repoRoot, "Cortex");
  if (!(await exists(cortex))) return; // Cortex/ が無いリポジトリでは何もしない

  await renameDir(cortex, "用語集", "Glossary");
  await renameDir(cortex, "メンバー", "Members");
  await scaffoldDir(cortex, "Rules");
  await scaffoldDir(cortex, "OpenQuestions");
}
