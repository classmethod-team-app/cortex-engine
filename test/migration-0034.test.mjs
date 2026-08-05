/**
 * migration 0034（デザインMD自動育成のスタブ撤去）。
 *
 * このマイグレーションが 0033 と分かれている理由をテストで固定する:
 *   `.github/workflows/` 配下は GITHUB_TOKEN では push できない（`workflows` 権限が要る）。
 *   autoApply:true のまま触ると夜間の engine-migrate が毎晩 push で失敗し、schema_version が
 *   前進しないので、それをゲートにしている Gold昇格・議事録生成まで静かに止まる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, meta } from "../migrations/0034-デザインMD自動育成のスタブを撤去.mjs";

function makeRepo({ withStub = true } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "mig34-"));
  const wf = path.join(repo, ".github", "workflows");
  mkdirSync(wf, { recursive: true });
  if (withStub) writeFileSync(path.join(wf, "update-design-notes.yml"), "name: デザインMD自動育成\n");
  writeFileSync(path.join(wf, "sync-designs.yml"), "name: デザイン同期\n");
  writeFileSync(path.join(wf, "update-gold.yml"), "name: Gold昇格\n");
  return { repo, wf };
}

test("[異常系] autoApply: false であること（ワークフローを触るため自動適用してはいけない）", () => {
  // ここが true になると、夜間の engine-migrate が毎晩 push で失敗し、schema_version が
  // 前進しないので Gold昇格・議事録生成まで静かに止まる。**方針そのものを固定する**
  assert.equal(meta.autoApply, false);
});

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
