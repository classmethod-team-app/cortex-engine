#!/usr/bin/env node
/**
 * cortex-grep — frontmatterを辿る「Cortex用grep」
 *
 * 標準のgrepは「ヒットしたファイル名」しか返さず、関連（出典・根拠・関係）は
 * frontmatterを見て手で辿り直す必要がある（grep→読む→grep→読む の多段）。
 * cortex-grep は Gold層（Cortex/）でseedをヒットさせ、そのfrontmatterの
 * relations / source / references / 本文中のBacklogリンクを N ホップ辿って、
 * 関連レコードを一括で集約して返す（dedup・新しい順・件数打ち切り付き）。
 *
 * 使い方:
 *   node scripts/cortex-grep.mjs "<検索語>" [--hops N] [--limit K] [--format json|md] [--root DIR]
 *
 * 既定: --hops 1  --limit 20  --format json  --root .（カレント＝リポジトリルート想定）
 *
 * 設計メモ: Gold起点→関係を辿る（探索戦略）の決定的実行。巡回エージェントの
 * per-project 読みプリミティブでもある。意味検索はしない（部分一致のみ・最小実装）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "./vendor/js-yaml.mjs"; // vendor同梱（プラグインキャッシュ内で依存インストール不要にする）

// ---------- 引数 ----------
function parseArgs(argv) {
  const opts = { query: "", hops: 1, limit: 20, format: "json", root: "." };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hops") opts.hops = parseInt(argv[++i], 10);
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10);
    else if (a === "--format") opts.format = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else rest.push(a);
  }
  opts.query = rest.join(" ").trim();
  return opts;
}

const USAGE = `cortex-grep — frontmatterを辿るCortex用grep
使い方: node scripts/cortex-grep.mjs "<検索語>" [--hops N] [--limit K] [--format json|md] [--root DIR]
  --hops N     関連を辿るホップ数（既定1）
  --limit K    返す件数の上限（既定20）
  --format     json（AI向け・既定） / md（人間向け）
  --root DIR   リポジトリルート（既定 .）`;

// ---------- frontmatter ----------
/** 先頭の --- ... --- を frontmatter として取り出す。無ければ data={} */
function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { data: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: raw };
  const fmText = raw.slice(3, end).replace(/^\r?\n/, "");
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  let data = {};
  try { data = yaml.load(fmText) || {}; } catch { data = {}; }
  return { data, body };
}

function normDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : v;
  }
  return "";
}

function toRelations(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r) => r && typeof r === "object" && r.rel && r.target)
    .map((r) => ({ rel: String(r.rel), target: String(r.target) }));
}
function toStrArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === "") return [];
  return [String(v)];
}

// ---------- ファイル走査 ----------
const SKIP_DIRS = new Set(["node_modules", ".git", "tmp", "dist", ".claude", ".cursor", ".rulesync", "resources", "templates"]);
async function walkMd(dir) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walkMd(full)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Bronze/Silver側のファイルから、安定IDで引けるレコードを拾う */
function bronzeIdsFor(file, raw, data, root) {
  const ids = [];
  const rel = path.relative(root, file).split(path.sep).join("/");
  // frontmatterのid（minute/material/design/issue/term等）
  if (data && data.id != null && data.type != null) ids.push(String(data.id));
  // 課題キー（課題管理/issues 配下の同期md）
  const km = raw.slice(0, 4000).match(/^- 課題キー: (\S+)$/m);
  if (km) ids.push(km[1]);
  // 議事録: パス規約 .../{YYYYMMDD}/*minutes*.md → minute:{親ディレクトリ名}:{YYYYMMDD}
  if (/minutes/i.test(path.basename(file))) {
    const dateDir = path.basename(path.dirname(file));
    const meetingDir = path.basename(path.dirname(path.dirname(file)));
    if (/^\d{8}$/.test(dateDir)) ids.push(`minute:${meetingDir}:${dateDir}`);
  }
  // リポジトリ相対パスでも引けるように（references が "README.md" 等のパス指定のcase）
  ids.push(rel);
  return { ids, rel };
}

// ---------- インデックス構築 ----------
const GOLD_TYPES = new Set(["decision", "term", "report", "overview"]);

