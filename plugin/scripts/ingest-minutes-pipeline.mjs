#!/usr/bin/env node
// 議事録自動生成の「決定的パイプライン＋LLM関数化」オーケストレータ（Node単体・npm依存なし）。
//
// 現行の議事録自動生成は claude -p の自由行動エージェント（max-turns 60）で、
// 未処理検出・ファイル移動・既存議事録との照合まで AI に任せているため、ターン枯渇等の
// 確率的失敗が起きる。これを「機械的にできることは決定的に・判断だけを小さな LLM 関数に切り出す」
// 構成に作り替える。移行は ①シャドー ②カナリア＋自動フォールバック ③艦隊展開 の3段で、
// 本スクリプトのスコープは ① まで（REAL モードはコードとして実装するがワークフローからは呼ばない）。
//
// 実行モード（env INGEST_PIPELINE_MODE。既定 shadow）:
//   - shadow: リポジトリを一切変更しない。判断・生成物を1つの Markdown レポートにまとめ、
//             $GITHUB_STEP_SUMMARY に判断サマリ、レポート全文を /tmp と run log に出す。
//   - real:   git mv（移動）→議事録書き込み→git commit。push はワークフロー側（本スクリプトはしない）。
//
// LLM 呼び出し（env で差し替え可能・テスト容易性）:
//   - 既定は `aws bedrock-runtime converse`（ランナーは OIDC で AWS 認証済み・aws CLI 標準搭載）。
//     モデルは env ANTHROPIC_MODEL、リージョンは env AWS_REGION。
//   - env PIPELINE_LLM_CMD が設定されていればそのコマンド（フィクスチャ用スタブ）に置き換わる。
//     スタブには env PIPELINE_LLM_PHASE（dest|same_meeting|generate|verify）と、
//     プロンプト全文を書いた一時ファイルのパスを env PIPELINE_LLM_INPUT で渡し、
//     stdout をモデル出力テキストとして受け取る（stdin ではなくファイル渡し＝大きな入力でも EPIPE しない）。
//
// 安全要件（最重要）: shadow モードはリポジトリを1バイトも変更しない。書き出しは /tmp と
// $GITHUB_STEP_SUMMARY のみ。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODE = (process.env.INGEST_PIPELINE_MODE || "shadow").toLowerCase() === "real" ? "real" : "shadow";
const MODEL = process.env.ANTHROPIC_MODEL || "global.anthropic.claude-sonnet-5";
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const log = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`::warning::ingest-minutes-pipeline: ${msg}\n`);

// ---------- 決定的: ファイル/設定の収集 ----------

function readText(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return null;
  }
}

// ディレクトリ名は案件でカスタマイズされ得る（会議/→MTG/ 等）。マーカーファイルの場所から導出する
// （fleet-status.mjs / resolve-external-sources.mjs と同じ流儀）。marker はルート直下か1階層下を探す。
function findDirByMarker(marker, fallback) {
  const root = listDir(".");
  if (root) {
    for (const d of root) {
      if (!d.isDirectory() || d.name === "node_modules" || d.name.startsWith(".")) continue;
      if (readText(`${d.name}/${marker}`) !== null) return d.name;
      for (const sub of listDir(d.name) || []) {
        if (sub.isDirectory() && readText(`${d.name}/${sub.name}/${marker}`) !== null) return d.name;
      }
    }
  }
  return fallback;
}

// 課題管理/issues/ 配下の実在課題キー集合（自己検証・機械検証で突合）。
function loadIssueKeys(issuesDir) {
  const keys = new Set();
  const keyRe = /[A-Z][A-Z0-9_]*-[0-9]+/g;
  const walk = (dir) => {
    for (const e of listDir(dir) || []) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".md")) {
        // 課題キーは本文の「課題キー: XXX-1」行、またはファイル名に現れる。両方から拾う。
        for (const m of `${e.name}\n${readText(full) || ""}`.matchAll(keyRe)) keys.add(m[0]);
      }
    }
  };
  walk(`${issuesDir}/issues`);
  return keys;
}

