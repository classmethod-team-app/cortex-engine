/**
 * DESIGN.md のニュートラルひな形（Cortexニュートラル / Liquid Glass）と、CLAUDE.md の
 * 「視覚成果物は DESIGN.md に従う」規約を既存案件へ配布する。
 *
 * 配色指定の真実源を CLAUDE.md → DESIGN.md に一本化する。Figma未使用案件では DESIGN.md の
 * この既定がアーティファクト（HTML等の視覚成果物）に使われ、Figma使用案件では sync-designs が
 * 毎晩フロントマターのトークンを案件ブランドで上書きする。
 *
 * 安全側（既存カスタム・Figma同期済みを壊さない）:
 *  1. デザインの figma.json をリポ内で探し（maxdepth 2）、その隣の DESIGN.md を見る
 *     - フロントマターに `colors:` が無い（未同期・旧ひな形）→ 新ひな形のフロントマター（ニュートラル
 *       tokens）を注入する。本文は「未記入（`{{例:` を含む）」なら新本文へ置換、記入済み/独自なら
 *       本文は触らずフロントマターのみ差し替える
 *     - フロントマターに既に `colors:` がある → 何もしない（案件トークン保護＝Figma同期済み等）
 *  2. CLAUDE.md のエンジン管理マーカー内に「## 視覚成果物のデザイン」節が無ければ追記する
 *     （マーカーが無ければスキップ）
 *  3. 2回実行しても壊れない（冪等）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 9,
  description: "DESIGN.mdニュートラルひな形とアーティファクト規約を配布",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_DESIGN = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", "デザイン", "DESIGN.md");
const SCAFFOLD_CLAUDE = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", "CLAUDE.md");

const ENGINE_END_MARKER = "<!-- cortex-engine:end -->";
const ARTIFACT_HEADING = "## 視覚成果物のデザイン";
const UNFILLED_MARKER = "{{例:"; // 本文が未記入（旧ひな形の穴埋めが残っている）目印
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

/** Home.md frontmatter の project 値（プレースホルダは無効扱い）。 */
async function readHomeProject(root) {
  const home = path.join(root, "Cortex", "Home.md");
  if (!(await exists(home))) return null;
  const text = await fs.readFile(home, "utf8");
  const m = /^project:\s*(?:"([^"]*)"|'([^']*)'|([^#\n]+))/m.exec(text);
  if (!m) return null;
  const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  if (!v || v.includes("{{")) return null;
  return v;
}

/** テキストを frontmatter（---...---）と本文に分ける。frontmatter が無ければ fm=null。 */
function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm: null, body: text };
  return { fm: m[1], body: text.slice(m[0].length) };
}

/** scaffold DESIGN.md を project 名で埋めて返す。 */
async function loadScaffoldDesign(repoRoot) {
  let tmpl = await fs.readFile(SCAFFOLD_DESIGN, "utf8");
  const project = await readHomeProject(repoRoot);
  if (project) tmpl = tmpl.split("{{プロジェクト名}}").join(project);
  return tmpl;
}

async function migrateDesignMd(repoRoot, designDir) {
  const dmd = path.join(designDir, "DESIGN.md");
  if (!(await exists(dmd))) return; // DESIGN.md が無い案件は対象外（新規作成はしない＝不在は触らない）
  const cur = await fs.readFile(dmd, "utf8");
  const { fm } = splitFrontmatter(cur);
  // フロントマターに colors: があれば案件トークン（Figma同期済み等）として保護し何もしない
  if (fm !== null && /^\s*colors:\s*$/m.test(fm)) return;

  const scaffold = await loadScaffoldDesign(repoRoot);
  const scaffoldParts = splitFrontmatter(scaffold);

  // 本文が未記入（`{{例:` を含む）なら新ひな形で丸ごと置換。記入済み/独自なら本文は温存しフロントマターだけ差し替える。
  if (cur.includes(UNFILLED_MARKER)) {
    await fs.writeFile(dmd, scaffold, "utf8");
    return;
  }
  const { body: curBody } = splitFrontmatter(cur);
  const newText = `---\n${scaffoldParts.fm}\n---\n\n${curBody.replace(/^\n+/, "")}`;
  await fs.writeFile(dmd, newText, "utf8");
}

/** scaffold CLAUDE.md からアーティファクト規約の節（見出し〜マーカー直前）を取り出す。 */
async function readArtifactSection() {
  const text = await fs.readFile(SCAFFOLD_CLAUDE, "utf8");
  const start = text.indexOf(ARTIFACT_HEADING);
  if (start === -1) return null;
  const end = text.indexOf(ENGINE_END_MARKER, start);
  const section = (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\s+$/, "");
  return section;
}

async function migrateClaudeMd(repoRoot) {
  const claude = path.join(repoRoot, "CLAUDE.md");
  if (!(await exists(claude))) return;
  const cur = await fs.readFile(claude, "utf8");
  const endIdx = cur.indexOf(ENGINE_END_MARKER);
  if (endIdx === -1) return; // エンジン管理マーカーが無ければスキップ（安全側）
  if (cur.includes(ARTIFACT_HEADING)) return; // 既に節がある（冪等）
  const section = await readArtifactSection();
  if (!section) return;
  const before = cur.slice(0, endIdx).replace(/\s+$/, "");
  const after = cur.slice(endIdx);
  const out = `${before}\n\n${section}\n\n${after}`;
  await fs.writeFile(claude, out, "utf8");
}

export async function run(repoRoot) {
  const designDir = await findDesignDir(repoRoot);
  if (designDir) await migrateDesignMd(repoRoot, designDir);
  await migrateClaudeMd(repoRoot);
}
