#!/usr/bin/env node
/**
 * テンプレート（aidd-project-cortex）を案件用に複製した直後に、リポジトリ内の
 * セットアップ用プレースホルダ（二重ブレース `{{...}}`）を実際の値で一括置換する。
 *
 * 置換するのは「固定の既知トークン」だけ。デザイン/DESIGN.md 等にある手動記入用の
 * `{{ }}`（例: `{{プロダクト名}}` `{{#______}}` `{{例: ...}}`）には一切触れない。
 *
 * 既知トークン:
 *   {{リポジトリ名}} {{プロジェクト名}} {{org}} {{クライアント名}}   ← 引数で指定
 *   {{今日}}    複製日 YYYY-MM-DD
 *   {{今日8}}   複製日 YYYYMMDD
 *   {{今日-N}}  複製日のN日前 YYYY-MM-DD（例 {{今日-6}}）
 *   {{今日8-N}} 複製日のN日前 YYYYMMDD
 *
 * ファイル内容の置換に加え、ファイル名に日付トークンを含むもの（Gold層サンプル等）も
 * リネームする。引数で渡されなかった値（=答えられなかった項目）の `{{ }}` はそのまま
 * 残し、末尾に「保留」として警告する（失敗扱いにはしない）。値が決まったら、その項目
 * だけを渡して再実行すれば埋まる（埋め済みの値には `{{ }}` が残らないため冪等）。
 *
 * このスクリプトは setup-project スキルに同梱されている。スキルからは
 * `<SKILL_DIR>/scripts/setup-fill.mjs`、手動セットアップではリポジトリ直下の
 * プラグインの `<SKILL_DIR>/scripts/setup-fill.mjs` を指定して実行する。
 * いずれもカレントディレクトリ（=リポジトリルート）を走査対象とする。
 *
 * 使い方:
 *   node <SKILL_DIR>/scripts/setup-fill.mjs \
 *     --リポジトリ名=my-project \
 *     --プロジェクト名="XX様向けYYシステム開発" \
 *     --org=my-org \
 *     --クライアント名="XX株式会社" \
 *     [--date=2026-06-14]   # 省略時は本日
 *
 * 終了コード: 0=OK（全埋め込み完了 or 一部保留の正常終了） / 2=引数エラー
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([".git", "node_modules", "tmp"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".mov", ".xlsx",
  ".pptx", ".docx", ".lock",
]);

/** --key=value 形式の引数をパース（unicodeキー対応） */
function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      args[a.slice(2)] = true;
    } else {
      args[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return args;
}

/** Dateを YYYY-MM-DD / YYYYMMDD に整形（ローカル日付） */
function fmt(date, compact) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return compact ? `${y}${m}${d}` : `${y}-${m}-${d}`;
}

/** 基準日からN日前のDateを返す */
function minusDays(base, n) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() - n);
  return d;
}

const args = parseArgs(process.argv.slice(2));

// 基準日（複製日）
let baseDate;
if (args.date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date);
  if (!m) {
    console.error(`✗ --date は YYYY-MM-DD 形式で指定してください: ${args.date}`);
    process.exit(2);
  }
  baseDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
} else {
  baseDate = new Date();
}

// セットアップ用の値トークン（この5つが完全な語彙）。引数で渡されたものだけ置換し、
// 渡されなかったものは「未入力」として後で警告・再実行で埋められる設計にする。
// 開発リポ（ソースコードリポジトリの owner/repo）は任意。無ければ未入力のまま残し、後で /clone-dev-repos 時に埋める。
const VALUE_KEYS = ["リポジトリ名", "プロジェクト名", "org", "クライアント名", "開発リポ"];
const tokenOf = (k) => `{{${k}}}`;
const keyOfToken = new Map(VALUE_KEYS.map((k) => [tokenOf(k), k]));

// 固定文字列の置換マップ（値が指定されたものだけ登録）
const literalMap = new Map();
const missingKeys = []; // 値が渡されなかったキー（=ユーザーが答えられなかった項目）
for (const k of VALUE_KEYS) {
  // 空文字も「意図的に空」という回答として扱い置換する（例: 社内プロジェクトのクライアント名）
  if (typeof args[k] === "string") literalMap.set(tokenOf(k), args[k]);
  else missingKeys.push(k);
}

if (literalMap.size === 0) {
  console.error(
    "✗ 値が1つも指定されていません。--リポジトリ名 / --プロジェクト名 / --org / --クライアント名 を指定してください。",
  );
  process.exit(2);
}

// 日付トークンの置換（{{今日}} {{今日8}} {{今日-N}} {{今日8-N}}）
const DATE_RE = /\{\{今日(8)?(?:-(\d+))?\}\}/g;
function replaceDates(text) {
  return text.replaceAll(DATE_RE, (_all, compact, offset) => {
    const d = offset ? minusDays(baseDate, Number(offset)) : baseDate;
    return fmt(d, Boolean(compact));
  });
}

