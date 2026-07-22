/**
 * `tmp/` を「Git管理外の作業領域」として定義する。
 *
 * 下書き（定例アジェンダ案・作業メモ等）はリポジトリに残さない。ツールに登録するものは
 * ツール側が正本になり、同期でリポジトリへ取り込まれるため、下書きを残すと二重管理になる。
 * 用途の説明として `tmp/README.md` だけは追跡する。
 *
 * - `.gitignore` に `tmp/` と `!tmp/README.md` が無ければ追記する（既存行は書き換えない）
 * - `tmp/README.md` が無ければ scaffold から配置する
 * - 既に追跡されている `tmp/` 配下のファイルは**そのまま残す**（gitignore は追跡済みに効かない。
 *   意図して置かれた資料もあるため、ここでは追跡解除しない）
 * - 2回実行しても壊れない（冪等）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 7,
  description: "tmp/ をGit管理外の作業領域として定義（READMEのみ追跡）",
  autoApply: true,
};

const SCAFFOLD_README = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "scaffold",
  "repo",
  "tmp",
  "README.md",
);

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(repoRoot) {
  // 1) .gitignore に tmp/ と !tmp/README.md を追記（既に両方あれば何もしない）
  const gitignorePath = path.join(repoRoot, ".gitignore");
  let text = (await exists(gitignorePath))
    ? await fs.readFile(gitignorePath, "utf8")
    : "";
  const lines = text.split("\n").map((l) => l.trim());
  const additions = [];
  if (!lines.includes("tmp/")) {
    additions.push(
      "",
      "# 作業領域。下書き（定例アジェンダ案・作業メモ等）はコミットしない。",
      "# 用途の説明として README だけは追跡する。",
      "tmp/",
    );
  }
  if (!lines.includes("!tmp/README.md")) additions.push("!tmp/README.md");
  if (additions.length) {
    if (text.length && !text.endsWith("\n")) text += "\n";
    await fs.writeFile(gitignorePath, text + additions.join("\n") + "\n", "utf8");
  }

  // 2) tmp/README.md が無ければ scaffold から配置（既にあれば案件側の記述を尊重して触らない）
  const readmePath = path.join(repoRoot, "tmp", "README.md");
  if (!(await exists(readmePath)) && (await exists(SCAFFOLD_README))) {
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
    await fs.copyFile(SCAFFOLD_README, readmePath);
  }
}
