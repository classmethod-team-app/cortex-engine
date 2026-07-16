/**
 * DESIGN.md を公式仕様（Google Labs OSS の DESIGN.md）準拠テンプレへ刷新する。
 *
 * 旧テンプレ（公式仕様公開前の独自10節・トークンがMarkdown表）を新テンプレ
 * （YAMLフロントマター＝トークン／本文＝設計判断の8節）へ置き換える。ただし
 * 壊してよいのは「未記入の旧テンプレ」だけ。人間が記入済み・独自形式・不在のものは触らない。
 *
 * - デザインの figma.json をリポジトリ内で探し（maxdepth 2）、その隣の DESIGN.md を見る
 *   - 旧テンプレの目印「クラスメソッド流のUIを再生産する」を含み、かつ `{{` を含む（＝未記入）
 *     → 新テンプレで置き換える（`{{プロジェクト名}}` は Home.md の project 値で埋められれば埋める）
 *   - それ以外（記入済み・独自形式・不在）→ 何もしない
 * - デザイン/README.md に「## DESIGN.md（デザイン版CLAUDE.md）」節が無ければ追記する
 * - 2回実行しても壊れない（冪等）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 4,
  description: "DESIGN.mdを公式仕様準拠テンプレへ刷新",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCAFFOLD_DESIGN = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  "デザイン",
  "DESIGN.md",
);
const SCAFFOLD_README = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  "デザイン",
  "README.md",
);

const OLD_TEMPLATE_MARKER = "クラスメソッド流のUIを再生産する";
const README_SECTION_HEADING = "## DESIGN.md（デザイン版CLAUDE.md）";
const SKIP_DIRS = new Set([".git", "node_modules", ".cortex-engine", "tmp"]);

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** figma.json のあるディレクトリを探す（maxdepth 2・除外ディレクトリはたどらない）。 */
async function findDesignDir(root) {
  async function walk(dir, depthLeft) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    if (entries.some((e) => e.isFile() && e.name === "figma.json")) return dir;
    if (depthLeft <= 0) return null;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        const found = await walk(path.join(dir, e.name), depthLeft - 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root, 1); // root直下 + 1階層（find -maxdepth 2 相当）
}

/** Home.md frontmatter の project 値を取り出す（プレースホルダは無効扱い）。 */
async function readHomeProject(root) {
  const home = path.join(root, "Cortex", "Home.md");
  if (!(await exists(home))) return null;
  const text = await fs.readFile(home, "utf8");
  const m = /^project:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const v = m[1].trim().replace(/^["']|["']$/g, "").trim();
  if (!v || v.includes("{{")) return null;
  return v;
}

/** scaffold README から DESIGN.md 節（末尾節）だけを取り出す。 */
async function readDesignReadmeSection() {
  const text = await fs.readFile(SCAFFOLD_README, "utf8");
  const idx = text.indexOf(README_SECTION_HEADING);
  if (idx === -1) return null;
  return text.slice(idx).replace(/\s+$/, "");
}

export async function run(repoRoot) {
  const designDir = await findDesignDir(repoRoot);
  if (!designDir) return; // デザイン同期を使っていないリポは対象外

  // 1. DESIGN.md: 未記入の旧テンプレだけを新テンプレへ置換する
  const dmd = path.join(designDir, "DESIGN.md");
  if (await exists(dmd)) {
    const body = await fs.readFile(dmd, "utf8");
    if (body.includes(OLD_TEMPLATE_MARKER) && body.includes("{{")) {
      let tmpl = await fs.readFile(SCAFFOLD_DESIGN, "utf8");
      const project = await readHomeProject(repoRoot);
      if (project) tmpl = tmpl.split("{{プロジェクト名}}").join(project);
      await fs.writeFile(dmd, tmpl, "utf8");
    }
  }

  // 2. README.md: DESIGN.md 節が無ければ追記する
  const readme = path.join(designDir, "README.md");
  if (await exists(readme)) {
    const cur = await fs.readFile(readme, "utf8");
    if (!cur.includes(README_SECTION_HEADING)) {
      const section = await readDesignReadmeSection();
      if (section) {
        await fs.writeFile(readme, `${cur.replace(/\s+$/, "")}\n\n${section}\n`, "utf8");
      }
    }
  }
}
