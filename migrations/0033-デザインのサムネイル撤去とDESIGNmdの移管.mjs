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
 * このmigrationがやること（4つ）:
 *   1. 同期が作ったサムネイルディレクトリを消す
 *   2. inventory md から画像リンク行を消す（**1だけやるとリンク切れが777件残る**）
 *   3. DESIGN.md 冒頭の「sync-designs が自動生成する（手編集しない）」コメントを書き換える
 *   4. 案件スタブ `update-design-notes.yml` を消す（デザインMD自動育成の廃止）
 *
 * 4 について: エンジン側の reusable `update-design-notes.yml` は**まだ消していない**。
 * 案件スタブが `uses: ...@v1` で参照しているので、reusable を先に消すと参照先を失ったスタブが
 * 起動時エラーになる。**このmigrationで全案件から参照を消しきってから**、次のリリースで
 * reusable を削除する。順序を逆にすると9案件の夜間ワークフローが赤くなる。
 *
 * 保守則（0018 の型）: 消すのは**同期が作ったものだけ**。`figma.json` の files[].key と名前が一致し、
 * かつ中身が全て .png のサブディレクトリに限る。key に一致しない all-png ディレクトリ（人が
 * `resources/画面キャプチャ/` を作った等）は**警告して残す**。resources 直下のファイル
 * （.gitkeep・手置きPNG）には触らない。
 *
 * autoApply: true（対象が機械生成物だけであることを条件で担保・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 33,
  description:
    "デザインのサムネイル（resources/{fileKey}/）を撤去し、inventoryの画像リンクを外す。DESIGN.mdの自動生成コメントを書き換え、update-design-notesスタブを削除",
  autoApply: true,
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

/** figma.json の files[].key を集める（読めない・壊れていれば空集合＝何も消さない側に倒す）。 */
export async function readFigmaKeys(designDir) {
  const text = await fs.readFile(path.join(designDir, "figma.json"), "utf8").catch(() => null);
  if (text === null) return new Set();
  try {
    const conf = JSON.parse(text);
    return new Set((conf.files || []).map((f) => f && f.key).filter((k) => typeof k === "string" && k));
  } catch {
    return new Set();
  }
}

/**
 * 1. 同期が作ったサムネイルディレクトリを消す。
 *
 * 削除条件は2つのAND: **figma.json の key と名前が完全一致** かつ **中身が全て .png**。
 * 「中身が.pngだけ」だけを条件にすると、人が resources/画面キャプチャ/ を作って
 * PNGを置いただけで消える。守ろうとしている資産の型が、1階層深いだけですり抜ける。
 */
export async function removeSyncedThumbnails(designDir, keys) {
  const resDir = path.join(designDir, "resources");
  if (!(await exists(resDir))) return { removed: [], kept: [] };

  const entries = await fs.readdir(resDir, { withFileTypes: true }).catch(() => []);
  const removed = [];
  const kept = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue; // 直下のファイル（.gitkeep・手置きPNG）は触らない
    const sub = path.join(resDir, e.name);
    const files = await fs.readdir(sub, { withFileTypes: true }).catch(() => []);
    const allPng = files.length > 0 && files.every((f) => f.isFile() && f.name.endsWith(".png"));
    if (!allPng) continue; // 画像以外が混ざるものは同期の生成物ではない
    if (!keys.has(e.name)) {
      kept.push(e.name);
      warn(
        `${sub} は画像だけのディレクトリですが figma.json のファイルキーと一致しないため残しました（人が置いたものの可能性）。中身を確認してください。`,
      );
      continue;
    }
    await fs.rm(sub, { recursive: true, force: true });
    removed.push(e.name);
  }
  return { removed, kept };
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
      // 画像行と、それが作っていた前後の空行の重なりを畳む（本文の他の行は変えない）
      const after = before.replace(/\n!\[[^\]]*\]\([^)]*resources\/[^)]*\)\n/g, "\n");
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

/**
 * 4. 案件スタブ `update-design-notes.yml` を消す。
 *
 * デザインMD自動育成の廃止。**エンジン側の reusable を消すより先に、全案件から参照を消しきる**
 * ためのステップ（順序を逆にすると、参照先を失ったスタブが夜間に起動時エラーになる）。
 */
export async function removeDesignNotesStub(repoRoot) {
  const p = path.join(repoRoot, ".github", "workflows", "update-design-notes.yml");
  if (!(await exists(p))) return false;
  await fs.rm(p, { force: true });
  return true;
}

export async function run(repoRoot) {
  // スタブの削除はデザイン設定の有無と無関係（figma.json が無くてもスタブは配られている）
  if (await removeDesignNotesStub(repoRoot)) {
    console.log("migration 0033: update-design-notes.yml（デザインMD自動育成）のスタブを削除しました");
  }

  const designDir = await findDesignDir(repoRoot);
  if (designDir === null) return; // デザイン同期が未設定の案件（艦隊15中10案件）は以降を何もしない

  const keys = await readFigmaKeys(designDir);
  const { removed } = await removeSyncedThumbnails(designDir, keys);
  if (removed.length > 0) {
    console.log(`migration 0033: サムネイルディレクトリを撤去しました（${removed.join(", ")}）`);
  }

  const stripped = await stripInventoryImages(designDir);
  if (stripped.length > 0) {
    console.log(`migration 0033: inventory ${stripped.length}件から画像リンク行を外しました`);
  }

  if (await rewriteDesignMdComment(designDir)) {
    console.log("migration 0033: DESIGN.md の自動生成コメントを書き換えました");
  }
}
