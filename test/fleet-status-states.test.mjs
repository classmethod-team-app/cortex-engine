/**
 * 会議の取り込み・Drive資料同期の「現在の状態」が、理由まで区別されることを固定する。
 *
 * なぜ必要か:
 *   設定UIから ON/OFF を押せるようにする以上、画面が現在値を出せないと
 *   「押したのに変わらない」と読まれる。そして以前の実装は
 *     - 会議: 「OFF」「設定ファイルなし」「合図が空」がすべて同じ undefined
 *     - 資料: 「OFF」「設定ファイルなし」「フォルダ未登録」がすべて `driveSync: false`
 *   に潰れていた。`goldState` を三値にしたときと同じ問題（区別できないと
 *   正常なOFFにも警告が出て、警告そのものが無視されるようになる）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "fleet-status.mjs");

/** 案件リポを模した一時ディレクトリで fleet-status.mjs を走らせ、結果を返す */
function run(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-"));
  // Home.md は tools の宣言に使う（applicability のゲート）
  const home = [
    "---", "type: overview", 'id: "overview:home"', "kind: 案件", "lifecycle: active",
    "tools:", "  会議: google-meet", "  共有資料: google-drive", "  デザイン: figma", "---", "", "# Home",
  ].join("\n");
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  writeFileSync(path.join(dir, "Cortex", "Home.md"), home);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
    writeFileSync(path.join(dir, p), body);
  }
  execFileSync("node", [SCRIPT], {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, FLEET_NOW: "2026-08-03T00:00:00Z", GITHUB_REPOSITORY: "org/kc-context" },
  });
  const out = JSON.parse(readFileSync(path.join(dir, "fleet-status.json"), "utf8"));
  const by = (kind) => (out.internalSources || []).find((s) => s.kind === kind) || {};
  const check = (id) => (out.checks || []).find((c) => c.id === id) || {};
  const pipe = (id) => (out.pipelines || []).find((p) => p.id === id) || {};
  return {
    designPipe: pipe("sync-designs"),
    meeting: by("会議"),
    materials: by("共有資料"),
    design: by("デザイン"),
    duplicates: check("config_duplicates"),
  };
}

const INGEST = (enabled, meetingKey) => JSON.stringify({ enabled, ...(meetingKey ? { meetingKey } : {}) });
const MATERIALS = (enabled, ids) => JSON.stringify({ enabled, driveFolderIds: ids });

test("[会議] ON / OFF / 未設置 / 壊れている を区別する", () => {
  assert.equal(run({ "会議/ingest-config.json": INGEST(true) }).meeting.ingestState, "on");
  assert.equal(run({ "会議/ingest-config.json": INGEST(false) }).meeting.ingestState, "off");
  assert.equal(run({}).meeting.ingestState, "unset");
  assert.equal(run({ "会議/ingest-config.json": "{ 壊れ" }).meeting.ingestState, "broken");
});

test("[資料] ON / OFF / 未設置 / フォルダ未登録 を区別する", () => {
  const on = run({ "共有資料/materials-config.json": MATERIALS(true, ["1AbC"]) }).materials;
  assert.equal(on.driveState, "on");
  assert.equal(on.driveFolderCount, 1);
  assert.equal(on.url, "https://drive.google.com/drive/folders/1AbC");

  // **OFF でもフォルダ数は残す。** 「消したのか、止めただけなのか」が画面で分かるように。
  const off = run({ "共有資料/materials-config.json": MATERIALS(false, ["1AbC", "2DeF"]) }).materials;
  assert.equal(off.driveState, "off");
  assert.equal(off.driveFolderCount, 2);

  assert.equal(run({ "共有資料/materials-config.json": MATERIALS(true, []) }).materials.driveState, "empty");
  assert.equal(run({}).materials.driveState, "unset");
});

test("[資料] driveSync は後方互換のため残す（既存の読み手が見ている）", () => {
  const on = run({ "共有資料/materials-config.json": MATERIALS(true, ["1AbC"]) }).materials;
  assert.equal(on.driveSync, undefined, "ONのときは付けない（従来どおり）");
  for (const cfg of [MATERIALS(false, ["1AbC"]), MATERIALS(true, [])]) {
    assert.equal(run({ "共有資料/materials-config.json": cfg }).materials.driveSync, false);
  }
});

test("[資料] 設定ファイルの置き場が案件で違っても読める", () => {
  // 実データ: cortex-context は 共有資料/materials-config/materials-config.json に置いている
  const r = run({ "共有資料/materials-config/materials-config.json": MATERIALS(true, ["1AbC"]) });
  assert.equal(r.materials.driveState, "on");
});

