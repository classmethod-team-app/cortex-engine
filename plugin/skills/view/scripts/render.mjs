#!/usr/bin/env node
/**
 * view/render — Markdown を「共有できる自己完結HTML」に決定的に変換する
 *
 * 設計の核: HTMLはLLMに書かせない。AIの役割は「変換したいMarkdownを渡す」「タイトルを決める」まで。
 * 変換自体はこのスクリプトが機械的に行う（毎回同じ入力なら同じ出力・オフラインで動く・依存ゼロ）。
 *
 * 使い方:
 *   node scripts/render.mjs <input.md> [--title "..."] [--theme report|compare] [--root DIR]
 *   cat answer.md | node scripts/render.mjs --title "調査結果"
 *
 * 出力: <root>/tmp/view/{YYYYMMDD-HHmmss}-{slug}.html
 *   tmp/ はgit管理外の作業領域。案件リポジトリの管理対象を増やさないためここに置く。
 *
 * 依存: Node標準のみ（Markdownパーサ・YAML読み取りも自前。npx等のネットワーク取得に依存させない）
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- 引数 ----------

const USAGE = `view/render — Markdown を共有可能な自己完結HTMLに変換する
使い方:
  node scripts/render.mjs <input.md> [options]
  cat answer.md | node scripts/render.mjs [options]

  --title "..."   ページタイトル（既定: 入力の先頭見出し → frontmatterのtitle → 入力ファイル名）
  --theme NAME    report（既定・読み物） / compare（h2ごとのカードを2カラム比較）
  --root DIR      案件リポジトリのルート（既定 .）。デザイントークンと出力先の基準
  --project NAME  ヘッダーに出すプロジェクト名（既定: デザイン/DESIGN.md の name → ルート名）
  --out PATH      出力先を明示指定する（既定: <root>/tmp/view/{日時}-{slug}.html）
  --stdout        ファイルに書かずHTMLを標準出力に出す（検証用）`;

function parseArgs(argv) {
  const opts = { theme: "report", root: ".", input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--title") opts.title = argv[++i];
    else if (a === "--theme") opts.theme = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else if (a === "--project") opts.project = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--stdout") opts.stdout = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-") opts.input = null;
    else if (!opts.input) opts.input = a;
  }
  return opts;
}

// ---------- 最小YAML読み取り（DESIGN.md のフロントマター用） ----------

/**
 * インデント2レベルまでのマップだけを読む最小パーサ。
 * DESIGN.md のフロントマターは sync-designs が機械生成する固定形式（colors/typography/rounded/spacing）なので、
 * ここではその範囲（ネストしたマップとスカラー）だけを解釈する。リスト・複数行文字列は扱わない。
 */
function parseSimpleYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue; // 空行・行頭コメント
    const m = /^(\s*)([^:\s][^:]*):\s*(.*)$/.exec(rawLine);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].trim();
    const value = m[3].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = unquoteYaml(value);
    }
  }
  return root;
}

function unquoteYaml(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}

