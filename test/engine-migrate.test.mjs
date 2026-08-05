/**
 * マイグレーションのランナーが「途中で止まって適用結果を捨てる」経路を持たないこと。
 *
 * 実際に起きたこと（艦隊9案件・約3週間）:
 *   `autoApply: false`（人手適用）のマイグレーションの後ろに、自動適用のものが積まれた。
 *   夜間の engine-migrate は毎晩それらを適用したうえで人手待ちに当たって exit 1 になり、
 *   **後続の commit/push ステップが暗黙の success() で skip された**。適用結果はランナーの
 *   作業ツリーごと消え、schema_version も進まない。翌晩また同じことを繰り返す。
 *
 *   run が赤いのは「催促」の設計なので、赤いこと自体は想定どおりに見える。一方 update-gold は
 *   緑のまま（schema_version のゲートで AI ステップだけ skip される）ため、**Gold昇格が
 *   止まっていることに誰も気づかなかった**。
 *
 * そこでゲートそのものを外した。34件中2件にしか付いておらず、どちらも理由は
 * 「`.github/workflows/` を触るので GITHUB_TOKEN では push できない」という技術的制約で、
 * 「人間のレビュー」は建前だった。**動かないゲートは安全装置ではない。**
 * いまはワークフローを push できるトークンを使うので、この区別が要らない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.join(HERE, "..");
const SCRIPT = path.join(ENGINE, "scripts", "engine-migrate.mjs");
const MIGRATIONS = path.join(ENGINE, "migrations");
const WORKFLOW = path.join(ENGINE, ".github", "workflows", "engine-migrate.yml");

const LATEST = Math.max(
  ...readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}-.*\.mjs$/.test(f))
    .map((f) => Number(f.slice(0, 4))),
);

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
  // execFileSync は成功時に stderr を返さないので spawnSync を使う
  const proc = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8" });
  const home = readFileSync(path.join(repo, "Cortex", "Home.md"), "utf8");
  return {
    status: proc.status ?? 1,
    stdout: String(proc.stdout || ""),
    stderr: String(proc.stderr || ""),
    schema: Number(home.match(/schema_version:\s*(\d+)/)[1]),
  };
}

test("[再現] 途中で止まらず、最新版まで一気に適用する", () => {
  // **ここが LATEST に届かないなら、どこかにゲートが残っている**（それが3週間の停止を生んだ）
  const r = migrate(0);
  assert.equal(r.status, 0, `exit ${r.status} で終わっている: ${r.stderr}`);
  assert.equal(r.schema, LATEST, `schema_version が ${r.schema} で止まっている（最新は ${LATEST}）`);
});

test("[正常系] 追いついていれば何もしない", () => {
  const r = migrate(LATEST);
  assert.equal(r.status, 0);
  assert.equal(r.schema, LATEST);
  assert.match(r.stdout, /未適用のマイグレーションはありません/);
});

test("[正常系] 途中の版からでも残りだけを適用する", () => {
  const r = migrate(LATEST - 1);
  assert.equal(r.status, 0);
  assert.equal(r.schema, LATEST);
  assert.match(r.stdout, /1 件のマイグレーションを適用しました/);
});

test("[異常系] マイグレーションの meta が壊れていたら止める", () => {
  // 規約を満たさないファイルを黙って飛ばすと、適用したつもりで抜けが出る
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /meta \{ to, description \} と run\(\) が必要です/);
  assert.match(src, /typeof meta\.to !== "number" \|\| typeof mod\.run !== "function"/);
});

test("[異常系] autoApply というゲートが復活していない", () => {
  // 復活させると、その後ろに積まれたマイグレーションが毎晩「適用しては捨てられる」状態に戻る。
  // **メタデータとしても読まない**ことを固定する（読むと書く側が付けたくなる）
  const src = readFileSync(SCRIPT, "utf8");
  const code = src.slice(src.indexOf("async function main()"));
  assert.ok(!code.includes("autoApply"), "ランナーが autoApply を読んでいる");
  for (const f of readdirSync(MIGRATIONS).filter((f) => /^\d{4}-.*\.mjs$/.test(f))) {
    const t = readFileSync(path.join(MIGRATIONS, f), "utf8");
    const meta = t.slice(t.indexOf("export const meta"), t.indexOf("};", t.indexOf("export const meta")));
    assert.ok(!meta.includes("autoApply"), `${f} の meta に autoApply が残っている`);
  }
});

// ---- ワークフロー側の配線 ----

test("[配線] push にワークフロー書き込み可のトークンを使う", () => {
  // GITHUB_TOKEN のままだと `.github/workflows/` を触るマイグレーションが push できず、
  // **そこだけ自動配布から漏れる**（漏れた結果が今回の3週間停止）
  const t = readFileSync(WORKFLOW, "utf8");
  assert.match(t, /token: \$\{\{ secrets\.FLEET_WORKFLOW_TOKEN \|\| secrets\.GITHUB_TOKEN \}\}/);
  assert.match(t, /FLEET_WORKFLOW_TOKEN:\n\s+required: false/, "secrets の受け口が宣言されていない");
});

test("[配線] スタブ雛形がそのトークンを渡している", () => {
  // reusable 側で受け口を作っても、スタブが渡さなければ届かない（別orgからは inherit も効かない）
  const stub = readFileSync(
    path.join(ENGINE, "plugin", "scaffold", "repo", ".github", "workflows", "engine-migrate.yml"),
    "utf8",
  );
  assert.match(stub, /FLEET_WORKFLOW_TOKEN: \$\{\{ secrets\.FLEET_WORKFLOW_TOKEN \}\}/);
});

test("[配線] commit/push ステップに if: が付いていない", () => {
  // 付けると「適用したのに push されない」経路が復活しうる
  const t = readFileSync(WORKFLOW, "utf8");
  const block = t.slice(t.indexOf("変更があればコミット＆push"), t.indexOf("robust-push@v1"));
  assert.ok(!/^\s+if:/m.test(block), "commit ステップに if: が付いている");
});
