/**
 * 案件リポの `Cortex/Home.md` の**本文**を、エンジン最新版（scaffold）に再度追随させる。
 *
 * 背景: Gold層は「決まったこと（Decisions）」「守ること（Rules）」「言葉（Glossary）」「人（Members）」を
 * 持つが、**どこへ向かうか（案件の目的）を持っていなかった**。AIが自律的に動くには「現在地」と「目的地」の
 * 差分が要る。Cortexは現在地を持っているので、目的地を入口に置けば次にすべきことを導けるようになる。
 * そこで Home に「## この案件が目指すもの」（解きたいこと／達成した状態）の節を追加した。
 *
 * **中身は案件ごとに違う**（何のためにこの案件をやるのか）。エンジンが配るのは**節とプレースホルダだけ**で、
 * 記入は案件側の仕事（`setup-project` が対話で聞く）。既存案件には未記入の状態で節が届くので、
 * 未記入であること自体が可視化され、記入の動機になる。
 *
 * 差し替えの範囲・ガード・所有権モデルは 0023 と同一:
 *   - **frontmatter は1文字も触らない**（識別カード・viewer_url・engine.schema_version は案件の値と機構）
 *   - **「## 使用ツール」節以降は丸ごと保持**（案件が記入したURL群）
 *   - `# Home` 見出しまたは `## 使用ツール` 節が無い案件（構成をカスタマイズ済み）は本文を触らず警告のみ
 *   - `{{プロジェクト名}}` は frontmatter から埋め、導出できなければプレースホルダのまま残す
 *   - 内容が同一なら書き込まない（冪等）
 *
 * 注意: 既に「この案件が目指すもの」を**記入済み**の案件では、本文差し替えによって記入内容が
 * プレースホルダに戻る。現時点では全案件が未記入（節そのものが無い）ため実害は無いが、
 * 今後 Home 本文を差し替える migration を書くときは、記入済みの節を保持する処理が要る。
 *
 * autoApply: true（エンジン所有の説明文の差し替えのみ・案件の値は不変・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 25,
  description:
    "Cortex/Home.md の本文に「この案件が目指すもの」の節を追加（frontmatterと使用ツール節は保持）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_HOME = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", "Cortex", "Home.md");

// 本文の境界。ここから前がエンジン所有の説明文、ここから後ろが案件の記入欄。
const TOOLS_HEADING = /^##\s+使用ツール\s*$/m;
const HOME_HEADING = /^#\s+Home\s*$/m;

function notice(message) {
  console.log(`::notice::migration 0025: ${message}`);
}

function warn(message) {
  console.log(`::warning::migration 0025: ${message}`);
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
