/**
 * 案件リポに MCP サーバー定義（`.mcp.json`）を配布する。
 *
 * 狙い: 対話セッションからの外部書き込みを「鍵は各自・投稿は本人名義」で行えるようにする。
 * 自動化（夜間 cron）は GitHub Actions Secrets を使うが、人が Claude Code から課題に返信したり
 * Issue を立てたりする対話経路は、**その人自身の資格情報**で動くべきである。その結合点を
 * リポジトリ同梱の `.mcp.json` が解く（各自は環境変数1個 or 初回OAuthだけで繋がる）。
 *
 * 配るのは2エントリのみ:
 *  - `backlog`: npx 型 stdio（`backlog-mcp-server`）。ドメインは秘密ではないので実値を焼き込み、
 *    **利用者の秘密は `BACKLOG_API_KEY` 1個だけ**（`${BACKLOG_API_KEY}` 参照＝各自の環境変数）。
 *    ドメインは `課題管理/issues/backlog-settings.json`（同期ミラーの生成物）から機械導出する。
 *  - `github`: GitHub 公式ホストのリモート MCP（`type: http`）。認証は各自の初回 OAuth なので
 *    **設定ファイルに秘密ゼロ**。gh CLI を入れていない非エンジニアでも Issue/PR 操作ができる。
 *
 * 所有権モデル（キー単位）:
 *   `mcpServers` のうち**エンジンが配った既知名（backlog / github）だけ**をエンジンが管理する。
 *   案件が独自に足した他のキーには永久に触らない。エンジン管理キーであっても、**既に存在する場合は
 *   内容が何であれ上書きせず `::warning` を出すだけ**にする（案件側のカスタムを壊さない。0013 と同じ保守則）。
 *
 * autoApply: true（新規キーの追記のみ・既存値は不変・冪等）。
 *
 * 冪等: 追加すべきキーが1つも無ければファイルを書き換えない（既存の整形も保たれる）。
 * 壊れた JSON は**触らずに警告のみ**（手で直してから再実行してもらう）。
 *
 * 補足: Backlog 連携済みだがまだ初回同期前で `backlog-settings.json` が無い案件では、`backlog`
 * エントリは追加されない（ドメインが分からないため）。その場合はセットアップ手順に従い、
 * scaffold の雛形（`plugin/scaffold/repo/.mcp.json`）を手で写して実スペースを記入する。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 14,
  description:
    "MCPサーバー定義（Backlog・GitHub）を案件リポの .mcp.json に標準同梱（既存キーは上書きしない）",
  autoApply: true,
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_MCP = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo", ".mcp.json");

// エンジンが所有するキー（これ以外には触らない）
const MANAGED_KEYS = ["backlog", "github"];
// scaffold 雛形に入っているドメインのプレースホルダ（実値に差し替える目印）
const DOMAIN_PLACEHOLDER = "<backlog-domain>";

const SKIP_DIRS = new Set([".git", "node_modules", ".cortex-engine", "tmp", "開発"]);

function warn(message) {
  console.log(`::warning::migration 0014: ${message}`);
}

async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** `backlog-settings.json` をリポ内から探す（ルート＋3階層・除外ディレクトリはたどらない）。 */
async function findBacklogSettings(root) {
  async function walk(dir, depthLeft) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    if (entries.some((e) => e.isFile() && e.name === "backlog-settings.json")) {
      return path.join(dir, "backlog-settings.json");
    }
    if (depthLeft <= 0) return null;
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        const found = await walk(path.join(dir, e.name), depthLeft - 1);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(root, 3);
}

/**
 * 案件の Backlog ドメイン（例 `example.backlog.jp`）。
 * Backlog 未連携・初回同期前は null（`backlog` エントリを配らない）。
 */
async function resolveBacklogDomain(root) {
  const settingsPath = await findBacklogSettings(root);
  if (!settingsPath) return null; // Backlog 未連携 or 初回同期前（静かにスキップ）
  const settings = await readJson(settingsPath);
  const domain = settings && typeof settings.domain === "string" ? settings.domain.trim() : "";
  if (!domain || domain.includes("{{") || domain.includes("<")) {
    warn(
      `${path.relative(root, settingsPath)} から Backlog ドメインを読めなかったため .mcp.json の backlog エントリを追加しませんでした。必要なら手動で追加してください。`,
    );
    return null;
  }
  return domain;
}

/** 配布するエントリ（scaffold の雛形が正本。backlog のドメインだけ実値に差し替える）。 */
async function buildEntries(repoRoot) {
  const template = await readJson(SCAFFOLD_MCP);
  const servers = template && template.mcpServers;
  if (!servers) {
    warn("scaffold の .mcp.json 雛形を読めなかったため、何もしませんでした。");
    return null;
  }

  const entries = {};
  if (servers.github) entries.github = servers.github;

  if (servers.backlog) {
    const domain = await resolveBacklogDomain(repoRoot);
    if (domain) {
      const backlog = JSON.parse(JSON.stringify(servers.backlog));
      if (backlog.env && backlog.env.BACKLOG_DOMAIN === DOMAIN_PLACEHOLDER) {
        backlog.env.BACKLOG_DOMAIN = domain;
      }
      entries.backlog = backlog;
    }
  }
  return entries;
}

/** MANAGED_KEYS の順に並べ、未知のキーは元の順序のまま後ろに残す（差分を読みやすくする）。 */
function orderServers(servers) {
  const ordered = {};
  for (const key of MANAGED_KEYS) {
    if (key in servers) ordered[key] = servers[key];
  }
  for (const [key, value] of Object.entries(servers)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

export async function run(repoRoot) {
  const entries = await buildEntries(repoRoot);
  if (!entries || Object.keys(entries).length === 0) return;

  const target = path.join(repoRoot, ".mcp.json");

  // (1) 新規作成
  if (!(await exists(target))) {
    await fs.writeFile(target, `${JSON.stringify({ mcpServers: orderServers(entries) }, null, 2)}\n`);
    return;
  }

  // (2) 既存ファイルへの追記（壊れた JSON は触らない）
  const current = await readJson(target);
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    warn(
      ".mcp.json が JSON として読めないため触りませんでした。手で直してから再実行してください（MCPサーバー定義は未配布です）。",
    );
    return;
  }

  const servers =
    current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? current.mcpServers
      : {};

  let added = false;
  for (const [key, value] of Object.entries(entries)) {
    if (key in servers) {
      // エンジン管理キーでも、既にあるものは内容を問わず尊重する（上書きしない）
      warn(
        `.mcp.json に "${key}" が既にあるため上書きしませんでした（案件側の定義を優先します）。エンジンの標準定義と揃えたい場合は手で確認してください。`,
      );
      continue;
    }
    servers[key] = value;
    added = true;
  }
  if (!added) return; // 冪等: 追加が無ければファイルを書き換えない

  current.mcpServers = orderServers(servers);
  await fs.writeFile(target, `${JSON.stringify(current, null, 2)}\n`);
}
