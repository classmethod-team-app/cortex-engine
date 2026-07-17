#!/usr/bin/env node
// 夜間Gold昇格(update-gold)が読み取る「外部ソース」の解決を一元化する。
// 既定ソースは既存の宣言（チャット/channels.json・.gitmodules）から自動導出し、
// Cortex/external-sources.json の明示登録をマージ・重複排除・除外して、
// 正規化済みリスト [{type, ref, name, ...options}] を標準出力にJSONで出す。
// fetcher（external-sources.sh）はこの出力を回すだけになる。
//
// --all フラグ: 除外済み（gold:false チャンネル・exclude リポ）も落とさず、gold:true/false と
// notify・url（slackのみ・channels.json由来）の注釈付きで全登録を出す。fleet-status の接続状況可視化用。
// 既定動作（フィルタ済み＝update-gold の取得対象）には影響しない。
//
// 入力: cwd（リポジトリルート）。読むもの:
//   - Cortex/Home.md           の frontmatter tools（チャット/開発 のゲート判定）と
//                              engine.dev_dir（開発submoduleの置き場の宣言。省略時は「開発」）
//   - チャット/channels.json    （既定 slack チャンネルの導出元。gold:false は除外）
//   - .gitmodules              （既定 github-issues の導出元。dev_dir 配下のsubmoduleのみ・wiki除外）
//   - Cortex/external-sources.json（特殊ソースの明示登録＋exclude）
// いずれも無ければその導出/マージをスキップする（1件も無ければ空配列）。
//
// 公開範囲の防衛線（重要・変えないこと）:
//   - 開発リポの導出対象は path が dev_dir（既定: 開発/）配下のsubmoduleに限定する。dev_dir 配下以外の
//     submoduleは内部情報用privateリポの可能性があるため絶対に導出対象にしない。
//     wiki（path末尾が /wiki・リポ名が .wiki で終わるもの）も除外する。
//   - dev_dir に危険値（`/`始まり・`.`始まり・`..`セグメント等）が宣言されていたら無効として warn し、
//     既定の「開発」にフォールバックする（宣言ミスで防衛線が広がらないようにする）。
//   - 除外（gold:false チャンネル・exclude リポ）は最終フィルタとして常に効かせる（読まない側に倒す）。
//
// 設計メモ:
//   - tools ゲート: チャット:slack でなければ slack を導出しない・開発:github でなければ github を導出しない。
//   - 導出できない項目（URL解釈不能・非github submodule等）は stderr に ::warning:: を出してその項目だけスキップし、
//     全体は落とさない（external-sources.sh の「1ソース失敗は他を止めない」思想と同じ）。
//   - dedupe は type+ref 単位。明示登録を優先し、そのオプション（decisions 等）を保持する。

import fs from "node:fs";

const DEFAULT_DEV_DIR = "開発";

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