/** 先頭の --- ... --- をフロントマターとして切り出す（無ければ null と本文） */
function splitFrontmatter(raw) {
  if (!raw.startsWith("---")) return { front: null, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { front: null, body: raw };
  const front = raw.slice(3, end).replace(/^\r?\n/, "");
  const rest = raw.slice(end + 4).replace(/^\r?\n/, "");
  return { front, body: rest };
}

// ---------- デザイントークン ----------

// DESIGN.md が無い案件・値が読めない場合の中立デフォルト（Cortex既定のニュートラルテーマ）
const DEFAULT_TOKENS = {
  name: null,
  primary: "#2563EB",
  primaryStrong: "#1D4ED8",
  surface: "#FFFFFF",
  background: "#F4F8FE",
  text: "#1B1F24",
  textMuted: "#6B727C",
  border: "#DBEAFE",
  accent: "#FACC15",
  fontFamily: '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif',
  radiusMd: "12px",
  radiusLg: "20px",
};

/** CSSに流し込む値を検証する（不正値は捨ててデフォルトへ。生成HTMLへの値の混入を防ぐ） */
const isColor = (v) => typeof v === "string" && /^#[0-9A-Fa-f]{3,8}$/.test(v.trim());
const isLength = (v) => typeof v === "string" && /^[0-9]+(\.[0-9]+)?(px|rem|em|%)$/.test(v.trim());

/** フォント名をCSS安全な形に整える（記号を落として引用符で包む） */
function sanitizeFontFamily(v) {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/["'`;{}()\\]/g, "").trim();
  if (!cleaned || cleaned.length > 60) return null;
  return `"${cleaned}", "Noto Sans JP", "Hiragino Sans", system-ui, sans-serif`;
}

/** colors マップから、意味名の完全一致 → 部分一致の順でトークンを拾う */
function pickColor(colors, names) {
  const keys = Object.keys(colors || {});
  for (const n of names) {
    const exact = keys.find((k) => k.toLowerCase() === n);
    if (exact && isColor(colors[exact])) return colors[exact].trim();
  }
  for (const n of names) {
    const partial = keys.find((k) => k.toLowerCase().includes(n) && isColor(colors[k]));
    if (partial) return colors[partial].trim();
  }
  return null;
}

/**
 * <root>/デザイン/DESIGN.md のフロントマター（sync-designs が生成するデザイントークン）を読む。
 * 無い / 壊れている / 値が不正な場合は、その項目だけ中立デフォルトにフォールバックする。
 */
async function loadTokens(root) {
  const tokens = { ...DEFAULT_TOKENS, source: "default" };
  let raw;
  try {
    raw = await fs.readFile(path.join(root, "デザイン", "DESIGN.md"), "utf8");
  } catch {
    return tokens;
  }
  const { front } = splitFrontmatter(raw);
  if (!front) return tokens;

  let data = {};
  try {
    data = parseSimpleYaml(front);
  } catch {
    return tokens;
  }
  tokens.source = "DESIGN.md";
  tokens.foundKeys = [];

  const colors = typeof data.colors === "object" ? data.colors : {};
  const assign = (field, names) => {
    const v = pickColor(colors, names);
    if (v) {
      tokens[field] = v;
      tokens.foundKeys.push(field);
    }
  };
  assign("primary", ["primary", "brand", "accent"]);
  assign("primaryStrong", ["primary-strong", "primary-dark", "primary-hover", "primary"]);
  assign("surface", ["surface", "card", "panel", "white"]);
  assign("background", ["background", "bg", "base"]);
  assign("text", ["text", "foreground", "ink"]);
  assign("textMuted", ["text-muted", "muted", "text-secondary", "subtle"]);
  assign("border", ["border", "divider", "outline"]);
  assign("accent", ["accent-yellow", "accent", "warning", "highlight"]);

  // typography: 本文向けのエントリを優先し、無ければ最初のエントリの fontFamily を使う
  const typo = typeof data.typography === "object" ? data.typography : {};
  const typoKeys = Object.keys(typo);
  const bodyKey =
    typoKeys.find((k) => /body|base|paragraph|text|default/i.test(k)) || typoKeys[0];
  if (bodyKey && typeof typo[bodyKey] === "object") {
    const ff = sanitizeFontFamily(typo[bodyKey].fontFamily);
    if (ff) {
      tokens.fontFamily = ff;
      tokens.foundKeys.push("fontFamily");
    }
  }

  const rounded = typeof data.rounded === "object" ? data.rounded : {};
  if (isLength(rounded.md)) {
    tokens.radiusMd = rounded.md.trim();
    tokens.foundKeys.push("radiusMd");
  }
  if (isLength(rounded.lg)) {
    tokens.radiusLg = rounded.lg.trim();
    tokens.foundKeys.push("radiusLg");
  }

  if (typeof data.name === "string" && data.name.trim()) tokens.name = data.name.trim();
  return tokens;
}

// ---------- エスケープ・インライン記法 ----------

/** HTMLエスケープ。入力に <script> 等が含まれても壊れない・実行されないようにする（最優先の規律） */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** リンク先を検証する。javascript: 等のスキームは無効化して素のテキストに落とす */
function safeHref(url) {
  const u = String(url).trim();
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(u) && !/[\s<>"']/.test(u)) return u;
  if (/^[\w.\-/%]+$/.test(u)) return u; // 相対パス
  return null;
}

const CODE_SENTINEL = "\u0000CODE";

/**
 * インライン記法を変換する。
 * 手順: ①先にコードスパンを退避 ②HTMLエスケープ ③強調・リンクを適用 ④コードスパンを戻す。
 * 対応外の記法はエスケープ済みの素のテキストとしてそのまま表示される（壊さない）。
 */
function renderInline(text) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `${CODE_SENTINEL}${codes.length - 1}\u0000`;
  });

  s = escapeHtml(s);

  // リンク [text](url)
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(url.replace(/&amp;/g, "&"));
    if (!href) return m;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  s = s.replace(new RegExp(`${CODE_SENTINEL}(\\d+)\\u0000`, "g"), (_m, i) => {
    return `<code>${escapeHtml(codes[Number(i)])}</code>`;
  });
  return s;
}