// 名簿（Cortex/メンバー/records/*.md）の title 一覧。人名の正規化・突合の材料。
function loadRosterTitles() {
  const titles = [];
  for (const e of listDir("Cortex/メンバー/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    const raw = readText(`Cortex/メンバー/records/${e.name}`) || "";
    const m = raw.match(/^title:\s*["']?([^"'\n#]+?)["']?\s*$/m);
    if (m && !/\{\{/.test(m[1])) titles.push(m[1].trim());
  }
  return titles;
}

// create-minute の様式（生成③・自己検証④の指示に使う）。
function loadSkill() {
  return readText(path.join(SCRIPT_DIR, "..", "skills", "create-minute", "SKILL.md")) || "";
}

// ---------- 決定的: 未処理文字起こしの列挙 ----------

// パス/ファイル名から会議日付（YYYYMMDD）を機械抽出。パス中の /{YYYYMMDD}/ を優先、
// 次にファイル名プレフィックス {YYYYMMDD}[-_]、最後にファイル名中の任意8桁。妥当性（年20xx・月日）も見る。
function plausibleDate(s) {
  if (!/^\d{8}$/.test(s)) return null;
  const y = +s.slice(0, 4), mo = +s.slice(4, 6), d = +s.slice(6, 8);
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return s;
}

function extractDate(relPath) {
  const segs = relPath.split("/");
  const base = segs[segs.length - 1];
  // パスセグメントが 8桁ちょうど
  for (const seg of segs.slice(0, -1)) {
    const hit = plausibleDate(seg);
    if (hit) return hit;
  }
  // ファイル名プレフィックス
  const pref = base.match(/^(\d{8})[-_]/);
  if (pref && plausibleDate(pref[1])) return pref[1];
  // ファイル名中の任意8桁
  for (const m of base.matchAll(/(\d{8})/g)) {
    const hit = plausibleDate(m[1]);
    if (hit) return hit;
  }
  return null;
}

const SKIP_BASENAMES = new Set(["ingest-config.json", "materials-config.json", "README.md", ".gitkeep"]);

function isTranscriptCandidate(relPath) {
  const base = path.basename(relPath);
  if (base.endsWith("_minutes.md")) return false; // 議事録そのもの
  if (SKIP_BASENAMES.has(base)) return false;
  if (relPath.split("/").includes("templates")) return false; // テンプレート置き場
  return true;
}

// 会議ディレクトリ配下を再帰走査し、未処理の文字起こしを列挙する。
//  - {YYYYMMDD} ディレクトリ配下のファイルは、その日付ディレクトリに _minutes.md が無いものだけ対象。
//  - 会議dir直下のフラット置き（notetaker投入分）も対象。
function enumerateTargets(meetingDir) {
  // まず各ディレクトリに _minutes.md があるか調べる
  const dirsWithMinute = new Set();
  const allDirs = new Set([meetingDir]);
  const files = [];
  const walk = (dir) => {
    for (const e of listDir(dir) || []) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        allDirs.add(full);
        walk(full);
      } else if (e.isFile()) {
        if (e.name.endsWith("_minutes.md")) dirsWithMinute.add(dir);
        files.push(full);
      }
    }
  };
  walk(meetingDir);

  const targets = [];
  for (const full of files) {
    if (!isTranscriptCandidate(full)) continue;
    const parent = path.dirname(full);
    // 日付ディレクトリ配下で、その日付ディレクトリに議事録が既にある → 処理済み
    if (parent !== meetingDir && dirsWithMinute.has(parent)) continue;
    const date = extractDate(full);
    if (!date) {
      warn(`日付を抽出できない文字起こしをスキップ: ${full}`);
      continue;
    }
    targets.push({ path: full, date, parent });
  }
  return { targets, existingDirs: allDirs };
}

// ---------- LLM 呼び出し（1関数に集約・env でスタブ差し替え可能） ----------

function callLLM(phase, { system, user, maxTokens, timeoutMs }) {
  const stub = process.env.PIPELINE_LLM_CMD;
  if (stub) {
    // プロンプトは一時ファイル渡し（stdin にすると大きな入力でスタブ側が読まない場合に EPIPE する）。
    const inFile = path.join(os.tmpdir(), `ingest-llm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      fs.writeFileSync(inFile, (system ? `SYSTEM:\n${system}\n\n` : "") + user, "utf-8");
      const r = spawnSync(stub, {
        shell: true,
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, PIPELINE_LLM_PHASE: phase, PIPELINE_LLM_INPUT: inFile },
      });
      if (r.status !== 0 || r.error) {
        warn(`LLMスタブ(${phase})が失敗しました: ${r.error ? r.error.message : `exit ${r.status}`}`);
        return null;
      }
      return (r.stdout || "").trim();
    } finally {
      try { fs.unlinkSync(inFile); } catch {}
    }
  }

  // 本番: aws bedrock-runtime converse
  const args = [
    "bedrock-runtime", "converse",
    "--model-id", MODEL,
    "--region", REGION,
    "--messages", JSON.stringify([{ role: "user", content: [{ text: user }] }]),
    "--inference-config", JSON.stringify({ maxTokens }), // temperature はSonnet 5で廃止（指定するとValidationException）
  ];
  if (system) args.push("--system", JSON.stringify([{ text: system }]));
  const r = spawnSync("aws", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error) {
    warn(`bedrock converse(${phase})が失敗しました: ${r.error ? r.error.message : (r.stderr || `exit ${r.status}`)}`);
    return null;
  }
  try {
    const out = JSON.parse(r.stdout || "{}");
    const blocks = out?.output?.message?.content || [];
    return blocks.map((b) => b.text || "").join("").trim();
  } catch {
    warn(`bedrock converse(${phase})の応答をJSONとして解釈できませんでした。`);
    return null;
  }
}

// JSON 出力の緩いパース（コードフェンス・前後の地の文を許容）。
function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(t.slice(i, j + 1));
    } catch {}
  }
  return null;
}

// JSON を期待する関数（①②④）: パース失敗時は1回だけ再試行。2回失敗なら null（呼び出し側でスキップ・報告）。
function callJSON(phase, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = callLLM(phase, opts);
    const obj = parseJsonLoose(text);
    if (obj) return obj;
    if (attempt === 0) warn(`${phase}: JSON解析に失敗。1回だけ再試行します。`);
  }
  return null;
}

// ---------- LLM 関数群 ----------

const SYS_COMMON =
  "あなたはCortex（案件コンテキスト基盤）の議事録パイプラインの一部です。指示に厳密に従い、余計な出力をしないでください。";

// ① 行き先判定: 文字起こしのタイトル/冒頭 ＋ 既存の会議ディレクトリ構造 → {dest_dir, reason}
function llmDecideDest(target, headText, existingDirsList) {
  const user = [
    "次の会議文字起こしを配置すべきディレクトリ（dest_dir）を判定してください。",
    "規約: 会議は 会議ディレクトリ配下の {定例名など}/{YYYYMMDD}/ に議事録・文字起こしを同居させます。",
    `この文字起こしの会議日付は ${target.date} です。dest_dir の末尾は必ずこの日付ディレクトリ（${target.date}）にしてください。`,
    "既存の定例（ディレクトリ）に該当するならそのパス配下に、該当しない新規会議なら既存の階層パターンに沿って新しいパスを作ってください。",
    "",
    "既存の会議ディレクトリ一覧:",
    existingDirsList.map((d) => `- ${d}`).join("\n"),
    "",
    "文字起こしファイル名: " + path.basename(target.path),
    "文字起こし冒頭:",
    headText,
    "",
    'JSONのみを出力: {"dest_dir": "<パス>", "reason": "<理由>"}',
  ].join("\n");
  return callJSON("dest", { system: SYS_COMMON, user, maxTokens: 512, timeoutMs: 90_000 });
}

// ② 同一会議判定: 既存議事録の H1/日付/出席者 ＋ 新文字起こしのタイトル/冒頭 → {same_meeting, reason}
function llmSameMeeting(existingMinuteHead, target, headText) {
  const user = [
    "同じ dest_dir に既存の議事録があります。新しい文字起こしがこの既存議事録と『同一の会議』かどうかを判定してください。",
    "",
    "既存議事録の冒頭（H1・日付・出席者など）:",
    existingMinuteHead,
    "",
    "新しい文字起こしファイル名: " + path.basename(target.path),
    "新しい文字起こし冒頭:",
    headText,
    "",
    'JSONのみを出力: {"same_meeting": true/false, "reason": "<理由>"}',
  ].join("\n");
  return callJSON("same_meeting", { system: SYS_COMMON, user, maxTokens: 512, timeoutMs: 90_000 });
}

// ③ 議事録生成: 文字起こし全文 ＋ SKILL様式 ＋ 名簿 → 議事録Markdown全文
function llmGenerate(target, fullText, skill, roster) {
  const user = [
    "以下の会議文字起こしから、次の様式（create-minute スキル）に厳密に従って議事録Markdownを生成してください。",
    "",
    "重要な出力ルール:",
    "- frontmatter（先頭の --- ブロック）は付けない。",
    "- H1（# で始まる見出し）から始める。",
    "- H1 の直後に必ず次の1行を入れる: > ⚠️ この議事録はAIによる自動生成です（人間レビュー前）。内容を確認したらこの行を削除してください。",
    "- 用語・人名は名簿の正式表記に正規化する。確定できない語・人名は ⚠️要確認 を付けて残す。",
    "- 議事録Markdown本文のみを出力し、コードフェンスや前置き・後置きは付けない。",
    "",
    "=== 名簿（正式表記） ===",
    roster.length ? roster.map((t) => `- ${t}`).join("\n") : "(名簿なし)",
    "",
    "=== 様式（create-minute/SKILL.md） ===",
    skill,
    "",
    "=== 文字起こし全文 ===",
    fullText,
  ].join("\n");
  return callLLM("generate", { system: SYS_COMMON, user, maxTokens: 8192, timeoutMs: 300_000 });
}

// ④ 自己検証パス: 生成議事録 ＋ 文字起こし ＋ 名簿 → {ok:true} または {ok:false, fixed_markdown}
function llmVerify(minute, fullText, roster) {
  const user = [
    "生成された議事録を、文字起こしと名簿に照らして自己検証してください（create-minute の第2パス相当）。",
    "チェック: 課題キーの実在性・担当者の名簿突合・日付×曜日・決定/TODOのステータス規律・文字起こしとの突合。",
    "誤りの疑いは上書き修正せず、該当箇所に ⚠️要確認 を付ける方針です。H1直後のAI自動生成バナー行は残すこと。",
    "軽微な修正がある場合のみ fixed_markdown に修正後の議事録全文を入れてください。問題なければ ok:true のみ。",
    "",
    "=== 名簿 ===",
    roster.length ? roster.map((t) => `- ${t}`).join("\n") : "(名簿なし)",
    "",
    "=== 生成議事録 ===",
    minute,
    "",
    "=== 文字起こし全文 ===",
    fullText,
    "",
    'JSONのみを出力: {"ok": true} もしくは {"ok": false, "fixed_markdown": "<修正後の議事録全文>"}',
  ].join("\n");
  return callJSON("verify", { system: SYS_COMMON, user, maxTokens: 8192, timeoutMs: 300_000 });
}

// ---------- 決定的: 機械検証 ----------

// dest_dir が許可パターン内か。既存ディレクトリ、または「既存の親ディレクトリ＋会議日付の新規ディレクトリ」のみ許可。
// 安全側: 会議ディレクトリの外・パス脱出・日付不一致は却下（スキップ多め）。
function validateDest(destRaw, target, existingDirs, meetingDir) {
  if (typeof destRaw !== "string" || !destRaw.trim()) return { ok: false, reason: "dest_dir が空" };
  let dest = destRaw.trim().replace(/\/+$/, "");
  const segs = dest.split("/");
  if (dest.startsWith("/") || segs.includes("..") || segs.includes(".") || segs.some((s) => s === "")) {
    return { ok: false, reason: "不正なパス" };
  }
  const underMeeting = dest === meetingDir || dest.startsWith(`${meetingDir}/`);
  if (!underMeeting) return { ok: false, reason: `会議ディレクトリ(${meetingDir})の外` };
  if (existingDirs.has(dest)) return { ok: true, dest };
  // 新規: 親が既存 かつ 末尾が会議日付
  const parent = path.dirname(dest);
  const base = path.basename(dest);
  if (existingDirs.has(parent) && base === target.date) return { ok: true, dest };
  return { ok: false, reason: "既存ディレクトリでも『既存の親＋会議日付』でもない" };
}

// 生成議事録の機械検証。H1あり・⚠️行あり・frontmatterなし・課題キー実在（無いキーは指摘）。
function mechanicalCheck(minute, issueKeys) {
  const startsWithFm = /^\s*---\s*\n/.test(minute);
  const hasH1 = /^#\s+\S/m.test(minute);
  const hasWarnLine = minute.includes("⚠️ この議事録はAIによる自動生成です");
  const keyRe = /[A-Z][A-Z0-9_]*-[0-9]+/g;
  const cited = [...new Set([...minute.matchAll(keyRe)].map((m) => m[0]))];
  const missingKeys = cited.filter((k) => !issueKeys.has(k));
  return {
    hasH1,
    hasWarnLine,
    noFrontmatter: !startsWithFm,
    citedKeys: cited,
    missingKeys,
    pass: hasH1 && hasWarnLine && !startsWithFm,
  };
}

// 実在しない課題キーに ⚠️ を付す（REAL・レポートの参考用。既存の ⚠️ を重複付与しない）。
function annotateMissingKeys(minute, missingKeys) {
  let out = minute;
  for (const k of missingKeys) {
    const re = new RegExp(`(${k})(?!\\s*⚠️)`, "g");
    out = out.replace(re, `$1 ⚠️要確認（実在しない課題キー）`);
  }
  return out;
}

// ---------- 決定的: 補助 ----------

function headOf(text, lines) {
  return (text || "").split(/\r?\n/).slice(0, lines).join("\n");
}

function existingMinuteInDir(dir) {
  for (const e of listDir(dir) || []) {
    if (e.isFile() && e.name.endsWith("_minutes.md")) return `${dir}/${e.name}`;
  }
  return null;
}

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失敗: ${r.stderr || ""}`);
  return (r.stdout || "").trim();
}

// ---------- メイン ----------

function main() {
  const meetingDir = findDirByMarker("ingest-config.json", "会議");
  const issuesDir = findDirByMarker("backlog-settings.json", "課題管理");

  const { targets, existingDirs } = enumerateTargets(meetingDir);

  // 対象0件 → LLM呼び出しゼロで即終了
  if (targets.length === 0) {
    log(`[ingest-minutes-pipeline] モード=${MODE} 会議ディレクトリ=${meetingDir} 対象=0件。処理なしで終了します。`);
    writeReport(`# ingest-minutes ${MODE}レポート\n\n- 会議ディレクトリ: ${meetingDir}\n- 対象文字起こし: 0件（未処理なし）\n`, "対象0件（未処理の文字起こしはありません）。");
    return;
  }

  // 対象がある時だけ重い収集を行う
  const issueKeys = loadIssueKeys(issuesDir);
  const roster = loadRosterTitles();
  const skill = loadSkill();
  const existingDirsList = [...existingDirs].sort();

  const results = [];
  for (const target of targets) {
    const res = processTarget(target, { meetingDir, existingDirs, existingDirsList, issueKeys, roster, skill });
    results.push(res);
  }

  emit(results, meetingDir);
}

function processTarget(target, ctx) {
  const fullText = readText(target.path) || "";
  const headText = headOf(fullText, 200);
  const res = { target, steps: {}, verdict: "", minute: null, mechanical: null };

  // ① 行き先判定
  const destObj = llmDecideDest(target, headText, ctx.existingDirsList);
  res.steps.dest = destObj;
  if (!destObj) {
    res.verdict = "スキップ（行き先判定の応答が不正）";
    return res;
  }
  let v = validateDest(destObj.dest_dir, target, ctx.existingDirs, ctx.meetingDir);
  if (!v.ok) {
    // 1回だけ再試行
    const retry = llmDecideDest(target, headText, ctx.existingDirsList);
    res.steps.destRetry = retry;
    v = retry ? validateDest(retry.dest_dir, target, ctx.existingDirs, ctx.meetingDir) : { ok: false, reason: "再試行の応答が不正" };
    if (!v.ok) {
      res.verdict = `スキップ（行き先が許可パターン外: ${v.reason}）`;
      return res;
    }
  }
  const dest = v.dest;
  res.dest = dest;

  // ② 同一会議判定（dest に既存 _minutes.md がある場合のみ）
  const existingMinutePath = ctx.existingDirs.has(dest) ? existingMinuteInDir(dest) : null;
  if (existingMinutePath) {
    const sm = llmSameMeeting(headOf(readText(existingMinutePath), 30), target, headText);
    res.steps.sameMeeting = sm;
    if (sm && sm.same_meeting === true) {
      res.verdict = "移動のみ（既存議事録と同一会議・生成スキップ）";
      return res;
    }
  }

  // ③ 議事録生成
  let minute = llmGenerate(target, fullText, ctx.skill, ctx.roster);
  if (!minute) {
    res.verdict = "スキップ（議事録生成に失敗）";
    return res;
  }

  // ④ 自己検証
  const verify = llmVerify(minute, fullText, ctx.roster);
  res.steps.verify = verify;
  if (verify && verify.ok === false && typeof verify.fixed_markdown === "string" && verify.fixed_markdown.trim()) {
    minute = verify.fixed_markdown;
    res.verifyFixed = true;
  }

  // 機械検証 ＋ 実在しない課題キーの⚠️付与
  const mech = mechanicalCheck(minute, ctx.issueKeys);
  if (mech.missingKeys.length) minute = annotateMissingKeys(minute, mech.missingKeys);
  res.mechanical = mech;
  res.minute = minute;
  res.verdict = mech.pass ? "生成（新規議事録）" : "生成（機械検証で要注意・レポート参照）";
  return res;
}

// ---------- 出力（モード分岐） ----------

function emit(results, meetingDir) {
  if (MODE === "real") {
    applyReal(results, meetingDir);
    return;
  }
  // SHADOW: リポジトリを一切変更しない。レポートのみ。
  const report = buildReport(results, meetingDir);
  const summary = buildSummary(results, meetingDir);
  writeReport(report, summary);
}

function buildSummary(results, meetingDir) {
  const lines = [];
  lines.push(`## 議事録パイプライン（シャドー）`);
  lines.push("");
  lines.push(`- 会議ディレクトリ: \`${meetingDir}\``);
  lines.push(`- 対象文字起こし: ${results.length}件`);
  lines.push("");
  lines.push("| # | 文字起こし | 日付 | 行き先 | 判定 |");
  lines.push("| --- | --- | --- | --- | --- |");
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | \`${path.basename(r.target.path)}\` | ${r.target.date} | ${r.dest ? `\`${r.dest}\`` : "-"} | ${r.verdict} |`);
  });
  return lines.join("\n") + "\n";
}

function buildReport(results, meetingDir) {
  const stamp = new Date().toISOString();
  const out = [];
  out.push(`# ingest-minutes シャドーレポート`);
  out.push("");
  out.push(`- 生成時刻: ${stamp}`);
  out.push(`- モード: shadow（リポジトリ無変更）`);
  out.push(`- 会議ディレクトリ: ${meetingDir}`);
  out.push(`- 対象文字起こし: ${results.length}件`);
  out.push("");
  out.push(buildSummary(results, meetingDir));
  out.push("---");
  out.push("");
  out.push("## 詳細");
  results.forEach((r, i) => {
    out.push("");
    out.push(`### ${i + 1}. ${r.target.path}`);
    out.push(`- 会議日付: ${r.target.date}`);
    out.push(`- 判定: ${r.verdict}`);
    out.push("- 行き先判定(①): " + jsonInline(r.steps.dest));
    if (r.steps.destRetry) out.push("- 行き先判定 再試行: " + jsonInline(r.steps.destRetry));
    if (r.steps.sameMeeting) out.push("- 同一会議判定(②): " + jsonInline(r.steps.sameMeeting));
    if (r.steps.verify) out.push("- 自己検証(④): " + jsonInline(r.steps.verify));
    if (r.mechanical) {
      const m = r.mechanical;
      out.push(`- 機械検証: H1=${m.hasH1} ⚠️バナー=${m.hasWarnLine} frontmatterなし=${m.noFrontmatter} 引用課題キー=[${m.citedKeys.join(", ")}] 未実在キー=[${m.missingKeys.join(", ")}]`);
    }
    if (r.minute != null) {
      out.push("");
      out.push("#### 生成議事録（全文）");
      out.push("");
      out.push("~~~markdown");
      out.push(r.minute);
      out.push("~~~");
    }
  });
  return out.join("\n") + "\n";
}

function jsonInline(obj) {
  if (obj == null) return "(応答なし/不正)";
  try {
    return "`" + JSON.stringify(obj) + "`";
  } catch {
    return String(obj);
  }
}

// レポート全文を /tmp に、判断サマリを $GITHUB_STEP_SUMMARY に、全文を run log に出す。
// いずれもリポジトリ外への書き出し（shadow の無変更要件を守る）。
function writeReport(report, summary) {
  const file = path.join(os.tmpdir(), `ingest-minutes-shadow-${Date.now()}.md`);
  try {
    fs.writeFileSync(file, report, "utf-8");
    log(`[ingest-minutes-pipeline] シャドーレポート: ${file}`);
  } catch (e) {
    warn(`レポートの /tmp 書き出しに失敗: ${e.message}`);
  }
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      fs.appendFileSync(stepSummary, (typeof summary === "string" ? summary : "") + "\n");
    } catch (e) {
      warn(`$GITHUB_STEP_SUMMARY への書き出しに失敗: ${e.message}`);
    }
  }
  // run log にも全文（artifact代替・観察用）
  log("----- ingest-minutes shadow report (begin) -----");
  log(report);
  log("----- ingest-minutes shadow report (end) -----");
}