// Home.md frontmatter から指定マップブロック（tools / engine 等）の key:value を読む（YAML依存なしの最小パース）。
function readFrontmatterMap(raw, blockName) {
  const map = {};
  if (raw === null) return map;
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return map;
  // frontmatter（先頭 --- 〜 次の ---）を切り出す
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  const fm = end === -1 ? lines.slice(1) : lines.slice(1, end);
  let inBlock = false;
  let blockIndent = 0;
  const blockRe = new RegExp(`^${blockName}:\\s*(#.*)?$`);
  for (const line of fm) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (indent === 0 && blockRe.test(line)) {
        inBlock = true;
        blockIndent = indent;
      }
      continue;
    }
    // ブロックはネスト（blockIndentより深い）。同階層以下に戻ったら終了。
    if (indent <= blockIndent) break;
    const m = line.match(/^\s*([^:#]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    // インラインコメント除去 → クォート除去
    let val = m[2].split("#")[0].trim().replace(/^["']|["']$/g, "");
    map[key] = val;
  }
  return map;
}

// engine.dev_dir を検証して開発submodule置き場を決める。危険値・不正値は warn して既定にフォールバック。
// 防衛線: 宣言ミス（絶対パス・上方参照等）で導出範囲が広がることを防ぐ（読まない側に倒す）。
function resolveDevDir(engine) {
  const declared = (engine.dev_dir || "").trim();
  if (!declared) return DEFAULT_DEV_DIR;
  // 末尾スラッシュだけは正規化として許容
  const v = declared.replace(/\/+$/, "");
  const segments = v.split("/");
  const dangerous =
    v === "" ||
    v.startsWith("/") ||
    v.startsWith(".") ||
    v.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (dangerous) {
    warn(`engine.dev_dir '${declared}' は無効な値のため無視し、既定の「${DEFAULT_DEV_DIR}」を使います。`);
    return DEFAULT_DEV_DIR;
  }
  return v;
}

// channels.json の slack チャンネルを {ref(ID), name, gold, notify, url} に正規化。platform 省略時は slack。
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
    out.push({ ref: m[1], name: c.name || m[1], gold: c.gold !== false, notify: c.notify === true, url });
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

// .gitmodules から dev_dir 配下（wiki除外）のsubmoduleを github-issues として導出。
function deriveGithubRepos(devDir) {
  const raw = readFileOr(".gitmodules");
  if (raw === null) return [];
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const path = cur.path || "";
    // 公開範囲の防衛線: dev_dir 配下のみ。dev_dir 外は絶対に導出しない。
    const underDev = path === devDir || path.startsWith(`${devDir}/`);
    // wiki 除外: path 末尾が /wiki のもの（配下含む）
    const isWikiPath = path === `${devDir}/wiki` || path.endsWith("/wiki") || path.includes("/wiki/");
    if (underDev && !isWikiPath) {
      const repo = normalizeGithubRepo(cur.url || "");
      if (!repo) {
        warn(`submodule '${path}' の url (${cur.url || ""}) をGitHubリポとして解釈できません。導出をスキップします。`);
      } else if (repo.endsWith(".wiki")) {
        // wiki 除外: リポ名が .wiki で終わるもの（pathがwiki風でなくても除外）
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
  // --all: 除外（gold:false チャンネル・exclude リポ）も落とさず、gold/notify の注釈付きで全登録を出す。
  // fleet-status（接続状況の可視化）用。既定動作（フィルタ済みリスト＝update-gold の取得対象）は不変。
  const ALL = process.argv.includes("--all");
  const home = readFileOr("Cortex/Home.md");
  const tools = readFrontmatterMap(home, "tools");
  const engine = readFrontmatterMap(home, "engine");
  const derived = [];

  // ゲート: チャット:slack のときだけ slack を導出
  if ((tools["チャット"] || "").toLowerCase() === "slack") {
    for (const ch of deriveSlackChannels()) {
      derived.push({ type: "slack", ref: ch.ref, name: ch.name, gold: ch.gold, notify: ch.notify, url: ch.url });
    }
  }
  // ゲート: 開発:github のときだけ github-issues を導出（対象は dev_dir 配下のsubmodule）
  if ((tools["開発"] || "").toLowerCase() === "github") {
    const devDir = resolveDevDir(engine);
    for (const r of deriveGithubRepos(devDir)) {
      derived.push({ type: "github-issues", ref: r.ref, name: r.name });
    }
  }

  // 明示登録（external-sources.json）。name は登録に書かれた場合だけ持つ
  // （無い場合にここで ref を入れてしまうと、マージ時に導出側の表示名（channels.json の name）を潰すため）。
  const cfg = readJsonOr("Cortex/external-sources.json") || {};
  const explicit = [];
  for (const s of cfg.sources || []) {
    const type = s.type || "";
    const ref = s.repo || s.channel || "";
    if (!type || !ref) continue;
    const item = { type, ref };
    if (s.name) item.name = s.name;
    if (s.decisions !== undefined) item.decisions = s.decisions;
    explicit.push(item);
  }
  const excludeRepos = new Set((cfg.exclude || []).map((r) => String(r)));

  // gold:false チャンネルID集合（最終フィルタで常に除外）
  const goldFalseChannels = new Set(
    derived.filter((d) => d.type === "slack" && d.gold === false).map((d) => d.ref),
  );

  // マージ＋dedupe（type+ref単位・明示登録優先）。まず導出→上書きで明示を反映。
  // 明示側に無いフィールド（name・notify・url 等の表示系）は導出側から補完し、
  // 明示側にあるフィールド（decisions 等の動作オプション・明示的な name）は明示を優先する。
  const byKey = new Map();
  const keyOf = (s) => `${s.type}\t${s.ref}`;
  for (const d of derived) {
    byKey.set(keyOf(d), { ...d });
  }
  for (const e of explicit) {
    const prev = byKey.get(keyOf(e));
    byKey.set(keyOf(e), prev ? { ...prev, ...e } : e);
  }

  const result = [];
  for (const s of byKey.values()) {
    const isGoldFalse = s.type === "slack" && goldFalseChannels.has(s.ref);
    const isExcluded = s.type.startsWith("github") && excludeRepos.has(s.ref);
    if (ALL) {
      // --all: 除外も落とさず gold で表現。slack は notify（channels.json 由来・既定false）と url も注釈する。
      const item = { type: s.type, ref: s.ref, name: s.name || s.ref, gold: !(isGoldFalse || isExcluded) };
      if (s.type === "slack") item.notify = s.notify === true;
      if (s.url) item.url = s.url;
      if (s.decisions !== undefined) item.decisions = s.decisions;
      result.push(item);
      continue;
    }
    // 既定: 最終フィルタ（opt-out は常に効かせる＝読まない側に倒す）。gold/notify/url は内部判定・表示用なので出力に残さない。
    if (isGoldFalse || isExcluded) continue;
    const item = { type: s.type, ref: s.ref, name: s.name || s.ref };
    if (s.decisions !== undefined) item.decisions = s.decisions;
    result.push(item);
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
