/**
 * 同じ決定が毎晩1件ずつ増える経路を塞ぐ。
 *
 * 実際に起きたこと（cortex-context）:
 *   20260803-001  03:55  supersedes なし
 *   20260803-004  13:51  supersedes: 001          ← 001を「置き換える」として起票
 *   20260803-006  13:53  supersedes: 001, 004     ← 001と004を「置き換える」として起票
 *
 * タイトルは3件とも一字一句同じ。中身も同じことを言い換えているだけで、置き換えるべき
 * 新事実は無かった。重複判定はプログラムで実装されていたが、**supersedes が付いていれば
 * 免除する**という例外が無条件だったため素通りした。しかも回を重ねるほど成立しやすくなる
 * （衝突相手が増えても、その全部を supersedes に入れれば条件を満たせる）。
 *
 * 例外そのものは要る——撤回・方針転換は表題が既存とほぼ同じになるので、機械的に捨てると
 * 「古い決定だけが Gold に残り、AI が撤回済みの方針を確定情報として読む」ことになる。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowsSupersedeOverride } from "../plugin/scripts/update-gold-pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("[異常系] 同じ日の決定を置き換える supersedes は免除しない（再抽出とみなす）", () => {
  // 決定日は元ソースから決まるので、同じ決定を何度抽出しても date は同じになる
  assert.equal(allowsSupersedeOverride(["20260803-001"], ["20260803-001"], "20260803"), false);
  // 回を重ねた形（衝突相手を全部 supersedes に入れる）でも通さない
  assert.equal(
    allowsSupersedeOverride(["20260803-001", "20260803-004"], ["20260803-001", "20260803-004"], "20260803"),
    false,
  );
});

test("[正常系] 別の日の決定を置き換える supersedes は免除する（本物の撤回）", () => {
  // 艦隊628件の実データでも、supersedes 45件のうち43件が別日だった
  assert.equal(allowsSupersedeOverride(["20260610-001"], ["20260610-001"], "20260803"), true);
  assert.equal(
    allowsSupersedeOverride(["20260610-001", "20260701-002"], ["20260610-001", "20260701-002"], "20260803"),
    true,
  );
});

test("[異常系] 同日と別日が混ざったら免除しない", () => {
  // 1つでも同日が混じれば再抽出が紛れている可能性がある。**通す側に倒さない**
  assert.equal(
    allowsSupersedeOverride(["20260610-001", "20260803-001"], ["20260610-001", "20260803-001"], "20260803"),
    false,
  );
});

test("[異常系] 衝突相手のうち1つでも置き換え対象でなければ免除しない（従来どおり）", () => {
  // 同じ決定の再抽出（実行窓のオーバーラップ・前夜に起票した撤回レコードとの衝突等）
  assert.equal(allowsSupersedeOverride(["20260610-001"], ["20260610-001", "20260611-003"], "20260803"), false);
});

test("[正常系] 材料が無ければ免除しない", () => {
  assert.equal(allowsSupersedeOverride([], ["20260610-001"], "20260803"), false);
  assert.equal(allowsSupersedeOverride(["20260610-001"], [], "20260803"), false);
  assert.equal(allowsSupersedeOverride(undefined, undefined, "20260803"), false);
});

test("[配線] パイプラインがこの判定を呼んでいる", () => {
  // **判定関数を作っただけで呼ばれていない**状態を許さない（今日この型で1度落としている）。
  // 免除の条件をここ以外に書くと、片方だけ直したときに食い違う。
  const src = readFileSync(path.join(HERE, "..", "plugin", "scripts", "update-gold-pipeline.mjs"), "utf8");
  assert.match(src, /const overridesCollision = allowsSupersedeOverride\(supersedes, collidingIds, date\)/);
  // 免除の判定が関数の外に散っていないこと（散ると、どちらが効いているのか読めなくなる）
  const uses = [...src.matchAll(/collidingIds\.every\(/g)];
  assert.equal(uses.length, 1, "衝突判定が複数箇所に散っています");
});
