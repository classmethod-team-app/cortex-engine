/**
 * ワークフローのステップ同士の依存が破綻していないかを検査する。
 *
 * なぜ必要か:
 *   **ステップが自分自身の出力を条件にしていると、そのステップは常に skip される。**
 *   GitHub はこれをエラーにしない（未定義は空文字＝偽）ので、run は緑のまま
 *   「そのステップだけ一度も動かない」状態になる。実際にそうなった:
 *   版ずれを検知するために足したガードが自分の出力で条件分岐しており、
 *   ガードが永久に skip → それを見ている取得ステップも skip → 全部フォールバック、
 *   という「一見動いているが新しい経路を一度も通らない」状態を作った。
 *
 *   もう1つ、**まだ実行されていないステップの出力を条件にする**のも同じ壊れ方をする。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");

/**
 * ステップ単位に切り出す（YAMLパーサを持ち込まずに済ませる）。
 *
 * **`- name:` だけを起点にしない。** 名前を持たないステップ（`- uses:` / `- run:` で
 * 始まるもの）を見落とすと、そこに自己参照の `if:` を書いても素通りする。
 */
function steps(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(\s*)- (?:name|uses|run|id|if):\s*(.*)$/);
    if (m && m[1].length >= 6) {
      if (cur) out.push(cur);
      cur = { name: m[2].trim() || "(名前なし)", indent: m[1].length, body: [line] };
    } else if (cur) {
      // ステップより浅い行が来たらステップの終わり
      const ind = line.length - line.trimStart().length;
      if (line.trim() !== "" && ind <= cur.indent) { out.push(cur); cur = null; }
      else cur.body.push(line);
    }
  }
  if (cur) out.push(cur);
  return out.map((s) => ({
    name: s.name,
    text: s.body.join("\n"),
    id: (s.body.join("\n").match(/^\s+id:\s*(\S+)/m) || [])[1],
    ifRefs: [...s.body.join("\n").matchAll(/steps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome|conclusion)/g)]
      .filter((_, i, all) => all)
      .map((m) => m[1]),
    hasIf: /^\s+if:/m.test(s.body.join("\n")),
  }));
}

/**
 * `if:` の値を取り出す。**1行だけ見ない。**
 * `if: >-` のようなブロックスカラーで書かれた条件を読み落とすと、そこに自己参照を
 * 書いた場合に検知できない。
 */
function ifValue(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^\s+if:/.test(l));
  if (at === -1) return "";
  const head = lines[at];
  const inline = (head.match(/^\s+if:\s*(.*)$/) || [])[1] || "";
  if (inline && !/^[>|][-+]?$/.test(inline.trim())) return inline;
  // ブロックスカラー: 見出しより深いインデントの行を連結する
  const indent = head.length - head.trimStart().length;
  const body = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") { body.push(""); continue; }
    if (lines[i].length - lines[i].trimStart().length <= indent) break;
    body.push(lines[i].trim());
  }
  return body.join(" ");
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml"));

test("存在しないコンテキストのプロパティを使っていない", () => {
  // `github.job_workflow_sha` は**存在しない**（正しくは job.workflow_sha）。
  // GitHub は未定義のプロパティをエラーにせず空文字にするので、`A || B` と書くと
  // 常に B に落ちる。実際にこれでエンジンの版がずれ、3ワークフローが落ちた。
  for (const f of files) {
    const text = readFileSync(path.join(DIR, f), "utf8");
    assert.doesNotMatch(
      text, /github\.job_workflow_sha/,
      `${f}: github.job_workflow_sha は存在しないプロパティです（job.workflow_sha が正しい）`,
    );
  }
});

test("ステップが自分自身の出力を条件にしていない（常にskipされる）", () => {
  for (const f of files) {
    for (const s of steps(readFileSync(path.join(DIR, f), "utf8"))) {
      if (!s.id) continue;
      const cond = ifValue(s.text);
      assert.ok(
        !cond.includes(`steps.${s.id}.`),
        `${f} / ${s.name}: 自分の出力（steps.${s.id}）を if: にしています。このステップは永久に skip されます`,
      );
    }
  }
});

test("参照しているステップが自分より前にある", () => {
  for (const f of files) {
    const list = steps(readFileSync(path.join(DIR, f), "utf8"));
    const seen = new Set();
    for (const s of list) {
      for (const ref of s.ifRefs) {
        assert.ok(
          seen.has(ref) || ref === s.id,
          `${f} / ${s.name}: まだ実行されていない steps.${ref} を参照しています`,
        );
      }
      if (s.id) seen.add(s.id);
    }
  }
});

test("版ずれのガードは、取得ステップより前にあり条件を持たない", () => {
  for (const f of files) {
    const list = steps(readFileSync(path.join(DIR, f), "utf8"));
    const guard = list.findIndex((s) => s.id === "engineok");
    if (guard === -1) continue;
    assert.equal(
      /^\s+if:/m.test(list[guard].text), false,
      `${f}: 版ずれのガードに if: が付いています（付けると検知そのものが skip されます）`,
    );
    const users = list
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.text.includes("steps.engineok.outputs"));
    for (const { s, i } of users) {
      assert.ok(i > guard, `${f} / ${s.name}: ガードより前で steps.engineok を参照しています`);
    }
  }
});

