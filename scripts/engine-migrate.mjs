#!/usr/bin/env node
/**
 * エンジンマイグレーションのランナー
 *
 * 案件リポのルート（カレントディレクトリ）で実行する。
 *   - 現在の schema_version を Cortex/Home.md の frontmatter `engine.schema_version` から読む
 *     （未宣言なら 0 とみなす）
 *   - エンジンの migrations/ にある NNNN-*.mjs を番号順に読み、未適用（to > 現在値）を順に実行する
 *   - 未適用のものを**すべて**実行する（人手待ちのゲートは持たない。後述）
 *   - 各マイグレーション成功後、Home.md の schema_version を to に書き進める
 *
 * **かつて `autoApply: false`（人手適用）というゲートがあったが、外した。**
 * 建前は「人間のレビュー」だったが、34件中2件だけに付いていて、しかもどちらも
 * 「`.github/workflows/` を触るので GITHUB_TOKEN では push できない」という技術的理由だった。
 * レビューする人は現れず、代わりに艦隊9案件が3週間止まった（人手待ちの後ろに積まれた
 * マイグレーションを毎晩適用しては捨てるのを繰り返し、schema_version が進まないので
 * Gold昇格まで沈黙した）。**動かないゲートは安全装置ではない。**
 * いまはワークフローを push できるトークン（`FLEET_WORKFLOW_TOKEN`）を使うので、この区別が要らない。
 *
 * **想定外の例外は exit 1 で落とす**（中途半端に適用された状態を push させない）。
 *
 * マイグレーションファイルの規約（migrations/README.md 参照）:
 *   export const meta = { to: <番号>, description: "..." };
 *   export async function run(repoRoot) { ... }   // 冪等に書くこと
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = process.cwd();
const HOME_MD = path.join(REPO_ROOT, "Cortex", "Home.md");

async function readSchemaVersion() {
  try {
    const text = await fs.readFile(HOME_MD, "utf8");
    // frontmatter内の engine.schema_version を素朴に読む（YAML依存を避ける）
    const m = text.match(/^\s*schema_version:\s*(\d+)\s*(#.*)?$/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function writeSchemaVersion(version) {
  let text = await fs.readFile(HOME_MD, "utf8");
  if (/^\s*schema_version:\s*\d+/m.test(text)) {
    text = text.replace(/^(\s*schema_version:\s*)\d+/m, `$1${version}`);
  } else if (/^engine:\s*$/m.test(text)) {
    text = text.replace(/^(engine:\s*)$/m, `$1\n  schema_version: ${version} # データスキーマ版。マイグレーションが更新する（手編集しない）`);
  } else {
    // frontmatter末尾（--- の直前）に engine ブロックごと追記する
    text = text.replace(/\n---\n/, `\n# エンジン設定\nengine:\n  schema_version: ${version} # データスキーマ版。マイグレーションが更新する（手編集しない）\n---\n`);
  }
  await fs.writeFile(HOME_MD, text);
}

async function main() {
  const current = await readSchemaVersion();
  const dir = path.join(ENGINE_ROOT, "migrations");
  const files = (await fs.readdir(dir))
    .filter((f) => /^\d{4}-.*\.mjs$/.test(f))
    .sort();

  let applied = 0;
  let version = current;
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const meta = mod.meta;
    if (!meta || typeof meta.to !== "number" || typeof mod.run !== "function") {
      console.error(`::error::${file}: meta { to, description } と run() が必要です`);
      process.exit(1);
    }
    if (meta.to <= version) continue; // 適用済み
    console.log(`適用中: ${file} — ${meta.description}`);
    await mod.run(REPO_ROOT);
    version = meta.to;
    await writeSchemaVersion(version);
    applied++;
  }

  console.log(applied > 0
    ? `${applied} 件のマイグレーションを適用しました（schema_version: ${current} → ${version}）`
    : `未適用のマイグレーションはありません（schema_version: ${version}）`);

}

main().catch((err) => {
  console.error(`::error::マイグレーションに失敗しました: ${err.message}`);
  process.exit(1);
});
