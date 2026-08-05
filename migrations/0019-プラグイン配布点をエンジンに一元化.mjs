/**
 * 案件リポの `.claude/settings.json` を、cortex プラグインの新しい配布点（エンジンリポ直参照）へ移行する。
 *
 * 背景: cortex は特定部署のものではなく全社共通の基盤なので、配布の入口を部カタログの中に置くと
 * 所有権が歪む（部が cortex の安定配布を抱えることになる／部カタログを見られない人が安定版に辿り着けない）。
 * 入口はエンジン自身に一元化し、**参照する ref でチャンネルを分ける**方式に変える:
 *   - 安定（一般の案件）: `ref: stable`
 *   - カナリア（先行検証・開発）: `ref` 省略（＝デフォルトブランチ main 追従）
 *
 * やること（すべて新規追加・置換は既定値と完全一致のときだけ）:
 *   1. `extraKnownMarketplaces` に `cortex-engine`（scaffold と同値＝ref: stable）が無ければ追加する
 *   2. `enabledPlugins` の `cortex@retail-app-harnesses` が **`true`（エンジンが配った既定値そのもの）** のときだけ、
 *      `cortex@cortex-engine: true` に置き換える
 *
 * 触らないもの（案件側の構成を壊さないためのガード）:
 *   - エンジンリポを**別のマーケットプレイス名で既に参照している**リポ（`cortex-canary` 等のカナリア構成）は
 *     一切触らない。同じリポを二重に登録して構成を濁らせない
 *   - `retail-app-harnesses` のマーケットプレイス宣言は残す。職能ハーネスの入口として使われ得るため削除しない
 *   - `cortex@retail-app-harnesses` が `false` 等、既定値以外に案件が変えている場合は触らない（警告のみ）
 *   - 既に `cortex@cortex-engine` が宣言済みなら、値が何であれ案件側を優先する（警告のみ）
 *   - 上記以外のキー（permissions・hooks・他プラグインの宣言）には一切触らない
 *
 * 冪等（新規追加＋エンジン既定値の付け替えのみ・冪等）。
 *
 * 何もしないケース（0016 と同じ保守則）: `.claude/settings.json` が無い／JSON として読めない案件では
 * **一切変更しない**（`::warning` のみ）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const meta = {
  to: 19,
  description:
    "cortex プラグインの配布点をエンジンリポ直参照（ref: stable）へ移行（部カタログ経由の既定宣言のみ置換・カナリア構成と案件独自の値は不変）",
};

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SETTINGS = path.join(
  ENGINE_ROOT,
  "plugin",
  "scaffold",
  "repo",
  ".claude",
  "settings.json",
);

// 新しい配布点（マーケットプレイス名＝エンジンリポ名）
const MARKETPLACE = "cortex-engine";
// 配布元のエンジンリポ（別名で既に参照していないかの判定に使う）
const ENGINE_REPO = "classmethod-team-app/cortex-engine";
// 置き換え対象（エンジンが配った旧既定値）と、その置き換え先
const OLD_PLUGIN = "cortex@retail-app-harnesses";
const NEW_PLUGIN = `cortex@${MARKETPLACE}`;

function warn(message) {
  console.log(`::warning::migration 0019: ${message}`);
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

/** scaffold の settings.json から新しいマーケットプレイス定義を取り出す（雛形が正本）。 */
async function loadScaffoldMarketplace() {
  const template = await readJson(SCAFFOLD_SETTINGS);
  const entry =
    template &&
    template.extraKnownMarketplaces &&
    template.extraKnownMarketplaces[MARKETPLACE];
  if (!entry || typeof entry !== "object") return null;
  return JSON.parse(JSON.stringify(entry));
}

/**
 * エンジンリポを `cortex-engine` 以外の名前で既に参照しているか（＝カナリア等の独自構成）。
 * 同じリポが2つの名前で登録された状態を作らないためのガード。
 */
function referencesEngineUnderOtherName(marketplaces) {
  return Object.entries(marketplaces).some(([name, entry]) => {
    if (name === MARKETPLACE) return false;
    const repo = entry && entry.source && entry.source.repo;
    return repo === ENGINE_REPO;
  });
}

/** OLD_PLUGIN のあった位置に NEW_PLUGIN を置く（キー順を保って差分を読みやすくする）。 */
function replacePluginKey(enabledPlugins) {
  const replaced = {};
  for (const [key, value] of Object.entries(enabledPlugins)) {
    if (key === OLD_PLUGIN) replaced[NEW_PLUGIN] = true;
    else replaced[key] = value;
  }
  return replaced;
}

export async function run(repoRoot) {
  const marketplace = await loadScaffoldMarketplace();
  if (!marketplace) {
    warn("scaffold の settings.json から cortex-engine のマーケットプレイス定義を読めなかったため、何もしませんでした。");
    return;
  }

  const settingsPath = path.join(repoRoot, ".claude", "settings.json");
  if (!(await exists(settingsPath))) {
    warn(
      ".claude/settings.json が無いため配布点を移行しませんでした（scaffold の settings.json を配置してから再実行してください）。",
    );
    return;
  }

  const settings = await readJson(settingsPath);
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    warn(
      ".claude/settings.json が JSON として読めないため触りませんでした。手で直してから再実行してください（配布点は未移行です）。",
    );
    return;
  }

  let changed = false;

  // (1) マーケットプレイス宣言の追加（既にあれば案件側を優先して触らない）
  const marketplaces =
    settings.extraKnownMarketplaces &&
    typeof settings.extraKnownMarketplaces === "object" &&
    !Array.isArray(settings.extraKnownMarketplaces)
      ? settings.extraKnownMarketplaces
      : {};
  if (referencesEngineUnderOtherName(marketplaces)) {
    warn(
      "エンジンリポを別のマーケットプレイス名で既に参照しているため何もしませんでした（カナリア等の独自構成を尊重します）。",
    );
    return;
  }
  if (!(MARKETPLACE in marketplaces)) {
    marketplaces[MARKETPLACE] = marketplace;
    settings.extraKnownMarketplaces = marketplaces;
    changed = true;
  }

  // (2) プラグイン宣言の付け替え（エンジンが配った既定値と完全一致のときだけ）
  const enabledPlugins =
    settings.enabledPlugins &&
    typeof settings.enabledPlugins === "object" &&
    !Array.isArray(settings.enabledPlugins)
      ? settings.enabledPlugins
      : null;
  if (enabledPlugins && OLD_PLUGIN in enabledPlugins) {
    if (enabledPlugins[OLD_PLUGIN] !== true) {
      // 案件が意図して無効化している等。エンジンの既定値ではないので触らない
      warn(
        `.claude/settings.json の "${OLD_PLUGIN}" がエンジンの既定値（true）ではないため付け替えませんでした（案件側の設定を優先します）。`,
      );
    } else if (NEW_PLUGIN in enabledPlugins) {
      // 既に新しい宣言があるところに旧宣言も残っている。どちらを残すかは案件の判断に委ねる
      warn(
        `.claude/settings.json に "${NEW_PLUGIN}" が既にあるため "${OLD_PLUGIN}" を触りませんでした（不要なら手で削除してください）。`,
      );
    } else {
      settings.enabledPlugins = replacePluginKey(enabledPlugins);
      changed = true;
    }
  }

  if (!changed) return; // 冪等: 変更が無ければファイルを書き換えない

  await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