test("[会議] 合図は ON/OFF に関わらず出す", () => {
  // **画面は「どんな会議名なら取り込まれるか」を常に示す必要がある。**
  // 取り込みの可否は「Botを会議に招待したか」で決まる（Router.gs の設計）。
  // 招待しても名前が合わなければ届かないので、合図は招待の判断に要る材料。
  // ON/OFF は ingestState が別に伝えるので、合図をそれで出し分けると情報が消えるだけ。
  assert.equal(run({ "会議/ingest-config.json": INGEST(true, "kc") }).meeting.meetingKey, "kc");
  assert.equal(run({ "会議/ingest-config.json": INGEST(false, "kc") }).meeting.meetingKey, "kc");
  // 設置されていなければ出しようがない
  assert.equal(run({}).meeting.meetingKey, undefined);
  assert.equal(run({ "会議/ingest-config.json": "{ 壊れ" }).meeting.meetingKey, undefined);
});

test("[会議] 宣言が無ければ合図を出さない（推測しない）", () => {
  // **既定の合図は艦隊レジストリのキーで、案件リポはそれを知らない。**
  // ここで案件名やclientから推測して出すと、そのとおり改名した会議が丸ごと未仕分けへ落ちる。
  // 艦隊キーは投入設定を持つ画面側が補う。
  assert.equal(run({ "会議/ingest-config.json": INGEST(true) }).meeting.meetingKey, undefined);
  assert.equal(run({ "会議/ingest-config.json": INGEST(true, "   ") }).meeting.meetingKey, undefined);
  // scaffold の未置換プレースホルダをそのまま合図として出さない
  assert.equal(run({ "会議/ingest-config.json": INGEST(true, "{{案件キー}}") }).meeting.meetingKey, undefined);
});

test("[会議] 廃止した meetingNamePatterns を合図として出さない", () => {
  // 照合から外れて久しいが、古い案件リポのファイルには残っている。
  // 出すと「この語を会議名に入れれば拾われる」と読めてしまう（実際には拾われない）
  const r = run({ "会議/ingest-config.json": JSON.stringify({ enabled: true, meetingNamePatterns: ["ハーネス定例"] }) });
  assert.equal(r.meeting.meetingKey, undefined);
  assert.equal(r.meeting.matchKeys, undefined, "廃止したフィールドを載せている");
});

test("[会議] 宣言された合図の扱いを、振り分け側と同じ表で固定する", () => {
  // **この規則は cortex-tools/apps-script/src/Projects.gs の normalizeMeetingKey_ と
  // 同じでなければならない。** 画面が出す目印と、実際に照合される値が食い違うと、
  // 画面のとおり会議を改名した人の文字起こしが丸ごと未仕分けへ落ちる。
  // 言語もリポも違うので共有できない——同じ表を両側に置いて突き合わせる。
  const table = [
    ["kc", "kc", "そのまま"],
    ["  kc  ", "kc", "前後の空白は落とす"],
    ["[kc]", "kc", "括弧付きで書かれたら剥がす（手順書が括弧付きで例示しているので起きる）"],
    ["【kc】", "kc", "全角も同じ"],
    ["", undefined, "空は宣言なし扱い"],
    ["   ", undefined, "空白のみも同じ"],
    ["[]", undefined, "剥がすと空"],
    ["[[kc]]", undefined, "剥がしても括弧が残る"],
    ["a b", undefined, "空白が混じると会議名に打ちにくく、当たらない事故になる"],
    ["{{案件キー}}", undefined, "scaffold の未置換プレースホルダ"],
  ];
  for (const [raw, want, why] of table) {
    const got = run({ "会議/ingest-config.json": JSON.stringify({ enabled: true, meetingKey: raw }) }).meeting.meetingKey;
    assert.equal(got, want, `${JSON.stringify(raw)} → ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）: ${why}`);
  }
});

test("[会議] 文字列でない合図で落ちない", () => {
  for (const bad of [123, true, ["kc"], { a: 1 }, null]) {
    const r = run({ "会議/ingest-config.json": JSON.stringify({ enabled: true, meetingKey: bad }) });
    assert.equal(r.meeting.meetingKey, undefined, `${JSON.stringify(bad)} を通している`);
    assert.equal(r.meeting.ingestState, "on", "他の情報まで巻き添えで落ちている");
  }
});

