/**
 * GitHubリポジトリ名の大小文字を、除外の照合と dedupe で区別しないこと。
 *
 * なぜ必要か:
 *   GitHubのリポジトリ名は大小文字を区別しない。一方 `.gitmodules` の URL は人が書くので
 *   実際に `https://github.com/Kasumigaseki-Capital/kc-line-miniapp.git` のような表記がある。
 *   設定UIが `owner/repo`（小文字）で `exclude` を書くと、**除外したつもりが効かない**。
 *   除外は「読まない側に倒す」ための最終フィルタなので、揃わないことによる取りこぼしは許容できない。
 *
 *   同じ理由で dedupe のキーも揃える。揃えないと導出（`Owner/Repo`）と明示登録（`owner/repo`）が
 *   別物になり、同じリポを2回読みに行く。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "plugin", "scripts", "resolve-external-sources.mjs");

/** 案件リポを模した一時ディレクトリで resolver を走らせ、結果の配列を返す */
function resolve({ gitmodulesUrl, external }) {
  const dir = mkdtempSync(path.join(tmpdir(), "extsrc-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cortex", "Home.md"),
    ["---", "type: overview", "tools:", "  開発: github", "  チャット: none", "---", "", "# Home"].join("\n"),
  );
  if (gitmodulesUrl) {
    writeFileSync(
      path.join(dir, ".gitmodules"),
      [`[submodule "開発/app"]`, "\tpath = 開発/app", `\turl = ${gitmodulesUrl}`].join("\n"),
    );
  }
  if (external) {
    writeFileSync(path.join(dir, "Cortex", "external-sources.json"), JSON.stringify(external));
  }
  const out = execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out);
}

const URL_MIXED = "https://github.com/Kasumigaseki-Capital/kc-line-miniapp.git";

test("大小文字が違っても除外は効く（効かないと「止めたつもり」が一番まずい）", () => {
  for (const excluded of [
    "kasumigaseki-capital/kc-line-miniapp", // 設定UIが書く形（小文字）
    "Kasumigaseki-Capital/kc-line-miniapp", // .gitmodules と同じ表記
    "KASUMIGASEKI-CAPITAL/KC-LINE-MINIAPP",
  ]) {
    const r = resolve({ gitmodulesUrl: URL_MIXED, external: { exclude: [excluded] } });
    assert.equal(r.length, 0, `exclude: ${excluded} で落ちていない`);
  }
});

test("大小文字が違う同じリポを2件に増やさない", () => {
  // 導出（Owner/Repo）と明示登録（owner/repo）が別物になると、同じリポを2回読みに行く
  const r = resolve({
    gitmodulesUrl: URL_MIXED,
    external: { sources: [{ type: "github-issues", repo: "kasumigaseki-capital/kc-line-miniapp" }] },
  });
  assert.equal(r.length, 1);
});

test("別のリポは巻き添えで落ちない", () => {
  const r = resolve({
    gitmodulesUrl: URL_MIXED,
    external: { exclude: ["other-org/other-repo"] },
  });
  assert.equal(r.length, 1);
  assert.match(r[0].ref, /kc-line-miniapp/);
});

test("除外が無ければ導出される（前提の確認）", () => {
  const r = resolve({ gitmodulesUrl: URL_MIXED });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, "github-issues");
});