test("[sync-backlog] 取りこぼしの検出をコミットより前に置き、意図した失敗を消さない", () => {
  // 検出→回収→コミット の順でないと、拾ったファイルがコミットに乗らない。
  // また continue-on-error を付けると「24時間以上入っていない」という
  // 意図した失敗まで消える（この検知は、緑のままデータが失われるのを防ぐためにある）。
  const text = readFileSync(path.join(DIR, "sync-backlog.yml"), "utf8");
  const audit = text.indexOf("- name: ドキュメントの取りこぼしを検出・回収");
  const commit = text.indexOf("- name: 変更をコミット・プッシュ");
  assert.notEqual(audit, -1, "取りこぼしの検出ステップがありません");
  assert.ok(audit < commit, "検出・回収はコミットより前に置く（拾った分をコミットに乗せるため）");

  const step = text.slice(audit, commit);
  assert.doesNotMatch(step, /continue-on-error/, "意図した失敗まで握りつぶしてしまう");
  assert.match(step, /backlog-document-audit\.mjs/);
  // キーの受け渡し: Secrets Manager 優先・repo secret フォールバックという艦隊の型に揃える
  assert.match(step, /steps\.backlog_key\.outputs\.value \|\| secrets\.BACKLOG_API_KEY/);
  assert.match(step, /BACKLOG_DOMAIN/);
  assert.match(step, /BACKLOG_PROJECT_KEY/);
});

test("[sync-backlog] 意図的に失敗するステップの後ろでも、診断ステップが飛ばない", () => {
  // GitHub Actions は `if:` に状態関数（success/failure/always/cancelled）が無いと
  // 暗黙に `success() && …` として評価する。取りこぼし検出は意図的に失敗することがあるので、
  // それだけで後続の診断ステップが丸ごと飛び、**別の障害の原因が読めなくなる**。
  const text = readFileSync(path.join(DIR, "sync-backlog.yml"), "utf8");
  const audit = text.indexOf("- name: ドキュメントの取りこぼしを検出・回収");
  assert.notEqual(audit, -1);

  const STATE_FN = /\b(success|failure|always|cancelled)\s*\(/;
  // 取りこぼし検出より後ろのステップは、すべて状態関数を明示していること
  const after = text.slice(audit);
  for (const m of after.matchAll(/^      - name: (.+)$/gm)) {
    const start = m.index;
    const body = after.slice(start, after.indexOf("\n      - name:", start + 1) + 1 || undefined);
    const ifLine = /^\s+if:\s*(.+)$/m.exec(body);
    if (!ifLine) continue; // if が無ければ常に走るので問題ない
    assert.match(
      ifLine[1],
      STATE_FN,
      `${m[1]}: if に状態関数が無いため暗黙の success() が付き、前のステップが失敗すると飛ぶ`,
    );
  }
});

test("[同期] 排他グループを占有したまま待たせない（リアルタイム同期が詰まる）", () => {
  // **寝ているだけの run が、リアルタイム同期を最大10分ブロックしていた。**
  // 定期同期（sync-backlog / sync-designs）は、Backlogのレート上限を避けるため
  // 0〜10分（デザインは0〜30分）のランダム待機を入れていた。ところが、この待機中も
  // `cortex-repo-write-<repo>` の排他グループを占有し続けるため、Webhook起点の
  // リアルタイム同期が順番待ちで動けなくなっていた（実際に困った）。
  //
  // そもそもBacklogのレート上限は**ユーザー単位**で（公式ドキュメント）、案件ごとの
  // キーへ移行しつつある今は前提も弱い。分散が必要になったら、実行時間を食わない方法
  // （案件ごとに固定オフセットで cron の分をずらす）で行う。
  for (const f of ["sync-backlog.yml", "sync-designs.yml", "backlog-webhook-sync.yml"]) {
    const text = readFileSync(path.join(DIR, f), "utf8");
    assert.doesNotMatch(text, /RANDOM/, `${f}: ランダム待機が復活しています`);
    // 「待つだけのステップ」を禁じる。失敗後のリトライ待ち（sleep $((attempt * 60))）は
    // 仕事をした結果の待機なので対象外——**着手前に寝るステップだけ**が問題
    assert.doesNotMatch(text, /^\s+- name: .*待機/m, `${f}: 待つだけのステップがあります（排他グループを占有します）`);
  }
});

test("[リアルタイム同期] 削除は名指ししたものだけを消す（pruneに倒さない）", () => {
  // `update` は取ってくるだけで、消えたものを消さない。消す役は定期同期の prune だけで、
  // 削除は最大1時間（夜間・土日は翌営業日まで）ミラーに残っていた。
  //
  // **prune は使わない。** prune は Backlog のツリーAPIを正とするが、ツリーAPIは新規ドキュメントを
  // 最大1時間半返さないことがある（実測）。取りこぼし検出で回収したばかりのファイルを
  // prune が巻き添えで消す（実測で再現した）。名指しなら構造的に起きない。
  const text = readFileSync(path.join(DIR, "backlog-webhook-sync.yml"), "utf8");
  assert.doesNotMatch(text, /backlog-exporter@\d+ prune/, "pruneは巻き添えを起こすので実行しない");
  assert.match(text, /delete_by_marker/, "削除が反映されない");

  // 3種別すべてを受ける（以前はドキュメントだけ対応していて課題・Wikiが取り残されていた）
  for (const v of ["DELETED_ISSUE_KEYS", "DELETED_WIKI_IDS", "DELETED_DOCUMENT_IDS"]) {
    assert.match(text, new RegExp(v), `${v} を受けていない`);
  }

  // **厳密に当てる。** 実データで2つの誤爆を確認している（前方一致・本文中の引用リンク）
  const fn = text.slice(text.indexOf("delete_by_marker() {"), text.indexOf("root=$("));
  assert.match(fn, /grep -qxF/, "課題キーは行全体の完全一致でないと前方一致で誤爆する");
  assert.match(fn, /head -10/, "先頭だけを見ないと本文中の引用リンクに誤爆する");
  assert.match(fn, /grep -qxF -- /, "-- が無いとオプション扱いでステップごと落ちる");
  assert.match(fn, /::warning::/, "見つからないことを黙って成功にしている");
});
