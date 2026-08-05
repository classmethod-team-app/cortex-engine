/**
 * デザイン同期がサムネイルを取るのをやめ、DESIGN.md からも手を引いたことの後始末。
 *
 * 何が起きていたか:
 *   `sync-designs` は画面ごとのサムネイルPNGを `デザイン/resources/{fileKey}/` に保存していた。
 *   ところが同期が全消し再生成するのは `inventory/` だけで、**resources は一度も掃除されない**。
 *   結果、5案件に **808件・162.5MB** が積み上がった（削除・改名された画面のPNGも残ったまま）。
 *
 *   インベントリの目的は地図であって絵ではない。画面の中身を見たいときは Figma MCP で当該フレームを
 *   直接開けばよく、閲覧権限の境界も Figma 側にある。
 *
 *   あわせて DESIGN.md のフロントマター（デザイントークン）の自動生成も撤去した。DESIGN.md は
 *   デザインハーネスの `design-md` が lint を通して仕上げる成果物で、それが毎晩機械で差し替わる
 *   ——1ファイルに所有者が2人いる状態——を解消するため。
 *
 * このmigrationがやること（3つ）:
 *   1. `resources/` をディレクトリごと消す
 *   2. inventory md から画像リンク行を消す（**1だけやるとリンク切れが777件残る**）
 *   3. DESIGN.md 冒頭の「sync-designs が自動生成する（手編集しない）」コメントを書き換える
 *
 * 案件スタブ `update-design-notes.yml` の削除は**ここではやらない**（0034 に分けた）。
 * 当時 `.github/workflows/` 配下は GITHUB_TOKEN で push できず、人手適用のゲートが要った。
 * ここを一緒にすると、162MBの回収まで人手待ちで止まってしまうため分けた。
 * （0035 以降はワークフロー用トークンを使うので、この分割は不要になっている）
 *
 * **`resources/` は箱ごと消す**（当初は「人がスクリーンショットを置く場所として残す」設計だった）。
 * 残しても同期する者がいないので、置かれたものは更新されないまま古くなり続ける。しかも
 * 「置いてよい場所」として残すと、正本（Figma・Drive）ではなくミラーに絵が溜まっていく——
 * CLAUDE.md の「内容を正本に残したいときは、ファイルを置くのではなく正本側へ書く」に反する。
 * 削除しても git 履歴からは消えないので、必要になれば掘り出せる。
 *
 * 冪等（冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 33,
  description:
    "デザインのサムネイル（resources/{fileKey}/）を撤去し、inventoryの画像リンクを外す。DESIGN.mdの自動生成コメントも書き換える",
};

const SKIP_DIRS = new Set([".git", "node_modules", ".cortex-engine", "tmp"]);

/**
 * DESIGN.md 冒頭にあったコメントの置換表（scaffold の DESIGN.md と同じ文言に揃える）。
 *
 * 1行目は sync_designs.py が生成していたもの（末尾の「。」の有無が案件で揺れる。生成版は「。」なし、
 * scaffold 由来は「。」あり）。**部分一致で置換する**ので両方に効く。
 * 2行目は scaffold 由来の案件だけが持つ（生成版はフロントマターを組み立て直すので付かない）。
 * 「Figma未使用の案件では」はもう条件になっていない——Cortexが上書きしなくなったので、
 * Figmaを使っていても記入が無ければ既定が使われる。
 */
const COMMENT_REWRITES = [
  [
    "# このフロントマター（デザイントークン）は sync-designs が Figma から自動生成する（手編集しない）",
    "# このファイルは案件のデザイン規約。デザインハーネスの design-md スキルで育てる（Cortexは同期しない）",
  ],
  [
    "# Figma未使用の案件では、この既定（Cortexニュートラル / Liquid Glass）がそのまま使われる。",
    "# 記入がなければ、この既定（Cortexニュートラル / Liquid Glass）がそのまま使われる。",
  ],
];

function warn(message) {
  console.log(`::warning::migration 0033: ${message}`);
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * figma.json のあるディレクトリを探す（root直下＋1階層）。
 * **`デザイン/` 決め打ちにしない。** `Figma/` にリネームしている案件が実在する（2案件）。
 */
export async function findDesignDir(root) {
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
  return walk(root, 1);
}

/**
 * 1. `resources/` をディレクトリごと消す。
 *
 * 同期が作ったサムネイルだけを選り分けて消す案もあったが、**箱ごと消す**。残すと、同期する者が
 * いないディレクトリに人が絵を置き、それが更新されないまま古くなり続けるため。絵の正本は
 * Figma（実機キャプチャ等は Drive）にあり、ミラーに置く理由がない。
 *
 * 中身が何であれ消すので、**何を消したかは必ず記録に残す**（git 履歴から掘り出せるようにする）。
 */
export async function removeResourcesDir(designDir) {
  const resDir = path.join(designDir, "resources");
  if (!(await exists(resDir))) return null;

  // 何を消したかを残す（.gitkeep 以外の実ファイルだけ数える）
  const removed = [];
  async function collect(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await collect(p);
      else if (e.name !== ".gitkeep") removed.push(path.relative(resDir, p));
    }
  }
  await collect(resDir);

  await fs.rm(resDir, { recursive: true, force: true });
  return removed;
}

