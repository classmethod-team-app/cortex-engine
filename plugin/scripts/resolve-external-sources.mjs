#!/usr/bin/env node
// 夜間Gold昇格(update-gold)が読み取る「外部ソース」の解決を一元化する。
// 既定ソースは既存の宣言（チャット/channels.json・.gitmodules）から自動導出し、
// Cortex/external-sources.json の明示登録をマージ・重複排除・除外して、
// 正規化済みリスト [{type, ref, name, ...options}] を標準出力にJSONで出す。
// fetcher（external-sources.sh）はこの出力を回すだけになる。
//
// 入力: cwd（リポジトリルート）。読むもの:
//   - Cortex/Home.md           の frontmatter tools（チャット/開発 のゲート判定）
//   - チャット/channels.json    （既定 slack チャンネルの導出元。gold:false は除外）
//   - .gitmodules              （既定 github-issues の導出元。開発/配下のsubmoduleのみ・開発/wiki除外）
//   - Cortex/external-sources.json（特殊ソースの明示登録＋exclude）
// いずれも無ければその導出/マージをスキップする（1件も無ければ空配列）。
//
// 公開範囲の防衛線（重要・変えないこと）:
//   - 開発リポの導出対象は path が「開発/」配下のsubmoduleに限定する。開発/外のsubmoduleは
//     内部情報用privateリポの可能性があるため絶対に導出対象にしない。開発/wiki も除外。
//   - 除外（gold:false チャンネル・exclude リポ）は最終フィルタとして常に効かせる（読まない側に倒す）。
//
// 設計メモ:
//   - tools ゲート: チャット:slack でなければ slack を導出しない・開発:github でなければ github を導出しない。
//   - 導出できない項目（URL解釈不能・非github submodule等）は stderr に ::warning:: を出してその項目だけスキップし、
//     全体は落とさない（external-sources.sh の「1ソース失敗は他を止めない」思想と同じ）。
//   - dedupe は type+ref 単位。明示登録を優先し、そのオプション（decisions 等）を保持する。

import fs from "node:fs";

const warn = (msg) => process.stderr.write(`::warning::resolve-external-sources: ${msg}\n`);

