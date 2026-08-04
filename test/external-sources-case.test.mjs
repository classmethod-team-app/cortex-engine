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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

// ---- 外部ソースの登録ファイルの配布（migration 0032）----

test("空の登録ファイルを配っても取り込み対象は変わらない", async () => {
  // 9案件中8案件にこのファイルが無い（設定UIの書き込み先なので配る必要がある）。
  // **配布そのものが取り込み対象を変えてはいけない**（既定の自動導出だけが効く状態を保つ）。
  const dir = mkdtempSync(path.join(tmpdir(), "mig32-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  mkdirSync(path.join(dir, "\u958b\u767a"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cortex", "Home.md"),
    ["---", "type: overview", "tools:", "  \u958b\u767a: github", "  \u30c1\u30e3\u30c3\u30c8: none", "---", "", "# Home"].join("\n"),
  );
  writeFileSync(
    path.join(dir, ".gitmodules"),
    ['[submodule "\u958b\u767a/src"]', "\tpath = \u958b\u767a/src", "\turl = https://github.com/Owner/App.git"].join("\n"),
  );
  const list = () =>
    JSON.parse(execFileSync("node", [SCRIPT], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));

  const before = list();
  assert.equal(before.length, 1, "前提: 導出が空でない状態で比べる");

  const mig = await import(path.join(HERE, "..", "migrations", "0032-\u5916\u90e8\u30bd\u30fc\u30b9\u306e\u767b\u9332\u30d5\u30a1\u30a4\u30eb\u306e\u914d\u5e03.mjs"));
  await mig.run(dir);
  await mig.run(dir); // 冪等
  assert.deepEqual(list(), before, "配布で取り込み対象が変わってはいけない");

  const written = JSON.parse(readFileSync(path.join(dir, "Cortex", "external-sources.json"), "utf8"));
  assert.deepEqual(written.sources, [], "空の雛形が置かれる（設定UIの書き込み先になる）");
  assert.deepEqual(written.exclude, []);
});

test("既にある登録ファイルは内容を問わず触らない", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mig32-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  const mine = JSON.stringify({ sources: [{ type: "github-issues", repo: "o/r" }] }, null, 2);
  writeFileSync(path.join(dir, "Cortex", "external-sources.json"), mine);
  const mig = await import(path.join(HERE, "..", "migrations", "0032-\u5916\u90e8\u30bd\u30fc\u30b9\u306e\u767b\u9332\u30d5\u30a1\u30a4\u30eb\u306e\u914d\u5e03.mjs"));
  await mig.run(dir);
  assert.equal(readFileSync(path.join(dir, "Cortex", "external-sources.json"), "utf8"), mine, "既存の設定を壊さない");
});

// ---- origin（どこから来たか）----

test("導出・明示・両方 を区別できる", () => {
  // 設定UIが「消してよいか」を判断するために要る。
  // derived / both は消す対象が無い（消しても導出で戻る・exclude を消すと逆に読み始める）。
  const dir = mkdtempSync(path.join(tmpdir(), "origin-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  mkdirSync(path.join(dir, "開発"), { recursive: true });
  mkdirSync(path.join(dir, "チャット"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cortex", "Home.md"),
    ["---", "type: overview", "tools:", "  開発: github", "  チャット: slack", "---", "", "# Home"].join("\n"),
  );
  writeFileSync(
    path.join(dir, ".gitmodules"),
    ['[submodule "開発/src"]', "\tpath = 開発/src", "\turl = https://github.com/o/derived.git"].join("\n"),
  );
  writeFileSync(
    path.join(dir, "チャット", "channels.json"),
    JSON.stringify({ channels: [{ name: "#両方", url: "https://x/archives/C0BOTHAAA", gold: true }] }),
  );
  writeFileSync(
    path.join(dir, "Cortex", "external-sources.json"),
    JSON.stringify({
      sources: [
        { type: "slack", channel: "C0BOTHAAA" },
        { type: "slack", channel: "C0EXPONLY" },
        { type: "github-issues", repo: "o/explicit-only" },
      ],
    }),
  );
  const all = JSON.parse(
    execFileSync("node", [SCRIPT, "--all"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
  );
  const by = (ref) => all.find((s) => s.ref === ref) || {};
  assert.equal(by("o/derived").origin, "derived", "submodule 由来");
  assert.equal(by("C0BOTHAAA").origin, "both", "channels.json と external-sources.json の両方");
  assert.equal(by("C0EXPONLY").origin, "explicit", "external-sources.json だけ");
  assert.equal(by("o/explicit-only").origin, "explicit");
});
