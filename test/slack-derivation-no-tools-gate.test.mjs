/**
 * Slackチャンネルの導出を `tools.チャット` でゲートしないこと。
 * そして**Gold昇格のゲート（チャンネル単位の `gold: true`）は変わらず効く**こと。
 *
 * なぜ必要か（実際に起きたこと）:
 *   「会議はTeams・連絡はSlack」という案件で、Slackを渡されているのに設定UIから追加できず、
 *   仮に追加しても読まれない状態だった。`tools.チャット` は能力ごとに**1値しか持てない**ので、
 *   この普通の構成を表せない。ゲートはそれを排他だと誤解した実装だった。
 *
 * **本来のゲートはチャンネル単位の `gold: true`。** channels.json は `/read-chat` の参照先・
 * 通知先としても使う共用の宣言なので、別目的で足したチャンネルが無言でGoldに上がらないよう、
 * 昇格だけは必ず明示させる——この判断は今回も**変えない**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "scripts",
  "resolve-external-sources.mjs",
);

const URL_OF = (id) => `https://classmethod.enterprise.slack.com/archives/${id}`;

/** 案件リポを模した一時ディレクトリで resolver を走らせる */
function resolve({ chat, channels = [], external, all = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), "slackgate-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  mkdirSync(path.join(dir, "チャット"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cortex", "Home.md"),
    ["---", "type: overview", "tools:", `  チャット: ${chat}`, "  開発: none", "---", "", "# Home"].join("\n"),
  );
  writeFileSync(path.join(dir, "チャット", "channels.json"), JSON.stringify({ channels }));
  if (external) writeFileSync(path.join(dir, "Cortex", "external-sources.json"), JSON.stringify(external));
  const out = execFileSync("node", [SCRIPT, ...(all ? ["--all"] : [])], { cwd: dir, encoding: "utf-8" });
  return JSON.parse(out);
}
const slackRefs = (list) => list.filter((s) => s.type === "slack").map((s) => s.ref);

test("[正常系] チャットがteamsでも gold:true のSlackチャンネルを読む", () => {
  // **これが本題。** 「会議はTeams・連絡はSlack」の案件が読まれるようになる
  const got = resolve({
    chat: "teams",
    channels: [{ name: "#biz-ge", url: URL_OF("C0AAA"), gold: true }],
  });
  assert.deepEqual(slackRefs(got), ["C0AAA"]);
});

test("[正常系] チャット未宣言でも読む", () => {
  const got = resolve({ chat: "none", channels: [{ name: "#x", url: URL_OF("C0BBB"), gold: true }] });
  assert.deepEqual(slackRefs(got), ["C0BBB"]);
});

// ---- Gold昇格のゲートは変わらず効く（ここを緩めない）----

test("[異常系] gold宣言が無いチャンネルは読まない（tools宣言に関わらず）", () => {
  // channels.json は /read-chat・通知先としても使う共用の宣言。
  // **別目的で足したチャンネルが無言で顧客可視のGoldへ流れないようにする**
  for (const chat of ["slack", "teams", "none"]) {
    const got = resolve({ chat, channels: [{ name: "#未宣言", url: URL_OF("C0CCC") }] });
    assert.deepEqual(slackRefs(got), [], `chat=${chat} で未宣言チャンネルを読んでいる`);
  }
});

test("[異常系] gold:false は明示的な除外として常に落とす", () => {
  const got = resolve({
    chat: "teams",
    channels: [
      { name: "#社内限定", url: URL_OF("C0DDD"), gold: false },
      { name: "#共有", url: URL_OF("C0EEE"), gold: true },
    ],
  });
  assert.deepEqual(slackRefs(got), ["C0EEE"]);
});

test("[正常系] external-sources.json への明示登録は従来どおり通る", () => {
  // 移行期の互換。登録自体が人間の判断とみなす
  const got = resolve({
    chat: "teams",
    channels: [{ name: "#未宣言", url: URL_OF("C0FFF") }],
    external: { sources: [{ type: "slack", channel: "C0FFF" }] },
  });
  assert.deepEqual(slackRefs(got), ["C0FFF"]);
});

// ---- 既存の挙動を壊さない ----

test("[正常系] チャットがslackの案件は従来どおり", () => {
  const got = resolve({
    chat: "slack",
    channels: [
      { name: "#a", url: URL_OF("C0111"), gold: true },
      { name: "#b", url: URL_OF("C0222"), gold: true },
      { name: "#c", url: URL_OF("C0333") },
    ],
  });
  assert.deepEqual(slackRefs(got).sort(), ["C0111", "C0222"]);
});

test("[正常系] --all は理由まで出す（設定UIの表示が壊れない）", () => {
  const got = resolve({
    chat: "teams",
    channels: [
      { name: "#on", url: URL_OF("C0777"), gold: true },
      { name: "#off", url: URL_OF("C0888"), gold: false },
      { name: "#未宣言", url: URL_OF("C0999") },
    ],
    all: true,
  });
  const byRef = Object.fromEntries(got.filter((s) => s.type === "slack").map((s) => [s.ref, s.goldState]));
  assert.deepEqual(byRef, { C0777: "on", C0888: "off", C0999: "undeclared" });
});