// 既知の全トークンを1文字列に適用
function applyAll(text) {
  let out = text;
  for (const [token, value] of literalMap) out = out.replaceAll(token, value);
  out = replaceDates(out);
  return out;
}

// 未展開チェック用の正規表現は、渡された値だけでなく「値トークン全4種＋日付トークン」を
// 対象にする。これにより、引数で渡されなかった（=答えられなかった）トークンの埋め残しも
// 確実に検出できる。日付トークンは値の有無に関わらず常に置換されるため残らない。
const KNOWN_LEFTOVER_RE = new RegExp(
  `(${[...keyOfToken.keys()]
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")}|\\{\\{今日8?(?:-\\d+)?\\}\\})`,
  "g",
);

const root = process.cwd();
let changedFiles = 0;
let totalReplacements = 0;
const renames = [];
const leftovers = new Map(); // relPath -> Set(tokens)

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name));
    } else if (e.isFile()) {
      await handleFile(path.join(dir, e.name));
    }
  }
}

async function handleFile(filePath) {
  const rel = path.relative(root, filePath);
  // このスクリプト自身はソース・生成物（.rulesync / .claude / .cursor）に
  // 複数コピーが存在し、いずれもコメント/コードにトークン文字列を含むため、
  // ファイル名で一律に対象外とする（自己書き換えによる破損防止）。
  if (path.basename(filePath) === "setup-fill.mjs") return;
  if (BINARY_EXT.has(path.extname(filePath).toLowerCase())) return;

  let buf;
  try {
    buf = await fs.readFile(filePath);
  } catch {
    return;
  }
  if (buf.includes(0)) return; // ヌルバイトを含むものはバイナリとみなす
  const raw = buf.toString("utf8");

  const replaced = applyAll(raw);
  if (replaced !== raw) {
    const before = (raw.match(KNOWN_LEFTOVER_RE) || []).length;
    const after = (replaced.match(KNOWN_LEFTOVER_RE) || []).length;
    totalReplacements += before - after;
    await fs.writeFile(filePath, replaced, "utf8");
    changedFiles++;
  }

  // 未展開（未指定値）の残存を記録
  const remain = replaced.match(KNOWN_LEFTOVER_RE);
  if (remain) leftovers.set(rel, new Set(remain));

  // ファイル名に既知トークンが含まれていればリネーム
  const baseName = path.basename(filePath);
  const newName = applyAll(baseName);
  if (newName !== baseName) {
    const newPath = path.join(path.dirname(filePath), newName);
    await fs.rename(filePath, newPath);
    renames.push([rel, path.relative(root, newPath)]);
  }
}

await walk(root);

// 結果サマリ
console.log("── setup-fill 実行結果 ──");
console.log(`複製日: ${fmt(baseDate, false)}`);
for (const [token, value] of literalMap) console.log(`  ${token} → ${value}`);
console.log(
  `置換ファイル数: ${changedFiles} / 置換トークン数: ${totalReplacements}`,
);
if (renames.length) {
  console.log(`リネーム: ${renames.length}件`);
  for (const [a, b] of renames) console.log(`  ${a} → ${b}`);
}

if (leftovers.size) {
  // 残っているのは「答えられなかった（引数で渡されなかった）値トークン」のみ。
  // これは失敗ではなく保留状態。値が決まったら同じスクリプトを再実行すれば埋まる
  // （埋め済みの値には `{{ }}` が残らないため、再実行しても変化しない＝冪等）。
  const pendingTokens = new Set();
  for (const tokens of leftovers.values())
    for (const t of tokens) pendingTokens.add(t);
  const pendingKeys = [...pendingTokens]
    .map((t) => keyOfToken.get(t))
    .filter(Boolean);

  console.log(
    `\n⚠ 未入力のプレースホルダが ${leftovers.size} ファイルに残っています（保留・後で埋められます）:`,
  );
  for (const t of pendingTokens) console.log(`  ${t}`);
  if (pendingKeys.length) {
    console.log(
      "\n値が決まったら、その項目だけを渡してこのスクリプトを再実行してください（埋め済みの値は変わりません）:",
    );
    const exampleArgs = pendingKeys
      .map((k) => `    --${k}="..."`)
      .join(" \\\n");
    console.log(
      `  node <SKILL_DIR>/scripts/setup-fill.mjs \\\n${exampleArgs}`,
    );
    console.log(
      "\n  ※ 値が存在しない項目（例: 社内プロジェクトのクライアント名）は空文字を渡してください: --クライアント名=\"\"",
    );
  }
  // 部分適用は正常終了（失敗扱いにしない）。残りは再実行で補完する設計。
  process.exit(0);
}

console.log("\n✓ すべてのセットアップ用プレースホルダを埋めました。");
