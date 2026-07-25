/**
 * 凍結済みのレポートディレクトリ（`Cortex/レポート/`）を Gold 層から撤去する。
 *
 * 経緯: 日次/週次レポートは「コンテキストレイヤーの消費」であって Gold 層への蓄積ではないため、生成は
 * PMハーネスの Slack 配信に一本化された（0012 で凍結注記）。凍結された「直近の動き」がレイヤーに残り
 * 続けると、時間が経つほど古い情報を確定情報として読ませることになる（＝Gold の信頼を損なう）。
 * 「時間が経っても正しい情報だけをレイヤーに」の原則に従って撤去する。
 *
 * 削除は git 履歴から消えるわけではない（いつでも掘り出せる）。派生ビューとして必要になれば再生成できる。
 *
 * 安全ガード（0011 の OpenQuestions 撤収と同じ保守則）:
 *   - 消すのは**機械生成のレポートだけ**。`records/` を走査し、frontmatter の `type: report` でない
 *     ファイル（人が置いたメモ等）が1件でもあれば**何も消さずに警告して残す**。
 *   - README.md / template.md / .gitkeep は生成物なので、records が全て report のときだけ一緒に撤去する。
 *   - `Cortex/レポート/` が無ければ何もしない（適用済み・未導入）。
 *
 * autoApply: true（対象が機械生成物だけであることを確認したうえでの削除・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 18,
  description:
    "凍結済みのレポートディレクトリ（Cortex/レポート/）を撤去（機械生成のreportレコードのみ。人の起票があれば残す）",
  autoApply: true,
};

// 生成物として一緒に撤去してよいファイル（これ以外が直下にあれば人が置いたものとみなす）
const GENERATED_FILES = new Set(["README.md", "template.md", ".gitkeep"]);

function warn(message) {
  console.log(`::warning::migration 0018: ${message}`);
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** frontmatter の type を読む（読めなければ null）。 */
async function typeOf(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => null);
  if (text === null) return null;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const t = m[1].match(/^type:\s*["']?([A-Za-z_]+)["']?\s*$/m);
  return t ? t[1] : null;
}

export async function run(repoRoot) {
  const dir = path.join(repoRoot, "Cortex", "レポート");
  if (!(await exists(dir))) return; // 適用済み・未導入

  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;

  // 直下に想定外のファイル・ディレクトリがあれば触らない（人が足したものを巻き込まない）
  const unexpected = entries.filter(
    (e) => !(e.isDirectory() && e.name === "records") && !(e.isFile() && GENERATED_FILES.has(e.name)),
  );
  if (unexpected.length > 0) {
    warn(
      `Cortex/レポート/ に想定外のファイルがあるため撤去しませんでした（${unexpected
        .map((e) => e.name)
        .join(", ")}）。中身を確認して手で整理してください。`,
    );
    return;
  }

  const recordsDir = path.join(dir, "records");
  if (await exists(recordsDir)) {
    const records = await fs.readdir(recordsDir, { withFileTypes: true }).catch(() => []);
    for (const r of records) {
      if (r.isDirectory()) {
        warn(`Cortex/レポート/records/ にディレクトリ（${r.name}）があるため撤去しませんでした。`);
        return;
      }
      if (r.name === ".gitkeep") continue;
      if (!r.name.endsWith(".md")) {
        warn(`Cortex/レポート/records/ に .md 以外（${r.name}）があるため撤去しませんでした。`);
        return;
      }
      const t = await typeOf(path.join(recordsDir, r.name));
      if (t !== "report") {
        warn(
          `Cortex/レポート/records/${r.name} が type: report ではない（人の起票の可能性）ため撤去しませんでした。中身を確認してください。`,
        );
        return;
      }
    }
  }

  // ここまで来れば中身は機械生成のレポートだけ。ディレクトリごと撤去する。
  await fs.rm(dir, { recursive: true, force: true });
}
