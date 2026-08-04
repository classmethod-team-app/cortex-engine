/**
 * Backlogドキュメントの取りこぼし検出。
 *
 * 守りたいのは「同期は緑なのにデータが入っていない」を二度と起こさないこと。
 * 実際に、顧客側メンバーの指摘があるまで誰も気づけなかった（同期は6回とも成功していた）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  classifyMissing,
  collectParentIds,
  collectTrashIds,
  expectsLocalFile,
  collectLocalDocumentIds,
  findDocumentsDir,
  findMissing,
  formatMissing,
  STALE_HOURS,
} from "../scripts/backlog-document-audit.mjs";

/** ミラーの1ファイル（exporter が実際に書く形。先頭にBacklogへのリンクが入る） */
const mirrorFile = (title, id) =>
  [`# ${title}`, "", `[Backlog Document Link](https://cm1.backlog.jp/document/PJ_CORTEX/${id})`, "", "## 内容", "本文"].join("\n");

function withMirror(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "docaudit-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    writeFileSync(path.join(dir, p), body);
  }
  return dir;
}

const ID_A = "019f925c274875b98665cea4bad8963d";
const ID_B = "019e634f2f8a778d885ba0000b853fbd";
const ID_MISSING = "019fca2f817972e09c773596b1e2c390";

test("[正常系] 取り込み済みIDは、階層の奥にあっても拾う", () => {
  const dir = withMirror({
    "Cortexとは.md": mirrorFile("Cortexとは", ID_A),
    "PMハーネス/PMプレイブック/Part0.md": mirrorFile("Part0", ID_B),
    "backlog-update.log": "ログ（.md でないので無視される）",
  });
  assert.deepEqual([...collectLocalDocumentIds(dir)].sort(), [ID_A, ID_B].sort());
});

test("[正常系] 突き合わせはIDで行う（ファイル名では一致しない）", () => {
  // タイトルの空白は `_` に置換され、親ドキュメントは 00_index.md になる。
  // 名前で突き合わせると、正常なものを「欠けている」と誤判定する。
  const dir = withMirror({
    "営業ハーネス/営業ハーネス_プレイブック.md": mirrorFile("営業ハーネス　プレイブック", ID_A),
    "ハーネスプラグイン設計/00_index.md": mirrorFile("ハーネスプラグイン設計", ID_B),
  });
  const remote = [
    { id: ID_A, title: "営業ハーネス　プレイブック" },
    { id: ID_B, title: "ハーネスプラグイン設計" },
  ];
  assert.deepEqual(findMissing(remote, collectLocalDocumentIds(dir)), []);
});

test("[異常系] Backlogに在ってミラーに無いものを見つける", () => {
  const dir = withMirror({ "Cortexとは.md": mirrorFile("Cortexとは", ID_A) });
  const remote = [
    { id: ID_A, title: "Cortexとは", created: "2026-07-24T04:22:20Z" },
    { id: ID_MISSING, title: "スケジュール生本", created: "2026-08-04T00:32:18Z" },
  ];
  const missing = findMissing(remote, collectLocalDocumentIds(dir));
  assert.equal(missing.length, 1);
  assert.equal(missing[0].title, "スケジュール生本");
});

test("[異常系] 大文字小文字が違っても同じIDとみなす", () => {
  const dir = withMirror({ "a.md": mirrorFile("A", ID_A.toUpperCase()) });
  assert.deepEqual(findMissing([{ id: ID_A }], collectLocalDocumentIds(dir)), []);
});

test("[正常系] 反映待ちと、詰まっているものを分ける", () => {
  // **新しい欠けで毎回赤くしない。** ドキュメント作成直後は必ずこの状態を通るので、
  // 赤が常態化して読まれなくなる（今回いちばん避けたい失敗の仕方）。
  const now = Date.parse("2026-08-04T12:00:00Z");
  const { waiting, stale } = classifyMissing(
    [
      { id: "a", title: "さっき作った", created: "2026-08-04T10:00:00Z" },
      { id: "b", title: "3日前に作った", created: "2026-08-01T12:00:00Z" },
    ],
    now,
  );
  assert.deepEqual(waiting.map((m) => m.title), ["さっき作った"]);
  assert.deepEqual(stale.map((m) => m.title), ["3日前に作った"]);
  assert.equal(waiting[0].ageHours, 2, "経過時間を人が読める形で添える");
});

test("[境界] 閾値ちょうどは詰まっている側に倒す", () => {
  const now = Date.parse("2026-08-04T12:00:00Z");
  const at = new Date(now - STALE_HOURS * 3_600_000).toISOString();
  assert.equal(classifyMissing([{ id: "a", created: at }], now).stale.length, 1);
  const justUnder = new Date(now - (STALE_HOURS * 3_600_000 - 60_000)).toISOString();
  assert.equal(classifyMissing([{ id: "a", created: justUnder }], now).waiting.length, 1);
});

test("[異常系] 日付が読めないものは見逃さず、詰まっている側に倒す", () => {
  const { stale } = classifyMissing([{ id: "a", title: "壊れ", created: "不明" }], Date.now());
  assert.equal(stale.length, 1);
  assert.equal(stale[0].ageHours, null, "経過時間は書けないので付けない");
});

