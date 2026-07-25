/**
 * Gold層の既存レコードに、確認状態 `status`（`draft`=AI生成・人間未確認 / `active`=人間が確認済み）を補う。
 *
 * 背景: `status` は用語・メンバー・ルールだけが持ち、Decision には無かった（Decisionは追記型で、
 * 訂正は supersede という設計だったため）。しかし読み手（人もAIも）が「AIが自動抽出したものか、
 * 人が確認したものか」を見分けられないのは、"確定した判断材料の層"として弱い。Gold層の全レコード型で
 * `status` を揃える（規約は docs/ontology.md の「確認状態（status）」）。
 *
 * 判定は **Git 履歴** で行う。一括 draft にすると既存の数百件が未確認扱いになりレビュー疲れを起こし、
 * 一括 active にすると実態と食い違う。そのファイルを **追加したコミットの author** が
 * `github-actions[bot]`（夜間の自動精製ワークフロー）なら `draft`、人間なら `active` が最も正確。
 *
 * 触らないもの（推測で値を付けないためのガード）:
 *   - 既に `status` を持つレコード（用語・メンバー・ルールの大半）は一切触らない
 *   - Git 履歴から author を取得できないレコード（履歴に無い＝未コミットの新規ファイル等）は何もしない
 *   - **shallow clone では全レコードを触らない**。浅いクローンでは唯一のコミットが root 扱いになり、
 *     全ファイルが「そのコミットで追加された」ように見えるため、判定が丸ごと誤る
 *     （このマイグレーションのために engine-migrate.yml の checkout は fetch-depth: 0 にしてある）
 *   - frontmatter が無い・壊れているファイル
 *
 * 挿入位置は各型のテンプレートに合わせる（既存フィールドの並びを壊さない）。
 *
 * autoApply: true（欠けているフィールドの追記のみ・既存の値は書き換えない・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const meta = {
  to: 20,
  description:
    "Gold層の既存レコードに status を付与（Git履歴で判定: github-actions[bot]が追加=draft / 人間が追加=active。既にstatusがあるものとshallow cloneは不変）",
  autoApply: true,
};

// 対象ディレクトリと、status の挿入位置（この順で最初に見つかった単一行フィールドの直後に入れる。
// 見つからなければ frontmatter の末尾）。位置は各 template.md の並びに合わせている。
const TARGETS = [
  { dir: ["Cortex", "Decisions", "records"], after: ["description"] },
  { dir: ["Cortex", "Glossary", "records"], after: ["scope", "description"] },
  { dir: ["Cortex", "Rules", "records"], after: ["description"] },
  { dir: ["Cortex", "Members", "records"], after: [] }, // メンバーは frontmatter 末尾
];

// 夜間の自動精製ワークフローがコミットに使う identity（全ワークフロー共通）
const BOT_NAME = "github-actions[bot]";

// 生成物・雛形はレコードではない
const META_FILES = new Set(["README.md", "template.md"]);

function warn(message) {
  console.log(`::warning::migration 0020: ${message}`);
}

/** git を実行して stdout を返す（失敗したら null）。 */
function git(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** shallow clone か（判定不能なら null）。 */
function shallowState(repoRoot) {
  const out = git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  if (out === null) return null; // gitが無い・リポジトリではない
  return out.trim() === "true";
}

/**
 * そのファイルを追加したコミットの author が bot か（判定できなければ null）。
 * `git log --diff-filter=A` は新しい順に出るので、先頭＝現在の中身を作った追加コミット。
 */
function addedByBot(repoRoot, relPath) {
  const out = git(repoRoot, [
    "log",
    "--diff-filter=A",
    "--format=%an%x09%ae",
    "--",
    relPath,
  ]);
  if (out === null) return null;
  const line = out.split("\n").find((l) => l.trim() !== "");
  if (!line) return null; // 履歴に無い（未コミット等）＝判定不能
  const [name = "", email = ""] = line.split("\t");
  return name.trim() === BOT_NAME || email.includes("github-actions[bot]");
}

/** frontmatter（先頭の --- 〜 --- ）の行範囲を返す（無ければ null）。 */
function frontmatterRange(lines) {
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { from: 1, to: i }; // [from, to) が中身・to が閉じ行
  }
  return null;
}

/**
 * frontmatter に `status: <value>` を挿入したテキストを返す。
 * 既に status がある / frontmatter が無い場合は null（＝何もしない）。
 */
function insertStatus(text, value, afterKeys) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const range = frontmatterRange(lines);
  if (!range) return null;

  const fm = lines.slice(range.from, range.to);
  if (fm.some((l) => /^status\s*:/.test(l))) return null; // 既にある＝触らない

  // 挿入位置: 指定キーのうち「値が同じ行にある単一行フィールド」の直後。
  // ブロックスカラー（`key: |` / `key: >-`）やリスト（`key:` のみ）の直後に入れると壊すので避ける。
  let at = range.to; // 既定は frontmatter 末尾
  for (const key of afterKeys) {
    const idx = fm.findIndex((l) => {
      const m = l.match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
      if (!m) return false;
      const v = m[1].trim();
      return v !== "" && !/^[|>][+-]?$/.test(v);
    });
    if (idx !== -1) {
      at = range.from + idx + 1;
      break;
    }
  }

  lines.splice(at, 0, `status: ${value}`);
  return lines.join(newline);
}

export async function run(repoRoot) {
  const shallow = shallowState(repoRoot);
  if (shallow === null) {
    warn("Gitリポジトリとして読めないため status を付与しませんでした（判定にGit履歴が必要です）。");
    return;
  }
  if (shallow) {
    warn(
      "shallow clone のため status を付与しませんでした（浅い履歴では追加コミットのauthorを正しく判定できません）。" +
        "checkout を fetch-depth: 0 にして再実行してください。",
    );
    return;
  }

  let filled = 0;
  let unknown = 0;
  for (const target of TARGETS) {
    const dirAbs = path.join(repoRoot, ...target.dir);
    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => null);
    if (entries === null) continue; // その型を導入していない案件

    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md") || META_FILES.has(e.name)) continue;
      const relPath = [...target.dir, e.name].join("/");
      const absPath = path.join(dirAbs, e.name);

      const text = await fs.readFile(absPath, "utf8").catch(() => null);
      if (text === null) continue;
      if (!/^---\r?\n/.test(text)) continue; // frontmatter が無いファイルは対象外

      const bot = addedByBot(repoRoot, relPath);
      if (bot === null) {
        // 推測で付けない（Git履歴から追加コミットを特定できないファイル）
        unknown++;
        continue;
      }

      const updated = insertStatus(text, bot ? "draft" : "active", target.after);
      if (updated === null) continue; // 既に status がある・frontmatter が壊れている
      await fs.writeFile(absPath, updated);
      filled++;
    }
  }

  if (unknown > 0) {
    warn(
      `${unknown}件のレコードはGit履歴から追加コミットを特定できなかったため status を付けませんでした（推測で付けない方針）。`,
    );
  }
  if (filled > 0) {
    console.log(`migration 0020: ${filled}件のGold層レコードに status を付与しました。`);
  }
}
