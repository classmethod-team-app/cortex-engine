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
};
writeFileSync("fleet-status.json", JSON.stringify(out, null, 2) + "\n");

const ICON = { ok: "✅", missing: "⬜", na: "➖", unknown: "❔" };
process.stderr.write(`fleet-status.json を生成: ${REPO} = ${score == null ? "—" : score + "%"}\n`);
for (const c of checks) process.stderr.write(`  ${ICON[c.status]} ${c.label}${c.detail ? " (" + c.detail + ")" : ""}\n`);
