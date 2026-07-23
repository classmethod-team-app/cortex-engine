#!/usr/bin/env node
// 夜間Gold昇格（update-gold）の「決定的パイプライン＋LLM関数化」オーケストレータ（Node単体・npm依存なし）。
//
// 現行のGold昇格は claude -p の自由行動エージェント（max-turns 150）で、ソース列挙・採番・重複照合まで
// AI に任せているため、ターン枯渇・タイムアウト等の確率的失敗が起きる。ingest-minutes-pipeline.mjs で
// 確立した「機械的にできることは決定的に・判断だけを小さな LLM 関数に切り出す」型を Gold にも適用する。
// 本スクリプトのスコープはシャドーモードまで（REAL モードはコードとして実装するがワークフローからは呼ばない）。
//
// 実行モード（env GOLD_PIPELINE_MODE。既定 shadow）:
//   - shadow: リポジトリを一切変更しない。起票するはずだった Decision/用語/メンバー/日次レポートの全文を
//             1つの Markdown レポートにまとめ、$GITHUB_STEP_SUMMARY にサマリ表、全文を /tmp と run log に出す。
//             env GOLD_PRE_HEAD があれば「本番（claude -p）が実際に起票したファイル一覧」を git diff から
//             機械取得して併記する（同一 run 内でシャドーと本番を突き合わせるため）。
//   - real:   validate-cortex.mjs による検証→ファイル書込→フェーズ別コミット（Decisions→用語集→メンバー→レポート）。
//             push はワークフロー側（本スクリプトはしない）。
//
// 各フェーズの規律は既存スキル（update-gold-auto / update-decision-log-auto / update-glossary-auto）に従う:
//   - ソース列挙は changed-sources.sh / external-sources.sh と同一スクリプト（二重定義によるドリフト防止）
//   - 会議ディレクトリ配下は議事録（*_minutes.md）のみ読む（文字起こし原本は読まない）
//   - 採番は「決定日の既存最大NNN+1」（ファイル名から機械取得）・重複照合は正規化titleの突合
//   - 用語・メンバーは status: draft（事後レビュー方式）・既存レコードは書き換えない（新規追加のみ）
//   - 公開範囲フィルタ（内部限定情報を書かない）はプロンプトに転記して維持
//
// LLM 呼び出し（ingest-minutes-pipeline と同じ流儀）:
//   - 既定は `aws bedrock-runtime converse`（OIDC 認証済みランナー・aws CLI 標準搭載）。
//     モデルは env ANTHROPIC_MODEL、リージョンは env AWS_REGION。
//   - env PIPELINE_LLM_CMD が設定されていればそのコマンド（フィクスチャ用スタブ）に置き換わる。
//     スタブには env PIPELINE_LLM_PHASE（decision|term|member|batch）と、プロンプト全文を書いた
//     一時ファイルのパスを env PIPELINE_LLM_INPUT で渡し、stdout をモデル出力テキストとして受け取る。
//   - JSON 出力はパース失敗時に1回だけ再試行。再試行も失敗ならそのソース×関数をスキップして報告
//     （冪等・逐次: 1件の失敗は1件の欠落として報告に載るだけで、パイプライン全体は落とさない）。
//
// 安全要件（最重要）: shadow モードはリポジトリを1バイトも変更しない。書き出しは /tmp と
// $GITHUB_STEP_SUMMARY のみ。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODE = (process.env.GOLD_PIPELINE_MODE || "shadow").toLowerCase() === "real" ? "real" : "shadow";
const MODEL = process.env.ANTHROPIC_MODEL || "global.anthropic.claude-sonnet-5";
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const SINCE = process.env.SINCE || "";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// 1ソースあたりの本文上限（converse への引数長の安全上限。超過分は切って警告）
const SOURCE_CHAR_CAP = 150_000;

const log = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`::warning::update-gold-pipeline: ${msg}\n`);

// ---------- 決定的: 基本ヘルパ ----------

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

// JST の今日（YYYYMMDD / YYYY-MM-DD）
function jstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const ymd = d.toISOString().slice(0, 10).replaceAll("-", "");
  return { ymd, dateH: d.toISOString().slice(0, 10) };
}

