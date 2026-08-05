/**
 * 案件リポに「セッション開始時の自動最新化」を配布する。
 *
 * 狙い: 同期ミラー（課題管理・デザイン・Gold昇格）はサーバー側が毎晩コミットするため、手元のクローンは
 * 放っておくと古くなる。古い状態のままAIに作業させる事故を、CLAUDE.md の努力目標ではなく**機構**で防ぐ。
 * 配るのは2点セット:
 *   - `scripts/session-sync.sh`（clean なときだけ `git pull --ff-only`。何が起きても exit 0）
 *   - `.claude/settings.json` の `SessionStart` hook（`startup|resume` で上記を呼ぶ）
 *
 * 所有権モデル（0014・0015 と同じ保守則）:
 *   エンジンが配るのは**未定義のときだけ**。`hooks.SessionStart` が既に何かしら定義されていれば、内容が
 *   何であれ触らず `::warning` のみ（案件が独自に足した hook を壊さない）。スクリプトも既にあれば触らない
 *   （案件が手を入れている可能性があるため）。
 *
 * 冪等（新規追加のみ・既存値は不変・冪等）。
 *
 * 何もしないケース: `.claude/settings.json` が無い／JSON として読めない案件では**一切変更しない**（警告のみ）。
 * hook の置き場所が無い状態でスクリプトだけ置いても死蔵するため、2点セットで足並みを揃える。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 16,
  description:
    "セッション開始時の自動最新化（session-sync.sh と SessionStart hook）を案件リポに配布（既存の hook・スクリプトは触らない）",
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_REPO = path.join(ENGINE_ROOT, "plugin", "scaffold", "repo");
const SCAFFOLD_SCRIPT = path.join(SCAFFOLD_REPO, "scripts", "session-sync.sh");
const SCAFFOLD_SETTINGS = path.join(SCAFFOLD_REPO, ".claude", "settings.json");

const SCRIPT_RELATIVE = path.join("scripts", "session-sync.sh");

function warn(message) {
  console.log(`::warning::migration 0016: ${message}`);
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

/** scaffold の settings.json から SessionStart hook の定義を取り出す（雛形が正本）。 */
async function loadScaffoldSessionStart() {
  const template = await readJson(SCAFFOLD_SETTINGS);
  const sessionStart = template && template.hooks && template.hooks.SessionStart;
  if (!Array.isArray(sessionStart) || sessionStart.length === 0) return null;
  return JSON.parse(JSON.stringify(sessionStart));
}

/** scripts/session-sync.sh を配置する（既にあれば触らない）。 */
async function installScript(repoRoot) {
  const target = path.join(repoRoot, SCRIPT_RELATIVE);
  if (await exists(target)) return; // 案件側の版を尊重する
  const body = await fs.readFile(SCAFFOLD_SCRIPT, "utf8");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, { mode: 0o755 });
  await fs.chmod(target, 0o755); // 既存ファイル上書き時に mode が効かないケースへの保険
}

export async function run(repoRoot) {
  const sessionStart = await loadScaffoldSessionStart();
  if (!sessionStart) {
    warn("scaffold の settings.json から SessionStart hook を読めなかったため、何もしませんでした。");
    return;
  }

  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (!(await exists(settingsPath))) {
    warn(
      ".claude/settings.json が無いため自動最新化を配布しませんでした（scaffold の settings.json を配置してから再実行してください）。",
    );
    return;
  }

  const settings = await readJson(settingsPath);
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    warn(
      ".claude/settings.json が JSON として読めないため触りませんでした。手で直してから再実行してください（自動最新化は未配布です）。",
    );
    return;
  }

  await installScript(repoRoot);

  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};

  if ("SessionStart" in hooks) {
    // 既にエンジンの定義そのものが入っている（scaffold 展開済み・適用済み）なら静かに終わる
    if (JSON.stringify(hooks.SessionStart) === JSON.stringify(sessionStart)) return;
    // 案件が独自に定義した hook を壊さない（内容を問わず上書きしない）
    warn(
      ".claude/settings.json に SessionStart hook が既にあるため上書きしませんでした（案件側の定義を優先します）。自動最新化を有効にする場合は scripts/session-sync.sh の呼び出しを手で追加してください。",
    );
    return; // 冪等: 書き換えない
  }

  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;
  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
