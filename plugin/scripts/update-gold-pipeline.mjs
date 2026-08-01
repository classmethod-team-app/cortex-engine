#!/usr/bin/env node
// 夜間Gold昇格（update-gold）の「決定的パイプライン＋LLM関数化」オーケストレータ（Node単体・npm依存なし）。
//
// 現行のGold昇格は claude -p の自由行動エージェント（max-turns 150）で、ソース列挙・採番・重複照合まで
// AI に任せているため、ターン枯渇・タイムアウト等の確率的失敗が起きる。ingest-minutes-pipeline.mjs で
// 確立した「機械的にできることは決定的に・判断だけを小さな LLM 関数に切り出す」型を Gold にも適用する。
// 本スクリプトのスコープはシャドーモードまで（REAL モードはコードとして実装するがワークフローからは呼ばない）。
//
// 実行モード（env GOLD_PIPELINE_MODE。既定 shadow）:
//   - shadow: リポジトリを一切変更しない。起票するはずだった Decision/用語/メンバーの全文を
//             1つの Markdown レポートにまとめ、$GITHUB_STEP_SUMMARY にサマリ表、全文を /tmp と run log に出す。
//             env GOLD_PRE_HEAD があれば「本番（claude -p）が実際に起票したファイル一覧」を git diff から
//             機械取得して併記する（同一 run 内でシャドーと本番を突き合わせるため）。
//   - real:   validate-cortex.mjs による検証→ファイル書込→フェーズ別コミット（Decisions→用語集→メンバー→ルール）。
//             push はワークフロー側（本スクリプトはしない）。
//
// 各フェーズの規律は update-gold-auto/SKILL.md の各 Phase（決定・用語・メンバー・ルール）に従う:
//   - ソース列挙は changed-sources.sh / external-sources.sh と同一スクリプト（二重定義によるドリフト防止）
//   - 会議ディレクトリ配下は議事録（*_minutes.md）のみ読む（文字起こし原本は読まない）
//   - 採番は「決定日の既存最大NNN+1」（ファイル名から機械取得）・重複照合は正規化titleの突合
//   - 既存レコードとの照合は「新規／重複／矛盾」の3分類。矛盾（既存を否定・撤回・変更する新事実で、
//     既存と両立しないもの）を重複として捨てると、古い決定だけが Gold に残り AI が撤回済みの方針を
//     確定情報として読む。Decision は supersedes を張った新レコードで起票し、用語・Rule は
//     （既存レコードを自動で書き換えない原則を守るため）起票せず ::warning:: で人の確認に回す。
//   - 自動起票は全型 status: draft（AI生成・人間未確認の印。事後レビュー方式）・既存レコードは書き換えない（新規追加のみ）
//   - 公開範囲フィルタ（内部限定情報を書かない）はプロンプトに転記して維持
//
// LLM 呼び出し（ingest-minutes-pipeline と同じ流儀）:
//   - 既定は `aws bedrock-runtime converse`（OIDC 認証済みランナー・aws CLI 標準搭載）。
//     モデルは env ANTHROPIC_MODEL、リージョンは env AWS_REGION。
//   - プロンプトは「毎回同一の前置き（規約・抽出基準・既存レコード一覧・名簿）」と「ソースごとに変わる本文」の
//     2ブロックに分けて送り、境界に cachePoint を置く（Bedrockのプロンプトキャッシュ。同一run内の繰り返し
//     呼び出しで入力トークンのコストを下げる。レイテンシは変わらない）。
//   - env PIPELINE_LLM_CMD が設定されていればそのコマンド（フィクスチャ用スタブ）に置き換わる。
//     スタブには env PIPELINE_LLM_PHASE（decision|term|member|batch）と、プロンプト全文（2ブロックを
//     連結したもの）を書いた一時ファイルのパスを env PIPELINE_LLM_INPUT で渡し、stdout をモデル出力
//     テキストとして受け取る。
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
// cachePoint（プロンプトキャッシュ）を置く前置きの最小長。これ未満だと cachePoint を置いても
// **AWS側が黙って無視する**（エラーにならず課金もされないが、キャッシュされない）。
//
// **最小長は cachePoint までの全体で判定される**（`tools` → `system` → `messages` の合計）。
// prefix 単体ではないので、本番と同じ tools/system を付けた状態で測る必要がある。
//
// 2026-08-01 実測（global.anthropic.claude-sonnet-5・本番と同じ system と toolConfig を付与）:
//   200字 → キャッシュ書込 0（無視）
//   300字 → キャッシュ書込 1,032（成立）
//   → tools+system だけで約770トークンあるため、prefix は250トークン程度で足りる。
//
// 参考: tools/system 無しで測ると境界は1,200字だった（最小1,024トークン）。この差がそのまま
// tools+system の寄与。**判定式は prefix.length しか見ていないので、閾値はこの下駄を織り込む。**
//
// 以前は 4,000 だった（Opus/Haiku 系の 4,096 を Sonnet に当てはめた値と思われる）。必要量の
// 10倍以上で、既存レコードが少ない案件ではキャッシュが1回も成立していなかった
// （2026-07-30の夜間実行で sushiro・tokyu-line・mitsubishi のキャッシュ書込が 0）。
//
// 600 は実測値300字の2倍。前置きは日本語だけでなく ASCII（課題キー・JSON例・enum値）を
// 15〜40%含み、ASCIIは1字あたりのトークン数が小さいので、字数での概算には余裕が要る。
//
// **モデルを変えるときは必ず測り直すこと。** 最小トークン数はモデルごとに違う
// （Sonnet 5 と Sonnet 4.5 は 1,024 だが、Haiku 4.5 と Opus 4.5/4.6 は 4,096）。
const CACHE_MIN_PREFIX_CHARS = 600;

const log = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`::warning::update-gold-pipeline: ${msg}\n`);
const error = (msg) => process.stderr.write(`::error::update-gold-pipeline: ${msg}\n`);

