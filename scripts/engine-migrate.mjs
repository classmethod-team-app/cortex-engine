#!/usr/bin/env node
/**
 * エンジンマイグレーションのランナー
 *
 * 案件リポのルート（カレントディレクトリ）で実行する。
 *   - 現在の schema_version を Cortex/Home.md の frontmatter `engine.schema_version` から読む
 *     （未宣言なら 0 とみなす）
 *   - エンジンの migrations/ にある NNNN-*.mjs を番号順に読み、未適用（to > 現在値）を順に実行する
 *   - autoApply: true のものだけ実行する。autoApply: false に当たったら、そこで停止して
 *     警告を出す（人間のレビューを要する変更。手動適用が必要）
 *   - 各マイグレーション成功後、Home.md の schema_version を to に書き進める
 *
 * マイグレーションファイルの規約（migrations/README.md 参照）:
 *   export const meta = { to: <番号>, description: "...", autoApply: true|false };
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
      console.error(`::error::${file}: meta { to, description, autoApply } と run() が必要です`);
      process.exit(1);
    }
    if (meta.to <= version) continue; // 適用済み
    if (!meta.autoApply) {
      console.log(`::warning::${file}（${meta.description}）は autoApply: false（人間レビュー必須）のため停止します。手動で適用してください。`);
      break;
    }
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
