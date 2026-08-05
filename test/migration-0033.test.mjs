/**
 * migration 0033（デザインのサムネイル撤去）が、**同期が作ったものだけ**を消すこと。
 *
 * 守りたいもの:
 *   `デザイン/resources/` は、この変更を境に「人がスクリーンショットを置く場所」になる。
 *   実際、艦隊には既に手置きPNGがある（japanetholings-context に5件・gdo に1件）。
 *   条件を緩めると、次に同じディレクトリを掃除しにきたときに人の資産を巻き込む。
 *
 * 条件を「中身が .png だけのサブディレクトリ」にしなかった理由:
 *   人が `resources/画面キャプチャ/` を作ってPNGを置けば、それだけで該当して消える。
 *   守ろうとしている資産の型が、1階層深いだけですり抜ける。**figma.json の key と一致すること**を
 *   AND条件に足して、同期の生成物だけを名指しする。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../migrations/0033-デザインのサムネイル撤去とDESIGNmdの移管.mjs";

const KEY = "abc123XYZ";

// 生成版（sync_designs.py が組み立てた形）。末尾に「。」が無く、2行目も無い
const OLD_AUTOGEN =
  "# このフロントマター（デザイントークン）は sync-designs が Figma から自動生成する（手編集しない）";
// scaffold 由来（案件に配られたひな形のまま）。末尾に「。」があり、2行目を持つ
const OLD_AUTOGEN_SCAFFOLD = `${OLD_AUTOGEN}。
# Figma未使用の案件では、この既定（Cortexニュートラル / Liquid Glass）がそのまま使われる。`;

const INVENTORY_MD = `# ログイン

- ファイル: アプリUI / ページ: 画面
- 更新日: 2026-07-03
- 参照ID: \`design:${KEY}:1:23\`
- [Figmaで開く](https://www.figma.com/design/${KEY}/x?node-id=1-23)

![ログイン](../../resources/${KEY}/1-23.png)

## 画面内テキスト（機械抽出）
- メールアドレス
`;

const DESIGN_MD = `---
${OLD_AUTOGEN}
version: alpha
name: "テスト案件"
---

# DESIGN.md

人が書いた本文。
`;

/**
 * 案件リポの雛形を作る。opts で「どんな汚れ方をしているか」を切り替える。
 * designDirName は案件でカスタマイズされる（Figma/ の案件が2つ実在する）。
 */
function makeRepo({ designDirName = "デザイン", withFigmaJson = true, extras = () => {} } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "mig33-"));
  mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".github", "workflows", "update-design-notes.yml"), "name: デザインMD自動育成\n");
  writeFileSync(path.join(repo, ".github", "workflows", "sync-designs.yml"), "name: デザイン同期\n");

  const dd = path.join(repo, designDirName);
  mkdirSync(dd, { recursive: true });
  if (withFigmaJson) {
    writeFileSync(path.join(dd, "figma.json"), JSON.stringify({ files: [{ key: KEY }] }));
    writeFileSync(path.join(dd, "DESIGN.md"), DESIGN_MD);

    // 同期が作ったサムネイル（消える）
    mkdirSync(path.join(dd, "resources", KEY), { recursive: true });
    writeFileSync(path.join(dd, "resources", KEY, "1-23.png"), "PNG");
    writeFileSync(path.join(dd, "resources", KEY, "4-56.png"), "PNG");
    // 直下の置き物（残る）
    writeFileSync(path.join(dd, "resources", ".gitkeep"), "");
    writeFileSync(path.join(dd, "resources", "実機キャプチャ.png"), "PNG");

    mkdirSync(path.join(dd, "inventory", "アプリUI"), { recursive: true });
    writeFileSync(path.join(dd, "inventory", "アプリUI", "ログイン-1-23.md"), INVENTORY_MD);
  }
  extras({ repo, designDir: dd });
  return { repo, designDir: dd };
}

test("[正常系] figma.jsonのkeyと一致する画像だけのディレクトリを消す", async () => {
  const { repo, designDir } = makeRepo();
  await run(repo);
  assert.equal(existsSync(path.join(designDir, "resources", KEY)), false, "同期の生成物が残っている");
});

test("[異常系] keyと一致しない画像だけのディレクトリは消さない（人が作ったフォルダ）", async () => {
  const { repo, designDir } = makeRepo({
    extras: ({ designDir: dd }) => {
      mkdirSync(path.join(dd, "resources", "画面キャプチャ"), { recursive: true });
      writeFileSync(path.join(dd, "resources", "画面キャプチャ", "本番.png"), "PNG");
    },
  });
  await run(repo);
  assert.ok(
    existsSync(path.join(designDir, "resources", "画面キャプチャ", "本番.png")),
    "人が作ったフォルダを巻き込んで消している",
  );
  assert.equal(existsSync(path.join(designDir, "resources", KEY)), false, "同期の生成物は消えるべき");
});

test("[異常系] resources直下の手置きファイル・.gitkeepは消さない", async () => {
  const { repo, designDir } = makeRepo();
  await run(repo);
  assert.ok(existsSync(path.join(designDir, "resources", "実機キャプチャ.png")), "手置きPNGが消えている");
  assert.ok(existsSync(path.join(designDir, "resources", ".gitkeep")), ".gitkeepが消えている");
});

