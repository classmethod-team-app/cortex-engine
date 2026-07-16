/**
 * OKF互換コア（type + title + description）を全Gold型に導入する。
 *
 * Google の Open Knowledge Format (OKF) v0.1 が推奨する description を全型の共通フィールドにし、
 * decision の同義フィールド summary を description にリネームして語彙を揃える。
 * description は OKF 消費者（index生成・検索スニペット）だけでなく、Cortex 自身の
 * frontmatter-first 探索・Viewer 一覧・日次レポートの機械列挙にも使う。
 *
 * 機械変換（全て冪等）:
 *   - decision: `summary:` キーを `description:` にリネーム（値は保持）
 *   - term:     description が無ければ本文の最初の文から補完（200字上限・draft品質。人間レビューで磨く前提）
 *   - member:   description が無ければ org / role から合成
 *   - report:   title / description が無ければ id の種別と日付から合成
 *   - overview: description が無ければ project から合成
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 5,
  description: "OKF互換コア（description共通化・decisionのsummaryをdescriptionへ）",
  autoApply: true,
};

async function listMd(dir) {
  try {
    const names = await fs.readdir(dir);
    return names
      .filter((n) => n.endsWith(".md") && !["README.md", "template.md"].includes(n))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** frontmatter部と本文に分割（frontmatterが無ければ null） */
function split(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : null;
}

function hasKey(fm, key) {
  return new RegExp(`^${key}:`, "m").test(fm);
}

function getValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return "";
  const v = m[1].trim();
  // クォート付きはクォート内のみ・非クォートは行内コメント(#)以前まで
  const qm = v.match(/^"((?:[^"\\]|\\.)*)"/);
  if (qm) return qm[1].replace(/\\(.)/g, "$1");
  return v.split("#")[0].trim();
}

/** title行の直後に description を挿入（title が無ければ先頭に） */
function insertAfterTitle(fm, descLine) {
  const lines = fm.split("\n");
  const i = lines.findIndex((l) => /^title:/.test(l));
  if (i >= 0) lines.splice(i + 1, 0, descLine);
  else lines.unshift(descLine);
  return lines.join("\n");
}

function yq(v) {
  // YAML二重引用符文字列としてエスケープ
  return `"${String(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** 本文の最初の文を抽出（term の description 補完用） */
function firstSentence(body) {
  const text = body
    .replace(/^#+\s.*$/gm, "") // 見出し除去
    .replace(/\[\[|\]\]/g, "") // wikiリンク記号除去
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // mdリンクをラベルに
    .replace(/[*_`]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  const m = text.match(/^(.{1,200}?。)/);
  return (m ? m[1] : text.slice(0, 200)).trim();
}

export async function run(repoRoot) {
  const gold = path.join(repoRoot, "Cortex");

  // ── decision: summary → description ──
  for (const f of await listMd(path.join(gold, "Decisions", "records"))) {
    const text = await fs.readFile(f, "utf8");
    const p = split(text);
    if (!p || hasKey(p.fm, "description")) continue;
    if (!hasKey(p.fm, "summary")) continue;
    const fm = p.fm.replace(/^summary:/m, "description:");
    await fs.writeFile(f, `---\n${fm}\n---\n${p.body}`);
  }

  // ── term: 本文第1文から補完 ──
  for (const f of await listMd(path.join(gold, "用語集", "records"))) {
    const text = await fs.readFile(f, "utf8");
    const p = split(text);
    if (!p || hasKey(p.fm, "description")) continue;
    const desc = firstSentence(p.body) || `${getValue(p.fm, "title")} の用語定義`;
    const fm = insertAfterTitle(p.fm, `description: ${yq(desc)}`);
    await fs.writeFile(f, `---\n${fm}\n---\n${p.body}`);
  }

  // ── member: org / role から合成 ──
  for (const f of await listMd(path.join(gold, "メンバー", "records"))) {
    const text = await fs.readFile(f, "utf8");
    const p = split(text);
    if (!p || hasKey(p.fm, "description")) continue;
    const org = getValue(p.fm, "org");
    const role = getValue(p.fm, "role");
    const desc = [org && `${org}所属`, role || "役割は確認中"].filter(Boolean).join("。") + "。";
    const fm = insertAfterTitle(p.fm, `description: ${yq(desc)}`);
    await fs.writeFile(f, `---\n${fm}\n---\n${p.body}`);
  }

  // ── report: id から title / description を合成 ──
  for (const f of await listMd(path.join(gold, "レポート", "records"))) {
    const text = await fs.readFile(f, "utf8");
    const p = split(text);
    if (!p) continue;
    const id = getValue(p.fm, "id"); // report:YYYYMMDD-weekly | report:YYYYMMDD-daily
    const m = id.match(/^report:(\d{4})(\d{2})(\d{2})-(weekly|daily)$/);
    if (!m) continue;
    const dateH = `${m[1]}-${m[2]}-${m[3]}`;
    const isWeekly = m[4] === "weekly";
    let fm = p.fm;
    let changed = false;
    if (!hasKey(fm, "title")) {
      const title = isWeekly ? `週次レポート ${dateH}` : `${dateH} デイリーレポート`;
      fm = fm.replace(/^(id:.*)$/m, `$1\ntitle: ${yq(title)}`);
      changed = true;
    }
    if (!hasKey(fm, "description")) {
      const desc = isWeekly ? `${dateH} を末日とする週の週次レポート` : `${dateH} の日次レポート`;
      fm = insertAfterTitle(fm, `description: ${yq(desc)}`);
      changed = true;
    }
    if (changed) await fs.writeFile(f, `---\n${fm}\n---\n${p.body}`);
  }

  // ── overview (Home.md): project から合成 ──
  const home = path.join(gold, "Home.md");
  try {
    const text = await fs.readFile(home, "utf8");
    const p = split(text);
    if (p && !hasKey(p.fm, "description")) {
      const project = getValue(p.fm, "project");
      const desc = project
        ? `${project}のコンテキストリポジトリの入口（Gold層）`
        : "コンテキストリポジトリの入口（Gold層）";
      const fm = insertAfterTitle(p.fm, `description: ${yq(desc)}`);
      await fs.writeFile(home, `---\n${fm}\n---\n${p.body}`);
    }
  } catch {
    // Home.md が無い場合は何もしない
  }
}
