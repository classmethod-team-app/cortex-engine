#!/usr/bin/env node
// 日次レポート通知（notify-daily）の親メッセージ本文とスレッド返信本文を組み立てる。
// update-gold の run 内 diff は使えないため、昨晩生成された日次レポート（daily.md）と
// その日の Decision レコードから本文を「再構成」する。案件リポのルート（cwd）で実行する。
//
// 入力（すべて env・任意）:
//   TARGET_DATE  対象日 YYYYMMDD。無ければ「前日のJST日付」を Date.now から算出（cronは9:00 JST=0:00 UTCに走る）。
//   PARENT_OUT   親本文の書き出し先パス（省略時 /tmp）。
//   THREAD_OUT   スレッド本文の書き出し先パス（省略時 /tmp）。
//   GITHUB_REPOSITORY  owner/repo（viewer_url 未設定時の GitHub リンク組み立て用。無ければ git remote から）。
//
// 出力契約:
//   - Cortex/レポート/records/{TARGET}-daily.md が無い／frontmatter status: skip → 標準出力に "skip" のみ・exit 0。
//   - それ以外 → PARENT_OUT / THREAD_OUT に完成した mrkdwn を書き出し、標準出力に "notify" のみ・exit 0。
//   - 例外時も落とさず "skip" を出す（呼び出しワークフローが best-effort で分岐に使う）。

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const pad2 = (n) => String(n).padStart(2, "0");

/** 対象日 YYYYMMDD。env 優先、無ければ前日JST（実行時刻の Date.now ベース）。 */
function targetDate() {
  const env = (process.env.TARGET_DATE || "").trim();
  if (/^\d{8}$/.test(env)) return env;
  // JST は UTC+9。cron は 0:00 UTC(=9:00 JST) 起動なので対象は前日。JST の壁時計から1日引く。
  const d = new Date(Date.now() + 9 * 3600e3 - 24 * 3600e3);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** owner/repo を env か git remote から取得（取れなければ ""）。 */
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : "";
  } catch { return ""; }
}

/** daily.md の frontmatter から status と sources.*_added を読む（YAML依存なしの最小パース）。 */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  const fm = { status: "", decisions: 0, terms: 0, members: 0 };
  if (!m) return fm;
  let inSources = false;
  for (const line of m[1].split("\n")) {
    if (/^status:/.test(line)) {
      fm.status = line.replace(/^status:\s*/, "").replace(/["']/g, "").trim();
      inSources = false;
      continue;
    }
    if (/^sources:\s*$/.test(line)) { inSources = true; continue; }
    if (inSources) {
      if (/^\s+\S/.test(line)) {
        const kv = line.match(/^\s+(\w+):\s*(\d+)/);
        if (kv) {
          if (kv[1] === "decisions_added") fm.decisions = Number(kv[2]);
          else if (kv[1] === "terms_added") fm.terms = Number(kv[2]);
          else if (kv[1] === "members_added") fm.members = Number(kv[2]);
        }
      } else {
        inSources = false;
      }
    }
  }
  return fm;
}

/** 本文の「## 今日の概要」セクション（空行除去・最大6行）。 */
function extractOverview(raw) {
  const lines = raw.split("\n");
  const start = lines.findIndex((l) => /^##\s*今日の概要/.test(l));
  if (start === -1) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    if (lines[i].trim() === "") continue;
    out.push(lines[i]);
    if (out.length >= 6) break;
  }
  return out.join("\n");
}

/** その日の Decision タイトルを最大3件（"・{title}\n" を連結。無ければ ""）。 */
function decisionTitles(target) {
  let files;
  try {
    files = readdirSync("Cortex/Decisions/records").filter((n) => n.startsWith(`${target}-`) && n.endsWith(".md"));
  } catch { return ""; }
  files.sort();
  let out = "";
  let count = 0;
  for (const f of files) {
    const raw = readText(`Cortex/Decisions/records/${f}`);
    if (!raw) continue;
    const m = raw.match(/^title:\s*(.+?)\s*$/m);
    if (!m) continue;
    const title = m[1].replace(/^["']|["']$/g, "").trim();
    if (!title) continue;
    out += `・${title}\n`;
    if (++count >= 3) break;
  }
  return out;
}

/** Home.md の viewer_url（未設定は ""）。 */
function viewerUrl() {
  const home = readText("Cortex/Home.md");
  if (!home) return "";
  const m = home.match(/^viewer_url:\s*["']?([^"'\n#]*?)["']?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : "";
}

function githubFileUrl(repo, path) {
  const enc = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/main/${enc}`;
}

function emitSkip() {
  process.stdout.write("skip\n");
  process.exit(0);
}

function main() {
  const target = targetDate();
  const reportPath = `Cortex/レポート/records/${target}-daily.md`;
  const raw = readText(reportPath);
  if (raw === null) return emitSkip(); // 対象レポート不在＝通知しない
  const fm = parseFrontmatter(raw);
  if (fm.status === "skip") return emitSkip(); // 動きの無かった日＝通知しない

  const overview = extractOverview(raw);
  const titles = decisionTitles(target);
  const vurl = viewerUrl();
  const repo = repoSlug();

  // リンク: 親=レポート個別ページ（viewer） or GitHubのdailyファイル / スレッド=Viewerトップ or CortexトップのGitHub
  let reportLink, topLink;
  if (vurl) {
    reportLink = `${vurl}/?id=report%3A${target}-daily`;
    topLink = vurl;
  } else if (repo) {
    reportLink = githubFileUrl(repo, reportPath);
    topLink = `https://github.com/${repo}/tree/main/Cortex`;
  } else {
    reportLink = "";
    topLink = "";
  }

  const md = `${Number(target.slice(4, 6))}/${Number(target.slice(6, 8))}`; // M/D（先頭ゼロなし・TARGET由来）

  const parent = reportLink
    ? `📅 本日の日報を作成しました（${md}） → <${reportLink}|レポートを見る>`
    : `📅 本日の日報を作成しました（${md}）`;

  const summary = `🌟 Gold昇格: Decision ${fm.decisions}件 / 用語 ${fm.terms}件(draft) / メンバー ${fm.members}件(draft)`;
  const reviewLine = topLink
    ? `draft のレビューをお願いします → <${topLink}|Cortexを開く>`
    : `draft のレビューをお願いします`;
  const thread = `${overview}\n\n${summary}\n${titles}${reviewLine}`;

  const parentOut = process.env.PARENT_OUT || "/tmp/cortex-daily-parent.txt";
  const threadOut = process.env.THREAD_OUT || "/tmp/cortex-daily-thread.txt";
  writeFileSync(parentOut, parent);
  writeFileSync(threadOut, thread);
  process.stdout.write("notify\n");
}

try {
  main();
} catch (e) {
  process.stderr.write(`::notice::compose-daily-notification: 例外のため通知をスキップします: ${e && e.message}\n`);
  emitSkip();
}
