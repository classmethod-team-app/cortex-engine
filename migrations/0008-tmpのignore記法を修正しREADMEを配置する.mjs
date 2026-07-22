/**
 * `tmp/` の ignore 記法を `tmp/*` に修正し、`tmp/README.md` を配置する。
 *
 * migration 0007 は `.gitignore` に `tmp/` と `!tmp/README.md` を書いたが、git の仕様上
 * **ディレクトリごと除外（`tmp/`）すると配下の再包含（`!tmp/README.md`）が効かない**ため、
 * README が追跡されず配置もコミットされなかった。`tmp/*`（中身を除外）に直すと再包含が効く。
 *
 * - `.gitignore` の `tmp/` 行（完全一致）を `tmp/*` に置換する。既に `tmp/*` なら触らない
 * - `!tmp/README.md` が無ければ追加する
 * - `tmp/README.md` が無ければ scaffold から配置する（案件独自の README は尊重して上書きしない）
 * - 2回実行しても壊れない（冪等）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 8,
  description: "tmpのignore記法をtmp/*に修正しREADMEを配置",
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
  // 1) .gitignore: `tmp/` を `tmp/*` へ。`!tmp/README.md` が無ければ足す
  const gitignorePath = path.join(repoRoot, ".gitignore");
  if (await exists(gitignorePath)) {
    let text = await fs.readFile(gitignorePath, "utf8");
    const fixed = text
      .split("\n")
      .map((line) => (line.trim() === "tmp/" ? line.replace("tmp/", "tmp/*") : line))
      .join("\n");
    let out = fixed;
    if (!fixed.split("\n").map((l) => l.trim()).includes("!tmp/README.md")) {
      if (out.length && !out.endsWith("\n")) out += "\n";
      out += "!tmp/README.md\n";
    }
    if (out !== text) await fs.writeFile(gitignorePath, out, "utf8");
  }

  // 2) tmp/README.md が無ければ scaffold から配置（あれば案件側を尊重）
  const readmePath = path.join(repoRoot, "tmp", "README.md");
  if (!(await exists(readmePath)) && (await exists(SCAFFOLD_README))) {
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
    await fs.copyFile(SCAFFOLD_README, readmePath);
  }
}