test("[異常系] 画像以外が混ざるディレクトリは消さない（keyが一致していても）", async () => {
  const { repo, designDir } = makeRepo({
    extras: ({ designDir: dd }) => {
      writeFileSync(path.join(dd, "resources", KEY, "メモ.md"), "人が置いたメモ");
    },
  });
  await run(repo);
  assert.ok(existsSync(path.join(designDir, "resources", KEY, "メモ.md")), "画像以外を巻き込んで消している");
  assert.ok(existsSync(path.join(designDir, "resources", KEY, "1-23.png")), "ディレクトリごと残すべき");
});

test("[正常系] inventoryの画像リンク行を外し、他の行は変えない", async () => {
  const { repo, designDir } = makeRepo();
  await run(repo);
  const md = readFileSync(path.join(designDir, "inventory", "アプリUI", "ログイン-1-23.md"), "utf8");
  assert.ok(!md.includes("!["), "画像行が残っている（消したresourcesへのリンク切れになる）");
  // 画像行以外は1文字も変わらないこと
  assert.equal(md, INVENTORY_MD.replace(`\n![ログイン](../../resources/${KEY}/1-23.png)\n`, "\n"));
  assert.match(md, /- 参照ID: `design:abc123XYZ:1:23`/);
  assert.match(md, /## 画面内テキスト（機械抽出）\n- メールアドレス/);
});

test("[正常系] DESIGN.mdの自動生成コメントを書き換え、本文は変えない", async () => {
  const { repo, designDir } = makeRepo();
  await run(repo);
  const md = readFileSync(path.join(designDir, "DESIGN.md"), "utf8");
  assert.ok(!md.includes(OLD_AUTOGEN), "「手編集しない」が残っている（育てる方針を否定する）");
  assert.match(md, /design-md スキルで育てる/);
  assert.match(md, /人が書いた本文。/);
  assert.match(md, /^---\n/);
  assert.match(md, /version: alpha\n/);
});

test("[正常系] scaffold由来のDESIGN.md（末尾「。」＋2行目あり）も両行とも書き換える", async () => {
  // 生成版と scaffold 版で文言が違う。**両方に効かないと、案件によって古い文言が残る**
  // （tokyu で実際に2行目が取り残された）
  const SCAFFOLD_DESIGN = `---
${OLD_AUTOGEN_SCAFFOLD}
version: alpha
name: "テスト案件"
---

# DESIGN.md

人が書いた本文。
`;
  const { repo, designDir } = makeRepo({
    extras: ({ designDir: dd }) => writeFileSync(path.join(dd, "DESIGN.md"), SCAFFOLD_DESIGN),
  });
  await run(repo);
  const md = readFileSync(path.join(designDir, "DESIGN.md"), "utf8");
  assert.ok(!md.includes("sync-designs が Figma から自動生成"), "1行目が残っている");
  assert.ok(!md.includes("Figma未使用の案件では"), "2行目が残っている（もう条件になっていない）");
  assert.match(md, /design-md スキルで育てる/);
  assert.match(md, /# 記入がなければ、この既定（Cortexニュートラル \/ Liquid Glass）がそのまま使われる。/);
  assert.match(md, /人が書いた本文。/);
});

test("[異常系] DESIGN.mdのコメントが書き換えられていたら触らない", async () => {
  const CUSTOM = "---\n# 案件で書き換えた説明\nversion: alpha\n---\n\n本文\n";
  const { repo, designDir } = makeRepo({
    extras: ({ designDir: dd }) => writeFileSync(path.join(dd, "DESIGN.md"), CUSTOM),
  });
  await run(repo);
  assert.equal(readFileSync(path.join(designDir, "DESIGN.md"), "utf8"), CUSTOM);
});

test("[正常系] update-design-notesスタブを消し、他のワークフローは残す", async () => {
  const { repo } = makeRepo();
  await run(repo);
  const wf = path.join(repo, ".github", "workflows");
  assert.equal(existsSync(path.join(wf, "update-design-notes.yml")), false, "スタブが残っている");
  assert.ok(existsSync(path.join(wf, "sync-designs.yml")), "他のワークフローを巻き込んで消している");
});

test("[正常系] デザインディレクトリ名がカスタマイズされていても動く（Figma/ の案件が実在する）", async () => {
  const { repo, designDir } = makeRepo({ designDirName: "Figma" });
  await run(repo);
  assert.equal(existsSync(path.join(designDir, "resources", KEY)), false);
  const md = readFileSync(path.join(designDir, "inventory", "アプリUI", "ログイン-1-23.md"), "utf8");
  assert.ok(!md.includes("!["));
});

test("[正常系] figma.jsonが無い案件では、スタブ削除以外なにもしない", async () => {
  // 艦隊15案件中10案件がこれ。デザイン設定が無いのに走って壊さないこと
  const { repo } = makeRepo({ withFigmaJson: false });
  await run(repo);
  assert.equal(
    existsSync(path.join(repo, ".github", "workflows", "update-design-notes.yml")),
    false,
    "スタブ削除はデザイン設定と無関係に効くべき",
  );
});

test("[正常系] 冪等（2回走らせても壊れない）", async () => {
  const { repo, designDir } = makeRepo();
  await run(repo);
  const after1 = readFileSync(path.join(designDir, "inventory", "アプリUI", "ログイン-1-23.md"), "utf8");
  const design1 = readFileSync(path.join(designDir, "DESIGN.md"), "utf8");
  await run(repo);
  assert.equal(readFileSync(path.join(designDir, "inventory", "アプリUI", "ログイン-1-23.md"), "utf8"), after1);
  assert.equal(readFileSync(path.join(designDir, "DESIGN.md"), "utf8"), design1);
  assert.ok(existsSync(path.join(designDir, "resources", "実機キャプチャ.png")));
});