// ---------- REAL モード（コードとして実装・ワークフローからは未呼び出し） ----------

// git mv（移動）→議事録書き込み→git commit。push はワークフロー側。
// 注意: この関数は INGEST_PIPELINE_MODE=real のときのみ実行される。シャドー展開では絶対に呼ばれない。
function applyReal(results, meetingDir) {
  let committed = 0;
  for (const r of results) {
    try {
      if (r.verdict.startsWith("スキップ")) continue;
      const dest = r.dest;
      if (!dest) continue;
      fs.mkdirSync(dest, { recursive: true });
      // 文字起こし原本を dest へ移動（日付プレフィックスは除いてよい）。
      const base = path.basename(r.target.path).replace(/^\d{8}[-_]/, "");
      const movedTo = `${dest}/${base}`;
      if (path.resolve(r.target.path) !== path.resolve(movedTo)) {
        git(["mv", r.target.path, movedTo]);
      }
      if (r.minute != null) {
        // 「移動のみ」判定でなければ議事録を書く
        const minutePath = `${dest}/${r.target.date}_minutes.md`;
        fs.writeFileSync(minutePath, r.minute, "utf-8");
        git(["add", minutePath]);
      }
      git(["add", "-A", dest]);
      const label = dest.split("/").slice(-2).join("/");
      const msg = r.minute != null ? `議事録を自動生成（${label}）` : `文字起こしを既存議事録に同居（${label}）`;
      git(["commit", "-m", msg]);
      committed++;
    } catch (e) {
      warn(`REAL適用に失敗（${r.target.path}）: ${e.message}`);
    }
  }
  log(`[ingest-minutes-pipeline] REAL: ${committed}件をコミットしました（push はワークフロー側）。`);
}

main();