// ---------- ブロック記法 ----------

const RE_HEADING = /^(#{1,4})\s+(.*)$/;
const RE_HR = /^\s*([-*_])\s*(\1\s*){2,}$/;
const RE_UL = /^(\s*)[-*+]\s+(.*)$/;
const RE_OL = /^(\s*)\d+[.)]\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/**
 * Markdown本文をブロック単位のHTML片リストに変換する。
 * 対応: 見出し(h1-h4)・段落・箇条書き/番号付き（ネスト可）・チェックリスト・コードブロック・
 *       表・引用・水平線・リンク・強調・インラインコード。
 * それ以外の記法（脚注・定義リスト・HTMLタグ等）は変換せず、エスケープした素のテキストとして表示する。
 */
function renderBlocks(lines) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // コードブロック（``` / ~~~）
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || "";
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 閉じフェンス
      const cls = /^[\w+-]{1,20}$/.test(lang) ? ` class="lang-${escapeHtml(lang)}"` : "";
      out.push(`<pre${cls}><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 水平線（リストの `-` と紛れないよう見出し系より先に判定）
    if (RE_HR.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    // 見出し
    const h = RE_HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 引用（連続する `>` 行をまとめて再帰的に解釈）
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(buf).join("\n")}</blockquote>`);
      continue;
    }

    // 表（ヘッダ行 + 区切り行 + 本体行）
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(toAlign);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        body.push(splitRow(lines[i]));
        i++;
      }
      out.push(renderTable(header, aligns, body));
      continue;
    }

    // 箇条書き・番号付き（インデントでネスト）
    if (RE_UL.test(line) || RE_OL.test(line)) {
      const buf = [];
      while (i < lines.length && (RE_UL.test(lines[i]) || RE_OL.test(lines[i]) || (buf.length && lines[i].trim() && /^\s{2,}/.test(lines[i])))) {
        buf.push(lines[i]);
        i++;
      }
      out.push(renderList(buf));
      continue;
    }

    // 段落（空行 or 次のブロック開始まで。表の開始行は次行の区切り行で判定する）
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isBlockStart(lines[i]) &&
      !(buf.length && lines[i].includes("|") && RE_TABLE_SEP.test(lines[i + 1] ?? ""))
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    if (buf.length) out.push(`<p>${renderInline(buf.join(" "))}</p>`);
    else i++; // 念のための無限ループ回避
  }
  return out;
}

