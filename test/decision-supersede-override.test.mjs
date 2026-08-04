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
import { allowsSupersedeOverride, buildDecisionFiles } from "../plugin/scripts/update-gold-pipeline.mjs";

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

// ---- 実際に起きた事故の再現（判定を呼ぶ本体まで通す）----

/** 既存レコード集合を、パイプラインが読む形（loadExistingDecisions の返り値）で作る */
function existingFrom(records) {
  const fileNames = [], entries = [], ids = new Set(), sigs = new Set(), sigToIds = new Map();
  for (const [id, title] of records) {
    fileNames.push(`${id}-x.md`);
    entries.push({ id, title });
    ids.add(id);
    // normalizeSig と同じ正規化（空白・記号を落として小文字化）
    const sig = title.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
    sigs.add(sig);
    sigToIds.set(sig, [...(sigToIds.get(sig) || []), id]);
  }
  return { fileNames, entries, ids, sigs, sigToIds };
}

const TITLE = "PMハーネス定例を7月末で終了し予定枠を削除、以後はリーダー主導で対応";
const decision = (over) => ({
  title: TITLE, date: "20260803", description: "同じことを言い換えただけ",
  category: "ビジネス", deciders: ["日吉杏太"], based_on: "minute:PMハーネス定例:20260803", ...over,
});

test("[再現] 2晩目・3晩目の再抽出を、supersedes 付きでも起票しない", () => {
  // 実際に起きたこと: 001（supersedesなし）→ 004（supersedes: 001）→ 006（supersedes: 001,004）。
  // タイトルは3件とも一字一句同じ。回を重ねるほど「衝突相手すべてが置き換え対象」を
  // 満たしやすくなるので、放置すると毎晩1件ずつ増える。
  const night2 = buildDecisionFiles(
    [decision({ supersedes: ["20260803-001"] })],
    existingFrom([["20260803-001", TITLE]]),
    new Set(),
  );
  assert.equal(night2.files.length, 0, "2晩目が起票されている");
  assert.match(night2.skipped[0].reason, /重複/);

  const night3 = buildDecisionFiles(
    [decision({ supersedes: ["20260803-001", "20260803-004"] })],
    existingFrom([["20260803-001", TITLE], ["20260803-004", TITLE]]),
    new Set(),
  );
  assert.equal(night3.files.length, 0, "3晩目が起票されている（回を重ねるほど通りやすい経路）");
});

test("[再現] 後日の本物の撤回は、これまでどおり起票する", () => {
  // 撤回は表題が既存とほぼ同じになる。ここで落とすと古い決定だけが Gold に残り、
  // AI が撤回済みの方針を確定情報として読む
  // **無関係な既存レコードを混ぜておく。** 免除の条件は「タイトルが衝突した相手」に対する
  // 判定であって、既存レコード全体ではない。ここを取り違えると条件が厳しくなりすぎ、
  // 本物の撤回まで落ちる（無関係な既存が1件でもあれば必ず落ちる）
  const r = buildDecisionFiles(
    [decision({ date: "20260901", supersedes: ["20260803-001"] })],
    existingFrom([["20260803-001", TITLE], ["20260610-999", "まったく別の決定"]]),
    new Set(),
  );
  assert.equal(r.files.length, 1, "本物の撤回まで落としている（衝突相手の取り違えの疑い）");
  assert.match(r.files[0].content, /rel: supersedes/);
  assert.match(r.files[0].content, /20260803-001/);
  assert.match(r.files[0].content, /status: draft/, "人のレビュー前提の印が要る");
});

test("[再現] 衝突していない既存を、置き換え対象と取り違えない", () => {
  // 免除の条件は「**タイトルが衝突した相手**のすべてを置き換えると言っていること」。
  // ここに無関係な既存IDを混ぜて判定すると、条件が緩くなって再抽出が通る。
  // （collidingIds に全既存IDを渡す取り違えを、これで捕まえる）
  const r = buildDecisionFiles(
    [decision({ supersedes: ["20260610-999"] })], // 別日の無関係な決定を置き換えると主張
    existingFrom([
      ["20260803-001", TITLE], // 同日・同タイトル＝本当の衝突相手
      ["20260610-999", "まったく別の決定"], // 衝突していない既存
    ]),
    new Set(),
  );
  assert.equal(r.files.length, 0, "衝突相手（同日・同タイトル）を置き換えると言っていないのに通っている");
});

test("[再現] 同じ夜のバッチ内の重複も、これまでどおり落とす", () => {
  const r = buildDecisionFiles(
    [decision({ supersedes: ["20260803-001"] })],
    existingFrom([]),
    new Set([TITLE.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase()]),
  );
  assert.equal(r.files.length, 0);
});
