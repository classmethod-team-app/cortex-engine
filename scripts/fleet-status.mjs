#!/usr/bin/env node
/**
 * セットアップ状況の自己チェック（案件リポで実行）
 *
 * この案件リポ自身のセットアップ充足度を算出し、リポジトリ直下の `fleet-status.json`
 * に書き出す。巡回エージェント／フリート管理はこのファイルを各案件から読み集約する。
 *
 * - 案件側で完結する（中央AWSは見ない）。Viewer/インフラ状況は cortex-tools 側が別途持つ。
 * - シークレットの有無は GitHub Actions の `secrets.X != ''` を env で受け取る（管理者権限不要）。
 *   ローカル実行時は env 未設定 → "unknown"。
 * - チェックの applicability は `Cortex/Home.md` frontmatter の `tools`（能力→ツール）で決める。
 *   例: `課題管理: backlog` のときだけ BACKLOG_* を見る。Teams/Box 等なら ➖。
 *   `tools` 未宣言の案件は推測にフォールバックする。
 * - 判定: ok(✅) / missing(⬜) / na(➖ 該当なし) / unknown(❔)
 *   スコア = ok ÷ (ok + missing) × 100（na・unknown は分母から除外）
 *
 * チェック項目は案件側スキル `setup-status` を踏襲し、夜間ワークフロー結果を加えている。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const NOW = process.env.FLEET_NOW || new Date().toISOString();
const REPO = process.env.GITHUB_REPOSITORY || tryGitRepo();

// ---------- 小道具 ----------
function tryGitRepo() {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
    const m = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    return m ? m[1] : "";
  } catch { return ""; }
}
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const listDir = (p) => { try { return readdirSync(p); } catch { return null; } };
const hasPlaceholder = (t) => !!t && /\{\{[^}]+\}\}/.test(t);

/** Home.md frontmatter の `tools`（能力→ツール）を { capability: tool } で返す。無しは null */
function parseTools(text) {
  if (!text) return null;
  const m = text.match(/^tools:\s*\n((?:[ \t]+\S.*\n?)+)/m);
  if (!m) return null;
  const map = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^[ \t]+([^:\s]+):\s*([^#\n]+?)\s*(?:#.*)?$/);
    if (kv) map[kv[1].trim()] = kv[2].trim().replace(/['"]/g, "");
  }
  return Object.keys(map).length ? map : null;
}

/** env の secret 有無フラグ（'true'/'false'）。未設定は null（=unknown） */
function secret(name) {
  const v = process.env[`HAS_${name}`];
  if (v === undefined || v === "") return null;
  return v === "true";
}
const okFromBool = (b) => (b === null ? "unknown" : b ? "ok" : "missing");
/** 自分のリポの直近ワークフローrun結果。取得不可は null */
function lastRun(workflowFile) {
  try {
    const out = execFileSync("gh", ["run", "list", "--workflow", workflowFile, "--limit", "1", "--json", "conclusion,status"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const a = JSON.parse(out);
    if (!a.length) return "none";
    return a[0].status === "completed" ? a[0].conclusion : a[0].status;
  } catch { return null; }
}
const runStatus = (r) => (r == null ? "unknown" : r === "success" ? "ok" : "missing");

// ---------- 信号収集（カレント＝リポ直下） ----------
const home = readText("Cortex/Home.md");
// 旧テンプレ複製方式は .rulesync/rules/overview.md、エンジン分離後は薄い CLAUDE.md が概要を持つ
const overview = readText(".rulesync/rules/overview.md") ?? readText("CLAUDE.md");
const readme = readText("README.md");
const channels = readText("チャット/channels.json");
const gitmodules = readText(".gitmodules");

// ディレクトリ名は案件でカスタマイズされ得る（例: 課題管理/→Backlog/、デザイン/→Figma/、会議/→MTG/）。
// マーカーファイル（backlog-settings.json / figma.json / ingest-config.json）の場所から導出する。
function findDirByMarker(marker, fallback) {
  try {
    for (const d of readdirSync(".", { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === "node_modules" || d.name.startsWith(".")) continue;
      try { readFileSync(`${d.name}/${marker}`); return d.name; } catch {}
      // backlog-settings.json は issues/ 等の1階層下に置かれる
      for (const sub of (listDir(d.name) || [])) {
        try { readFileSync(`${d.name}/${sub}/${marker}`); return d.name; } catch {}
      }
    }
  } catch {}
  return fallback;
}
const issuesDir = findDirByMarker("backlog-settings.json", "課題管理");
const designDir = findDirByMarker("figma.json", "デザイン");
const meetingDir = findDirByMarker("ingest-config.json", "会議");
const figmaJson = readText(`${designDir}/figma.json`);

const decisionsCount = (listDir("Cortex/Decisions/records") || []).filter((n) => n.endsWith(".md") && !n.includes("{{")).length;
const issuesCount = (listDir(`${issuesDir}/issues`) || []).length;
const inventoryCount = (listDir(`${designDir}/inventory`) || []).length;
const meetingCount = (listDir(meetingDir) || []).length;

// 案件の利用ツール宣言（Cortex/Home.md の `tools`: 能力→ツール）。
// 宣言があればそれで applicability を決め、無ければ推測にフォールバックする（未移行案件のため）。
const tools = parseTools(home);
const usesFigmaInfer = !!(figmaJson && !hasPlaceholder(figmaJson) && /"key"\s*:\s*"[^"\s]+"/.test(figmaJson));
/** capability のツールが expected か。tools 未宣言なら fallback */
const usesTool = (cap, expected, fallback) => (tools === null ? fallback : tools[cap] === expected);

const runDecisionLog = lastRun("update-gold.yml");
const runBacklog = lastRun("sync-backlog.yml");
const runDesigns = lastRun("sync-designs.yml");

const projectName = (() => {
  const m = home && home.match(/^project:\s*["']?([^"'\n#]+)/m);
  return m ? m[1].trim() : REPO;
})();

// ---------- エンジン分離の状態 ----------
// 移行済みか＝engine-migrate スタブの有無で判定する
const engineMigrated = readText(".github/workflows/engine-migrate.yml") != null;
// エンジンのバージョン: ワークフローが渡す ENGINE_VERSION（job_workflow_sha）を優先し、
// 空なら CI 上のエンジン checkout（.cortex-engine）の SHA にフォールバック
const engineVersion = (() => {
  if (process.env.ENGINE_VERSION) return process.env.ENGINE_VERSION;
  try {
    return execFileSync("git", ["-C", ".cortex-engine", "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
})();
const engineChannel = (() => { const m = home && home.match(/^\s*channel:\s*(\w+)/m); return m ? m[1] : null; })();
const schemaVersion = (() => { const m = home && home.match(/^\s*schema_version:\s*(\d+)/m); return m ? Number(m[1]) : null; })();

// ---------- チェック定義 ----------
const CHECKS = [
  // ---- 常に対象（基盤） ----
  { id: "placeholders", label: "プレースホルダ展開", cat: "基盤",
    status: (overview == null && home == null) ? "unknown" : (hasPlaceholder(overview) || hasPlaceholder(home) ? "missing" : "ok"),
    action: "/setup-project の setup-fill を実値で再実行" },
  { id: "home_card", label: "Home識別カード", cat: "基盤",
    status: home == null ? "missing" : (/kind:/.test(home) && /lifecycle:/.test(home) && !hasPlaceholder(home) ? "ok" : "missing"),
    action: "Cortex/Home.md の kind/lifecycle/client/tools を記入" },
  { id: "overview_filled", label: "overview記入", cat: "基盤",
    status: overview == null ? "missing" : (hasPlaceholder(overview) ? "missing" : "ok") },
  { id: "readme_project", label: "README案件化", cat: "基盤",
    status: readme == null ? "unknown" : (hasPlaceholder(readme) ? "missing" : "ok") },
  { id: "engine_migrated", label: "エンジン分離 移行", cat: "基盤",
    status: engineMigrated ? "ok" : "missing",
    action: "エンジン分離構成へ移行（cortex-engine scaffold のスタブ・settings.json を配置）" },
  { id: "engine_token", label: "ENGINE_REPO_TOKEN", cat: "シークレット", applies: engineMigrated,
    status: okFromBool(secret("ENGINE_REPO_TOKEN")),
    action: "cortex-engine への read 専用 PAT を repo secret に登録（org secret は Free プランでは private リポに届かない）" },
  { id: "role_secret", label: "AWS_ROLE_TO_ASSUME", cat: "シークレット",
    status: okFromBool(secret("AWS_ROLE_TO_ASSUME")), action: "案件リポに RoleArn を登録" },
  { id: "decisions_content", label: "Cortex/Decisions 実データ", cat: "Cortex",
    status: decisionsCount > 0 ? "ok" : "missing", detail: `${decisionsCount}件` },
  { id: "nightly_decisionlog", label: "夜間 Gold昇格 run", cat: "自動化",
    status: runStatus(runDecisionLog), detail: runDecisionLog || "" },
  // ---- 課題管理 == backlog ----
  { id: "backlog_secrets", label: "BACKLOG_* シークレット", cat: "課題管理", applies: usesTool("課題管理", "backlog", true),
    status: (() => { const vals = ["BACKLOG_API_KEY", "BACKLOG_DOMAIN", "BACKLOG_PROJECT_KEY"].map(secret);
      if (vals.some((v) => v === null)) return "unknown"; return vals.every(Boolean) ? "ok" : "missing"; })(),
    action: "案件の Backlog 値を Secret 登録" },
  { id: "backlog_synced", label: "課題管理 同期データ", cat: "課題管理", applies: usesTool("課題管理", "backlog", true),
    status: issuesCount > 0 ? "ok" : "missing", detail: `${issuesCount}件`, action: "sync-backlog を workflow_dispatch で実行（初回全量同期）" },
  { id: "nightly_backlog", label: "夜間 Backlog同期 run", cat: "自動化", applies: usesTool("課題管理", "backlog", true),
    status: runStatus(runBacklog), detail: runBacklog || "" },
  // ---- チャット == slack | teams ----
  { id: "channels_json", label: "channels.json 充足", cat: "チャット", applies: usesTool("チャット", "slack", true) || usesTool("チャット", "teams", false),
    status: (() => { if (channels == null) return "missing"; try { return (JSON.parse(channels).channels || []).some((x) => (x.url || "").length > 0 && !/CHANNEL_ID/.test(x.url)) ? "ok" : "missing"; } catch { return "missing"; } })(),
    action: "チャット/channels.json に実チャンネルを登録" },
  // ---- 開発 == github（ソースコードrepoをsubmoduleで同梱） ----
  { id: "submodules", label: "開発 submodule 構成", cat: "開発", applies: usesTool("開発", "github", gitmodules != null),
    status: gitmodules == null ? "missing" : (hasPlaceholder(gitmodules) ? "missing" : "ok"),
    action: "開発リポを submodule として追加" },
  // ---- 会議 == google-meet（議事録の自動取得 = Meet/Drive） ----
  { id: "meeting_minutes", label: "議事録(Meet自動取得) ※暫定", cat: "会議", applies: usesTool("会議", "google-meet", true),
    status: meetingCount > 0 ? "ok" : "missing", action: "Google Meet/Drive 連携を設定し post-meeting を回す" },
  // ---- デザイン == figma ----
  { id: "figma_token", label: "FIGMA_TOKEN", cat: "デザイン", applies: usesTool("デザイン", "figma", usesFigmaInfer),
    status: okFromBool(secret("FIGMA_TOKEN")) },
  { id: "figma_inventory", label: "デザインinventory 同期", cat: "デザイン", applies: usesTool("デザイン", "figma", usesFigmaInfer),
    status: inventoryCount > 0 ? "ok" : "missing", detail: `${inventoryCount}件`, action: "/sync-designs で同期" },
  { id: "figma_sync", label: "夜間 デザイン同期 run", cat: "デザイン", applies: usesTool("デザイン", "figma", usesFigmaInfer),
    status: runStatus(runDesigns), detail: runDesigns || "" },
];

// ---------- 外部ソース接続状況（best-effort・失敗しても全体は成功） ----------
// 「何と接続していて、毎晩何がGoldに昇格するか」をAISビューアが表示するための材料。
// ソース解決は update-gold と同一の resolve-external-sources.mjs（--all＝除外込み全登録）を再利用し、
// 物理ゲート（bot招待・トークンスコープ）をソース1件につき1コールで実測する。
const RESOLVER = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "resolve-external-sources.mjs");

function resolveExternalSourcesAll() {
  try {
    const out = execFileSync("node", [RESOLVER, "--all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 });
    return JSON.parse(out);
  } catch { return []; }
}

/** slack の物理ゲート実測: bot招待済みで読めるか（conversations.history limit=1） */
function probeSlackGate(ref) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return "no_token";
  try {
    const body = execFileSync("curl", ["-sS", "--max-time", "5", "-G",
      "https://slack.com/api/conversations.history",
      "-H", `Authorization: Bearer ${token}`,
      "--data-urlencode", `channel=${ref}`,
      "--data-urlencode", "limit=1"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
    const j = JSON.parse(body);
    if (j.ok) return "ok";
    if (j.error === "not_in_channel") return "not_in_channel";
    if (j.error === "channel_not_found" || j.error === "is_archived") return "unreachable";
    return "unknown";
  } catch { return "unknown"; }
}

/** github の物理ゲート実測: トークンスコープでリポが見えるか（repos/{ref} 1コール） */
function probeGithubGate(ref) {
  const token = process.env.EXTERNAL_SOURCES_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return "no_token";
  try {
    execFileSync("gh", ["api", `repos/${ref}`, "--jq", ".id"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
        env: { ...process.env, GH_TOKEN: token } });
    return "ok";
  } catch (e) {
    const s = `${e.stderr || ""}${e.stdout || ""}`;
    if (/404|403|Not Found/i.test(s)) return "unreachable";
    return "unknown";
  }
}

const externalSources = resolveExternalSourcesAll().map((s) => {
  const gate = s.type === "slack" ? probeSlackGate(s.ref) : probeGithubGate(s.ref);
  const item = { type: s.type, name: s.name, ref: s.ref, gold: s.gold !== false };
  if (s.type === "slack") item.notify = s.notify === true;
  // 表示用URL（判明する場合のみ付与）: slack=channels.json の url / github系=ref から機械導出
  let url;
  if (s.type === "slack") url = s.url;
  else if (s.type === "github-issues") url = `https://github.com/${s.ref}`;
  else if (s.type === "github-discussions") url = `https://github.com/${s.ref}/discussions`;
  if (url) item.url = url;
  item.gate = gate;
  return item;
});

// ---------- パイプライン一覧（エンジンreusableを uses しているスタブ） ----------
// 「毎晩どの配管が動いているか」の宣言的な一覧。lastSuccess と直近completed runの成否
// （lastConclusion/lastRun）を gh で best-effort 取得
// （権限不足・取得失敗はフィールド省略で静かに続行。engine-migrate はデータ配管ではないので除外）。
function listPipelines() {
  const dir = ".github/workflows";
  const out = [];
  for (const f of (listDir(dir) || []).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = readText(`${dir}/${f}`);
    if (!text || !/uses:\s*\S*cortex-engine\/\.github\/workflows\//.test(text)) continue;
    const id = f.replace(/\.ya?ml$/, "");
    if (id === "engine-migrate") continue;
    const nameM = text.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    const p = { id, label: nameM ? nameM[1] : id };
    try {
      const runs = execFileSync("gh", ["run", "list", "--workflow", f, "--status", "success", "-L", "1", "--json", "createdAt"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
      const arr = JSON.parse(runs);
      if (arr.length && arr[0].createdAt) p.lastSuccess = arr[0].createdAt;
    } catch {}
    // 直近の completed run の成否（in_progress しか無い場合に備え直近5件から探す）。＋1コール/パイプラインまで。
    try {
      const runs = execFileSync("gh", ["run", "list", "--workflow", f, "-L", "5", "--json", "status,conclusion,createdAt"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
      const done = JSON.parse(runs).find((r) => r.status === "completed");
      if (done) {
        if (done.conclusion) p.lastConclusion = done.conclusion;
        if (done.createdAt) p.lastRun = done.createdAt;
      }
    } catch {}
    out.push(p);
  }
  return out;
}
const pipelines = listPipelines();

// ---------- リポ内同期ソース一覧（Gold昇格の読み取り対象の全体像） ----------
// 夜間Gold昇格の差分ゲートはリポ全体の.md変更を見るため、実際の読み取り対象は外部ソースだけでなく
// 同期ミラー（課題管理・会議・共有資料・デザイン）を含む。ビューアが全体像を表示するための一覧。
// Home.md tools の宣言から列挙し（none は載せない）、ディレクトリ解決は既存の findDirByMarker を再利用。
// lastSync は取得済み pipelines の lastSuccess を対応付けて再利用（追加のAPI呼び出しをしない）。
// 開発（github）とチャット（slack）は externalSources 側で表現済みのため載せない。
function pipelineLastSuccess(id) {
  const p = pipelines.find((x) => x.id === id);
  return p && p.lastSuccess ? p.lastSuccess : undefined;
}
const toolDisp = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
/** backlog-settings.json からプロジェクトURLを機械導出（できない場合は undefined） */
function backlogProjectUrl() {
  try {
    const j = JSON.parse(readText(`${issuesDir}/issues/backlog-settings.json`) || "");
    if (!j.domain) return undefined;
    return j.projectIdOrKey ? `https://${j.domain}/projects/${j.projectIdOrKey}` : `https://${j.domain}/`;
  } catch { return undefined; }
}
/** figma.json の先頭ファイルキーからデザインファイルURLを導出（プレースホルダ・欠如は undefined） */
function figmaFileUrl() {
  try {
    const j = JSON.parse(figmaJson || "");
    const key = j.files && j.files[0] && j.files[0].key;
    if (!key || /[{}\s]/.test(key)) return undefined;
    return `https://www.figma.com/design/${key}`;
  } catch { return undefined; }
}
/** 設定ファイルをリポ内から探す（ルート直下→1階層→2階層。notetakerのProjects.gsと同じ発想の探索） */
function findConfigPath(marker) {
  if (readText(marker) != null) return marker;
  try {
    for (const d of readdirSync(".", { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === "node_modules" || d.name.startsWith(".")) continue;
      if (readText(`${d.name}/${marker}`) != null) return `${d.name}/${marker}`;
      for (const sub of (listDir(d.name) || [])) {
        if (readText(`${d.name}/${sub}/${marker}`) != null) return `${d.name}/${sub}/${marker}`;
      }
    }
  } catch {}
  return null;
}
/** Home.md frontmatter の client 名（会議照合の既定キー）。未記入・空は "" */
const clientName = (() => {
  const m = home && home.match(/^client:\s*["']?([^"'\n#]*?)["']?\s*(?:#.*)?$/m);
  return m ? m[1].trim() : "";
})();
/** 会議の照合キー: client名 ＋ ingest-config.json の meetingNamePatterns（無効・未設置は undefined） */
function meetingMatchKeys() {
  const p = findConfigPath("ingest-config.json");
  if (!p) return undefined;
  try {
    const cfg = JSON.parse(readText(p) || "");
    if (!cfg.enabled) return undefined;
    const keys = [clientName, ...(cfg.meetingNamePatterns || [])]
      .map((s) => String(s).trim()).filter((s) => s && !/\{\{/.test(s));
    return keys.length ? [...new Set(keys)] : undefined;
  } catch { return undefined; }
}
/** 共有資料の Drive 同期状態: 有効なら url（先頭）＋複数時 urls、未設置/無効/空なら driveSync:false */
function materialsExtras() {
  const p = findConfigPath("materials-config.json");
  if (p) {
    try {
      const cfg = JSON.parse(readText(p) || "");
      const ids = (cfg.driveFolderIds || []).filter(Boolean);
      if (cfg.enabled && ids.length) {
        const urls = ids.map((id) => `https://drive.google.com/drive/folders/${id}`);
        const ex = { url: urls[0] };
        if (urls.length > 1) ex.urls = urls;
        return ex;
      }
    } catch {}
  }
  return { driveSync: false };
}
function listInternalSources() {
  const defs = [
    { kind: "課題管理", def: "backlog",
      label: (t) => (t === "backlog" ? "Backlog 課題・ドキュメント（同期ミラー）" : `課題・ドキュメント（同期ミラー）（${toolDisp(t)}）`),
      url: (t) => (t === "backlog" ? backlogProjectUrl() : undefined), pipeline: "sync-backlog" },
    { kind: "会議", def: "google-meet",
      label: (t) => (t === "google-meet" ? "会議の文字起こし・議事録" : `会議の文字起こし・議事録（${toolDisp(t)}）`),
      // 取り込み対象の会議名の照合キー（ビューアが「この語が会議名に入れば取り込まれる」を表示）
      extra: () => { const keys = meetingMatchKeys(); return keys ? { matchKeys: keys } : {}; },
      pipeline: "ingest-minutes" },
    { kind: "共有資料", def: "google-drive",
      label: (t) => (t === "google-drive" ? "共有資料（Drive同期・Markdown変換）" : `共有資料（Markdown変換）（${toolDisp(t)}）`),
      // Drive自動同期の設定状態（未設定は driveSync:false でUIに正直に示す）
      extra: () => materialsExtras(),
      pipeline: "sync-materials" },
    { kind: "デザイン", def: "figma",
      label: (t) => (t === "figma" ? "デザイン（画面インベントリ・DESIGN.md）" : `デザイン（${toolDisp(t)}）`),
      url: (t) => (t === "figma" ? figmaFileUrl() : undefined), pipeline: "sync-designs" },
  ];
  const out = [];
  for (const d of defs) {
    // tools 宣言があればそれに従う（none・未記載は載せない）。未宣言（旧構成）の案件は既定ツールで推測
    // （デザインだけは figma.json の実値の有無で推測。既存チェックの usesFigmaInfer と同思想）。
    const tool = tools === null
      ? (d.kind === "デザイン" ? (usesFigmaInfer ? "figma" : null) : d.def)
      : tools[d.kind];
    if (!tool || tool === "none") continue;
    const item = { kind: d.kind, tool, label: d.label(tool) };
    const url = d.url ? d.url(tool) : undefined;
    if (url) item.url = url;
    if (d.extra) Object.assign(item, d.extra(tool));
    const last = pipelineLastSuccess(d.pipeline);
    if (last) item.lastSync = last;
    out.push(item);
  }
  return out;
}
const internalSources = listInternalSources();

// ---------- 評価 ----------
let okW = 0, denW = 0;
const checks = CHECKS.map((c) => {
  const status = c.applies === false ? "na" : c.status;
  const w = c.weight || 1;
  if (status === "ok") { okW += w; denW += w; } else if (status === "missing") { denW += w; }
  return { id: c.id, label: c.label, category: c.cat, status, weight: w,
    detail: c.detail || undefined, action: status === "missing" ? c.action : undefined };
});
const score = denW > 0 ? Math.round((okW / denW) * 100) : null;
const nextActions = checks.filter((c) => c.status === "missing" && c.action).map((c) => c.action);

const out = {
  generatedAt: NOW, repository: REPO, project: projectName, tools: tools || undefined,
  // エンジン分離の状態（巡回エージェントがフリートのバージョン分布・移行状況を見る）
  engine: { migrated: engineMigrated, version: engineVersion, channel: engineChannel, schemaVersion },
  score, checks, nextActions,
  // 外部ソース接続状況（gate=物理ゲート実測）・リポ内同期ソース一覧・夜間パイプライン一覧（AISビューア表示用）
  externalSources, internalSources, pipelines,
};
writeFileSync("fleet-status.json", JSON.stringify(out, null, 2) + "\n");

const ICON = { ok: "✅", missing: "⬜", na: "➖", unknown: "❔" };
process.stderr.write(`fleet-status.json を生成: ${REPO} = ${score == null ? "—" : score + "%"}\n`);
for (const c of checks) process.stderr.write(`  ${ICON[c.status]} ${c.label}${c.detail ? " (" + c.detail + ")" : ""}\n`);