// 重複照合用の正規化（空白・記号を落として小文字化。プログラム側の完全一致判定に使う）
function normalizeSig(s) {
  return String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

// ファイル名に使えない文字を除去（要約・代表表記のスラグ化）
function sanitizeName(s, maxLen = 60) {
  const cleaned = String(s || "")
    .replace(/[\\/:*?"<>|\r\n]/g, "")
    .replace(/\s+/g, "")
    .trim();
  return cleaned.slice(0, maxLen) || "無題";
}

// YAML の二重引用符スカラとして安全な文字列（JSON 文字列は YAML double-quoted の部分集合）
function yq(s) {
  return JSON.stringify(String(s ?? ""));
}

// ディレクトリ名は案件でカスタマイズされ得る（会議/→MTG/ 等）。マーカーファイルの場所から導出する
// （fleet-status.mjs / ingest-minutes-pipeline.mjs と同じ流儀）。
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

// ---------- 決定的: ソース列挙 ----------

// リポ内差分ソース: changed-sources.sh "$SINCE" "Cortex/"（ワークフローの差分ゲートと同一スクリプト）。
// 会議ディレクトリ配下は *_minutes.md のみ（文字起こし原本は読まない＝スキルの規律）。
function enumerateRepoSources(meetingDir) {
  const r = spawnSync("bash", [path.join(SCRIPT_DIR, "changed-sources.sh"), SINCE, "Cortex/"], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error) {
    warn(`changed-sources.sh の実行に失敗: ${r.error ? r.error.message : r.stderr || `exit ${r.status}`}`);
    return [];
  }
  const out = [];
  for (const line of (r.stdout || "").split("\n")) {
    const f = line.trim();
    if (!f || !f.endsWith(".md")) continue;
    const underMeeting = f === meetingDir || f.startsWith(`${meetingDir}/`);
    if (underMeeting && !f.endsWith("_minutes.md")) continue; // 文字起こし原本・アジェンダ等は読まない
    if (readText(f) === null) continue; // 削除済みファイル（差分に現れるが実体なし）はスキップ
    out.push(f);
  }
  return [...new Set(out)];
}

// 外部ソース: external-sources.sh "$SINCE" の出力（見出し付きテキスト）を、
// 「## [type] ref ...」見出し単位のチャンクに分割する。コメント節（### [type] ref #N のコメント）は
// 同じ番号の本体チャンクへ再結合する（emit順の都合で本体群の後にまとまるため）。
function enumerateExternalSources() {
  const r = spawnSync("bash", [path.join(SCRIPT_DIR, "external-sources.sh"), SINCE], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error) {
    warn(`external-sources.sh の実行に失敗（外部ソースなしとして続行）: ${r.error ? r.error.message : `exit ${r.status}`}`);
    return [];
  }
  const text = (r.stdout || "").trim();
  if (!text) return [];

  const chunks = [];
  let cur = null;
  const flush = () => {
    if (cur && !cur._inChunks) chunks.push(cur);
    cur = null;
  };
  for (const line of text.split("\n")) {
    const head = line.match(/^## \[([a-z-]+)\] (.+)$/);
    if (head) {
      flush();
      // 見出し例: "[github-issues] owner/repo #12 タイトル (state: open) (updated ...)" / "[slack] #general (3 messages since ...)"
      const type = head[1];
      const rest = head[2];
      const refMatch = rest.match(/^(\S+)/);
      const numMatch = rest.match(/#(\d+)\s/);
      cur = {
        kind: "external",
        type,
        ref: refMatch ? refMatch[1] : rest,
        number: numMatch ? numMatch[1] : null,
        label: `[${type}] ${rest}`,
        lines: [line],
      };
      continue;
    }
    const cmt = line.match(/^### \[([a-z-]+)\] (\S+) #(\d+) のコメント$/);
    if (cmt) {
      // 同じ type+ref+番号の本体チャンクへ再結合（emit順の都合でコメント節は本体群の後に来る）
      const target = chunks.concat(cur ? [cur] : []).find(
        (c) => c.type === cmt[1] && c.ref === cmt[2] && c.number === cmt[3],
      );
      if (target && target !== cur) {
        flush();
        target.lines.push(line);
        // 以降の行は次の見出しまでこのチャンクに積む（既に chunks に入っているので二重 push を防ぐ印を付ける）
        cur = target;
        cur._inChunks = true;
        continue;
      }
    }
    if (cur) cur.lines.push(line);
  }
  flush();
  return chunks.map((c) => ({
    kind: "external",
    type: c.type,
    ref: c.ref,
    label: c.label,
    content: c.lines.join("\n"),
  }));
}

// 外部ソースの decisions オプション（none なら Decision を作らない）。external-sources.json から機械取得。
function loadDecisionsGate() {
  const map = new Map();
  const raw = readText("Cortex/external-sources.json");
  if (!raw) return map;
  try {
    const cfg = JSON.parse(raw);
    for (const s of cfg.sources || []) {
      const ref = s.repo || s.channel || "";
      if (s.type && ref && s.decisions !== undefined) map.set(`${s.type}\t${ref}`, s.decisions);
    }
  } catch {
    warn("Cortex/external-sources.json のJSON解析に失敗。decisions ゲートなしで続行します。");
  }
  return map;
}

// ---------- 決定的: 照合材料の収集（全文Readせず frontmatter だけ抜く） ----------

// frontmatter ブロック（先頭 --- 〜 次の ---）だけを返す
function frontmatterOf(raw) {
  if (!raw || !raw.startsWith("---")) return "";
  const end = raw.indexOf("\n---", 3);
  return end === -1 ? "" : raw.slice(0, end);
}

function fmField(fmText, field) {
  const m = fmText.match(new RegExp(`^${field}:\\s*["']?([^"'\\n#]+?)["']?\\s*$`, "m"));
  return m ? m[1].trim() : "";
}

function fmListField(fmText, field) {
  // インライン配列（synonyms: ["a", "b"]）のみ対応（テンプレ準拠の生成物はこの形）
  const m = fmText.match(new RegExp(`^${field}:\\s*\\[(.*)\\]\\s*$`, "m"));
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// 既存 Decision: 採番用のファイル名一覧＋重複照合用の title 一覧
function loadExistingDecisions() {
  const fileNames = [];
  const titles = [];
  for (const e of listDir("Cortex/Decisions/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    fileNames.push(e.name);
    const fm = frontmatterOf(readText(`Cortex/Decisions/records/${e.name}`) || "");
    const t = fmField(fm, "title");
    if (t) titles.push(t);
  }
  return { fileNames, titles };
}

// 既存用語: title / synonyms の集合
function loadExistingTerms() {
  const titles = [];
  const sigs = new Set();
  for (const e of listDir("Cortex/用語集/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    const fm = frontmatterOf(readText(`Cortex/用語集/records/${e.name}`) || "");
    const t = fmField(fm, "title");
    if (t) {
      titles.push(t);
      sigs.add(normalizeSig(t));
    }
    for (const s of fmListField(fm, "synonyms")) sigs.add(normalizeSig(s));
  }
  return { titles, sigs };
}

// 用語集 README の「除外用語」（過去にレビューで却下された語の再追加防止）
function loadExcludedTerms() {
  const raw = readText("Cortex/用語集/README.md") || "";
  const m = raw.match(/^#{2,3}\s*除外用語\s*$([\s\S]*?)(?=^#{1,3}\s|\n*$(?![\s\S]))/m);
  const result = { raw: [], sigs: new Set() };
  if (!m) return result;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^\s*[-*]\s+`?([^`\s].*?)`?\s*(（.*）)?\s*$/);
    if (item) {
      result.raw.push(item[1]);
      result.sigs.add(normalizeSig(item[1]));
    }
  }
  return result;
}

// 名簿: title / aliases の一覧と正規化集合
function loadRoster() {
  const names = [];
  const sigs = new Set();
  for (const e of listDir("Cortex/メンバー/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    const fm = frontmatterOf(readText(`Cortex/メンバー/records/${e.name}`) || "");
    const t = fmField(fm, "title");
    if (t) {
      names.push(t);
      sigs.add(normalizeSig(t));
    }
    for (const a of fmListField(fm, "aliases")) sigs.add(normalizeSig(a));
  }
  return { names, sigs, dirExists: listDir("Cortex/メンバー/records") !== null };
}

// ---------- LLM 呼び出し（ingest-minutes-pipeline と同じヘルパ流儀） ----------

function callLLM(phase, { system, user, maxTokens, timeoutMs }) {
  const stub = process.env.PIPELINE_LLM_CMD;
  if (stub) {
    // プロンプトは一時ファイル渡し（stdin だと大きな入力でスタブ側が読まない場合に EPIPE する）
    const inFile = path.join(os.tmpdir(), `gold-llm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
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

function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {}
  // 先頭の JSON 配列/オブジェクトを緩く切り出す
  for (const [open, close] of [["[", "]"], ["{", "}"]]) {
    const i = t.indexOf(open), j = t.lastIndexOf(close);
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch {}
    }
  }
  return null;
}

// JSON を期待する関数: パース失敗時は1回だけ再試行。2回失敗なら null（呼び出し側でスキップ・報告）
function callJSON(phase, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = callLLM(phase, opts);
    const obj = parseJsonLoose(text);
    if (obj !== null) return obj;
    if (attempt === 0) warn(`${phase}: JSON解析に失敗。1回だけ再試行します。`);
  }
  return null;
}

// ---------- LLM 関数群（A: Decision / B: 用語 / C: メンバー / D: バッチ統合） ----------

const SYS_COMMON =
  "あなたはCortex（案件コンテキスト基盤）の夜間Gold昇格パイプラインの一部です。指示に厳密に従い、JSONのみを出力してください。";

// 公開範囲フィルタ（update-gold-auto/SKILL.md の文言を転記。全抽出関数の共通規律）
const PRIVACY_RULE = [
  "公開範囲フィルタ（必ず適用）: 内部限定情報（売上・利益率・原価・見積・アサイン工数・単価・人事評価・",
  "顧客/ベンダーへの率直な評価・内部限定のリスク所感等）は抽出結果に一切含めない。",
  "とくにチャット由来のソースは内部の雑談・評価が混ざりやすいので注意する（Gold＝顧客可視面）。",
].join("");

// A: Decision抽出。確定/未確定の基準は update-decision-log-auto/SKILL.md ステップ3の文言を転記。
function llmExtractDecisions(source, existingTitles, rosterNames) {
  const user = [
    "次のソースから、確定した意思決定だけを抽出してください。",
    "",
    "抽出対象（確定表現のみ）: 「〜で決定」「〜にした」「〜で進める」「〜で合意した」「〜方針とする」等の完了・確定の表現。",
    "議事録は「決定事項まとめ」セクションを主たる情報源とする。課題は、質問→回答で方針が確定したやり取り・合意表現。",
    "除外するもの: 質問のみ・回答待ち（未確定）、「確認中」「検討中」等の未確定表現。",
    "「〜で合意する」「〜で決める」「後段で合意」「本会で確定」等、これから決める予定を表す未来形・予定表現（=アジェンダ論点）。",
    "アカウントセットアップ・環境構築等の運用作業。些末な実装細部。",
    "未開催の定例ファイル（アジェンダ）からは抽出しない: 協議予定セクションだけのもの・「決定事項まとめ」が空のもの・実施日が未来のもの。",
    "抽出範囲は機能要件に限らず、仕様・設計・運用・ビジネスの確定事項すべて。根拠（ソース中の該当発言の引用）を必ず quote に入れ、根拠を示せないものは抽出しない。",
    PRIVACY_RULE,
    "",
    "既存Decisionのタイトル一覧（これらと同一・実質同一の決定は抽出しない＝重複回避）:",
    existingTitles.length ? existingTitles.map((t) => `- ${t}`).join("\n") : "(なし)",
    "",
    "名簿（deciders はこの正式表記に正規化する。名簿に無い人名は「名前（要確認）」と書く）:",
    rosterNames.length ? rosterNames.map((t) => `- ${t}`).join("\n") : "(名簿なし)",
    "",
    `カテゴリーは次から選ぶ: ビジネス / 技術選定 / 設計方針 / 運用ルール / インフラ / デザイン`,
    "based_on はソースの安定ID（議事録: minute:{定例名}:{YYYYMMDD}、課題: 課題キー、外部: owner/repo#N）。分からなければ空文字。",
    "date は決定が行われた日（会議日・コメント日。実行日ではない）を YYYYMMDD で。",
    "",
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    'JSON配列のみを出力（0件なら []）:',
    '[{"date": "YYYYMMDD", "title": "...", "description": "...", "deciders": ["..."], "category": "...", "based_on": "...", "quote": "..."}]',
  ].join("\n");
  return callJSON("decision", { system: SYS_COMMON, user, maxTokens: 4096, timeoutMs: 240_000 });
}

// B: 用語抽出（update-glossary-auto/SKILL.md ステップ3の基準を転記。Webツールなし前提＝定義が明示された語のみ）
function llmExtractTerms(source, existingTermTitles, excludedList) {
  const user = [
    "次のソースから、用語集に登録すべき案件固有の新規用語を抽出してください。",
    "",
    "対象: 案件・業界固有の用語、社内略語、一般語だがこの案件で特別な意味を持つ語。",
    "定義がソース中に明示されている語のみ登録する。文脈からの推測で定義を書かない。",
    "Web検索は使えない実行環境なので、一般公開のサービス・技術用語で定義がソースに無いものは登録しない。",
    "確信が持てない語は登録しない（過剰登録はノイズとなり用語集の信頼を損なう。直コミットされるため保守的に判断する）。",
    PRIVACY_RULE,
    "",
    "既存用語のタイトル一覧（これらと同一・実質同義の語は抽出しない＝重複回避）:",
    existingTermTitles.length ? existingTermTitles.map((t) => `- ${t}`).join("\n") : "(なし)",
    excludedList.length ? "除外用語（過去にレビューで却下。再追加しない）:\n" + excludedList.map((t) => `- ${t}`).join("\n") : "",
    "",
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    'JSON配列のみを出力（0件なら []）:',
    '[{"term": "代表表記", "yomi": "よみ", "definition": "この案件における意味（ソースに明示された定義）", "synonyms": ["..."]}]',
  ].join("\n");
  return callJSON("term", { system: SYS_COMMON, user, maxTokens: 2048, timeoutMs: 180_000 });
}

// C: メンバー抽出（update-gold-auto/SKILL.md Phase C の基準を転記。未登録のみ・確証なければ起票しない）
function llmExtractMembers(source, rosterNames) {
  const user = [
    "次のソースに登場する人物のうち、名簿に無い新規メンバー候補を抽出してください。",
    "",
    "対象: 議事録の参加者欄・発言者、チャットの発言者（表示名から氏名の見当がつくもののみ）。",
    "GitHub の author（login のみ）は氏名の確証が持てないことが多いので、login から実名が明らかな場合を除き抽出しない。",
    "氏名の確証が持てない場合（ハンドルネームのみ等）は抽出しない（過剰起票はノイズ）。",
    "side は cm（開発側）/ client（顧客）/ vendor（ベンダー）のいずれか。不明なら空文字。",
    PRIVACY_RULE.replace("抽出結果", "org/role"),
    "",
    "名簿（既登録。これらの人物は抽出しない）:",
    rosterNames.length ? rosterNames.map((t) => `- ${t}`).join("\n") : "(名簿なし)",
    "",
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    'JSON配列のみを出力（0件なら []）:',
    '[{"name": "氏名", "yomi": "よみ", "org": "所属組織", "side": "cm|client|vendor|", "role": "役割"}]',
  ].join("\n");
  return callJSON("member", { system: SYS_COMMON, user, maxTokens: 1024, timeoutMs: 120_000 });
}

// D: バッチ統合パス（1回だけ）: 全ソースの抽出結果を横断チェックし、重複統合・supersedes候補の指摘と
//    「今日の概要」（日次レポート用3-6行）を生成する。指摘は報告用（採番済みファイルは変更しない）。
function llmBatchReview(decisions, terms, members, sourceLabels) {
  const user = [
    "夜間Gold昇格の当日抽出結果一式です。横断チェックを行ってください。",
    "",
    "1. duplicates: 抽出結果の中で実質同一の決定があれば、そのタイトルの組を指摘する（統合の提案。ファイル操作はしない）。",
    "2. supersedes_candidates: 過去の決定を置き換えていそうな決定があれば「新タイトル → 置き換え対象の既存タイトル/ID」を指摘する。",
    "3. summary: 「今日の概要」を3〜6行で。プロジェクトに何が起きたか（顧客とのやり取り・議論の進展・決まったこと・進行中の作業・浮上した課題）を書く。",
    "   書かないこと: Gold昇格の件数・「差分ソースがN件だった」等のシステム内部動作。",
    PRIVACY_RULE,
    "",
    "=== 当日の差分ソース一覧 ===",
    sourceLabels.map((s) => `- ${s}`).join("\n") || "(なし)",
    "",
    "=== 抽出された決定 ===",
    JSON.stringify(decisions, null, 1),
    "",
    "=== 抽出された用語 ===",
    JSON.stringify(terms, null, 1),
    "",
    "=== 抽出されたメンバー ===",
    JSON.stringify(members, null, 1),
    "",
    'JSONのみを出力:',
    '{"duplicates": [["タイトルA", "タイトルB"], ...], "supersedes_candidates": ["新タイトル → 既存タイトル/ID", ...], "summary": "..."}',
  ].join("\n");
  return callJSON("batch", { system: SYS_COMMON, user, maxTokens: 2048, timeoutMs: 180_000 });
}

// ---------- 決定的: 検証・採番・frontmatter組み立て ----------

// 決定の採番: 日付ごとの既存最大NNN+1（ファイル名から機械取得。update-decision-log-auto ステップ2と同じ規律）
function nextDecisionNumber(dateYmd, existingFileNames, allocated) {
  let max = 0;
  for (const n of existingFileNames) {
    const m = n.match(new RegExp(`^${dateYmd}-(\\d{3})`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  for (const id of allocated) {
    const m = id.match(new RegExp(`^${dateYmd}-(\\d{3})$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, "0");
}

const CATEGORIES = new Set(["ビジネス", "技術選定", "設計方針", "運用ルール", "インフラ", "デザイン"]);

// LLM抽出の決定を検証・採番して「起票予定ファイル」に確定する。
// 重複排除: 既存title・当夜バッチ内titleの正規化完全一致はプログラム側でも落とす（LLM任せにしない保険）。
function buildDecisionFiles(extracted, existing, batchSigs) {
  const files = [];
  const skipped = [];
  const allocated = [];
  for (const d of extracted) {
    const title = String(d.title || "").trim();
    const date = String(d.date || "").trim();
    if (!title || !/^\d{8}$/.test(date)) {
      skipped.push({ item: d, reason: "title または date(YYYYMMDD) が不正" });
      continue;
    }
    const sig = normalizeSig(title);
    if (existing.sigs.has(sig) || batchSigs.has(sig)) {
      skipped.push({ item: d, reason: "既存/当夜バッチ内の Decision と正規化titleが一致（重複）" });
      continue;
    }
    batchSigs.add(sig);
    const nnn = nextDecisionNumber(date, existing.fileNames, allocated);
    const id = `${date}-${nnn}`;
    allocated.push(id);
    const dateH = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const deciders = (Array.isArray(d.deciders) ? d.deciders : []).map((x) => String(x).trim()).filter(Boolean);
    if (!deciders.length) deciders.push("不明（要確認）");
    const category = CATEGORIES.has(d.category) ? d.category : "ビジネス";
    const basedOn = String(d.based_on || "").trim();
    const ref = String(d.source_ref || "").trim() || basedOn || "（出典要確認）";
    const fm = [
      "---",
      "type: decision",
      `id: ${yq(id)}`,
      `title: ${yq(title)}`,
      `date: ${dateH}`,
      `category: ${category}`,
      "deciders:",
      ...deciders.map((x) => `  - ${yq(x)}`),
      `description: ${yq(String(d.description || title))}`,
      ...(basedOn
        ? ["relations:", "  - rel: based_on", `    target: ${yq(basedOn)}`]
        : []),
      "references:",
      `  - ${yq(ref)}`,
      "---",
    ].join("\n");
    const body = [
      "",
      `# ${title}`,
      "",
      "## 背景",
      "",
      `> ${String(d.quote || "").trim() || "（根拠引用なし・要確認）"}`,
      "",
      "## 理由",
      "",
      String(d.description || "").trim() || "（記載なし）",
      "",
    ].join("\n");
    files.push({
      path: `Cortex/Decisions/records/${id}-${sanitizeName(title)}.md`,
      id,
      title,
      content: fm + body,
    });
  }
  return { files, skipped };
}

// 用語: 既存title/synonyms・除外リスト・当夜バッチ内の正規化一致を落とし、status: draft で組み立てる
function buildTermFiles(extracted, existingTerms, excludedSigs, batchSigs, dateH) {
  const files = [];
  const skipped = [];
  for (const t of extracted) {
    const term = String(t.term || "").trim();
    const definition = String(t.definition || "").trim();
    if (!term || !definition) {
      skipped.push({ item: t, reason: "term または definition が空" });
      continue;
    }
    const sig = normalizeSig(term);
    if (existingTerms.sigs.has(sig)) {
      skipped.push({ item: t, reason: "既存用語（title/synonyms）と一致" });
      continue;
    }
    if (excludedSigs.has(sig)) {
      skipped.push({ item: t, reason: "除外用語リストに該当" });
      continue;
    }
    if (batchSigs.has(sig)) {
      skipped.push({ item: t, reason: "当夜バッチ内で重複" });
      continue;
    }
    batchSigs.add(sig);
    const safe = sanitizeName(term);
    const synonyms = (Array.isArray(t.synonyms) ? t.synonyms : []).map((x) => String(x).trim()).filter(Boolean);
    const fm = [
      "---",
      "type: term",
      `id: ${yq(`term:${safe}`)}`,
      `title: ${yq(safe)}`,
      `description: ${yq(definition.split("\n")[0].slice(0, 120))}`,
      `synonyms: [${synonyms.map(yq).join(", ")}]`,
      "scope: project",
      "status: draft",
      `date: ${dateH}`,
      ...(t.source ? [`source: ${yq(String(t.source))}`] : []),
      "---",
    ].join("\n");
    files.push({
      path: `Cortex/用語集/records/${safe}.md`,
      id: `term:${safe}`,
      title: safe,
      content: fm + `\n\n${definition}\n`,
    });
  }
  return { files, skipped };
}

// メンバー: 名簿（title/aliases）・当夜バッチ内の正規化一致を落とし、status: draft で組み立てる
function buildMemberFiles(extracted, roster, batchSigs) {
  const files = [];
  const skipped = [];
  if (!roster.dirExists) {
    if (extracted.length) skipped.push({ item: null, reason: "Cortex/メンバー/records が無い案件のためフェーズごとスキップ" });
    return { files, skipped };
  }
  for (const m of extracted) {
    const name = String(m.name || "").trim();
    if (!name) {
      skipped.push({ item: m, reason: "name が空" });
      continue;
    }
    const sig = normalizeSig(name);
    if (roster.sigs.has(sig)) {
      skipped.push({ item: m, reason: "名簿（title/aliases）に既登録" });
      continue;
    }
    if (batchSigs.has(sig)) {
      skipped.push({ item: m, reason: "当夜バッチ内で重複" });
      continue;
    }
    batchSigs.add(sig);
    const compact = name.replace(/[\s　]+/g, "");
    const side = ["cm", "client", "vendor"].includes(m.side) ? m.side : "";
    const org = String(m.org || "").trim();
    const role = String(m.role || "").trim();
    const description = `${org ? `${org}所属。` : ""}${role ? `${role}。` : "役割は確認中。"}`;
    const fm = [
      "---",
      "type: member",
      `id: ${yq(`member:${sanitizeName(compact)}`)}`,
      `title: ${yq(name)}`,
      `description: ${yq(description)}`,
      ...(m.yomi ? [`yomi: ${yq(String(m.yomi))}`] : []),
      ...(org ? [`org: ${yq(org)}`] : []),
      ...(side ? [`side: ${side}`] : []),
      ...(role ? [`role: ${yq(role)}`] : []),
      "status: draft",
      "---",
    ].join("\n");
    files.push({
      path: `Cortex/メンバー/records/${sanitizeName(compact)}.md`,
      id: `member:${sanitizeName(compact)}`,
      title: name,
      content: fm + `\n\n${description}\n`,
    });
  }
  return { files, skipped };
}

// 日次レポートの組み立て（テンプレ準拠・件数は機械集計・概要はバッチ統合パスDの出力）
function buildDailyReport({ ymd, dateH }, counts, summary, decisionFiles, termFiles, memberFiles, sourceLabels, viewerUrl) {
  const linkOf = (id, title) => {
    if (viewerUrl) return `[${title}](${viewerUrl}/?id=${encodeURIComponent(id)})`;
    return `\`${id}\` ${title}`;
  };
  const summaryText = String(summary || "").trim() || "（概要生成に失敗。当日のソース一覧を参照）";
  const fm = [
    "---",
    "type: report",
    `id: ${yq(`report:${ymd}-daily`)}`,
    `title: ${yq(`${dateH} デイリーレポート`)}`,
    `description: ${yq(summaryText.split("\n")[0].slice(0, 120))}`,
    `date: ${dateH}`,
    "status: active",
    "sources:",
    `  changed_files: ${counts.changedFiles}`,
    `  decisions_added: ${decisionFiles.length}`,
    `  terms_added: ${termFiles.length}`,
    `  members_added: ${memberFiles.length}`,
    "---",
  ].join("\n");
  const body = [
    "",
    `# ${dateH} デイリーレポート`,
    "",
    "## 今日の概要",
    "",
    summaryText,
    "",
    "## 新しい決定",
    "",
    decisionFiles.length ? decisionFiles.map((f) => `- ${linkOf(f.id, f.title)}`).join("\n") : "- なし",
    "",
    "## 新しい用語 / メンバー",
    "",
    termFiles.length || memberFiles.length
      ? [...termFiles, ...memberFiles].map((f) => `- ${linkOf(f.id, f.title)}`).join("\n")
      : "- なし",
    "",
    "## 動きのあった課題・会議",
    "",
    sourceLabels.length ? sourceLabels.map((s) => `- ${s}`).join("\n") : "- なし",
    "",
  ].join("\n");
  return { path: `Cortex/レポート/records/${ymd}-daily.md`, id: `report:${ymd}-daily`, title: `${dateH} デイリーレポート`, content: fm + body };
}

// ---------- メイン ----------

function main() {
  const meetingDir = findDirByMarker("ingest-config.json", "会議");

  // [決定的] ソース列挙
  const repoFiles = enumerateRepoSources(meetingDir);
  const externalChunks = enumerateExternalSources();
  const sources = [
    ...repoFiles.map((f) => ({ kind: "repo", label: f, path: f })),
    ...externalChunks,
  ];

  // 対象0件 → LLM呼び出しゼロで即終了
  if (sources.length === 0) {
    log(`[update-gold-pipeline] モード=${MODE} 対象ソース=0件。処理なしで終了します。`);
    writeShadowOutputs(
      `# update-gold シャドーレポート\n\n- 対象ソース: 0件（差分なし）\n`,
      "## Goldパイプライン（シャドー）\n\n対象ソース0件（LLM呼び出しなし）。\n",
    );
    return;
  }

  // [決定的] 照合材料の収集
  const existingDecisions = loadExistingDecisions();
  existingDecisions.sigs = new Set(existingDecisions.titles.map(normalizeSig));
  const existingTerms = loadExistingTerms();
  const excludedTerms = loadExcludedTerms();
  const roster = loadRoster();
  const decisionsGate = loadDecisionsGate();
  const today = jstToday();

  // ソース1件ごとに LLM 関数 A/B/C（冪等・逐次。1件の失敗は欠落として報告に載るだけ）
  const allDecisions = [];
  const allTerms = [];
  const allMembers = [];
  const perSource = [];
  for (const src of sources) {
    const entry = { label: src.label, a: null, b: null, c: null, notes: [] };
    let content = src.kind === "repo" ? readText(src.path) || "" : src.content;
    if (content.length > SOURCE_CHAR_CAP) {
      warn(`ソース ${src.label} が大きいため ${SOURCE_CHAR_CAP} 文字に切り詰めます。`);
      content = content.slice(0, SOURCE_CHAR_CAP) + "\n…（以降切り詰め）";
      entry.notes.push("本文を切り詰め");
    }
    const s = { ...src, content };

    // A: Decision（外部ソースの decisions: none はゲート＝そのソースからは Decision を作らない）
    const gated = src.kind === "external" && decisionsGate.get(`${src.type}\t${src.ref}`) === "none";
    if (gated) {
      entry.notes.push("decisions:none のため Decision 抽出をスキップ");
    } else {
      const a = llmExtractDecisions(s, existingDecisions.titles, roster.names);
      if (a === null) {
        entry.notes.push("A(Decision抽出)が不正応答→スキップ");
      } else if (Array.isArray(a)) {
        entry.a = a.length;
        for (const d of a) allDecisions.push({ ...d, source_label: src.label, source_ref: decisionSourceRef(src) });
      } else {
        entry.notes.push("A(Decision抽出)が配列でない→スキップ");
      }
    }

    // B: 用語
    const b = llmExtractTerms(s, existingTerms.titles, excludedTerms.raw);
    if (b === null) {
      entry.notes.push("B(用語抽出)が不正応答→スキップ");
    } else if (Array.isArray(b)) {
      entry.b = b.length;
      for (const t of b) allTerms.push({ ...t, source: decisionSourceRef(src) });
    } else {
      entry.notes.push("B(用語抽出)が配列でない→スキップ");
    }

    // C: メンバー（名簿ディレクトリが無い案件はスキップ＝マイグレーション未適用）
    if (roster.dirExists) {
      const c = llmExtractMembers(s, roster.names);
      if (c === null) {
        entry.notes.push("C(メンバー抽出)が不正応答→スキップ");
      } else if (Array.isArray(c)) {
        entry.c = c.length;
        allMembers.push(...c);
      } else {
        entry.notes.push("C(メンバー抽出)が配列でない→スキップ");
      }
    }
    perSource.push(entry);
  }

  // [決定的] 検証・採番・重複排除・frontmatter組み立て
  const decisionBatchSigs = new Set();
  const dec = buildDecisionFiles(allDecisions, existingDecisions, decisionBatchSigs);
  const term = buildTermFiles(allTerms, existingTerms, excludedTerms.sigs, new Set(), today.dateH);
  const mem = buildMemberFiles(allMembers, roster, new Set());

  // [バッチ統合パスD・1回だけ] 横断チェック（重複統合・supersedes候補の指摘＋今日の概要）
  const batch = llmBatchReview(
    dec.files.map((f) => ({ id: f.id, title: f.title })),
    term.files.map((f) => f.title),
    mem.files.map((f) => f.title),
    sources.map((s) => s.label),
  );

  // [決定的] 日次レポートの組み立て
  const viewerUrl = (() => {
    const m = (readText("Cortex/Home.md") || "").match(/^viewer_url:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/m);
    const v = m ? m[1].trim() : "";
    return v && !/\{\{/.test(v) ? v.replace(/\/+$/, "") : "";
  })();
  const daily = buildDailyReport(
    today,
    { changedFiles: sources.length },
    batch && batch.summary,
    dec.files,
    term.files,
    mem.files,
    sources.map((s) => s.label),
    viewerUrl,
  );

  const result = { sources, perSource, dec, term, mem, batch, daily };

  // [決定的] モード分岐
  if (MODE === "real") {
    applyReal(result);
  } else {
    const report = buildShadowReport(result);
    const summary = buildShadowSummary(result);
    writeShadowOutputs(report, summary);
  }
}

// Decision の references / relations 用の出典参照（リポ内: パス（人間向け）・外部: ref#番号/URL）
function decisionSourceRef(src) {
  if (src.kind === "repo") return src.path;
  const urlMatch = src.content && src.content.match(/^URL: (\S+)$/m);
  if (urlMatch) return urlMatch[1];
  return src.label;
}

// ---------- SHADOW 出力 ----------

function buildShadowSummary(r) {
  const lines = [];
  lines.push("## Goldパイプライン（シャドー）");
  lines.push("");
  lines.push(`- 対象ソース: ${r.sources.length}件 / 起票予定: Decision ${r.dec.files.length}・用語 ${r.term.files.length}・メンバー ${r.mem.files.length}・日次レポート 1`);
  lines.push("");
  lines.push("| ソース | A:決定 | B:用語 | C:メンバー | 備考 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const e of r.perSource) {
    lines.push(`| ${e.label} | ${e.a ?? "-"} | ${e.b ?? "-"} | ${e.c ?? "-"} | ${e.notes.join("・") || ""} |`);
  }
  return lines.join("\n") + "\n";
}

function buildShadowReport(r) {
  const out = [];
  out.push("# update-gold シャドーレポート");
  out.push("");
  out.push(`- 生成時刻: ${new Date().toISOString()}`);
  out.push(`- モード: shadow（リポジトリ無変更）`);
  out.push(`- SINCE: ${SINCE || "(未指定・約25時間)"}`);
  out.push("");
  out.push(buildShadowSummary(r));
  out.push("");

  // 本番（claude -p）が同一 run で実際に起票したファイル一覧（GOLD_PRE_HEAD..HEAD の git diff から機械取得）
  out.push("## 本番が起票したファイル（比較用）");
  out.push("");
  const preHead = process.env.GOLD_PRE_HEAD || "";
  if (preHead) {
    const g = spawnSync("git", ["-c", "core.quotepath=false", "diff", "--name-only", `${preHead}..HEAD`, "--", "Cortex/"], {
      encoding: "utf-8",
    });
    const files = (g.status === 0 ? g.stdout : "").split("\n").map((s) => s.trim()).filter(Boolean);
    out.push(files.length ? files.map((f) => `- ${f}`).join("\n") : "（本番の起票なし）");
  } else {
    out.push("（GOLD_PRE_HEAD 未指定のため取得なし）");
  }
  out.push("");

  out.push("## バッチ統合パス（D）の指摘");
  out.push("");
  if (r.batch) {
    const dups = Array.isArray(r.batch.duplicates) ? r.batch.duplicates : [];
    const sups = Array.isArray(r.batch.supersedes_candidates) ? r.batch.supersedes_candidates : [];
    out.push(`- 重複統合の指摘: ${dups.length ? dups.map((p) => JSON.stringify(p)).join(" / ") : "なし"}`);
    out.push(`- supersedes候補: ${sups.length ? sups.join(" / ") : "なし"}`);
  } else {
    out.push("- （応答なし/不正）");
  }
  out.push("");

  const skips = [
    ...r.dec.skipped.map((s) => ({ ...s, kind: "decision" })),
    ...r.term.skipped.map((s) => ({ ...s, kind: "term" })),
    ...r.mem.skipped.map((s) => ({ ...s, kind: "member" })),
  ];
  out.push("## 機械検証で落とした候補");
  out.push("");
  out.push(skips.length ? skips.map((s) => `- [${s.kind}] ${s.reason}: ${JSON.stringify(s.item && (s.item.title || s.item.term || s.item.name) || "")}`).join("\n") : "- なし");
  out.push("");

  out.push("## 起票するはずだったファイル（全文）");
  for (const f of [...r.dec.files, ...r.term.files, ...r.mem.files, r.daily]) {
    out.push("");
    out.push(`### ${f.path}`);
    out.push("");
    out.push("~~~markdown");
    out.push(f.content);
    out.push("~~~");
  }
  return out.join("\n") + "\n";
}

// レポート全文を /tmp と run log に、サマリを $GITHUB_STEP_SUMMARY に出す。
// いずれもリポジトリ外への書き出し（shadow の無変更要件を守る）。
function writeShadowOutputs(report, summary) {
  const file = path.join(os.tmpdir(), `update-gold-shadow-${Date.now()}.md`);
  try {
    fs.writeFileSync(file, report, "utf-8");
    log(`[update-gold-pipeline] シャドーレポート: ${file}`);
  } catch (e) {
    warn(`レポートの /tmp 書き出しに失敗: ${e.message}`);
  }
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    try {
      fs.appendFileSync(stepSummary, summary + "\n");
    } catch (e) {
      warn(`$GITHUB_STEP_SUMMARY への書き出しに失敗: ${e.message}`);
    }
  }
  log("----- update-gold shadow report (begin) -----");
  log(report);
  log("----- update-gold shadow report (end) -----");
}

// ---------- REAL モード（コードとして実装・ワークフローからは未呼び出し） ----------

// フェーズ別コミット（Decisions→用語集→メンバー→レポート）。各フェーズでファイル書込→validate-cortex.mjs→
// 検証OKならコミット・NGならそのフェーズの書込を取り消して警告（壊れたレコードをコミットしない）。
// push はワークフロー側。
function applyReal(r) {
  const validate = () => {
    const v = spawnSync("node", [path.join(SCRIPT_DIR, "validate-cortex.mjs")], { encoding: "utf-8" });
    if (v.status !== 0) warn(`validate-cortex 違反:\n${v.stdout || ""}${v.stderr || ""}`);
    return v.status === 0;
  };
  const git = (args) => {
    const g = spawnSync("git", args, { encoding: "utf-8" });
    if (g.status !== 0) throw new Error(`git ${args.join(" ")} 失敗: ${g.stderr || ""}`);
    return (g.stdout || "").trim();
  };
  const phases = [
    { files: r.dec.files, dir: "Cortex/Decisions/", msg: "Decisionsに当日の決定事項を自動追記" },
    { files: r.term.files, dir: "Cortex/用語集/", msg: "用語集に新規用語をdraftで自動追記" },
    { files: r.mem.files, dir: "Cortex/メンバー/", msg: "メンバー名簿に新規参加者をdraftで自動追記" },
    { files: [r.daily], dir: "Cortex/レポート/", msg: "日次レポートを生成" },
  ];
  for (const phase of phases) {
    if (!phase.files.length) continue;
    const written = [];
    try {
      for (const f of phase.files) {
        // 既存レコードは書き換えない（新規追加のみ）。日次レポートだけは当日再実行での上書きを許す（スキルと同じ）。
        if (fs.existsSync(f.path) && !f.path.includes("-daily.md")) {
          warn(`既存ファイルのためスキップ（書き換えない規律）: ${f.path}`);
          continue;
        }
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        fs.writeFileSync(f.path, f.content, "utf-8");
        written.push(f.path);
      }
      if (!written.length) continue;
      if (!validate()) {
        for (const p of written) {
          try { fs.unlinkSync(p); } catch {}
        }
        warn(`${phase.dir} の生成物がスキーマ検証に失敗したため、このフェーズの書込を取り消しました。`);
        continue;
      }
      git(["add", phase.dir]);
      const diff = spawnSync("git", ["diff", "--staged", "--quiet"], { encoding: "utf-8" });
      if (diff.status === 0) continue; // 追記なし
      git(["commit", "-m", phase.msg]);
      log(`[update-gold-pipeline] REAL: ${phase.dir} を ${written.length}件コミットしました。`);
    } catch (e) {
      warn(`REAL適用に失敗（${phase.dir}）: ${e.message}`);
    }
  }
  log("[update-gold-pipeline] REAL 完了（push はワークフロー側）。");
}

main();