async function buildIndex(root) {
  const byId = new Map(); // id -> record
  const goldSeeds = [];   // Gold層レコード（seed検索の対象）

  const register = (rec) => {
    for (const id of rec.ids) {
      if (id && !byId.has(id)) byId.set(id, rec);
    }
  };

  // Gold層（Cortex/）
  const cortexDir = path.join(root, "Cortex");
  for (const file of await walkMd(cortexDir)) {
    const base = path.basename(file).toLowerCase();
    if (base === "readme.md" || base === "template.md") continue;
    const raw = await fs.readFile(file, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const relPath = path.relative(root, file).split(path.sep).join("/");
    const id = data.id != null ? String(data.id) : relPath;
    const h1 = body.match(/^#\s+(.+)$/m);
    const rec = {
      id,
      ids: [id, relPath],
      layer: "gold",
      type: data.type != null ? String(data.type) : "",
      title: data.title != null ? String(data.title) : h1 ? h1[1].trim() : path.basename(file),
      date: normDate(data.date),
      summary: data.summary != null ? String(data.summary) : "",
      path: relPath,
      body,
      relations: toRelations(data.relations),
      source: data.source != null ? String(data.source).trim() : "",
      references: toStrArray(data.references),
      bodyLinks: extractBacklogKeys(body),
    };
    register(rec);
    goldSeeds.push(rec);
  }

  // Bronze/Silver（ルート直下の各ディレクトリ。Cortex以外）
  let topDirs = [];
  try { topDirs = await fs.readdir(root, { withFileTypes: true }); } catch { /* noop */ }
  for (const top of topDirs) {
    if (!top.isDirectory() || top.name.startsWith(".")) continue;
    if (top.name === "Cortex" || SKIP_DIRS.has(top.name)) continue;
    for (const file of await walkMd(path.join(root, top.name))) {
      const raw = await fs.readFile(file, "utf8");
      const { data, body } = parseFrontmatter(raw);
      const { ids, rel } = bronzeIdsFor(file, raw, data, root);
      if (byId.has(ids[0]) && ids.every((i) => byId.has(i))) continue;
      const h1 = body.match(/^#\s+(.+)$/m);
      const km = raw.slice(0, 4000).match(/^- 課題キー: (\S+)$/m);
      const rec = {
        id: ids[0],
        ids,
        layer: "context",
        type: data.type != null ? String(data.type) : km ? "issue" : "",
        title: data.title != null ? String(data.title) : h1 ? h1[1].trim() : path.basename(file),
        date: normDate(data.date),
        summary: data.summary != null ? String(data.summary) : "",
        path: rel,
        body,
        relations: toRelations(data.relations),
        source: data.source != null ? String(data.source).trim() : "",
        references: toStrArray(data.references),
        bodyLinks: extractBacklogKeys(body),
      };
      register(rec);
    }
  }

  return { byId, goldSeeds };
}

/** 本文中のBacklog課題URL（…/view/KEY-123）から課題キーを抜き出す */
function extractBacklogKeys(body) {
  const out = new Set();
  const re = /\/view\/([A-Z][A-Z0-9_]*-\d+)/g;
  let m;
  while ((m = re.exec(body))) out.add(m[1]);
  return [...out];
}

// ---------- seed検索 ----------
function matchSeed(rec, q) {
  const hay = (rec.id + " " + rec.title + " " + rec.summary + " " + rec.body).toLowerCase();
  return hay.indexOf(q) !== -1;
}

// ---------- 展開（BFS） ----------
function neighborTargets(rec) {
  // {target, rel} の配列
  const out = [];
  for (const r of rec.relations) out.push({ target: r.target, rel: r.rel });
  if (rec.source) out.push({ target: rec.source, rel: "source" });
  for (const ref of rec.references) out.push({ target: ref, rel: "reference" });
  for (const k of rec.bodyLinks) out.push({ target: k, rel: "link" });
  return out;
}

function snippet(rec, q, max = 280) {
  const text = (rec.body || "").replace(/\s+/g, " ").trim();
  if (!text) return rec.summary || "";
  if (q) {
    const i = text.toLowerCase().indexOf(q);
    if (i !== -1) {
      const start = Math.max(0, i - 60);
      return (start > 0 ? "…" : "") + text.slice(start, start + max) + (start + max < text.length ? "…" : "");
    }
  }
  return text.slice(0, max) + (text.length > max ? "…" : "");
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.query) {
    console.log(USAGE);
    process.exit(opts.query ? 0 : 1);
  }
  const root = path.resolve(opts.root);
  const q = opts.query.toLowerCase();
  const { byId, goldSeeds } = await buildIndex(root);

  // seed: Gold層でヒットしたもの（hop 0）
  const seeds = goldSeeds.filter((r) => matchSeed(r, q));

  // BFS で関連を辿る
  const collected = new Map(); // id -> { rec, hop, rel }
  for (const s of seeds) collected.set(s.id, { rec: s, hop: 0, rel: "seed" });
  let frontier = seeds.map((s) => s.id);
  for (let hop = 1; hop <= opts.hops; hop++) {
    const next = [];
    for (const id of frontier) {
      const { rec } = collected.get(id);
      for (const { target, rel } of neighborTargets(rec)) {
        // [label](url) 形式の参照は url をキー・label を表示名に正規化する
        const md = target.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
        const tid = md ? md[2] : target;
        const label = md ? (md[1] || md[2]) : target;
        const found = byId.get(tid);
        if (!found) {
          // 解決できないターゲットも「ポインタ」として記録（外部URL・未解決ID・tmp等の対象外パス）
          if (!collected.has(tid)) {
            collected.set(tid, { rec: { id: tid, ids: [tid], layer: "pointer", type: ISSUE_KEY_RE.test(tid) ? "issue" : /^https?:\/\//.test(tid) ? "external" : "path", title: label, date: "", summary: "", path: tid, body: "", relations: [], source: "", references: [], bodyLinks: [] }, hop, rel });
          }
          continue;
        }
        if (!collected.has(found.id)) {
          collected.set(found.id, { rec: found, hop, rel });
          next.push(found.id);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  // dedup（id単位・済）→ ランク（seed優先→新しい順→ホップ近い順）→ 打ち切り
  let items = [...collected.values()];
  const layerRank = { gold: 0, context: 1, pointer: 2 };
  items.sort((a, b) => {
    if (a.hop !== b.hop) return a.hop - b.hop; // 近いホップ優先
    const la = layerRank[a.rec.layer] ?? 3, lb = layerRank[b.rec.layer] ?? 3;
    if (la !== lb) return la - lb;
    if (a.rec.date !== b.rec.date) return a.rec.date < b.rec.date ? 1 : -1; // 新しい順
    return a.rec.id < b.rec.id ? 1 : -1;
  });
  const total = items.length;
  items = items.slice(0, opts.limit);

  const bundle = items.map((it) => ({
    id: it.rec.id,
    type: it.rec.type,
    layer: it.rec.layer,
    date: it.rec.date,
    hop: it.hop,
    rel: it.rel,
    path: it.rec.path,
    title: it.rec.title,
    content: it.rec.layer === "pointer" ? "" : snippet(it.rec, q),
  }));

  if (opts.format === "md") {
    const lines = [];
    lines.push(`# cortex-grep: "${opts.query}"`);
    lines.push(`seed ${seeds.length}件 / 集約 ${total}件（表示 ${bundle.length}件・hops=${opts.hops}）`);
    lines.push("");
    for (const b of bundle) {
      const tag = b.hop === 0 ? "★seed" : `hop${b.hop}・${b.rel}`;
      lines.push(`## [${tag}] ${b.title}`);
      lines.push(`- id: \`${b.id}\` / type: ${b.type || "-"} / date: ${b.date || "-"}${b.path ? ` / ${b.path}` : ""}`);
      if (b.content) lines.push(`- ${b.content}`);
      lines.push("");
    }
    process.stdout.write(lines.join("\n") + "\n");
  } else {
    process.stdout.write(JSON.stringify({
      query: opts.query,
      hops: opts.hops,
      seedCount: seeds.length,
      total,
      shown: bundle.length,
      bundle,
    }, null, 2) + "\n");
  }
}

run().catch((e) => { console.error("cortex-grep error:", e?.message ?? e); process.exit(1); });
