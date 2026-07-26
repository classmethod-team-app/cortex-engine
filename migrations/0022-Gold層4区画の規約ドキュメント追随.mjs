/**
 * Gold層4区画（Decisions / Glossary / Members / Rules）の規約ドキュメント
 * （`README.md` と `template.md`）を、エンジン最新版に追随させる。
 *
 * 背景: この2ファイルは「その区画のレコードをどう書くか」の規約であり、AIS Viewer の
 * 「AIで編集 / ＋AIで登録」も**これを読んでからレコードを書く**。つまり規約の正本そのもので、
 * 古いままだと出力が古い規約に従う（実測: 案件リポの Decisions README は `summary` フィールド・
 * 旧スキル名・`.rulesync/` 参照のまま残っており、現行スキーマの `description` を知らない）。
 *
 * 所有権モデル: 0014・0016・0017 の設定ファイル（案件が値を持つ＝エンジンは未定義のときだけ配る）とは
 * **逆**で、この2ファイルは**エンジンが所有する規約ドキュメント**（案件がカスタマイズする対象ではない・
 * 同期ミラーに近い性質）。したがって内容を問わず scaffold の版で**上書きする**。上書きした事実は
 * `::notice::` に出し、実際の変更内容は同じコミットの git diff で追えるようにする。
 *
 * ガード:
 *   - 区画のディレクトリが無い案件では何もしない（未導入・改名済み）
 *   - `records/` には一切触らない（案件のデータ）
 *   - セットアップ用プレースホルダ（`{{クライアント名}}` / `{{開発リポ}}`）は、案件の値を
 *     Home.md・.gitmodules から導出して埋め戻す。導出できないものは置換せずそのまま残す
 *     （scaffold 直後と同じ状態＝setup-project が後から埋められる）
 *   - 内容が同一なら書き込まない（冪等）
 *
 * autoApply: true（エンジン所有の生成物の差し替えのみ・案件データは不変・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 22,
  description:
    "Gold層4区画（Decisions/Glossary/Members/Rules）の README.md・template.md をエンジン最新版に差し替え（規約ドキュメントのため上書き。records には触らない）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_GOLD = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", "Cortex");

// 対象の区画（0010 で英語名に統一済み）と、エンジンが所有するファイル
const SECTIONS = ["Decisions", "Glossary", "Members", "Rules"];
const OWNED_FILES = ["README.md", "template.md"];

function notice(message) {
  console.log(`::notice::migration 0022: ${message}`);
}

function warn(message) {
  console.log(`::warning::migration 0022: ${message}`);
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p) {
  return await fs.readFile(p, "utf8").catch(() => null);
}

/** Cortex/Home.md の frontmatter から単一行フィールドの値を読む（無ければ null）。 */
async function homeField(repoRoot, key) {
  const text = await readIfExists(path.join(repoRoot, "Cortex", "Home.md"));
  if (text === null) return null;
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  // 値はクォートあり／なしの両方を許し、行末のコメントは落とす
  const m = fm[1].match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return null;
  let v = m[1].trim();
  const quoted = v.match(/^"([^"]*)"|^'([^']*)'/);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  v = v.replace(/\s+#.*$/, "").trim();
  return v;
}

/** .gitmodules のソースコード submodule（パスが `/src` で終わるもの）から owner/repo を導出する。 */
async function devRepoFromSubmodules(repoRoot) {
  const text = await readIfExists(path.join(repoRoot, ".gitmodules"));
  if (text === null) return null;
  const blocks = text.split(/^\[submodule /m).slice(1);
  for (const b of blocks) {
    const p = b.match(/^\s*path\s*=\s*(.+)$/m)?.[1]?.trim();
    const url = b.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
    if (!p || !url) continue;
    if (!/(^|\/)src$/.test(p)) continue;
    const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  }
  return null;
}

/** 既に埋め込み済みの案件リポの README から開発リポ（owner/repo）を拾う。 */
async function devRepoFromExistingReadme(repoRoot) {
  const text = await readIfExists(
    path.join(repoRoot, "Cortex", "Decisions", "README.md"),
  );
  if (text === null) return null;
  const m = text.match(/https:\/\/github\.com\/([^/\s)]+\/[^/\s)]+)\/issues\//);
  if (!m || m[1].includes("{{")) return null; // 未展開のプレースホルダを値として拾わない
  return m[1];
}

/**
 * scaffold のプレースホルダを案件の値で埋める。
 * 導出できなかったものは置換しない（`{{ }}` のまま残し、setup-project が後から埋められる状態にする）。
 */
function fill(text, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value.includes("{{")) continue; // 未展開のプレースホルダでは埋めない
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

export async function run(repoRoot) {
  const values = {
    クライアント名: await homeField(repoRoot, "client"),
    開発リポ:
      (await devRepoFromSubmodules(repoRoot)) ??
      (await devRepoFromExistingReadme(repoRoot)),
  };

  const updated = [];
  for (const section of SECTIONS) {
    const dir = path.join(repoRoot, "Cortex", section);
    if (!(await exists(dir))) continue; // 未導入・改名済みの案件では何もしない

    for (const name of OWNED_FILES) {
      const source = await readIfExists(path.join(SCAFFOLD_GOLD, section, name));
      if (source === null) {
        warn(`scaffold の Cortex/${section}/${name} を読めなかったため、この1件は見送りました。`);
        continue;
      }
      const next = fill(source, values);
      const target = path.join(dir, name);
      const current = await readIfExists(target);
      if (current === next) continue; // 冪等（内容が同一なら書き込まない）

      await fs.writeFile(target, next);
      updated.push(`Cortex/${section}/${name}`);
    }
  }

  if (updated.length > 0) {
    notice(
      `Gold層の規約ドキュメントをエンジン最新版に更新しました（${updated.length}件: ${updated.join(", ")}）。` +
        "これらはエンジンが所有する規約であり案件のカスタマイズ対象ではないため上書きしています。" +
        "変更内容はこのコミットの diff を参照してください。",
    );
  }
}
