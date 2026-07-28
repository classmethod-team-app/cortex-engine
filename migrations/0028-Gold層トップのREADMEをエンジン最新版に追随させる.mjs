/**
 * `Cortex/README.md`（Gold層トップの規約ドキュメント）をエンジン最新版へ追随させる。
 *
 * 背景: 0022 は `Cortex/<区画>/README.md` と `template.md`（Decisions / Glossary / Members / Rules）
 * だけを対象にしており、**その親である `Cortex/README.md` が漏れていた**。結果として全案件で
 * 以下の陳腐化した記述が残っていた:
 *   - ディレクトリ構成が `用語集/`・`レポート/`（改名前・撤去済み）のままで、`Members/`・`Rules/` が無い
 *   - 廃止済みスキル `/weekly-report` を「経由して生成せよ」と案内している
 *   - rulesync 時代の `pnpm run lint:cortex` を検証手段として案内している
 *   - アーカイブ済みテンプレート `aidd-project-cortex` を変更手順の起点として案内している
 *
 * Gold層の入口の規約が古いと、AI が存在しないディレクトリを読み、存在しないスキルを呼び、
 * 誤った場所にレコードを生成する。案件把握の初動を直接狂わせるので追随させる。
 *
 * このファイルはエンジンが所有する規約であり案件のカスタマイズ対象ではない（0022 と同じ扱い）。
 * したがって内容を問わず scaffold の版で**上書きする**。scaffold 側にプレースホルダは無いため
 * 0022 のような値の差し込みは行わない。
 *
 * autoApply: true（エンジン所有ファイルの上書きのみ・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 28,
  description:
    "Cortex/README.md をエンジン最新版に追随（撤去済みレポート・改名前の用語集・廃止スキルへの参照を解消）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", "Cortex", "README.md");

export async function run(repoRoot) {
  const target = path.join(repoRoot, "Cortex", "README.md");

  let source;
  try {
    source = await fs.readFile(SOURCE, "utf8");
  } catch {
    return; // scaffold を読めない場合は何もしない（既存の内容を壊さない）
  }

  let current = null;
  try {
    current = await fs.readFile(target, "utf8");
  } catch {
    return; // Gold層が未導入の案件には配らない
  }

  if (current === source) return; // 冪等
  await fs.writeFile(target, source);
}