test("[正常系] created が無ければ updated で判断する", () => {
  const now = Date.parse("2026-08-04T12:00:00Z");
  const r = classifyMissing([{ id: "a", updated: "2026-08-04T11:00:00Z" }], now);
  assert.equal(r.waiting.length, 1);
});

test("[正常系] 置き場が案件で違っても documents のミラーを見つける", () => {
  const settings = (folderType) => JSON.stringify({ folderType, domain: "cm1.backlog.jp" });
  const dir = withMirror({
    "課題管理/issues/backlog-settings.json": settings("issue"),
    "課題管理/wiki/backlog-settings.json": settings("wiki"),
    "課題管理/documents/backlog-settings.json": settings("document"),
  });
  assert.equal(findDocumentsDir(dir), path.join(dir, "課題管理", "documents"));
});

test("[異常系] エンジン自身のチェックアウトを案件のミラーと間違えない", () => {
  // ワークフローは同じ場所に .cortex-engine/ としてエンジンを展開する。
  // そこにテスト用のフィクスチャが入ると、浅い順に選ぶ規則でそちらが勝ちうる。
  const settings = JSON.stringify({ folderType: "document" });
  const dir = withMirror({
    ".cortex-engine/test/fixtures/backlog-settings.json": settings,
    "課題管理/documents/backlog-settings.json": settings,
  });
  assert.equal(findDocumentsDir(dir), path.join(dir, "課題管理", "documents"));

  // エンジンしか無ければ「ミラー無し」とみなす（案件のものではないので触らない）
  const engineOnly = withMirror({ ".cortex-engine/fixtures/backlog-settings.json": settings });
  assert.equal(findDocumentsDir(engineOnly), null);
});

test("[異常系] 壊れた設定ファイルは候補にしない・無ければ null", () => {
  const broken = withMirror({ "課題管理/documents/backlog-settings.json": "{ 壊れ" });
  assert.equal(findDocumentsDir(broken), null);
  assert.equal(findDocumentsDir(withMirror({ "README.md": "x" })), null);
});

test("[正常系] 人が読める通知文になる", () => {
  const s = formatMissing([{ id: ID_MISSING, title: "スケジュール生本", ageHours: 26 }]);
  assert.match(s, /スケジュール生本/);
  assert.match(s, new RegExp(ID_MISSING), "IDも出す（人が手で取り直せるように）");
  assert.match(s, /26時間前/);
});


// ---- 誤検知の除外（実データで当てて分かった2種類）----

test("[異常系] ゴミ箱のドキュメントを「欠けている」と言わない", () => {
  // 一覧APIは削除済みも返す。ミラーからは prune が消すので、無いのが正しい状態。
  const tree = { trashTree: { children: [{ id: ID_A, name: "用語集", children: [] }] } };
  const trashIds = collectTrashIds(tree);
  assert.deepEqual(findMissing([{ id: ID_A, title: "用語集", plain: "本文あり" }], new Set(), { trashIds }), []);
  // ゴミ箱に入っていなければ、これまでどおり検出する
  assert.equal(findMissing([{ id: ID_B, title: "生きてる", plain: "本文" }], new Set(), { trashIds }).length, 1);
});

test("[異常系] 本文が空の親ドキュメントを「欠けている」と言わない", () => {
  // 子を持つドキュメントは 00_index.md として保存されるが、
  // exporter は本文が空なら作らない（skip-empty-parent）。フォルダの見出しは大抵これ。
  const tree = {
    activeTree: { children: [{ id: ID_A, name: "PMハーネス", children: [{ id: "child1", children: [] }] }] },
  };
  const parentIds = collectParentIds(tree);
  assert.deepEqual(findMissing([{ id: ID_A, title: "PMハーネス", plain: "  \n " }], new Set(), { parentIds }), []);

  // 本文がある親は 00_index.md が出来るので、無ければ本当に欠けている
  assert.equal(findMissing([{ id: ID_A, title: "親", plain: "説明文" }], new Set(), { parentIds }).length, 1);

  // 子が無ければ、本文が空でもファイルは作られる
  assert.equal(findMissing([{ id: ID_B, title: "空のメモ", plain: "" }], new Set(), { parentIds }).length, 1);
});

test("[異常系] 子の有無を一覧APIで判定しない（常に空で返ってくる）", () => {
  // 一覧APIは、子を持つドキュメントでも childDocumentIds を空で返す（実データで確認）。
  // ここを一覧API側で見ると、親ドキュメントが全部「欠けている」に化ける。
  const fromList = { id: ID_A, title: "PMハーネス", childDocumentIds: [], plain: "" };
  const parentIds = collectParentIds({ activeTree: { children: [{ id: ID_A, children: [{ id: "c" }] }] } });
  assert.equal(expectsLocalFile(fromList, { parentIds }), false, "ツリー由来の親判定が効く");
  assert.equal(expectsLocalFile(fromList, {}), true, "材料が無ければ検出側に倒す（見逃さない）");
});

test("[正常系] 材料が無いときは「ファイルが出来るはず」に倒す", () => {
  // 見逃す側に倒すと、検知の意味が無くなる
  assert.equal(expectsLocalFile({ id: "a", plain: "本文" }), true);
  assert.equal(expectsLocalFile({ id: "a" }), true);
  assert.equal(expectsLocalFile(null), false);
});