/**
 * resources を指す画像行を落とす。
 *
 * **行単位で判定する。** alt テキストは Figma のフレーム名がエスケープなしで埋め込まれており
 * （旧実装: `f"\n![{frame_name}]({rel})\n"`）、フレーム名は自由入力なので `]` を含みうる。
 * `!\[[^\]]*\]` のような「`]` を含まない」前提の式は、`![A[異常]](...)` でマッチせず取りこぼす。
 *
 * 画像行の前後にあった空行が二重にならないよう、直前の空行を1つ畳む。
 */
export function dropImageLines(text) {
  const IMAGE_LINE = /^!\[.*\]\(.*resources\/.*\)\s*$/;
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!IMAGE_LINE.test(lines[i])) {
      out.push(lines[i]);
      continue;
    }
    // 「空行・画像行・空行」だった箇所が空行2つにならないように、直前の空行を1つ落とす
    if (out.length > 0 && out[out.length - 1] === "" && lines[i + 1] === "") out.pop();
  }
  return out.join("\n");
}

/**
 * 2. inventory md から画像リンク行を消す。
 *
 * **1だけやるとリンク切れが残る。** 現在の inventory md は
 * `![画面名](../../resources/{key}/{node}.png)` を持っており、5案件で777件ある。
 * 次に sync-designs が成功すれば全再生成で直るが、**同じコミットの中で自己整合させる**のが正しい
 * （壊れた状態を作って、別の仕組みの成功を当てにしない）。顧客が生で見るリポジトリでもある。
 */
export async function stripInventoryImages(designDir) {
  const invDir = path.join(designDir, "inventory");
  if (!(await exists(invDir))) return [];

  const changed = [];
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.name.endsWith(".md")) continue;
      const before = await fs.readFile(p, "utf8").catch(() => null);
      if (before === null) continue;
      const after = dropImageLines(before);
      if (after !== before) {
        await fs.writeFile(p, after, "utf8");
        changed.push(path.relative(invDir, p));
      }
    }
  }
  await walk(invDir);
  return changed;
}

/**
 * 3. DESIGN.md 冒頭の自動生成コメントを書き換える。
 *
 * 放置すると「sync-designs が自動生成する（**手編集しない**）」が残り、DESIGN.md を人・ハーネスが
 * 育てるという本件の目的を正面から否定する。**完全一致のときだけ**置換する（案件が書き換えていたら触らない）。
 */
export async function rewriteDesignMdComment(designDir) {
  const p = path.join(designDir, "DESIGN.md");
  const before = await fs.readFile(p, "utf8").catch(() => null);
  if (before === null) return false;
  let after = before;
  for (const [old, next] of COMMENT_REWRITES) {
    if (after.includes(old)) after = after.replace(old, next);
  }
  if (after === before) return false;
  await fs.writeFile(p, after, "utf8");
  return true;
}

export async function run(repoRoot) {
  const designDir = await findDesignDir(repoRoot);
  if (designDir === null) return; // デザイン同期が未設定の案件（艦隊15中10案件）は以降を何もしない

  const removed = await removeResourcesDir(designDir);
  if (removed !== null) {
    console.log(`migration 0033: ${designDir}/resources/ をディレクトリごと撤去しました（${removed.length}ファイル）`);
    // サムネイル以外が入っていたら名指しで残す（git履歴から掘り出す手がかりになる）
    const nonThumb = removed.filter((p) => !p.includes(path.sep) || !p.endsWith(".png"));
    if (nonThumb.length > 0) {
      warn(`サムネイル以外も含まれていました: ${nonThumb.join(", ")}（git履歴から復元できます）`);
    }
  }

  const stripped = await stripInventoryImages(designDir);
  if (stripped.length > 0) {
    console.log(`migration 0033: inventory ${stripped.length}件から画像リンク行を外しました`);
  }

  if (await rewriteDesignMdComment(designDir)) {
    console.log("migration 0033: DESIGN.md の自動生成コメントを書き換えました");
  }
}
