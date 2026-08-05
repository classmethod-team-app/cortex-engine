#!/usr/bin/env node
/**
 * `FLEET_WORKFLOW_TOKEN` を案件リポの Actions secret として配る。
 *
 * 何のためのトークンか:
 *   `GITHUB_TOKEN` は `contents: write` を持っているのに `workflows` だけ持てない
 *   （ジョブの `permissions:` でも付与できないGitHubの仕様）。そのため
 *   `.github/workflows/` を触るマイグレーションだけ自動配布から漏れていた。
 *   漏れたぶんは人手適用のゲートで受けていたが、**そのゲートが動かず艦隊9案件が止まった**。
 *   ワークフローを push できるトークンを渡せば、この区別自体が要らなくなる。
 *
 * 必要な権限（fine-grained PAT）:
 *   - Repository access: 配布先の案件リポだけを選ぶ（All repositories にしない）
 *   - Repository permissions: **Contents: Read and write** ＋ **Workflows: Read and write**
 *   それ以外は付けない。dispatch も Issues も要らない。
 *
 * 使い方（トークンは引数に書かない。標準入力から渡す）:
 *   pbpaste | node scripts/put-fleet-workflow-token.mjs classmethod-internal/xxx-context ...
 *   node scripts/put-fleet-workflow-token.mjs --list classmethod-internal/xxx-context ...   # 確認だけ
 *
 * 前提: `gh` が使えること。`GH_TOKEN` に**配布先リポの Secrets を書ける**トークンが入っていること
 *      （配るトークン自身とは別物でよい。こちらは admin 相当が要る）。
 *
 * 値は表示しない・ログに出さない・リポジトリに保存しない。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SECRET = "FLEET_WORKFLOW_TOKEN";
const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const repos = argv.filter((a) => a !== "--list");

if (repos.length === 0) {
  console.error("使い方: pbpaste | node scripts/put-fleet-workflow-token.mjs <owner/repo>...");
  console.error("        node scripts/put-fleet-workflow-token.mjs --list <owner/repo>...");
  process.exit(1);
}

if (listOnly) {
  for (const repo of repos) {
    let has = "取得不可";
    try {
      const out = execFileSync("gh", ["api", `repos/${repo}/actions/secrets`, "--jq", "[.secrets[].name]"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      has = JSON.parse(out).includes(SECRET) ? "あり" : "なし";
    } catch {
      /* 権限不足・リポ不在は「取得不可」のまま */
    }
    console.log(`  ${repo}: ${has}`);
  }
  process.exit(0);
}

// **標準入力から読む。** 引数に置くとシェル履歴とプロセス一覧に残る
const token = readFileSync(0, "utf8").trim();
if (!token) {
  console.error("::error::トークンが標準入力から読めませんでした（例: pbpaste | node ...）");
  process.exit(1);
}
if (!/^github_pat_|^ghp_/.test(token)) {
  console.error("::error::PAT の形式に見えません。コピー範囲を確認してください（値は表示しません）");
  process.exit(1);
}

let failed = 0;
for (const repo of repos) {
  try {
    execFileSync("gh", ["secret", "set", SECRET, "--repo", repo, "--body", token], { stdio: "ignore" });
    console.log(`  ${repo}: 設定しました`);
  } catch (e) {
    failed++;
    // **例外メッセージを出さない**（トークンを引数に渡しているので、そのまま出すと値が漏れる）
    console.error(`::error::${repo}: 設定に失敗しました（権限とリポジトリ名を確認してください）`);
  }
}
process.exit(failed ? 1 : 0);