// LLM呼び出しのトークン使用量を集計する（プロンプトキャッシュが本番で効いているかを毎晩ログで確認するため。
// キャッシュは環境・モデル・呼び出し順序に依存するので、手元の実測だけでは効いている保証にならない）。
const usageTotal = { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
function recordUsage(u) {
  if (!u) return;
  usageTotal.calls += 1;
  usageTotal.input += u.inputTokens || 0;
  usageTotal.output += u.outputTokens || 0;
  usageTotal.cacheWrite += u.cacheWriteInputTokens || 0;
  usageTotal.cacheRead += u.cacheReadInputTokens || 0;
}
/** 実行の最後に1行で出す。cacheRead が積み上がっていればキャッシュが効いている。 */
function logUsageSummary() {
  if (usageTotal.calls === 0) return;
  const { calls, input, output, cacheWrite, cacheRead } = usageTotal;
  const billed = input + cacheWrite + cacheRead;
  const saved = billed > 0 ? Math.round((cacheRead / billed) * 100) : 0;
  log(
    `LLM使用量: ${calls}回 / 入力 ${input} / 出力 ${output} / キャッシュ書込 ${cacheWrite} / キャッシュ読込 ${cacheRead}（入力側の${saved}%がキャッシュ読込）`,
  );
}

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

// シャドー比較の公平性: 本番（claude -p）が同一runで起票したファイルは「既存」として扱わない。
// 同一ジョブで本番→シャドーの順に走るため、作業ツリーには本番の新規レコードが既に存在する。
// これをそのまま重複照合に使うと、本番が拾った決定をシャドーが常に「重複」として見送り、
// 取りこぼしに見えてしまう（比較手法の欠陥）。GOLD_PRE_HEAD..HEAD の新規分を除外して
// 本番実行前の状態を再現する（GOLD_PRE_HEAD はシャドーステップだけが渡すので REAL には影響しない）。
const PROD_NEW_FILES = (() => {
  const preHead = process.env.GOLD_PRE_HEAD || "";
  if (!preHead) return new Set();
  const g = spawnSync("git", ["-c", "core.quotepath=false", "diff", "--name-only", `${preHead}..HEAD`, "--", "Cortex/"], {
    encoding: "utf-8",
  });
  if (g.status !== 0) return new Set();
  return new Set((g.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean));
})();

// 既存 Decision: 採番用のファイル名一覧＋照合用の id/title 一覧
// entries（id＋title）は LLM に「既存一覧」として渡す（矛盾判定で supersedes 先の実在IDを書かせるため）。
// sigToIds は「正規化titleが衝突した相手のID」を引くための索引（矛盾と重複の切り分けに使う）。
function loadExistingDecisions() {
  const fileNames = [];
  const entries = [];
  const ids = new Set();
  const sigs = new Set();
  const sigToIds = new Map();
  for (const e of listDir("Cortex/Decisions/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    if (PROD_NEW_FILES.has(`Cortex/Decisions/records/${e.name}`)) continue; // 本番が今run起票した分は既存扱いしない
    fileNames.push(e.name);
    const fm = frontmatterOf(readText(`Cortex/Decisions/records/${e.name}`) || "");
    const t = fmField(fm, "title");
    const id = fmField(fm, "id");
    if (id) ids.add(id);
    if (t) {
      const sig = normalizeSig(t);
      sigs.add(sig);
      if (id) sigToIds.set(sig, [...(sigToIds.get(sig) || []), id]);
      entries.push({ id, title: t });
    }
  }
  return { fileNames, entries, ids, sigs, sigToIds };
}

// 既存用語: title / synonyms の集合
function loadExistingTerms() {
  const titles = [];
  const sigs = new Set();
  for (const e of listDir("Cortex/Glossary/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    if (PROD_NEW_FILES.has(`Cortex/Glossary/records/${e.name}`)) continue; // 本番が今run起票した分は既存扱いしない
    const fm = frontmatterOf(readText(`Cortex/Glossary/records/${e.name}`) || "");
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
  return loadExclusionList("Cortex/Glossary/README.md", "除外用語");
}

// 既存 Rule: 重複照合用の title の集合（用語と同型。synonyms は持たない）
function loadExistingRules() {
  const titles = [];
  const sigs = new Set();
  for (const e of listDir("Cortex/Rules/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    if (PROD_NEW_FILES.has(`Cortex/Rules/records/${e.name}`)) continue; // 本番が今run起票した分は既存扱いしない
    const fm = frontmatterOf(readText(`Cortex/Rules/records/${e.name}`) || "");
    const t = fmField(fm, "title");
    if (t) {
      titles.push(t);
      sigs.add(normalizeSig(t));
    }
  }
  return { titles, sigs, dirExists: listDir("Cortex/Rules/records") !== null };
}

// Rules README の「除外ルール」（過去にレビューで却下された制約の再追加防止。用語の除外リストと同型）
function loadExcludedRules() {
  return loadExclusionList("Cortex/Rules/README.md", "除外ルール");
}

// README の「## 除外XXX」節から 1行1件のリストを読む（自動追加してはいけないものの一覧）。
// 節が無ければ空（除外なし）。編集は人間のみ・自動更新は読むだけ。
function loadExclusionList(readmePath, heading) {
  const raw = readText(readmePath) || "";
  const m = raw.match(new RegExp(`^#{2,3}\\s*${heading}\\s*$([\\s\\S]*?)(?=^#{1,3}\\s|\\n*$(?![\\s\\S]))`, "m"));
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
  for (const e of listDir("Cortex/Members/records") || []) {
    if (!e.isFile() || !e.name.endsWith(".md") || e.name.includes("{{")) continue;
    if (PROD_NEW_FILES.has(`Cortex/Members/records/${e.name}`)) continue; // 本番が今run起票した分は既存扱いしない
    const fm = frontmatterOf(readText(`Cortex/Members/records/${e.name}`) || "");
    const t = fmField(fm, "title");
    if (t) {
      names.push(t);
      sigs.add(normalizeSig(t));
    }
    for (const a of fmListField(fm, "aliases")) sigs.add(normalizeSig(a));
  }
  return { names, sigs, dirExists: listDir("Cortex/Members/records") !== null };
}

// ---------- LLM 呼び出し（ingest-minutes-pipeline と同じヘルパ流儀） ----------

function callLLM(phase, { system, prefix, variable, maxTokens, timeoutMs, tools }) {
  const stub = process.env.PIPELINE_LLM_CMD;
  if (stub) {
    // プロンプトは一時ファイル渡し（stdin だと大きな入力でスタブ側が読まない場合に EPIPE する）。
    // スタブは1つの文字列として受け取る作りなので、prefix と variable を連結して渡す（本番と同一の全文）。
    const inFile = path.join(os.tmpdir(), `gold-llm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      fs.writeFileSync(inFile, (system ? `SYSTEM:\n${system}\n\n` : "") + prefix + variable, "utf-8");
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
  // 前置き（prefix）と可変部（variable）の境界に cachePoint を置く。キャッシュは「先頭から cachePoint までの
  // 連続一致」で判定されるので、毎回同一の前置きだけがキャッシュに載る。
  const content = prefix.length >= CACHE_MIN_PREFIX_CHARS
    ? [{ text: prefix }, { cachePoint: { type: "default" } }, { text: variable }]
    : [{ text: prefix + variable }]; // 最小トークン数に満たない前置きはキャッシュされないので分割しない
  // リクエストは**ファイル渡し**（--cli-input-json）にする。コマンドライン引数で渡してはいけない。
  // Linux には1引数あたり 131,072バイト（MAX_ARG_STRLEN。32ページ固定で ulimit では緩められない）の
  // 上限があり、`--messages` に本文を直接載せると長いソースで execve が E2BIG で落ちる。
  // SOURCE_CHAR_CAP は 150,000字＝日本語UTF-8で約450KBを許容しているので上限の3倍以上になりうる。
  // 実測（2026-08-01）: cortexの最大の文字起こし＋前置きで128,898バイト＝上限まで残り2,174バイト。
  // 既存レコード一覧は毎晩増えて前置きが伸びるため、放置すると近いうちに必ず発火する。
  //
  // 発火したときの壊れ方が悪い: spawnSync がエラーを返す→「不正応答」として3回リトライ→全部同じ失敗
  // → failedCells に載って run 失敗 → SINCE が前進しない → 翌晩も同じ失敗 → GIVE_UP_AFTER で
  // 恒久的な取りこぼしが確定する。長い議事録が1本入るだけで起きる。
  // ツール呼び出しを強制すると、応答が toolUse.input にパース済みオブジェクトで返る（自由文で返す事故が消える）。
  const payload = {
    modelId: MODEL,
    messages: [{ role: "user", content }],
    inferenceConfig: { maxTokens }, // temperature はSonnet 5で廃止（指定するとValidationException）
    ...(system ? { system: [{ text: system }] } : {}),
    ...(tools ? { toolConfig: tools } : {}),
  };
  const reqFile = path.join(os.tmpdir(), `gold-req-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  let r;
  try {
    // mode 0600。一時ディレクトリは他ユーザーからも見えるうえ、本文には顧客の会議文字起こしが入る。
    fs.writeFileSync(reqFile, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
    r = spawnSync("aws", [
      "bedrock-runtime", "converse",
      "--region", REGION,
      "--cli-input-json", `file://${reqFile}`,
    ], {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // **本関数は throw しない**（失敗は必ず null で返す）という契約を守る。ここで例外を漏らすと
    // 呼び出し側に catch が無いためプロセスごと落ち、applyReal 前に死んでその晩の成果が全て消える。
    warn(`bedrock converse(${phase})のリクエスト書き出しに失敗しました: ${e.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(reqFile); } catch {}
  }
  if (r.status !== 0 || r.error) {
    warn(`bedrock converse(${phase})が失敗しました: ${r.error ? r.error.message : (r.stderr || `exit ${r.status}`)}`);
    return null;
  }
  try {
    const out = JSON.parse(r.stdout || "{}");
    recordUsage(out?.usage);
    const blocks = out?.output?.message?.content || [];
    // 出力が maxTokens で打ち切られると toolUse.input が途中で切れる。原因を切り分けられるよう明示する。
    if (out?.stopReason === "max_tokens") {
      warn(`bedrock converse(${phase}): maxTokens(${maxTokens})に達して出力が打ち切られました。`);
    }
    const toolUse = blocks.find((b) => b.toolUse)?.toolUse;
    if (toolUse) return { __toolInput: toolUse.input };
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

// フェーズごとの出力スキーマ（tool use の inputSchema）。
// ツール入力はオブジェクトである必要があるので、配列を返すフェーズは items で包み、受け取り側で開く。
// 制約付きデコーディング（outputConfig / strict）は現行モデルが未対応のため、ここでのスキーマは
// 強制ではなく誘導。型の取り違え・必須欠落は後段の機械検証で落とす（cortex-engine Issue #13）。
const STR = { type: "string" };
const STR_LIST = { type: "array", items: STR };
const PHASE_SCHEMAS = {
  decision: {
    unwrap: "items",
    item: {
      date: STR, title: STR, description: STR, deciders: STR_LIST,
      category: STR, based_on: STR, quote: STR, supersedes: STR_LIST,
    },
  },
  term: {
    unwrap: "items",
    item: { term: STR, yomi: STR, definition: STR, synonyms: STR_LIST, conflicts_with: STR },
  },
  member: {
    unwrap: "items",
    // side / rel は取りうる値が決まっている。enum を書かないとモデルが自然な語（"自社"・"prohibits" 等）を
    // 入れてくるため、スキーマ側で許容値を宣言して誘導する。
    item: {
      name: STR, yomi: STR, org: STR, role: STR,
      side: { type: "string", enum: ["cm", "client", "vendor", ""] },
    },
  },
  rule: {
    unwrap: "items",
    item: {
      title: STR, description: STR, target: STR, conflicts_with: STR,
      rel: { type: "string", enum: ["derived_from", "based_on", ""] },
    },
  },
  batch: {
    unwrap: null,
    object: {
      duplicates: { type: "array", items: { type: "array", items: STR } },
      supersedes_candidates: STR_LIST,
    },
  },
};

// フェーズ名から tool use の toolConfig を組み立てる。
function toolConfigFor(phase) {
  const s = PHASE_SCHEMAS[phase];
  if (!s) return null;
  const json = s.unwrap
    ? {
        type: "object",
        properties: { [s.unwrap]: { type: "array", items: { type: "object", properties: s.item } } },
        required: [s.unwrap],
      }
    : { type: "object", properties: s.object, required: Object.keys(s.object) };
  return {
    tools: [{ toolSpec: { name: `submit_${phase}`, description: "抽出結果を提出する", inputSchema: { json } } }],
    toolChoice: { tool: { name: `submit_${phase}` } },
  };
}

// JSON を期待する関数。
// tool use（toolChoice で強制）を使うので、応答は toolUse.input にパース済みオブジェクトで返る。
// テキストからのJSON切り出しは、スタブ経路と、ツールを呼ばずに返してきた場合のフォールバックとして残す。
// パース失敗時は1回だけ再試行。2回失敗なら null（呼び出し側でスキップ・報告）。
// LLM応答の解釈に失敗したときの再試行回数。一時的な失敗はここで吸収し、
// 吸収しきれなかったものは「落ちたマス」として集約して呼び出し側が扱う。
const LLM_ATTEMPTS = Number(process.env.PIPELINE_LLM_ATTEMPTS || 3);

function callJSON(phase, opts) {
  const tools = toolConfigFor(phase);
  const unwrap = PHASE_SCHEMAS[phase]?.unwrap;
  for (let attempt = 0; attempt < LLM_ATTEMPTS; attempt++) {
    const res = callLLM(phase, { ...opts, tools });
    const obj = res && typeof res === "object" && !Array.isArray(res) && "__toolInput" in res
      ? res.__toolInput
      : parseJsonLoose(res);
    if (obj !== null && obj !== undefined) {
      // 配列フェーズは items で包ませているので開く。包まずに配列で返してきた場合もそのまま受ける。
      if (unwrap && !Array.isArray(obj)) {
        // 期待キー（items）に配列が入っていなければ「0件」ではなく解釈失敗として扱う。
        // 空配列を返すと、キー違い・単体オブジェクトが無警告の0件に化けて取りこぼしが見えなくなる。
        if (Array.isArray(obj[unwrap])) return obj[unwrap];
        warn(`${phase}: 応答に配列 ${unwrap} がありません（キー: ${Object.keys(obj || {}).join(", ") || "なし"}）。`);
        continue;
      }
      return obj;
    }
    if (attempt < LLM_ATTEMPTS - 1) {
      warn(`${phase}: 応答を解釈できませんでした。再試行します（${attempt + 2}/${LLM_ATTEMPTS}）。`);
    }
  }
  return null;
}

// ---------- LLM 関数群（A: Decision / B: 用語 / C: メンバー / D: Rule / 横断チェック） ----------

const SYS_COMMON =
  "あなたはCortex（案件コンテキスト基盤）の夜間Gold昇格パイプラインの一部です。指示に厳密に従い、指定されたツールを呼び出して結果を提出してください。";

// 公開範囲フィルタ（update-gold-auto/SKILL.md の文言を転記。全抽出関数の共通規律）
const PRIVACY_RULE = [
  "公開範囲フィルタ（必ず適用）: 内部限定情報（売上・利益率・原価・見積・アサイン工数・単価・人事評価・",
  "顧客/ベンダーへの率直な評価・内部限定のリスク所感等）は抽出結果に一切含めない。",
  "とくにチャット由来のソースは内部の雑談・評価が混ざりやすいので注意する（Gold＝顧客可視面）。",
].join("");

// A: Decision抽出。確定/未確定の基準は update-gold-auto/SKILL.md の Phase A の文言を転記。
// existingEntries は { id, title } の配列（矛盾判定で supersedes 先の実在IDを書かせるため ID も渡す）。
function llmExtractDecisions(source, existingEntries, rosterNames) {
  // 前置き（毎回同一。既存一覧・名簿は同一run内で不変なのでここに入れてキャッシュに載せる）
  const prefix = [
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
    "既存Decisionの一覧（`ID タイトル`）。各候補を次の3分類で判定する:",
    "  新規（既存に無い）→ 抽出する。重複（既存と同じことを言っている）→ 抽出しない。",
    "  矛盾（既存を否定・撤回・変更する新事実で、既存と両立しない）→ **破棄せず抽出し**、置き換える既存のIDを supersedes に入れる（一覧に無いIDは書かない）。",
    existingEntries.length ? existingEntries.map((e) => `- ${e.id} ${e.title}`).join("\n") : "(なし)",
    "",
    "名簿（deciders はこの正式表記に正規化する。名簿に無い人名は「名前（要確認）」と書く）:",
    rosterNames.length ? rosterNames.map((t) => `- ${t}`).join("\n") : "(名簿なし)",
    "",
    `カテゴリーは次から選ぶ: ビジネス / 技術選定 / 設計方針 / 運用ルール / インフラ / デザイン`,
    "based_on はソースの安定ID（議事録: minute:{定例名}:{YYYYMMDD}、課題: 課題キー、外部: owner/repo#N）。分からなければ空文字。",
    "date は決定が行われた日（会議日・コメント日。実行日ではない）を YYYYMMDD で。",
    "",
  ].join("\n") + "\n";
  // 可変部（ソース本文と出力形式の指示。prefix と連結すると分割前のプロンプトと完全に一致する）
  const variable = [
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    '抽出結果を items に入れてツールで提出する（0件なら items は []）。各要素の形:',
    '[{"date": "YYYYMMDD", "title": "...", "description": "...", "deciders": ["..."], "category": "...", "based_on": "...", "quote": "...", "supersedes": ["矛盾する既存DecisionのID(YYYYMMDD-NNN)。矛盾でなければ空配列"]}]',
  ].join("\n");
  return callJSON("decision", { system: SYS_COMMON, prefix, variable, maxTokens: 4096, timeoutMs: 240_000 });
}

// B: 用語抽出（update-gold-auto/SKILL.md の Phase B の基準を転記。Webツールなし前提＝定義が明示された語のみ）
function llmExtractTerms(source, existingTermTitles, excludedList) {
  // 前置き（毎回同一。既存用語・除外用語は同一run内で不変なのでここに入れてキャッシュに載せる）
  const prefix = [
    "次のソースから、用語集に登録すべき案件固有の新規用語を抽出してください。",
    "",
    "対象: 案件・業界固有の用語、社内略語、一般語だがこの案件で特別な意味を持つ語。",
    "",
    "**その語の中身がソースで規定されているものだけ**を登録する。判定は文の形ではなく、",
    "「この案件でその語について何が定まっているか」が読み取れるかどうかで行う。",
    "  ⭕️ 意味を明示している … 「承認者が申請を前工程へ戻す操作を差戻しと呼ぶ」",
    "  ⭕️ 属性・ルール・状態遷移を定めている … 「クーポンは1人1枚まで、有効期限は発行から30日」",
    "     （「〜とは〜のこと」の形でなくても、その語が何であるかを規定していれば対象。ドメインの語彙はこの形が多い）",
    "  ❌ その語を使っているだけ … 「デザインの天井を上げる」（天井が何かは規定されていない）",
    "**推測で定義を書かない**。使われ方から意味を察して定義を作るのは、規定されていることの記録ではない。",
    "とくに一般的な比喩表現（天井・床・地図・器・肌感 等）は、会話でそう表現されただけのことが多いので、",
    "その語自体の中身が規定されていない限り登録しない。",
    "",
    "判断基準は「その語の意味を知らないと、この案件のやり取りを誤読するか」。",
    "用語集は語の意味を揃える場所であり、何を採用したか・何が存在するかを記録する場所ではない。",
    "",
    "判断の例（⭕️=登録する / ❌=登録しない）:",
    "⭕️ 差戻し … 一般語だが、この案件では「承認者が申請を前工程へ戻す操作」という特定の意味を持つ",
    "⭕️ 一次連携 … 案件独自の工程名。知らないと会話が通じない",
    "⭕️ 温度 … 一般語だが、この案件では「見込み客の購買意欲の段階」を指す",
    "❌ PostgreSQL … 製品名。採用した事実は決定（Decision）であって語彙ではない",
    "❌ リアルユーザーモニタリング … 一般的な技術用語。辞書的な説明しか書けない",
    "❌ daily-report … スキル名。固有名詞であって語彙ではない",
    "❌ config.json … ファイル名。同様にリポジトリ名・ディレクトリ名も登録しない",
    "❌ 山田太郎 … 人名。メンバー名簿の領分",
    "",
    "一般的な意味しか書けない語は登録しない。製品名・サービス名・ライブラリ名は、",
    "この案件でその語自体が独自の意味に転じている場合を除き登録しない（採用の事実はDecisionが持つ）。",
    "確信が持てない語は登録しない（過剰登録はノイズとなり用語集の信頼を損なう。直コミットされるため保守的に判断する）。",
    PRIVACY_RULE,
    "",
    "既存用語のタイトル一覧（これらと同一・実質同義の語は抽出しない＝重複回避）。",
    "ただし既存の定義を否定・変更する新事実（矛盾）なら、破棄せず抽出し conflicts_with に矛盾する既存用語のタイトルを入れる:",
    existingTermTitles.length ? existingTermTitles.map((t) => `- ${t}`).join("\n") : "(なし)",
    excludedList.length ? "除外用語（過去にレビューで却下。再追加しない）:\n" + excludedList.map((t) => `- ${t}`).join("\n") : "",
    "",
  ].join("\n") + "\n";
  // 可変部（ソース本文と出力形式の指示）
  const variable = [
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    '抽出結果を items に入れてツールで提出する（0件なら items は []）。各要素の形:',
    '[{"term": "代表表記", "yomi": "よみ", "definition": "この案件における意味（ソースに明示された定義）", "synonyms": ["..."], "conflicts_with": "矛盾する既存用語のタイトル。矛盾でなければ空文字"}]',
  ].join("\n");
  return callJSON("term", { system: SYS_COMMON, prefix, variable, maxTokens: 2048, timeoutMs: 180_000 });
}

// C: メンバー抽出（update-gold-auto/SKILL.md Phase C の基準を転記。未登録のみ・確証なければ起票しない）
function llmExtractMembers(source, rosterNames) {
  // 前置き（毎回同一。名簿は同一run内で不変なのでここに入れてキャッシュに載せる）
  const prefix = [
    "次のソースに登場する人物のうち、名簿に無い新規メンバー候補を抽出してください。",
    "",
    "対象: 議事録の参加者欄・発言者、チャットの発言者（表示名から氏名の見当がつくもののみ）。",
    "GitHub の author（login のみ）は氏名の確証が持てないことが多いので、login から実名が明らかな場合を除き抽出しない。",
    "",
    "名簿の役割は人物を一意に特定することなので、**姓名が揃っているものだけ**を抽出する。",
    "姓のみ・名のみ（「田島」「太郎」等）は抽出しない。同姓の別人と区別できず、後から姓名が判明したときに",
    "別レコードとして二重登録され、決定の deciders をどちらに正規化すべきか決められなくなる。",
    "敬称・肩書き付きの呼称（「田島さん」「山口部長」）から姓名が確定できない場合も同様に抽出しない。",
    "氏名の確証が持てない場合（ハンドルネームのみ等）も抽出しない（過剰起票はノイズ）。",
    "side は cm（開発側）/ client（顧客）/ vendor（ベンダー）のいずれか。不明なら空文字。",
    PRIVACY_RULE.replace("抽出結果", "org/role"),
    "",
    "名簿（既登録。これらの人物は抽出しない）:",
    rosterNames.length ? rosterNames.map((t) => `- ${t}`).join("\n") : "(名簿なし)",
    "",
  ].join("\n") + "\n";
  // 可変部（ソース本文と出力形式の指示）
  const variable = [
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    '抽出結果を items に入れてツールで提出する（0件なら items は []）。各要素の形:',
    '[{"name": "氏名", "yomi": "よみ", "org": "所属組織", "side": "cm|client|vendor|", "role": "役割"}]',
  ].join("\n");
  return callJSON("member", { system: SYS_COMMON, prefix, variable, maxTokens: 1024, timeoutMs: 120_000 });
}

// Rule 抽出（Rules/README.md の規律を転記。用語より一段保守的に）。
// Rule は AI の行動を直接制約する（禁止曜日にデプロイ案内をしない等）ため、誤起票のコストが用語より高い。
function llmExtractRules(source, existingRuleTitles, excludedList) {
  // 前置き（毎回同一。既存Rule・除外ルールは同一run内で不変なのでここに入れてキャッシュに載せる）
  const prefix = [
    "次のソースから、案件で継続的に守るべき制約・運用ルールとして明示的に合意されたものだけを抽出してください。",
    "",
    "対象は**案件を進めるうえで守る運用上の制限事項**。「作業しようとしたときに、知らないと事故になる線」だけを抽出する。",
    "典型: リリースのタイミング制限 / 本番環境への操作の制限 / アクセス経路の制限 / データの取り扱いの制限 /",
    "      レビュー・承認を必須とする手続き / 顧客とのやり取りの制限。",
    "  例: 「本番リリースは金曜・祝前日に行わない」「決済処理は必ず二重確認を通す」",
    "      「顧客環境へのアクセスはVPN経由のみ」「個人情報を含むデータをローカルに保存しない」。",
    "",
    "判定は「**破ったときに何が起きるか**」で行う。障害・情報漏洩・顧客との約束違反など**実害が説明できる**ものだけがRule。",
    "「良い作りにならない」「方針とズレる」程度のものはRuleではない。",
    "",
    "除外するもの（重要）:",
    "  - **「どう作るか」「どう構成するか」の決定は、継続的に適用されるものでもRuleにしない**。これはDecisionの領分。",
    "    ✗「各ハーネスにプレイブック層を必ず設ける」「新規案件にPPOを必ず配置する」「顧客共有Driveは案件ごとに1つ作る」",
    "    ✗「アーキに沿わない案件では開発ハーネスを使わない」「テンプレートは○○ディレクトリに配置する」",
    "    これらは「必ず」「〜しない」と書かれていても、**体制・構成・作り方の取り決め**であって作業時の制限事項ではない。",
    "  - 一回きりの意思決定（＝Decision。「Next.jsを採用した」等の過去の選択）。",
    "  - 単発のTODO・アクションアイテム・期限付きの依頼（「今週中に〜する」等）。",
    "  - 推測・ニュアンス。ソース中に制約として明示的に合意された根拠が無いもの。",
    "",
    "**該当が無い案件は珍しくない**（作るものが決まっていて運用上の制限が少ない案件では 0 件が正常）。",
    "数を揃えるために Decision を言い換えて Rule にしない。0件で構わない。",
    "**確信が持てなければ抽出しない**（Rules は AI の行動を直接制約するため、誤起票のコストが用語より高い。直コミットされるので保守的に判断する）。",
    PRIVACY_RULE,
    "",
    "既存Ruleのタイトル一覧（これらと同一・実質同一の制約は抽出しない＝重複回避）。",
    "ただし既存の制約を否定・撤回・変更する新事実（矛盾。例: 禁止の解除・条件の変更）なら、破棄せず抽出し conflicts_with に矛盾する既存Ruleのタイトルを入れる:",
    existingRuleTitles.length ? existingRuleTitles.map((t) => `- ${t}`).join("\n") : "(なし)",
    excludedList.length ? "除外ルール（過去にレビューで却下。再追加しない）:\n" + excludedList.map((t) => `- ${t}`).join("\n") : "",
    "",
    "出典（rel/target）: このソースが既存のDecisionを制約として立てているなら rel=derived_from・target=そのDecisionのID（YYYYMMDD-NNN）。",
    "議事録・課題から直接読み取れる制約なら rel=based_on・target=安定ID（議事録: minute:{定例名}:{YYYYMMDD}、課題: 課題キー、外部: owner/repo#N）。",
    "安定IDが分からなければ rel/target は空文字にする（relations無しで起票する。ファイルパスは書かない）。",
    "",
  ].join("\n") + "\n";
  // 可変部（ソース本文と出力形式の指示）
  const variable = [
    `=== ソース: ${source.label} ===`,
    source.content,
    "",
    '抽出結果を items に入れてツールで提出する（0件なら items は []）。各要素の形:',
    '[{"title": "制約の1行表現", "description": "制約の1文要約", "rel": "derived_from|based_on|", "target": "安定ID または空", "conflicts_with": "矛盾する既存Ruleのタイトル。矛盾でなければ空文字"}]',
  ].join("\n");
  return callJSON("rule", { system: SYS_COMMON, prefix, variable, maxTokens: 2048, timeoutMs: 180_000 });
}

// 横断チェック（1回だけ）: 全ソースの抽出結果を横断し、重複統合・supersedes候補を指摘する（Gold品質の観察）。
//   指摘は報告用（採番済みファイルは変更しない）。
function llmBatchReview(decisions, terms, members, sourceLabels) {
  // 前置き（毎回同一。ただし1run1回の呼び出しなので実際にはキャッシュ対象の長さに満たない）
  const prefix = [
    "夜間Gold昇格の当日抽出結果一式です。横断チェックを行ってください。",
    "",
    "1. duplicates: 抽出結果の中で実質同一の決定があれば、そのタイトルの組を指摘する（統合の提案。ファイル操作はしない）。",
    "2. supersedes_candidates: 過去の決定を置き換えていそうな決定があれば「新タイトル → 置き換え対象の既存タイトル/ID」を指摘する。",
    PRIVACY_RULE,
    "",
  ].join("\n") + "\n";
  // 可変部（当日の抽出結果と出力形式の指示）
  const variable = [
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
    '結果をツールで提出する。形:',
    '{"duplicates": [["タイトルA", "タイトルB"], ...], "supersedes_candidates": ["新タイトル → 既存タイトル/ID", ...]}',
  ].join("\n");
  return callJSON("batch", { system: SYS_COMMON, prefix, variable, maxTokens: 2048, timeoutMs: 180_000 });
}

// ---------- 決定的: 検証・採番・frontmatter組み立て ----------

// 決定の採番: 日付ごとの既存最大NNN+1（ファイル名から機械取得。update-gold-auto Phase A と同じ規律）
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

// LLM が「この既存決定と矛盾する（撤回・方針転換）」として返したIDを、実在する Decision ID だけに絞る。
// 後方互換: フィールドが無い旧来の応答は空配列（＝新規扱い）になる。文字列・配列の両形式を受ける。
// 捏造ID（既存一覧に無いID）は警告して落とす（存在しない決定を指す supersedes を Gold に残さない）。
// ただし「矛盾として起票すること自体」は落とさない——新事実の取りこぼしを防ぐのがこの判定の目的なので、
// 参照だけを外して新レコードとして起票し、人のレビュー（draft→active）に委ねる。
function resolveSupersedes(value, existingIds, title) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const v of raw) {
    const m = String(v).match(/\d{8}-\d{3}/); // 「20260723-002（タイトル）」等の混在表記からIDだけ取る
    const id = m ? m[0] : "";
    if (!id) {
      warn(`supersedes の値がDecision ID形式ではないため無視します（${JSON.stringify(v)} / 対象: ${title}）。`);
      continue;
    }
    if (!existingIds.has(id)) {
      warn(`supersedes 先の Decision ${id} が実在しないため関係を張りません（捏造IDの可能性・対象: ${title}）。`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// LLM抽出の決定を検証・採番し、status: draft（AI生成・人間未確認）で「起票予定ファイル」に確定する。
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
    const supersedes = resolveSupersedes(d.supersedes ?? d.conflicts_with, existing.ids, title);
    // 矛盾（supersedes 付き）の場合だけ、既存titleとの衝突を「重複」と見なさない例外を認める。
    // 撤回・方針転換は表題が既存とほぼ同じになり得るため、ここで落とすと古い決定だけが Gold に残る。
    // ただし衝突相手に supersedes 対象でないレコードが混じるなら、それは同じ決定の再抽出
    // （実行窓のオーバーラップ・前夜に起票した撤回レコードとの衝突等）なので従来どおり重複として落とす。
    const collidingIds = existing.sigToIds.get(sig) || [];
    const overridesCollision =
      supersedes.length > 0 && collidingIds.length > 0 && collidingIds.every((id) => supersedes.includes(id));
    if (batchSigs.has(sig) || (existing.sigs.has(sig) && !overridesCollision)) {
      skipped.push({ item: d, reason: "既存/当夜バッチ内の Decision と正規化titleが一致（重複）" });
      continue;
    }
    if (supersedes.length) {
      warn(`既存Decision ${supersedes.join(" / ")} と矛盾する新事実として起票します（supersedesを張ったdraft・要レビュー）: ${title}`);
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
      "status: draft",
      // 矛盾を検出した場合も既存レコードは書き換えず、supersedes を張った新レコードで置き換えを表す
      // （Decisions は追記型＝「いつ・誰が・なぜ決めたか」の履歴。過去の判断を消すと経緯が追えない）。
      ...(supersedes.length || basedOn
        ? [
            "relations:",
            ...supersedes.flatMap((id) => ["  - rel: supersedes", `    target: ${yq(id)}`]),
            ...(basedOn ? ["  - rel: based_on", `    target: ${yq(basedOn)}`] : []),
          ]
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
      supersedes,
      content: fm + body,
    });
  }
  return { files, skipped };
}

// 用語: 既存title/synonyms・除外リスト・当夜バッチ内の正規化一致を落とし、status: draft で組み立てる
function buildTermFiles(extracted, existingTerms, excludedSigs, batchSigs, dateH) {
  const files = [];
  const skipped = [];
  const conflicts = [];
  for (const t of extracted) {
    const term = String(t.term || "").trim();
    const definition = String(t.definition || "").trim();
    if (!term || !definition) {
      skipped.push({ item: t, reason: "term または definition が空" });
      continue;
    }
    // 矛盾（既存の定義を否定・変更する新事実）: 用語は更新型だが、自動化は新規追加のみという原則を
    // 崩さないため既存レコードは書き換えず、起票もせずログに明記して人の確認に回す。
    // TODO(将来): 人のレビュー前提で、既存レコードへの定義更新（差分の提案・別ブランチ化等）まで
    //             自動化する余地がある。現状は「検出して知らせる」までに留める。
    const conflictWith = String(t.conflicts_with || "").trim();
    if (conflictWith) {
      warn(`既存レコード「${conflictWith}」（用語）と矛盾する内容が検出されました。人の確認が必要です（検出語: ${term}）。`);
      conflicts.push({ kind: "term", title: term, target: conflictWith });
      skipped.push({ item: t, reason: `既存用語「${conflictWith}」と矛盾（自動更新はしない・人の確認が必要）` });
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
      path: `Cortex/Glossary/records/${safe}.md`,
      id: `term:${safe}`,
      title: safe,
      content: fm + `\n\n${definition}\n`,
    });
  }
  return { files, skipped, conflicts };
}

// Rule: 既存title・除外リスト・当夜バッチ内の正規化一致を落とし、status: draft で組み立てる（用語Bと同型）。
// Rules/records が無い案件（マイグレーション未適用）はフェーズごとスキップする。
function buildRuleFiles(extracted, existingRules, excludedSigs, batchSigs) {
  const files = [];
  const skipped = [];
  const conflicts = [];
  if (!existingRules.dirExists) {
    if (extracted.length) skipped.push({ item: null, reason: "Cortex/Rules/records が無い案件のためフェーズごとスキップ" });
    return { files, skipped, conflicts };
  }
  for (const r of extracted) {
    const title = String(r.title || "").trim();
    const description = String(r.description || "").trim();
    if (!title || !description) {
      skipped.push({ item: r, reason: "title または description が空" });
      continue;
    }
    // 矛盾（既存の制約を否定・撤回・変更する新事実）: 用語と同じ扱い。既存Ruleを自動で書き換えず、
    // 矛盾する制約を並立させることもせず（Rules は AI の行動を直接縛るため両立は危険）、
    // ログに明記して人の確認に回す。TODO(将来): レビュー前提の更新自動化の余地はある。
    const conflictWith = String(r.conflicts_with || "").trim();
    if (conflictWith) {
      warn(`既存レコード「${conflictWith}」（Rule）と矛盾する内容が検出されました。人の確認が必要です（検出: ${title}）。`);
      conflicts.push({ kind: "rule", title, target: conflictWith });
      skipped.push({ item: r, reason: `既存Rule「${conflictWith}」と矛盾（自動更新はしない・人の確認が必要）` });
      continue;
    }
    const sig = normalizeSig(title);
    if (existingRules.sigs.has(sig)) {
      skipped.push({ item: r, reason: "既存Rule（title）と一致" });
      continue;
    }
    if (excludedSigs.has(sig)) {
      skipped.push({ item: r, reason: "除外ルールリストに該当" });
      continue;
    }
    if (batchSigs.has(sig)) {
      skipped.push({ item: r, reason: "当夜バッチ内で重複" });
      continue;
    }
    batchSigs.add(sig);
    const safe = sanitizeName(title);
    // relations は任意。rel が derived_from|based_on で target が「パスでない安定ID」のときだけ張る。
    const rel = ["derived_from", "based_on"].includes(r.rel) ? r.rel : "";
    const target = String(r.target || "").trim();
    const targetIsPath = target.includes("/") && target.includes(".md");
    const hasRelation = rel && target && !targetIsPath;
    const fm = [
      "---",
      "type: rule",
      `id: ${yq(`rule:${safe}`)}`,
      `title: ${yq(title)}`,
      `description: ${yq(description.split("\n")[0].slice(0, 120))}`,
      "status: draft",
      ...(hasRelation
        ? ["relations:", `  - rel: ${rel}`, `    target: ${yq(target)}`]
        : []),
      "---",
    ].join("\n");
    files.push({
      path: `Cortex/Rules/records/${safe}.md`,
      id: `rule:${safe}`,
      title,
      content: fm + `\n\n${description}\n`,
    });
  }
  return { files, skipped, conflicts };
}

// メンバー: 名簿（title/aliases）・当夜バッチ内の正規化一致を落とし、status: draft で組み立てる
// 姓名が揃っているか。名簿は人物を一意に特定する台帳なので、姓だけ・名だけの登録を防ぐ。
//   - 区切りがあるもの（"山田 太郎" / "Taro Yamada"）: 2語以上あれば姓名とみなす
//   - 区切りが無い日本語（"山田太郎"）: 漢字・かなが3文字以上あれば姓名とみなす
//     （日本語の姓名は連結すると3文字以上になるのが通例。2文字以下は姓だけの可能性が高い）
// 判定を誤って落としても、翌日以降に姓名が揃った形で再度現れれば拾える（起票しすぎより安全側）。
function isFullName(name) {
  const n = String(name || "").trim();
  if (!n) return false;
  if (/[\s　・･]/.test(n)) return n.split(/[\s　・･]+/).filter(Boolean).length >= 2;
  if (/^[A-Za-z.'-]+$/.test(n)) return false; // 区切りの無い英字1語は姓か名のどちらか
  return n.length >= 3;
}

function buildMemberFiles(extracted, roster, batchSigs) {
  const files = [];
  const skipped = [];
  if (!roster.dirExists) {
    if (extracted.length) skipped.push({ item: null, reason: "Cortex/Members/records が無い案件のためフェーズごとスキップ" });
    return { files, skipped };
  }
  for (const m of extracted) {
    const name = String(m.name || "").trim();
    if (!name) {
      skipped.push({ item: m, reason: "name が空" });
      continue;
    }
    // 名簿は人物を一意に特定するための台帳なので、姓名が揃っていないものは起票しない。
    // 姓だけのレコードは同姓の別人と区別できず、後から姓名が判明したときに二重登録になり、
    // 決定の deciders をどちらへ正規化すべきか決められなくなる。
    // プロンプトでも指示しているが、散文の指示は守られないことがあるのでここでも機械的に弾く。
    if (!isFullName(name)) {
      skipped.push({ item: m, reason: `姓名が揃っていない（人物を一意に特定できない）: ${name}` });
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
      path: `Cortex/Members/records/${sanitizeName(compact)}.md`,
      id: `member:${sanitizeName(compact)}`,
      title: name,
      content: fm + `\n\n${description}\n`,
    });
  }
  return { files, skipped };
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
  const existingTerms = loadExistingTerms();
  const excludedTerms = loadExcludedTerms();
  const existingRules = loadExistingRules();
  const excludedRules = loadExcludedRules();
  const roster = loadRoster();
  const decisionsGate = loadDecisionsGate();
  const today = jstToday();

  // ソース1件ごとに LLM 関数 A/B/C/D（冪等・逐次。1件の失敗は欠落として報告に載るだけ）
  const allDecisions = [];
  const allTerms = [];
  const allMembers = [];
  const allRules = [];
  const perSource = [];
  for (const src of sources) {
    const entry = { label: src.label, a: null, b: null, c: null, d: null, notes: [] };
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
      const a = llmExtractDecisions(s, existingDecisions.entries, roster.names);
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

    // D: Rule（Rules ディレクトリが無い案件はスキップ＝マイグレーション未適用）
    if (existingRules.dirExists) {
      const d = llmExtractRules(s, existingRules.titles, excludedRules.raw);
      if (d === null) {
        entry.notes.push("D(Rule抽出)が不正応答→スキップ");
      } else if (Array.isArray(d)) {
        entry.d = d.length;
        allRules.push(...d);
      } else {
        entry.notes.push("D(Rule抽出)が配列でない→スキップ");
      }
    }
    perSource.push(entry);
  }

  // [決定的] 検証・採番・重複排除・frontmatter組み立て
  const decisionBatchSigs = new Set();
  const dec = buildDecisionFiles(allDecisions, existingDecisions, decisionBatchSigs);
  const term = buildTermFiles(allTerms, existingTerms, excludedTerms.sigs, new Set(), today.dateH);
  const mem = buildMemberFiles(allMembers, roster, new Set());
  const rule = buildRuleFiles(allRules, existingRules, excludedRules.sigs, new Set());

  // [横断チェック・1回だけ] 重複統合・supersedes候補の指摘（Gold品質の観察。ファイルは変更しない）
  const batch = llmBatchReview(
    dec.files.map((f) => ({ id: f.id, title: f.title })),
    term.files.map((f) => f.title),
    mem.files.map((f) => f.title),
    sources.map((s) => s.label),
  );

  // 抽出に失敗した「ソース×フェーズ」のマスを集約する。
  // 1マスの失敗は他に波及しないが、run が成功のまま終わると増分起点 SINCE が前進し、
  // そのソースのその窓は二度と再処理されない（恒久的な取りこぼしになる）。
  const failedCells = [];
  for (const e of perSource) {
    for (const n of e.notes) {
      const m = n.match(/^([A-D])\((.+?)\)が不正応答/);
      if (m) failedCells.push(`${e.label} → ${m[2]}`);
    }
  }

  const result = { sources, perSource, dec, term, mem, rule, batch, failedCells };

  // [決定的] モード分岐
  if (MODE === "real") {
    applyReal(result);
  } else {
    const report = buildShadowReport(result);
    const summary = buildShadowSummary(result);
    writeShadowOutputs(report, summary);
  }

  // 落ちたマスの扱い（REALのみ強制。shadowは観察なので報告に留める）:
  //   通常は run を失敗させる。SINCE は「直近成功run」基準なので、失敗させれば窓が前進せず
  //   翌日のrunが同じ窓を再処理する＝取りこぼしが自動で回収される（状態ファイルを持たずに済む）。
  //   ただし恒常的に落ちるソースがあると毎晩赤くなり続け、他の失敗が埋もれる。
  //   連続失敗が GIVE_UP_AFTER に達したら、そのマスを諦めて run を成功させ、窓を前進させる。
  if (failedCells.length > 0) {
    const consecutive = Number(process.env.CONSECUTIVE_FAILURES || 0);
    const giveUpAfter = Number(process.env.GIVE_UP_AFTER || 2);
    const list = failedCells.map((c) => `  - ${c}`).join("\n");
    if (MODE !== "real") {
      warn(`抽出に失敗したマスが ${failedCells.length} 件あります（shadowのため報告のみ）:\n${list}`);
    } else if (consecutive >= giveUpAfter) {
      error(
        `抽出に失敗したマスが ${failedCells.length} 件ありますが、${consecutive}回連続で失敗しているため` +
          `このrunは成功として扱い、以下は諦めます（窓が前進するため再処理されません。人の確認が必要です）:\n${list}`,
      );
    } else {
      error(`抽出に失敗したマスが ${failedCells.length} 件あります。次回のrunで再処理するため、このrunを失敗させます:\n${list}`);
      process.exitCode = 1;
    }
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
  lines.push(`- 対象ソース: ${r.sources.length}件 / 起票予定: Decision ${r.dec.files.length}・用語 ${r.term.files.length}・メンバー ${r.mem.files.length}・ルール ${r.rule.files.length}`);
  const supersedingCount = r.dec.files.filter((f) => f.supersedes && f.supersedes.length).length;
  const conflictCount = (r.term.conflicts || []).length + (r.rule.conflicts || []).length;
  if (supersedingCount || conflictCount) {
    lines.push(`- 既存レコードとの矛盾: Decision ${supersedingCount}件（supersedesを張って起票）・用語/ルール ${conflictCount}件（起票せず・人の確認が必要）`);
  }
  lines.push("");
  lines.push("| ソース | A:決定 | B:用語 | C:メンバー | D:ルール | 備考 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const e of r.perSource) {
    lines.push(`| ${e.label} | ${e.a ?? "-"} | ${e.b ?? "-"} | ${e.c ?? "-"} | ${e.d ?? "-"} | ${e.notes.join("・") || ""} |`);
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

  out.push("## 横断チェックの指摘");
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

  // 3択判定のうち「矛盾」だけを抜き出した一覧（見落とすと古い決定だけが Gold に残るため独立節にする）
  out.push("## 既存レコードと矛盾した候補（3択判定の「矛盾」）");
  out.push("");
  const conflictLines = [
    ...r.dec.files
      .filter((f) => f.supersedes && f.supersedes.length)
      .map((f) => `- [decision] ${f.id} ${f.title} → supersedes: ${f.supersedes.join(" / ")}（draftで起票）`),
    ...[...(r.term.conflicts || []), ...(r.rule.conflicts || [])].map(
      (c) => `- [${c.kind}] ${c.title} ⚠ 既存「${c.target}」と矛盾（起票せず・人の確認が必要）`,
    ),
  ];
  out.push(conflictLines.length ? conflictLines.join("\n") : "- なし");
  out.push("");

  const skips = [
    ...r.dec.skipped.map((s) => ({ ...s, kind: "decision" })),
    ...r.term.skipped.map((s) => ({ ...s, kind: "term" })),
    ...r.mem.skipped.map((s) => ({ ...s, kind: "member" })),
    ...r.rule.skipped.map((s) => ({ ...s, kind: "rule" })),
  ];
  out.push("## 機械検証で落とした候補");
  out.push("");
  out.push(skips.length ? skips.map((s) => `- [${s.kind}] ${s.reason}: ${JSON.stringify(s.item && (s.item.title || s.item.term || s.item.name) || "")}`).join("\n") : "- なし");
  out.push("");

  out.push("## 起票するはずだったファイル（全文）");
  for (const f of [...r.dec.files, ...r.term.files, ...r.mem.files, ...r.rule.files]) {
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

// フェーズ別コミット（Decisions→用語集→メンバー→ルール）。各フェーズでファイル書込→validate-cortex.mjs→
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
    { files: r.term.files, dir: "Cortex/Glossary/", msg: "用語集に新規用語をdraftで自動追記" },
    { files: r.mem.files, dir: "Cortex/Members/", msg: "メンバー名簿に新規参加者をdraftで自動追記" },
    { files: r.rule.files, dir: "Cortex/Rules/", msg: "Rulesに新規ルールをdraftで自動追記" },
  ];
  for (const phase of phases) {
    if (!phase.files.length) continue;
    // 巻き戻しは「削除」ではなく「書き込み前の状態へ復元」する。
    // 新規作成なら削除、既存への上書きなら元の内容を書き戻す。将来レコードの更新を許すときに
    // 削除だけの巻き戻しだと、検証に失敗した瞬間に既存レコードを失う。
    const written = [];
    try {
      for (const f of phase.files) {
        // 既存レコードは書き換えない（新規追加のみ）。
        if (fs.existsSync(f.path)) {
          warn(`既存ファイルのためスキップ（書き換えない規律）: ${f.path}`);
          continue;
        }
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        written.push({ path: f.path, before: null }); // 書き込む前に退避（新規なので before は null）
        fs.writeFileSync(f.path, f.content, "utf-8");
      }
      if (!written.length) continue;
      if (!validate()) {
        for (const w of written) {
          try {
            if (w.before === null) fs.unlinkSync(w.path);
            else fs.writeFileSync(w.path, w.before, "utf-8");
          } catch {}
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
logUsageSummary();
