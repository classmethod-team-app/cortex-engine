/**
 * migration 0034（デザインMD自動育成のスタブ撤去）。
 *
 * 0033 と分かれているのは、当時 `.github/workflows/` 配下を GITHUB_TOKEN で push できず、
 * 人手適用のゲートを噛ませる必要があったため（0035 以降はワークフロー用トークンを渡すので解消）。
 * ここで守るのは「消す対象を間違えないこと」だけ。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../migrations/0034-デザインMD自動育成のスタブを撤去.mjs";

function makeRepo({ withStub = true } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "mig34-"));
  const wf = path.join(repo, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  if (withStub) writeFileSync(path.join(wf, "update-design-notes.yml"), "name: デザインMD自動育成\n");
  writeFileSync(path.join(wf, "sync-designs.yml"), "name: デザイン同期\n");
  writeFileSync(path.join(wf, "update-gold.yml"), "name: Gold昇格\n");
  return { repo, wf };
}

test("[正常系] スタブを消し、他のワークフローは残す", async () => {
  const { repo, wf } = makeRepo();
  await run(repo);
  assert.equal(existsSync(path.join(wf, "update-design-notes.yml")), false, "スタブが残っている");
  assert.ok(existsSync(path.join(wf, "sync-designs.yml")), "他のワークフローを巻き込んで消している");
  assert.ok(existsSync(path.join(wf, "update-gold.yml")));
});

test("[正常系] 既に無ければ何もしない（冪等・未配布の案件でも落ちない）", async () => {
  const { repo, wf } = makeRepo({ withStub: false });
  await run(repo);
  await run(repo);
  assert.ok(existsSync(path.join(wf, "sync-designs.yml")));
});