function isBlockStart(line) {
  return (
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line) ||
    /^\s*(```|~~~)/.test(line) ||
    /^\s*>/.test(line)
  );
}

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function toAlign(sep) {
  const s = sep.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  return "left";
}

function renderTable(header, aligns, body) {
  const th = header
    .map((c, n) => `<th style="text-align:${aligns[n] || "left"}">${renderInline(c)}</th>`)
    .join("");
  const rows = body
    .map((cells) => {
      const tds = header
        .map(
          (_h, n) =>
            `<td style="text-align:${aligns[n] || "left"}">${renderInline(cells[n] ?? "")}</td>`,
        )
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
}

/** インデント量でネストを組み立てる（同レベルの連続行を1つのリストにまとめる） */
function renderList(lines) {
  const items = [];
  for (const line of lines) {
    const ul = RE_UL.exec(line);
    const ol = ul ? null : RE_OL.exec(line);
    if (ul || ol) {
      const m = ul || ol;
      items.push({ indent: m[1].length, ordered: !!ol, text: m[2], children: [] });
    } else if (items.length) {
      // リスト項目の折り返し（継続行）
      items[items.length - 1].text += ` ${line.trim()}`;
    }
  }
  if (!items.length) return "";
  return buildList(items, items[0].indent, { i: 0 });
}

function buildList(items, indent, cursor) {
  const ordered = items[cursor.i]?.ordered;
  const parts = [];
  while (cursor.i < items.length && items[cursor.i].indent >= indent) {
    const item = items[cursor.i];
    if (item.indent > indent) {
      parts.push(buildList(items, item.indent, cursor));
      continue;
    }
    cursor.i++;
    let inner;
    const task = /^\[([ xX])\]\s+(.*)$/.exec(item.text);
    if (task) {
      const checked = task[1].toLowerCase() === "x";
      inner = `<label class="task"><input type="checkbox" disabled${checked ? " checked" : ""} /> <span>${renderInline(task[2])}</span></label>`;
    } else {
      inner = renderInline(item.text);
    }
    // 子（より深いインデント）があればネストして内包する
    let nested = "";
    if (cursor.i < items.length && items[cursor.i].indent > item.indent) {
      nested = buildList(items, items[cursor.i].indent, cursor);
    }
    parts.push(`<li>${inner}${nested}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  return `<${tag}>${parts.join("")}</${tag}>`;
}

// ---------- レイアウト（テーマ） ----------

/**
 * テーマは凝らない。既定は report（1カラムの読み物）。
 * compare は h2 ごとにカード化して2カラムに並べ、左右比較を読みやすくする。
 * ここに checklist 等を足す場合も「HTMLの構造を少し変えるだけ」に留めること（LLMに書かせない設計を守る）。
 */
const THEMES = new Set(["report", "compare"]);

function layoutBlocks(blocks, theme) {
  if (theme !== "compare") return blocks.join("\n");
  const sections = [];
  let lead = [];
  let current = null;
  for (const b of blocks) {
    if (b.startsWith("<h2")) {
      if (current) sections.push(current);
      current = [b];
    } else if (current) current.push(b);
    else lead.push(b);
  }
  if (current) sections.push(current);
  if (!sections.length) return blocks.join("\n");
  const cards = sections.map((s) => `<section class="card">\n${s.join("\n")}\n</section>`).join("\n");
  return `${lead.join("\n")}\n<div class="compare-grid">\n${cards}\n</div>`;
}

// ---------- HTML組み立て ----------

function buildHtml({ title, bodyHtml, tokens, projectName, generatedAt, theme }) {
  const css = `
:root {
  --primary: ${tokens.primary};
  --primary-strong: ${tokens.primaryStrong};
  --surface: ${tokens.surface};
  --background: ${tokens.background};
  --text: ${tokens.text};
  --text-muted: ${tokens.textMuted};
  --border: ${tokens.border};
  --accent: ${tokens.accent};
  --radius-md: ${tokens.radiusMd};
  --radius-lg: ${tokens.radiusLg};
  --font: ${tokens.fontFamily};
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 40px 20px 80px;
  background: var(--background);
  color: var(--text);
  font-family: var(--font);
  font-size: 15px;
  line-height: 1.8;
  -webkit-font-smoothing: antialiased;
}
.sheet {
  max-width: 960px;
  margin: 0 auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 40px 44px 56px;
  box-shadow: 0 8px 32px rgba(16, 24, 40, 0.08);
}
.meta {
  font-size: 12px;
  color: var(--text-muted);
  letter-spacing: 0.02em;
  margin-bottom: 4px;
}
.title {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.4;
  margin: 0 0 28px;
  padding-bottom: 16px;
  border-bottom: 2px solid var(--primary);
}
h1, h2, h3, h4 { line-height: 1.45; font-weight: 700; }
h1 { font-size: 24px; margin: 40px 0 16px; }
h2 {
  font-size: 20px;
  margin: 36px 0 14px;
  padding-left: 12px;
  border-left: 4px solid var(--primary);
}
h3 { font-size: 17px; margin: 28px 0 10px; color: var(--primary-strong); }
h4 { font-size: 15px; margin: 22px 0 8px; color: var(--text-muted); }
p { margin: 0 0 14px; }
a { color: var(--primary-strong); }
ul, ol { margin: 0 0 14px; padding-left: 1.5em; }
li { margin: 4px 0; }
li > ul, li > ol { margin: 4px 0; }
.task { display: inline-flex; align-items: baseline; gap: 6px; }
strong { font-weight: 700; }
del { color: var(--text-muted); }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 5px;
  padding: 0.12em 0.4em;
}
pre {
  background: #1b1f24;
  color: #e6edf3;
  border-radius: var(--radius-md);
  padding: 16px 18px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.65;
  margin: 0 0 18px;
}
pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
blockquote {
  margin: 0 0 18px;
  padding: 4px 18px;
  border-left: 4px solid var(--border);
  color: var(--text-muted);
}
blockquote p:last-child { margin-bottom: 0; }
.table-wrap { overflow-x: auto; margin: 0 0 20px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { border: 1px solid var(--border); padding: 8px 12px; vertical-align: top; }
th { background: var(--background); font-weight: 700; }
tbody tr:nth-child(even) { background: rgba(0, 0, 0, 0.015); }
hr { border: 0; border-top: 1px solid var(--border); margin: 32px 0; }
.compare-grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 4px 20px 12px;
  background: var(--background);
}
.card h2 { margin-top: 20px; }
@media (min-width: 760px) {
  .compare-grid { grid-template-columns: 1fr 1fr; }
}
@media print {
  body { background: #fff; padding: 0; font-size: 11.5pt; }
  .sheet { max-width: none; border: 0; border-radius: 0; box-shadow: none; padding: 0; }
  pre { background: #f4f4f4; color: #111; border: 1px solid #ddd; }
  pre, blockquote, table, .card { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
  a { color: inherit; text-decoration: underline; }
  .compare-grid { grid-template-columns: 1fr 1fr; }
}
`.trim();

  const metaLine = [generatedAt, projectName, `theme: ${theme}`].filter(Boolean).join(" ・ ");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main class="sheet">
<div class="meta">${escapeHtml(metaLine)}</div>
<h1 class="title">${escapeHtml(title)}</h1>
${bodyHtml}
</main>
</body>
</html>
`;
}

// ---------- 出力先 ----------

function timestamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return {
    stamp: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    human: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/** ファイル名用のslug。日本語はそのまま残し、パスに使えない文字だけを落とす */
function slugify(s) {
  const base = String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\p{L}\p{N}\-_]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (base || "view").slice(0, 40);
}

// ---------- メイン ----------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!THEMES.has(opts.theme)) {
    console.error(`未対応のテーマです: ${opts.theme}（対応: ${[...THEMES].join(" / ")}）`);
    process.exit(1);
  }

  const raw = opts.input ? await fs.readFile(opts.input, "utf8") : await readStdin();
  if (!raw.trim()) {
    console.error("変換する内容が空です。Markdownファイルのパスを渡すか、標準入力で流し込んでください。");
    process.exit(1);
  }

  // 入力にfrontmatterがあれば本文から外す（titleだけ拾う）
  const { front, body } = splitFrontmatter(raw);
  const frontData = front ? parseSimpleYaml(front) : {};

  const lines = body.split(/\r?\n/);

  // タイトル: --title → 入力の先頭h1（本文からは取り除く） → frontmatterのtitle → ファイル名
  let title = opts.title;
  const firstHeading = lines.findIndex((l) => l.trim());
  if (!title && firstHeading >= 0) {
    const m = /^#\s+(.*)$/.exec(lines[firstHeading].trim());
    if (m) {
      title = m[1].trim();
      lines.splice(firstHeading, 1);
    }
  } else if (title && firstHeading >= 0) {
    // --title 指定時も、同じ文言の先頭h1が続くなら重複を避ける
    const m = /^#\s+(.*)$/.exec(lines[firstHeading].trim());
    if (m && m[1].trim() === title.trim()) lines.splice(firstHeading, 1);
  }
  if (!title && typeof frontData.title === "string") title = frontData.title;
  if (!title && opts.input) title = path.basename(opts.input).replace(/\.md$/i, "");
  if (!title) title = "無題";

  const root = path.resolve(opts.root);
  const tokens = await loadTokens(root);
  const projectName = opts.project || tokens.name || path.basename(root);

  const blocks = renderBlocks(lines);
  const bodyHtml = layoutBlocks(blocks, opts.theme);
  const { stamp, human } = timestamp(new Date());

  const html = buildHtml({
    title,
    bodyHtml,
    tokens,
    projectName,
    generatedAt: human,
    theme: opts.theme,
  });

  if (opts.stdout) {
    process.stdout.write(html);
    return;
  }

  const outPath = opts.out
    ? path.resolve(opts.out)
    : path.join(root, "tmp", "view", `${stamp}-${slugify(title)}.html`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, html, "utf8");

  console.log(outPath);
  console.error(
    `変換しました: テーマ=${opts.theme} / デザイントークン=${tokens.source}` +
      (tokens.foundKeys?.length ? `（${tokens.foundKeys.join(", ")}）` : ""),
  );
}

main().catch((err) => {
  console.error(`変換に失敗しました: ${err.message}`);
  process.exit(1);
});
