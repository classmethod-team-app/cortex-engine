/**
 * 案件リポの `Cortex/Home.md` の**本文**を、エンジン最新版（scaffold）に追随させる。
 *
 * 背景: Home は Gold 層の入口であり、新メンバー・顧客・AIエージェントが最初に読むページ。その本文が
 * 現行のGold層と食い違っていた（実測: 撤去済みの「レポート」を案内し続け、いま在る「メンバー」「ルール」に
 * 触れていない。見出しも「AISについて」なのに中身は仕組みの説明で噛み合っておらず、「AI生成・未確認」の
 * 直し方＝ビューアの「AIで編集」への導線も無い）。入口が古い案内をしているのは、レイヤーの信頼を直接損なう。
 *
 * 所有権モデル: 0022（Gold層の規約ドキュメント）と同じく、**本文の前半はエンジンが所有する説明文**として
 * 上書きする。ただし Home は案件固有の値も同居するページなので、次の2つには**絶対に触れない**:
 *   - **frontmatter**: 識別カード（kind/client/domains/tools 等）・`viewer_url`・`engine.schema_version` が
 *     入っており、案件の値と機構そのもの。1文字も書き換えない
 *   - **「## 使用ツール」節以降**: 案件が記入した実際のURL群。丸ごと保持する
 *
 * ガード:
 *   - `Cortex/Home.md` が無い案件では何もしない
 *   - 本文に `# Home` 見出し、または `## 使用ツール` 節が見つからない案件（構成をカスタマイズ済み）は
 *     **本文を触らず警告だけ**出す（勝手に構造を壊さない）
 *   - `{{プロジェクト名}}` は案件の frontmatter から埋める。導出できなければプレースホルダのまま残す
 *     （0022 と同じ保守則。setup-project が後から埋められる状態）
 *   - 内容が同一なら書き込まない（冪等）
 *
 * 冪等（エンジン所有の説明文の差し替えのみ・案件の値は不変・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 23,
  description:
    "Cortex/Home.md の本文をエンジン最新版に追随（撤去済みレポートの案内を削除しGold層4区画と「AIで編集」の導線に更新。frontmatterと使用ツール節は不変）",
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_HOME = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", "Cortex", "Home.md");

// 本文の境界。ここから前がエンジン所有の説明文、ここから後ろが案件の記入欄。
const TOOLS_HEADING = /^##\s+使用ツール\s*$/m;
const HOME_HEADING = /^#\s+Home\s*$/m;

function notice(message) {
  console.log(`::notice::migration 0023: ${message}`);
}

function warn(message) {
  console.log(`::warning::migration 0023: ${message}`);
}

async function readIfExists(p) {
  return await fs.readFile(p, "utf8").catch(() => null);
}

/** frontmatter（先頭の `---` ブロック・区切り行含む）と本文に分割する。frontmatter が無ければ前半は空。 */
function splitFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!m) return { frontmatter: "", body: text };
  return { frontmatter: m[0], body: text.slice(m[0].length) };
}

/** frontmatter から単一行フィールドの値を読む（無ければ null）。行末コメントとクォートを落とす。 */
function field(frontmatter, key) {
  const m = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return null;
  let v = m[1].trim();
  const quoted = v.match(/^"([^"]*)"|^'([^']*)'/);
  if (quoted) return (quoted[1] ?? quoted[2] ?? "").trim();
  v = v.replace(/\s+#.*$/, "").trim();
  return v;
}

/**
 * 案件の表示名を導出する。`project` を優先し、無ければ `title`。
 * `title` はこのスキーマでは固定値 "Home"（= 案件名ではない）なので採用しない。
 * 導出できなければ null（＝プレースホルダのまま残す）。
 */
function projectName(frontmatter) {
  for (const key of ["project", "title"]) {
    const v = field(frontmatter, key);
    if (!v || v.includes("{{")) continue;
    if (key === "title" && v === "Home") continue;
    return v;
  }
  return null;
}

/** 本文を「使用ツール節より前（エンジン所有）」と「使用ツール節以降（案件の記入欄）」に割る。 */
function splitAtTools(body) {
  const m = body.match(TOOLS_HEADING);
  if (!m || m.index === undefined) return null;
  return { head: body.slice(0, m.index), tail: body.slice(m.index) };
}

export async function run(repoRoot) {
  const target = path.join(repoRoot, "Cortex", "Home.md");
  const current = await readIfExists(target);
  if (current === null) return; // Home.md が無い案件では何もしない

  const source = await readIfExists(SCAFFOLD_HOME);
  if (source === null) {
    warn("scaffold の Cortex/Home.md を読めなかったため、何もしませんでした。");
    return;
  }

  const scaffoldParts = splitAtTools(splitFrontmatter(source).body);
  if (scaffoldParts === null) {
    warn("scaffold の Cortex/Home.md に「## 使用ツール」節が見つからないため、何もしませんでした。");
    return;
  }

  const { frontmatter, body } = splitFrontmatter(current);
  if (!HOME_HEADING.test(body)) {
    warn(
      "Cortex/Home.md の本文に「# Home」見出しが無い（構成をカスタマイズ済み）ため、本文を更新しませんでした。" +
        "必要ならエンジンの scaffold（plugin/scaffold/repo/Cortex/Home.md）を見て手で反映してください。",
    );
    return;
  }
  const parts = splitAtTools(body);
  if (parts === null) {
    warn(
      "Cortex/Home.md に「## 使用ツール」節が無い（構成をカスタマイズ済み）ため、本文を更新しませんでした。" +
        "必要ならエンジンの scaffold（plugin/scaffold/repo/Cortex/Home.md）を見て手で反映してください。",
    );
    return;
  }

  const name = projectName(frontmatter);
  const head = name === null
    ? scaffoldParts.head
    : scaffoldParts.head.split("{{プロジェクト名}}").join(name);

  // frontmatter と「使用ツール」節はそのまま。差し替えるのは本文前半だけ。
  const next = frontmatter + head + parts.tail;
  if (next === current) return; // 冪等（内容が同一なら書き込まない）

  await fs.writeFile(target, next);
  notice(
    "Cortex/Home.md の本文（説明文）をエンジン最新版に更新しました" +
      "（Gold層4区画の案内・「AIで編集」の導線に差し替え。frontmatter と「使用ツール」節は変更していません）。",
  );
}