test("[異常系] 同名の設定ファイルが複数あることを検知する", () => {
  // 資料の変換が設定ファイルを移動する事故があり、読み手が空の正本を見て
  // 2案件の資料同期が数週間止まった。複数あること自体が異常の兆候なので気づけるようにする。
  const dup = run({
    "共有資料/materials-config.json": MATERIALS(false, []),
    "共有資料/materials-config/materials-config.json": MATERIALS(true, ["1A"]),
  });
  assert.equal(dup.duplicates.status, "missing");
  assert.match(dup.duplicates.detail, /materials-config\.json/);
  // 読み手が見る方（浅い方）が先に出る
  assert.match(dup.duplicates.detail, /共有資料\/materials-config\.json \/ 共有資料\/materials-config\//);

  // 1つだけなら正常
  const ok = run({ "共有資料/materials-config.json": MATERIALS(true, ["1A"]) });
  assert.equal(ok.duplicates.status, "ok");
});

test("[正常系] 設定UIが「どれを外すか」を選ぶための材料を出す", () => {
  // 先頭1件のURLだけでは選べない（6ファイル登録している案件がある）。
  // Driveも「2件以上かつ有効」のときしか出しておらず、唯一Driveを使う案件が
  // ちょうど1件なので一度も使えなかった。
  const r = run({
    "デザイン/figma.json": JSON.stringify({
      files: [
        { key: "AAAAAAAAAAAAAAAAAAAAAA", name: "Sprint22" },
        { key: "BBBBBBBBBBBBBBBBBBBBBB", name: "Sprint21" },
        { key: "{プレースホルダ}", name: "未設定" },
      ],
    }),
    "共有資料/materials-config.json": MATERIALS(true, ["1AAA"]),
  });
  const design = r.design;
  assert.equal(design.figmaFiles.length, 2, "プレースホルダは除く");
  assert.deepEqual(design.figmaFiles.map((f) => f.name), ["Sprint22", "Sprint21"]);

  // 1件でもフォルダ一覧を出す
  assert.deepEqual(r.materials.driveFolderIds, ["1AAA"]);
  assert.equal(r.materials.urls.length, 1);
});

test("[正常系] 止めている案件でもフォルダ一覧は出す（1件だけ外せるように）", () => {
  const r = run({ "共有資料/materials-config.json": MATERIALS(false, ["1AAA", "2BBB"]) });
  assert.equal(r.materials.driveState, "off");
  assert.deepEqual(r.materials.driveFolderIds, ["1AAA", "2BBB"]);
});

// パイプラインは .github/workflows/ のスタブ（engineのreusableを uses しているもの）から列挙される
const DESIGN_STUB = [
  "name: デザイン同期",
  "on: { schedule: [{ cron: \"45 12 * * *\" }] }",
  "jobs:",
  "  sync:",
  "    uses: classmethod-team-app/cortex-engine/.github/workflows/sync-designs.yml@v1",
].join("\n");

test("[デザイン] 実キーが無ければ「稼働中」に見せない", () => {
  // 同期は figma.json が未記入だと何もせず正常終了する。宣言（tools: figma）だけで
  // 適用扱いにすると ✅ が並び、何も同期していないのに動いているように見える。
  // 雛形のプレースホルダのまま放置された案件と、設定UIから最後の1件を外した案件が
  // どちらもこの状態になる（後者は実際に踏んだ）。
  const stub = { ".github/workflows/sync-designs.yml": DESIGN_STUB };
  const real = JSON.stringify({ files: [{ key: "AAAAAAAAAAAAAAAAAAAAAA", name: "UI" }] });
  const ok = run({ ...stub, "デザイン/figma.json": real }).designPipe;
  assert.equal(ok.id, "sync-designs", "前提: パイプラインが列挙されている");
  assert.equal(ok.applicable, undefined, "実キーがあれば適用（印を付けない）");

  for (const [label, body] of [
    ["空", JSON.stringify({ files: [] })],
    ["雛形のプレースホルダ", JSON.stringify({ files: [{ key: "{FigmaのURL ... をここに}", name: "{メモ}" }] })],
  ]) {
    assert.equal(run({ ...stub, "デザイン/figma.json": body }).designPipe.applicable, false, `${label} は適用外にする`);
  }
  assert.equal(run(stub).designPipe.applicable, false, "figma.json が無い案件も適用外");

  // **宣言側の条件も要る。** 別ツールを使う（あるいは使わないと決めた）案件で、
  // 雛形の figma.json に実キーが残っていると適用扱いに戻ってしまう。
  const declineDesign = ["---", "type: overview", 'id: "overview:home"', "tools:", "  デザイン: none", "---", "", "# Home"].join("\n");
  const r = run({ ...stub, "Cortex/Home.md": declineDesign, "デザイン/figma.json": real });
  assert.equal(r.designPipe.applicable, false, "デザインを使わないと宣言した案件は適用外");
});

// ---- デザインMD自動育成の撤去（エンジンから消えたものが名前だけ残らないように）----

test("[異常系] デザインMD自動育成（update-design-notes）がどこにも残っていない", () => {
  // エンジンの reusable・案件スタブ・育成スキルはすべて撤去済み。DESIGN.md はデザインハーネスの
  // 所有物になった。**判定コードや表示名に名前だけ残ると、消えた配管を探す人が出る**
  const engine = path.join(HERE, "..");
  assert.equal(
    existsSync(path.join(engine, ".github", "workflows", "update-design-notes.yml")),
    false,
    "reusable が残っている",
  );
  assert.equal(existsSync(path.join(engine, "plugin", "skills", "update-design-md-auto")), false, "スキルが残っている");
  assert.equal(
    existsSync(path.join(engine, "plugin", "scaffold", "repo", ".github", "workflows", "update-design-notes.yml")),
    false,
    "スタブ雛形が残っている",
  );

  // 判定コードの死にコード（case が残ると、無いパイプラインの分岐を読むことになる）
  const src = readFileSync(path.join(engine, "scripts", "fleet-status.mjs"), "utf8");
  assert.ok(!src.includes("update-design-notes"), "fleet-status に判定が残っている");
  // 表示名も直す（Cortex はもう DESIGN.md を同期しない）
  assert.ok(!src.includes("画面インベントリ・DESIGN.md"), "表示名に DESIGN.md が残っている");
});

// ---- フォルダの表示名（IDだけでは「どれを外してよいか」判断できない）----

test("[正常系] 表示名は登録済みIDのぶんだけ出す", () => {
  // 外したフォルダの名前が設定に残っていても、画面に出す理由が無い（消し忘れを漏らさない）
  const r = run({
    "共有資料/materials-config.json": JSON.stringify({
      enabled: true,
      driveFolderIds: ["1AAA", "2BBB"],
      driveFolderNames: { "1AAA": "設計資料", "9ZZZ": "もう外したフォルダ", "2BBB": "  " },
    }),
  });
  assert.deepEqual(r.materials.driveFolderNames, { "1AAA": "設計資料" });
  assert.deepEqual(r.materials.driveFolderIds, ["1AAA", "2BBB"], "IDの一覧は名前と無関係に全部出す");
});

test("[正常系] 名前が無ければフィールドごと出さない（既存9案件はこの状態）", () => {
  // **後方互換の要。** ここが壊れると、いま動いている案件の画面が変わる
  const r = run({ "共有資料/materials-config.json": MATERIALS(true, ["1AAA"]) });
  assert.equal(r.materials.driveFolderNames, undefined);
  assert.deepEqual(r.materials.driveFolderIds, ["1AAA"]);
});

test("[異常系] driveFolderNames が壊れていても落ちない", () => {
  // 人が手で書き換えることがある。判定できないことを理由に一覧ごと消さない
  for (const bad of ['"文字列"', "[1,2]", "null", "123"]) {
    const r = run({
      "共有資料/materials-config.json": `{"enabled":true,"driveFolderIds":["1AAA"],"driveFolderNames":${bad}}`,
    });
    assert.deepEqual(r.materials.driveFolderIds, ["1AAA"], `driveFolderNames=${bad} で一覧が消えた`);
    assert.equal(r.materials.driveFolderNames, undefined);
  }
});

test("[正常系] 止めている案件でも表示名は出す", () => {
  const r = run({
    "共有資料/materials-config.json": JSON.stringify({
      enabled: false, driveFolderIds: ["1AAA"], driveFolderNames: { "1AAA": "設計資料" },
    }),
  });
  assert.equal(r.materials.driveState, "off");
  assert.deepEqual(r.materials.driveFolderNames, { "1AAA": "設計資料" });
});

test("[異常系] 登録していない名前を、継承したプロパティから拾わない", () => {
  // フォルダIDの検証は /^[A-Za-z0-9_-]{10,}$/ なので `constructor`（11文字）は**通る**。
  // 素の `raw[id]` で読むと、名前を1つも登録していないのに Object.prototype.constructor
  // （関数）を拾い、それが画面に出る。**own property だけを見る。**
  const r = run({
    "共有資料/materials-config.json": JSON.stringify({
      enabled: true,
      driveFolderIds: ["constructor", "toString", "1AAA"],
      driveFolderNames: { "1AAA": "設計資料" }, // constructor / toString の名前は登録していない
    }),
  });
  assert.deepEqual(r.materials.driveFolderNames, { "1AAA": "設計資料" },
    "継承したプロパティを名前として拾っている");
  assert.deepEqual(r.materials.driveFolderIds, ["constructor", "toString", "1AAA"],
    "ID一覧は名前と無関係に全部出す");
});

test("[正常系] 特殊な名前のキーでも、登録されていれば出す", () => {
  // 上の裏返し。own property として書かれていれば、キー名が何であれ正当な登録
  const r = run({
    "共有資料/materials-config.json": JSON.stringify({
      enabled: true,
      driveFolderIds: ["constructor"],
      driveFolderNames: { constructor: "本当に登録した名前" },
    }),
  });
  assert.deepEqual(r.materials.driveFolderNames, { constructor: "本当に登録した名前" });
});
;