function readFileOr(path) {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readJsonOr(path) {
  const raw = readFileOr(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    warn(`${path} のJSON解析に失敗しました。無視します。`);
    return null;
  }
}

// Home.md frontmatter の tools ブロックから チャット/開発 等の値を読む（YAML依存なしの最小パース）。
function readTools(homePath) {
  const raw = readFileOr(homePath);
  if (raw === null) return {};
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  // frontmatter（先頭 --- 〜 次の ---）を切り出す
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  const fm = end === -1 ? lines.slice(1) : lines.slice(1, end);
  const tools = {};
  let inTools = false;
  let toolsIndent = 0;
  for (const line of fm) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inTools) {
      if (/^tools:\s*$/.test(line.trim()) || /^tools:\s*(#.*)?$/.test(line)) {
        inTools = true;
        toolsIndent = indent;
      }
      continue;
    }
    // tools ブロックはネスト（toolsIndentより深い）。同階層以下に戻ったら終了。
    if (indent <= toolsIndent) break;
    const m = line.match(/^\s*([^:#]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    // インラインコメント除去 → クォート除去
    let val = m[2].split("#")[0].trim().replace(/^["']|["']$/g, "");
    tools[key] = val;
  }
  return tools;
}

// channels.json の slack チャンネルを {ref(ID), name, gold} に正規化。platform 省略時は slack。
function deriveSlackChannels() {
  const data = readJsonOr("チャット/channels.json");
  if (!data) return [];
  const out = [];
  for (const c of data.channels || []) {
    const platform = (c.platform || "slack").toLowerCase();
    if (platform !== "slack") continue; // teams 等は slack ソースとして導出しない
    const url = c.url || "";
    const m = url.match(/\/archives\/([A-Z0-9]+)/);
    if (!m) {
      const label = c.name || url || "?";
      warn(`チャンネル '${label}' の url からIDを抽出できません。スキップします。`);
      continue;
    }
    out.push({ ref: m[1], name: c.name || m[1], gold: c.gold !== false });
  }
  return out;
}

// git@github.com:owner/repo(.git) / https://github.com/owner/repo(.git) → owner/repo。github以外はnull。
function normalizeGithubRepo(url) {
  if (!url) return null;
  let s = url.trim().replace(/\.git$/, "");
  let m = s.match(/^git@github\.com:(.+)$/);
  if (m) return m[1];
  m = s.match(/^(?:https?:\/\/|ssh:\/\/git@)github\.com\/(.+)$/);
  if (m) return m[1];
  return null;
}

// .gitmodules から 開発/配下（開発/wiki除外）のsubmoduleを github-issues として導出。
function deriveGithubRepos() {
  const raw = readFileOr(".gitmodules");
  if (raw === null) return [];
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const path = cur.path || "";
    // 公開範囲の防衛線: 開発/配下のみ。開発/wiki は除外。開発/外は絶対に導出しない。
    const underDev = path === "開発" || path.startsWith("開発/");
    const isWiki = path === "開発/wiki" || path.startsWith("開発/wiki/");
    if (underDev && !isWiki) {
      const repo = normalizeGithubRepo(cur.url || "");
      if (!repo) {
        warn(`submodule '${path}' の url (${cur.url || ""}) をGitHubリポとして解釈できません。導出をスキップします。`);
      } else {
        out.push({ ref: repo, name: repo });
      }
    }
    cur = null;
  };
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[submodule /.test(t)) {
      flush();
      cur = {};
      continue;
    }
    if (!cur) continue;
    let m = t.match(/^path\s*=\s*(.+)$/);
    if (m) {
      cur.path = m[1].trim();
      continue;
    }
    m = t.match(/^url\s*=\s*(.+)$/);
    if (m) {
      cur.url = m[1].trim();
      continue;
    }
  }
  flush();
  return out;
}

function main() {
  const tools = readTools("Cortex/Home.md");
  const derived = [];

  // ゲート: チャット:slack のときだけ slack を導出
  if ((tools["チャット"] || "").toLowerCase() === "slack") {
    for (const ch of deriveSlackChannels()) {
      derived.push({ type: "slack", ref: ch.ref, name: ch.name, gold: ch.gold });
    }
  }
  // ゲート: 開発:github のときだけ github-issues を導出
  if ((tools["開発"] || "").toLowerCase() === "github") {
    for (const r of deriveGithubRepos()) {
      derived.push({ type: "github-issues", ref: r.ref, name: r.name });
    }
  }

  // 明示登録（external-sources.json）
  const cfg = readJsonOr("Cortex/external-sources.json") || {};
  const explicit = [];
  for (const s of cfg.sources || []) {
    const type = s.type || "";
    const ref = s.repo || s.channel || "";
    if (!type || !ref) continue;
    const item = { type, ref, name: s.name || ref };
    if (s.decisions !== undefined) item.decisions = s.decisions;
    explicit.push(item);
  }
  const excludeRepos = new Set((cfg.exclude || []).map((r) => String(r)));

  // gold:false チャンネルID集合（最終フィルタで常に除外）
  const goldFalseChannels = new Set(
    derived.filter((d) => d.type === "slack" && d.gold === false).map((d) => d.ref),
  );

  // マージ＋dedupe（type+ref単位・明示登録優先）。まず導出→上書きで明示を反映。
  const byKey = new Map();
  const keyOf = (s) => `${s.type}\t${s.ref}`;
  for (const d of derived) {
    // gold フラグは内部判定用なので出力には残さない
    byKey.set(keyOf(d), { type: d.type, ref: d.ref, name: d.name });
  }
  for (const e of explicit) {
    byKey.set(keyOf(e), e); // 明示登録がオプションごと優先
  }

  // 最終フィルタ（opt-out は常に効かせる＝読まない側に倒す）
  const result = [];
  for (const s of byKey.values()) {
    if (s.type === "slack" && goldFalseChannels.has(s.ref)) continue;
    if (s.type.startsWith("github") && excludeRepos.has(s.ref)) continue;
    result.push(s);
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
