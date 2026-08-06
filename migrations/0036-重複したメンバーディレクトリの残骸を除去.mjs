/**
 * `Cortex/Members/` と `Cortex/メンバー/` が両方ある案件から、空の `メンバー/` を取り除く。
 *
 * なぜ残るか（0002 と 0010 の噛み合わせ）:
 *   scaffold は現在 `Cortex/Members/`（英語＝0010 適用後の形）を同梱している。ところが
 *   新規リポは schema 0 から全マイグレーションを順に適用するため、
 *
 *     0002 … `Cortex/メンバー/` が無いので**新規作成する**
 *     0010 … メンバー→Members のリネームを試みるが**両方あるので警告してスキップ**
 *
 *   となり、空の `メンバー/` が残る。ビューアは `Cortex/` 直下のディレクトリをそのままタブにするので、
 *   **メンバータブが2つ並ぶ**（実際に発生）。
 *
 * 0002 側は英語名があれば作らないよう直したが、**既に残骸ができている案件は直らない**（マイグレーションは
 * 一度適用したら再実行されない）ので、こちらで掃除する。
 *
 * **中身があるものは消さない。** 0010 が「両方ある」で止まった状況には、
 * 「日本語名のまま運用していた案件に英語名が別途できた」という別の経路もありうる。
 * そちらは実データが `メンバー/records/` に入っているので、機械が消してよいものではない。
 * 記録が1件でもあれば警告だけ出して残す。
 */
import fs from "node:fs/promises";
import path from "node:path";

export const meta = {
  to: 36,
  description: "Cortex/メンバー/ と Cortex/Members/ の重複を解消（空の日本語名を除去）",
};

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** records/ 配下に .md が1件でもあるか（テンプレート・READMEは数えない） */
async function hasRecords(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && e.name.endsWith(".md"));
}

export async function run(repoRoot) {
  const cortex = path.join(repoRoot, "Cortex");
  const ja = path.join(cortex, "メンバー");
  const en = path.join(cortex, "Members");

  // 片方しか無ければ何もしない（正常な状態）
  if (!(await exists(ja)) || !(await exists(en))) return;

  if (await hasRecords(path.join(ja, "records"))) {
    process.stderr.write(
      "::warning::migration 0036: Cortex/メンバー/records に記録があるため削除しませんでした。" +
        "Cortex/Members/ と中身を突き合わせて手で統合してください。\n",
    );
    return;
  }

  await fs.rm(ja, { recursive: true, force: true });
}
