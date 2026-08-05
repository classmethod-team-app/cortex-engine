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
 * 下の CHECKS が「セットアップ完了度の定義そのもの」であり、この定義が正本。
 * 人手でセットアップ進捗を確認したいときも、本スクリプトの出力（fleet-status.json / stderr の一覧）を読む。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// figma.json が使える状態かの判定は1箇所に集約する（sync-designs も同じものを呼ぶ）
import { hasRealFigmaKey } from "./figma-configured.mjs";

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
  // `tools:` の後に行内コメントが付くケースを許す。scaffold の既定はコメント無しだが、
  // 手で書き足された案件が実在する。resolve-external-sources.mjs の readFrontmatterMap は
  // `^tools:\s*(#.*)?$` で許しており、ここだけ「直後に改行が必須」だったため、
  // **同じ宣言を2つのスクリプトが別々に解釈していた**。実際にそう書かれた案件の tools が
  // fleet-status.json から丸ごと欠落し、「宣言と実体の食い違いを可視化する」はずの
  // 計測器自身が食い違いを作っていた。
  // `\s*` を `[ \t]*` に絞ると `\r` を食えなくなるので、CRLF は `\r?` で明示的に許す。
  const m = text.match(/^tools:[ \t]*(?:#[^\r\n]*)?\r?\n((?:[ \t]+\S.*\r?\n?)+)/m);
  if (!m) return null;
  const map = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^[ \t]+([^:\s]+):\s*([^#\n]+?)\s*(?:#.*)?$/);
    if (kv) map[kv[1].trim()] = kv[2].trim().replace(/['"]/g, "");
  }
  return Object.keys(map).length ? map : null;
}

/** Secrets Manager に入っているか（'true'/'false'）。未設定は null（=見ていない） */
function inManager(name) {
  const v = process.env[`IN_MANAGER_${name}`];
  if (v === undefined || v === "") return null;
  return v === "true";
}

/**
 * env の secret 有無フラグ（'true'/'false'）。未設定は null（=unknown）。
 * 設定UIから投入されたトークンは Secrets Manager に入り、移行が済んだ案件では
 * repo secret が消える。**両方を見ないと、移行した案件ほど充足度が落ちる。**
 */
function secret(name) {
  if (inManager(name) === true) return true;
  const v = process.env[`HAS_${name}`];
  if (v === undefined || v === "") return null;
  return v === "true";
}

/**
 * どこから供給されているか。移行の進み具合を画面に出すために使う。
 * **その値自体が揃っているときだけ答える。** 揃っていないのに供給元を書くと、
 * 欠けているものがあるのに「repo secret から来ています」と読めてしまう。
 */
function secretSource(name) {
  if (secret(name) !== true) return "";
  if (inManager(name) === true) return "Secrets Manager";
  if (process.env[`HAS_${name}`] === "true") return "repo secret";
  return "";
}
const okFromBool = (b) => (b === null ? "unknown" : b ? "ok" : "missing");
/** 同名の設定ファイルが複数あるもの（移動・複製の事故の兆候） */
function duplicateConfigs() {
  const names = ["materials-config.json", "ingest-config.json", "figma.json", "channels.json", "external-sources.json"];
  return names
    .map((name) => ({ name, paths: findConfigPathsAll(name) }))
    .filter((d) => d.paths.length > 1);
}
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
const usesFigmaInfer = hasRealFigmaKey(figmaJson);
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

// scaffold ドリフト: エンジンが所有するファイルが scaffold から乖離していないか。
// 対象は Gold層4区画の `README.md` / `template.md`（migration 0022 が配っているもの）だけに絞る。
// これらは「その区画のレコードをどう書くか」の規約の正本であり、案件がカスタマイズする対象ではない。
// 古いまま残るとAI（ビューアの「AIで編集」含む）が旧規約でレコードを書くため、追随漏れを検知する。
// Home.md は本文がエンジン所有でも frontmatter が案件固有なので、単純比較では必ず誤検知になる→対象外。
// scaffold のプレースホルダ（`{{クライアント名}}` 等）は案件側で実値に埋まっているのが正常なので、
// scaffold 側にプレースホルダがある行は比較から除く（migration 0022 の fill と同じ考え方）。
// scaffold を参照できない環境（案件リポ単体での実行等）では null を返し、チェックを na（➖）にする。
const SCAFFOLD_GOLD = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scaffold", "repo", "Cortex");
const OWNED_GOLD_SECTIONS = ["Decisions", "Glossary", "Members", "Rules"];
const OWNED_GOLD_FILES = ["README.md", "template.md"];
/** scaffold と同一内容か（プレースホルダ行は比較しない） */
function sameIgnoringPlaceholders(scaffoldText, repoText) {
  const a = scaffoldText.split("\n");
  const b = repoText.split("\n");
  if (a.length !== b.length) return false;
  return a.every((line, i) => hasPlaceholder(line) || line === b[i]);
}
/** 乖離しているファイルのリポ相対パス一覧（scaffold 参照不可なら null） */
function scaffoldDriftFiles() {
  if (listDir(SCAFFOLD_GOLD) === null) return null;
  const drifted = [];
  for (const section of OWNED_GOLD_SECTIONS) {
    if (listDir(`Cortex/${section}`) === null) continue; // 未導入・改名済みの区画は対象外
    for (const name of OWNED_GOLD_FILES) {
      const source = readText(join(SCAFFOLD_GOLD, section, name));
      if (source === null) continue; // scaffold 側に無いファイルは判定材料が無い
      const current = readText(`Cortex/${section}/${name}`);
      if (current === null || !sameIgnoringPlaceholders(source, current)) drifted.push(`Cortex/${section}/${name}`);
    }
  }
  return drifted;
}
const scaffoldDrift = scaffoldDriftFiles();

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
  { id: "scaffold_drift", label: "エンジン所有ファイルの追随", cat: "基盤", applies: scaffoldDrift !== null,
    status: scaffoldDrift === null ? "na" : (scaffoldDrift.length === 0 ? "ok" : "missing"),
    detail: scaffoldDrift === null ? undefined : (scaffoldDrift.length === 0 ? "乖離なし" : `${scaffoldDrift.length}件乖離: ${scaffoldDrift.join(", ")}`),
    action: "engine-migrate を実行してGold層の規約ドキュメント（README.md / template.md）をエンジン最新版に追随させる" },
  { id: "engine_token", label: "ENGINE_REPO_TOKEN", cat: "シークレット", applies: engineMigrated,
    status: okFromBool(secret("ENGINE_REPO_TOKEN")),
    action: "cortex-engine への read 専用 PAT を repo secret に登録（org secret は Free プランでは private リポに届かない）" },
  { id: "role_secret", label: "AWS_ROLE_TO_ASSUME", cat: "シークレット",
    status: okFromBool(secret("AWS_ROLE_TO_ASSUME")), action: "案件リポに RoleArn を登録" },
  // 同名の設定ファイルが複数あると、読み手は浅い方だけを見る。移動・複製の事故に気づけるようにする。
  { id: "config_duplicates", label: "設定ファイルの重複", cat: "Cortex",
    status: () => (duplicateConfigs().length ? "missing" : "ok"),
    detail: () => duplicateConfigs().map((d) => `${d.name}（${d.paths.join(" / ")}）`).join(" , "),
    action: "重複した設定ファイルを1つに整理する（読み手は浅い方だけを見ます）" },
  { id: "decisions_content", label: "Cortex/Decisions 実データ", cat: "Cortex",
    status: decisionsCount > 0 ? "ok" : "missing", detail: `${decisionsCount}件` },
  { id: "nightly_decisionlog", label: "夜間 Gold昇格 run", cat: "自動化",
    status: runStatus(runDecisionLog), detail: runDecisionLog || "" },
  // ---- 課題管理 == backlog ----
  { id: "backlog_secrets", label: "BACKLOG_* シークレット", cat: "課題管理", applies: usesTool("課題管理", "backlog", true),
    status: (() => { const vals = ["BACKLOG_API_KEY", "BACKLOG_DOMAIN", "BACKLOG_PROJECT_KEY"].map(secret);
      if (vals.some((v) => v === null)) return "unknown"; return vals.every(Boolean) ? "ok" : "missing"; })(),
    // DOMAIN / PROJECT_KEY が欠けていれば供給元を語らない（APIキーだけ見ると誤解を招く）
    detail: ["BACKLOG_DOMAIN", "BACKLOG_PROJECT_KEY"].every((n) => secret(n) === true)
      ? secretSource("BACKLOG_API_KEY") : "",
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
  // 「宣言はあるのに1件も導出されていない」を捕まえる。
  // 開発リポの Issues は .gitmodules から自動導出されるが、submodule の置き場が `開発/` 以外の案件は
  // Home.md に engine.dev_dir を宣言しないと導出が空振りする。しかも**その空振りは警告を出さない**
  // （resolveDevDir が warn するのは危険値のときだけで、未宣言は既定へ静かにフォールバックする）。
  // 実際に、submodule を持ち `開発: github` と宣言しているのに Issues が一度も読まれていない案件があった。
  { id: "dev_issues_derived", label: "開発 Issues の導出", cat: "開発",
    applies: usesTool("開発", "github", gitmodules != null) && gitmodules != null,
    status: () => (externalSources.some((x) => String(x.type).startsWith("github")) ? "ok" : "missing"),
    detail: () => externalSources.filter((x) => String(x.type).startsWith("github")).length + "件",
    action: "submodule の置き場が 開発/ 以外なら Cortex/Home.md に engine.dev_dir を宣言する" },
  // ---- 会議 == google-meet（議事録の自動取得 = Meet/Drive） ----
  { id: "meeting_minutes", label: "議事録(Meet自動取得) ※暫定", cat: "会議", applies: usesTool("会議", "google-meet", true),
    status: meetingCount > 0 ? "ok" : "missing", action: "Google Meet/Drive 連携を設定し文字起こしの自動取り込みを有効化する" },
  // ---- デザイン == figma ----
  { id: "figma_token", label: "FIGMA_TOKEN", cat: "デザイン", applies: usesTool("デザイン", "figma", usesFigmaInfer),
    status: okFromBool(secret("FIGMA_TOKEN")), detail: secretSource("FIGMA_TOKEN") },
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
  // **読めなかったとき、原因が「外部ソース用トークンの未設定」なのかを区別する。**
  // 以前は失敗を一律 `unreachable` にしていたため、「トークンが無い」と「スコープ不足/リポが無い」が
  // 同じ値になっていた。原因が1本のトークン未設定でも、ソースの行数だけ警告が並ぶ状態だった。
  //
  // 自リポの Issues は自動トークンで読めるので、フォールバック自体は残す（外すと読めているものまで
  // no_token になる）。切り分けるのは**失敗したとき**だけ。
  const external = process.env.EXTERNAL_SOURCES_TOKEN;
  const token = external || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return "no_token";
  try {
    execFileSync("gh", ["api", `repos/${ref}`, "--jq", ".id"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
        env: { ...process.env, GH_TOKEN: token } });
    return "ok";
  } catch (e) {
    const s = `${e.stderr || ""}${e.stdout || ""}`;
    if (/404|403|Not Found/i.test(s)) {
      // 外部ソース用トークンが無い状態で他リポを読もうとして落ちたなら、原因はスコープではなく未設定。
      // こう分けておくと、表示側が「N件読めていません（原因: トークン未設定）」と原因単位でまとめられる。
      return external ? "unreachable" : "no_token";
    }
    return "unknown";
  }
}

const externalSources = resolveExternalSourcesAll().map((s) => {
  const gate = s.type === "slack" ? probeSlackGate(s.ref) : probeGithubGate(s.ref);
  // goldState は resolver 由来の三値（on/off/undeclared/excluded）。表示側が「意図的な除外」と
  // 「宣言し忘れ」を区別するために要る（区別できないと正常なOFFにも警告が出て麻痺する）。
  // **ここは明示の許可リスト。列挙しないと画面まで届かない。**
  // resolver が付けた origin を落として、設定UIが「消してよいか」を判断できなくなっていた。
  const item = {
    type: s.type, name: s.name, ref: s.ref,
    gold: s.gold !== false, goldState: s.goldState,
    origin: s.origin,
  };
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
// applicable: Home.md tools の宣言からこの案件での適用可否を判定し、対象外だけ false を付ける
// （適用対象はフィールド省略＝true扱い。tools 未宣言の案件は判定材料が無いので全て適用扱い）。
// run結果（lastSuccess/lastConclusion）は対象外でもデータとして残す（過去に動いていた履歴の保全）。
function pipelineApplicable(id) {
  if (tools === null) return true;
  switch (id) {
    case "sync-designs":
    case "update-design-notes":
      // **宣言だけで決めない。** figma.json に実キーが無ければ同期は毎回スキップして
      // 正常終了するので、宣言だけで適用扱いにすると ✅ が並び「動いている」ように見える
      // （applicable はまさにそれを防ぐための印）。雛形のプレースホルダのまま放置された案件と、
      // 設定UIから最後の1件を外した案件が、どちらもこの状態になる。
      return tools["デザイン"] !== "none" && usesFigmaInfer;
    case "sync-materials":
      return tools["共有資料"] !== "none";
    case "sync-backlog":
    case "backlog-webhook-sync":
      return tools["課題管理"] === "backlog";
    case "ingest-minutes":
      return tools["会議"] !== "none";
    default:
      return true; // update-gold / validate-cortex / fleet-status / run-harness-skill(pm-daily/pm-weekly) 等は常に適用
  }
}
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
    if (!pipelineApplicable(id)) p.applicable = false;
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
// Home.md tools の宣言から4能力（課題管理・会議・共有資料・デザイン）を常に列挙し、
// none・未記載は enabled:false の非活性行として出す（アダプターの品揃えを隠さない）。
// ディレクトリ解決は既存の findDirByMarker を再利用。
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
/**
 * 同名の設定ファイルがリポジトリ内に複数あるか（浅い順で見つかったパスの一覧）。
 *
 * **なぜ見るか**: 資料の変換が設定ファイルを `共有資料/materials-config/` へ move する事故があり、
 * 読み手が空の正本を見て**2案件の資料同期が数週間止まった**。複数あること自体が異常の兆候なので、
 * 気づけるようにする。
 */
function findConfigPathsAll(marker) {
  const hits = [];
  if (readText(marker) != null) hits.push(marker);
  try {
    for (const d of readdirSync(".", { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === "node_modules" || d.name.startsWith(".")) continue;
      if (readText(`${d.name}/${marker}`) != null) hits.push(`${d.name}/${marker}`);
      for (const sub of (listDir(d.name) || [])) {
        if (readText(`${d.name}/${sub}/${marker}`) != null) hits.push(`${d.name}/${sub}/${marker}`);
      }
    }
  } catch {}
  return hits;
}
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
/**
 * 会議の取り込み状態。
 *
 * **「意図的にOFF」と「まだ設置していない」を潰さない。** 設定UIから ON/OFF を押せるように
 * する以上、画面が現在値を出せないと「押したのに変わらない」と読まれる。
 * `goldState` を三値にしたときと同じ理由（区別できないと正常なOFFにも警告が出て麻痺する）。
 */
function meetingIngestState() {
  const p = findConfigPath("ingest-config.json");
  if (!p) return "unset";
  try {
    const cfg = JSON.parse(readText(p) || "");
    return cfg.enabled ? "on" : "off";
  } catch { return "broken"; }
}
/**
 * 会議の照合キー: client名 ＋ ingest-config.json の meetingNamePatterns（未設置・壊れは undefined）。
 *
 * **`enabled` で出し分けない。** 照合キーは設定そのものの性質で、ON/OFFとは別の情報。
 * 画面は「どんな会議名なら取り込まれるか」を常に示す必要がある——招待しても名前が合わなければ
 * 届かないので、これは招待の判断に要る材料。ON/OFFは `ingestState` が別に伝える。
 */
function meetingMatchKeys() {
  const p = findConfigPath("ingest-config.json");
  if (!p) return undefined;
  try {
    const cfg = JSON.parse(readText(p) || "");
    const keys = [clientName, ...(cfg.meetingNamePatterns || [])]
      .map((s) => String(s).trim()).filter((s) => s && !/\{\{/.test(s));
    return keys.length ? [...new Set(keys)] : undefined;
  } catch { return undefined; }
}
/**
 * 共有資料の Drive 同期状態。
 * `driveSync: false` は後方互換のため残す（既存の読み手が見ている）。
 * **`driveState` で理由まで区別する**（未設置 / OFF / フォルダ未登録 / ON）。
 */
function materialsExtras() {
  const p = findConfigPath("materials-config.json");
  if (!p) return { driveSync: false, driveState: "unset", driveFolderCount: 0 };
  let cfg;
  try {
    cfg = JSON.parse(readText(p) || "");
  } catch {
    return { driveSync: false, driveState: "broken", driveFolderCount: 0 };
  }
  const ids = (cfg.driveFolderIds || []).filter(Boolean);
  if (!cfg.enabled) {
    return { driveSync: false, driveState: "off", driveFolderCount: ids.length, driveFolderIds: ids };
  }
  if (!ids.length) return { driveSync: false, driveState: "empty", driveFolderCount: 0 };
  // **urls は件数にも enabled にも関わらず出す。** 設定UIが「どのフォルダを外すか」を
  // 選ばせるのに要る。以前は「2件以上かつ有効」のときしか出しておらず、
  // 艦隊で唯一Driveを使っている案件がちょうど1件なので、一度も使えなかった。
  const urls = ids.map((id) => `https://drive.google.com/drive/folders/${id}`);
  return { url: urls[0], urls, driveFolderIds: ids, driveState: "on", driveFolderCount: ids.length };
}
/**
 * 同期対象のFigmaファイル一覧。
 * **設定UIが「どのファイルを外すか」を選ばせるのに要る**（以前は先頭1件のURLしか出していなかった）。
 * 6ファイルを登録している案件があり、先頭だけでは選べない。
 */
function figmaFileList() {
  const p = findConfigPath("figma.json");
  if (!p) return undefined;
  try {
    const files = (JSON.parse(readText(p) || "").files || [])
      .filter((f) => f && typeof f.key === "string" && /^[A-Za-z0-9_-]{8,}$/.test(f.key))
      .map((f) => ({ key: f.key, name: String(f.name || f.key) }));
    return files.length ? files : undefined;
  } catch { return undefined; }
}
function listInternalSources() {
  const defs = [
    { kind: "課題管理", def: "backlog",
      label: (t) => (t === "backlog" ? "Backlog 課題・ドキュメント（同期ミラー）" : `課題・ドキュメント（同期ミラー）（${toolDisp(t)}）`),
      url: (t) => (t === "backlog" ? backlogProjectUrl() : undefined), pipeline: "sync-backlog" },
    { kind: "会議", def: "google-meet",
      label: (t) => (t === "google-meet" ? "会議の文字起こし・議事録" : `会議の文字起こし・議事録（${toolDisp(t)}）`),
      // 取り込み対象の会議名の照合キー（ビューアが「この語が会議名に入れば取り込まれる」を表示）
      extra: () => { const keys = meetingMatchKeys(); return { ingestState: meetingIngestState(), ...(keys ? { matchKeys: keys } : {}) }; },
      pipeline: "ingest-minutes" },
    { kind: "共有資料", def: "google-drive",
      label: (t) => (t === "google-drive" ? "共有資料（Drive同期・Markdown変換）" : `共有資料（Markdown変換）（${toolDisp(t)}）`),
      // Drive自動同期の設定状態（未設定は driveSync:false でUIに正直に示す）
      extra: () => materialsExtras(),
      pipeline: "sync-materials" },
    { kind: "デザイン", def: "figma",
      label: (t) => (t === "figma" ? "デザイン（画面インベントリ・DESIGN.md）" : `デザイン（${toolDisp(t)}）`),
      url: (t) => (t === "figma" ? figmaFileUrl() : undefined),
      // 設定UIが「どのファイルを外すか」を選ばせるのに要る（先頭1件のURLだけでは選べない）
      extra: () => { const files = figmaFileList(); return files ? { figmaFiles: files } : {}; },
      pipeline: "sync-designs" },
  ];
  const out = [];
  for (const d of defs) {
    // tools 宣言があればそれに従う。未宣言（旧構成）の案件は既定ツールで推測
    // （デザインだけは figma.json の実値の有無で推測。既存チェックの usesFigmaInfer と同思想）。
    const tool = tools === null
      ? (d.kind === "デザイン" ? (usesFigmaInfer ? "figma" : null) : d.def)
      : tools[d.kind];
    if (tools === null) {
      // 旧構成: 推測できない能力は従来どおり載せない
      if (!tool) continue;
    } else if (!tool || tool === "none") {
      // 「アダプターとして何があるか」を常に全部見せる方針: none・未記載でも行は出し、
      // enabled:false で未使用（非活性）を表現する（url/lastSync/matchKeys 等の詳細は付けない）。
      out.push({ kind: d.kind, tool: "none", label: d.kind, enabled: false });
      continue;
    }
    // 有効エントリは enabled を付けない（省略＝true扱い）
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
  // status / detail / applies は関数で書ける（遅延評価）。CHECKS は externalSources より前に
  // 定義されるため、後続の値に依存するチェックは関数にしないと参照できない（TDZ）。
  const applies = typeof c.applies === "function" ? c.applies() : c.applies;
  const rawStatus = typeof c.status === "function" ? c.status() : c.status;
  const status = applies === false ? "na" : rawStatus;
  const w = c.weight || 1;
  if (status === "ok") { okW += w; denW += w; } else if (status === "missing") { denW += w; }
  return { id: c.id, label: c.label, category: c.cat, status, weight: w,
    detail: (typeof c.detail === "function" ? c.detail() : c.detail) || undefined,
    action: status === "missing" ? c.action : undefined };
});
const score = denW > 0 ? Math.round((okW / denW) * 100) : null;
const nextActions = checks.filter((c) => c.status === "missing" && c.action).map((c) => c.action);

const out = {
  generatedAt: NOW, repository: REPO, project: projectName, tools: tools || undefined,
  // エンジン分離の状態（巡回エージェントがフリートのバージョン分布・移行状況を見る）
  // scaffoldDrift: エンジン所有ファイルのうち scaffold と乖離しているものの一覧
  // （空配列＝乖離なし／scaffold を参照できない環境ではフィールド自体を省略）
  engine: { migrated: engineMigrated, version: engineVersion, channel: engineChannel, schemaVersion,
    scaffoldDrift: scaffoldDrift ?? undefined },
  score, checks, nextActions,
  // 外部ソース接続状況（gate=物理ゲート実測）・リポ内同期ソース一覧・夜間パイプライン一覧（AISビューア表示用）
  externalSources, internalSources, pipelines,
  // 各トークンをどこから取っているか（AISビューアの「連携の鍵」に出す）。
  // 「入れたのに、まだ repo secret で動いている」が画面で分かるようにするためのもの。
  // キーは設定UI側の連携名（resolveSecretTarget の kind）と揃える。
  secretSources: {
    figma: secretSource("FIGMA_TOKEN"),
    backlog: secretSource("BACKLOG_API_KEY"),
    "external-sources": secretSource("EXTERNAL_SOURCES_TOKEN"),
  },
};
writeFileSync("fleet-status.json", JSON.stringify(out, null, 2) + "\n");

const ICON = { ok: "✅", missing: "⬜", na: "➖", unknown: "❔" };
process.stderr.write(`fleet-status.json を生成: ${REPO} = ${score == null ? "—" : score + "%"}\n`);
for (const c of checks) process.stderr.write(`  ${ICON[c.status]} ${c.label}${c.detail ? " (" + c.detail + ")" : ""}\n`);
