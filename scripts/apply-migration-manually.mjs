#!/usr/bin/env node
/**
 * マイグレーションを案件リポへ**手で**適用する。
 *
 * なぜ手なのか:
 *   `.github/workflows/` 配下を書き換えるマイグレーションは、夜間の engine-migrate から
 *   push できない。GITHUB_TOKEN にはワークフローを作成・更新する権限（`workflows`）が無く、
 *   これはジョブの `permissions:` でも付与できないため。
 *   0027（スタブのsecretsを明示渡しにする回）が実際にこれで弾かれ、人手で push している。
 *
 *   そのままだと engine-migrate が毎晩 push で失敗し、しかも schema_version が前進しないので、
 *   それをゲートにしている Gold昇格・議事録生成まで静かに止まる。よってこの種のマイグレーションは
 *   `autoApply: false` にし、**エンジンを配る前に**この道具で先に配る。
 *
 * 使い方:
 *   # 何が変わるかを見る（push しない）
 *   node scripts/apply-migration-manually.mjs 31 classmethod-internal/kc-context ...
 *   # 実際に適用して push する
 *   node scripts/apply-migration-manually.mjs 31 --push classmethod-internal/kc-context ...
 *
 * 前提:
 *   `gh` が使えること。**ワークフローを push できるトークン**（fine-grained PAT なら
 *   Workflows: Read and write）が `GH_TOKEN` に入っていること。無いと push が
 *   `refusing to allow ... without workflows permission` で弾かれる。
 *
 * 何をするか（1リポにつき）:
 *   1. 一時ディレクトリへ clone（浅く）
 *   2. 該当マイグレーションの run() を実行
 *   3. Cortex/Home.md の schema_version を meta.to に上げる
 *      （**ここまで一緒にやらないと**、次の engine-migrate が同じマイグレーションで止まる）
 *   4. 差分があれば commit → push
 */
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(HERE, "..", "migrations");

const argv = process.argv.slice(2);
const push = argv.includes("--push");
const rest = argv.filter((a) => a !== "--push");
const version = Number(rest[0]);
const repos = rest.slice(1);

if (!Number.isInteger(version) || repos.length === 0) {
  console.error("使い方: node scripts/apply-migration-manually.mjs <版番号> [--push] <owner/repo>...");
  process.exit(1);
}

const files = (await fs.readdir(MIGRATIONS)).filter((f) => f.endsWith(".mjs"));
const file = files.find((f) => Number(f.slice(0, 4)) === version);
if (!file) {
  console.error(`::error::版 ${version} のマイグレーションが見つかりません`);
  process.exit(1);
}
const mod = await import(pathToFileURL(path.join(MIGRATIONS, file)).href);

const run = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let failed = 0;
for (const repo of repos) {
  const dir = mkdtempSync(path.join(tmpdir(), "cortex-migrate-"));
  try {
    // gh の認証を git に流用する（トークンをコマンドラインに書かない）
    execFileSync("gh", ["repo", "clone", repo, dir, "--", "--depth", "1"], { stdio: "ignore" });

    await mod.run(dir);
    await bumpSchemaVersion(dir, mod.meta.to);

    const diff = run(dir, "status", "--porcelain");
    if (!diff.trim()) {
      console.log(`${repo}: 変更なし（適用済み）`);
      continue;
    }
    console.log(`\n=== ${repo} ===`);
    console.log(run(dir, "diff", "--stat"));

    if (push) {
      run(dir, "add", "-A");
      run(dir, "-c", "user.name=cortex-engine", "-c", "user.email=cortex@classmethod.jp",
          "commit", "-m", `スタブに ${mod.meta.description}`);
      run(dir, "push");
      console.log(`${repo}: push しました`);
    } else {
      console.log(`${repo}: （--push を付けると適用します）`);
    }
  } catch (e) {
    failed++;
    console.error(`::error::${repo}: ${e.message.split("\n").slice(0, 3).join(" / ")}`);
  }
}
process.exit(failed ? 1 : 0);

/**
 * Cortex/Home.md の frontmatter にある schema_version を上げる。
 * **engine-migrate.mjs の writeSchemaVersion と同じ書き方にすること。**
 * 実物の行は `  schema_version: 30 # データスキーマ版。…` と行内コメントが付くので、
 * 行末までを対象にすると一致しない（そのまま気づかず版が据え置かれる）。
 */
async function bumpSchemaVersion(repoRoot, to) {
  const p = path.join(repoRoot, "Cortex", "Home.md");
  const text = await fs.readFile(p, "utf8").catch(() => null);
  if (text === null) return; // Home.md を持たないリポは触らない
  const re = /^(\s*schema_version:\s*)\d+/m;
  if (!re.test(text)) {
    console.log("::warning::schema_version が Home.md に見つかりません（手で確認してください）");
    return;
  }
  await fs.writeFile(p, text.replace(re, `$1${to}`));
}
