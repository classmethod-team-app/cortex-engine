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
 * **人手待ちで止まったときも exit 0 で返す。** 赤くするのは呼び出し側（ワークフロー）の最後の
 * ステップに任せ、`paused` を GITHUB_OUTPUT で渡す。ここで exit 1 にすると、後続の
 * commit/push ステップが暗黙の success() で skip され、**それまでに適用したぶんが丸ごと捨てられる**。
 * 実際それで艦隊9案件が3週間止まった（0031 が人手待ちの後ろに 0032・0033 が積まれ、毎晩
 * 適用しては捨てるのを繰り返していた。schema_version も進まないので Gold昇格まで沈黙した）。
 *
 * 一方、**想定外の例外は従来どおり exit 1 で落とす**（中途半端に適用された状態を push させない）。
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
  let paused = null; // autoApply:false（人間レビュー必須）で停止したマイグレーション
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    const meta = mod.meta;
    if (!meta || typeof meta.to !== "number" || typeof mod.run !== "function") {
      console.error(`::error::${file}: meta { to, description, autoApply } と run() が必要です`);
      process.exit(1);
    }
    if (meta.to <= version) continue; // 適用済み
    if (!meta.autoApply) {
      paused = { file, description: meta.description, to: meta.to };
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

  // autoApply:false で停止したことは呼び出し側に伝える。**ここでは exit 1 にしない。**
  // 赤くするのはワークフロー側の最後のステップの仕事（commit/push を skip させないため）。
  if (paused) {
    console.error(
      `::error::${paused.file}（${paused.description}）は autoApply: false（人間レビュー必須）です。` +
        `自動適用せず停止しました。内容を確認して手動で適用し、schema_version を進めてください` +
        `（node scripts/apply-migration-manually.mjs ${paused.to} --push <owner/repo>...）。` +
        `この実行は、停止に気づけるよう意図的に失敗（赤）にしています（コードのバグではありません）。`,
    );
    await setOutput("paused", "true");
    await setOutput("paused_migration", paused.file);
  }
}

/** GitHub Actions のステップ出力に書く（ローカル実行では GITHUB_OUTPUT が無いので何もしない）。 */
async function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  await fs.appendFile(f, `${name}=${value}\n`);
}

main().catch((err) => {
  console.error(`::error::マイグレーションに失敗しました: ${err.message}`);
  process.exit(1);
});
