/**
 * 人手待ち（autoApply: false）で止まったとき、**それまでに適用したぶんを捨てないこと**。
 *
 * 実際に起きたこと（艦隊9案件・約3週間）:
 *   0031 が autoApply:false で、その後ろに 0032・0033 が積まれた。夜間の engine-migrate は
 *   毎晩 0031 で停止して exit 1 になり、**後続の commit/push ステップが暗黙の success() で
 *   skip された**。適用の結果はランナーの作業ツリーごと消え、schema_version も進まない。
 *   翌晩また同じことを繰り返す。
 *
 *   しかも run が赤いのは「催促」の設計なので、赤いこと自体は想定どおりに見える。
 *   一方 update-gold は緑のまま（schema_version のゲートで AI ステップだけ skip される）ため、
 *   **Gold昇格が止まっていることに誰も気づかなかった**。
 *
 * 直し方の骨子:
 *   停止はスクリプトの exit code ではなく `paused` 出力で伝え、赤くするのは push の**後**の
 *   ステップに任せる。想定外の例外は従来どおり exit 1（中途半端な適用を push させない）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "..");
const SCRIPT = path.join(ENGINE, "scripts", "engine-migrate.mjs");
const WORKFLOW = path.join(ENGINE, ".github", "workflows", "engine-migrate.yml");

const HOME = (v) => `---
type: overview
id: "overview:home"
engine:
  schema_version: ${v} # データスキーマ版。マイグレーションが更新する（手編集しない）
---

# Home
`;

/** 案件リポに見立てた一時ディレクトリで engine-migrate を走らせる。 */
function migrate(schemaVersion) {
  const repo = mkdtempSync(path.join(tmpdir(), "mig-run-"));
  mkdirSync(path.join(repo, "Cortex"), { recursive: true });
  writeFileSync(path.join(repo, "Cortex", "Home.md"), HOME(schemaVersion));
  const outFile = path.join(repo, "gh_output");
  writeFileSync(outFile, "");

  // **spawnSync を使う。** execFileSync は成功時に stderr を返さないので、exit 0 になった今は
  // 「::error:: を出しているか」を確かめられない（そこを取り違えて一度テストを落とした）。
  const proc = spawnSync("node", [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outFile },
  });
  const status = proc.status ?? 1;
  const stderr = String(proc.stderr || "");
  const outputs = Object.fromEntries(
    readFileSync(outFile, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")),
  );
  const home = readFileSync(path.join(repo, "Cortex", "Home.md"), "utf8");
  return { status, stderr, outputs, schema: Number(home.match(/schema_version:\s*(\d+)/)[1]) };
}

test("[再現] 人手待ちで止まっても exit 0（後続の commit/push を skip させない）", () => {
  // schema 0 から走らせると、最初の autoApply:false に当たって停止する。
  // **ここが exit 1 だと、その手前で適用したぶんが push されずに消える。**
  const r = migrate(0);
  assert.equal(r.status, 0, `人手待ちで exit ${r.status} になっている（適用済みのぶんが捨てられる）`);
});

test("[正常系] 止まったことは paused 出力で伝える", () => {
  const r = migrate(0);
  assert.equal(r.outputs.paused, "true");
  assert.match(r.outputs.paused_migration ?? "", /^\d{4}-.*\.mjs$/);
  // 人が気づけるよう ::error:: は従来どおり出す
  assert.match(r.stderr, /autoApply: false/);
  // 手で適用する道具の使い方まで書いておく（毎回調べ直さないで済むように）
  assert.match(r.stderr, /apply-migration-manually\.mjs/);
});

test("[正常系] 停止までに適用したぶんは schema_version に残る", () => {
  // 停止したマイグレーションの1つ手前まで進んでいること。
  // **0 のままなら、適用結果が捨てられている**（今回の事故そのもの）。
  const r = migrate(0);
  assert.ok(r.schema > 0, `schema_version が ${r.schema} のまま（適用結果が残っていない）`);
});

test("[正常系] 追いついていれば何もせず exit 0・paused も立てない", () => {
  const latest = Math.max(
    ...execFileSync("ls", [path.join(ENGINE, "migrations")], { encoding: "utf8" })
      .split("\n")
      .filter((f) => /^\d{4}-.*\.mjs$/.test(f))
      .map((f) => Number(f.slice(0, 4))),
  );
  const r = migrate(latest);
  assert.equal(r.status, 0);
  assert.equal(r.outputs.paused, undefined);
  assert.equal(r.schema, latest);
});

// ---- ワークフロー側の配線（スクリプトを直しても、繋ぎ方を誤ると同じ壊れ方をする）----

test("[配線] 赤くするステップが push の後ろにある", () => {
  const t = readFileSync(WORKFLOW, "utf8");
  const push = t.indexOf("robust-push@v1");
  const fail = t.indexOf("steps.migrate.outputs.paused == 'true'");
  assert.ok(push > 0, "push ステップが見つからない");
  assert.ok(fail > 0, "paused を見て赤くするステップが無い");
  assert.ok(fail > push, "赤くするステップが push より前にある（適用済みのぶんが push されない）");
});

test("[配線] マイグレーション実行ステップに id が付いている", () => {
  // id が無いと steps.migrate.outputs.* が常に空になり、**赤にする条件が永久に偽**になる。
  // GitHub はこれをエラーにしないので、静かに催促が止まる。
  const t = readFileSync(WORKFLOW, "utf8");
  assert.match(t, /id: migrate\n\s+run: node \.cortex-engine\/scripts\/engine-migrate\.mjs/);
});

test("[配線] commit/push ステップに if: が付いていない（success()のまま skip されない）", () => {
  // スクリプトが exit 0 で返る前提なので、ここに if: を足すと再び捨てる挙動に戻りうる。
  const t = readFileSync(WORKFLOW, "utf8");
  const block = t.slice(t.indexOf("変更があればコミット＆push"), t.indexOf("robust-push@v1"));
  assert.ok(!/^\s+if:/m.test(block), "commit ステップに if: が付いている");
});
