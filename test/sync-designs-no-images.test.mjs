/**
 * デザイン同期が **画像を取らず、DESIGN.md に触らない** こと。
 *
 * なぜ実際に走らせるか:
 *   「消したつもりで消えていない」は、ソース文字列の照合では捕まらない。呼び出し側が残っていても
 *   grep は通る。逆に「何も動かなければ何も起きない」ので、否定形の検証（画像を取らない・
 *   DESIGN.md を書き換えない）は**スクリプトが起動に失敗しただけで全部通ってしまう**。
 *   同じ型の素通り事故を資料変換で一度やっている（ci.yml のコメント参照）。
 *   そこで偽の Figma API を立てて実際に走らせ、**受けたリクエストのパスを全部記録**して確かめる。
 *
 * 何を守っているか:
 *   サムネイルは デザイン/resources/ に 808件162MB 積み上がり、しかも一度も掃除されなかった。
 *   DESIGN.md はデザインハーネスの所有物になったので、Cortex は読むだけで書かない。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "plugin", "skills", "sync-designs", "scripts", "sync_designs.py");
const FAKE_SERVER = path.join(HERE, "fixtures", "fake-figma-server.mjs");

const FILE_KEY = "TESTKEY123";

/** Figma /files/{key} の応答。ページ1枚・トップレベルフレーム2枚。 */
const FIGMA_FILE = {
  name: "テストUI",
  lastModified: "2026-08-05T00:00:00Z",
  document: {
    children: [
      {
        type: "CANVAS",
        name: "画面",
        children: [
          {
            type: "FRAME",
            id: "1:23",
            name: "ログイン",
            children: [
              { type: "TEXT", characters: "メールアドレス" },
              { type: "INSTANCE", name: "Button/Primary" },
            ],
          },
          { type: "FRAME", id: "4:56", name: "ホーム", children: [{ type: "TEXT", characters: "ようこそ" }] },
        ],
      },
    ],
  },
};

/**
 * 偽Figmaは**別プロセス**で動かす。テストは execFileSync で python を同期実行するので、
 * 同一プロセスにサーバーを置くとイベントループが止まって応答できずハングする。
 * 受けたパスはログファイル経由で受け取る。
 */
let child;
let baseUrl;
let logPath;

before(async () => {
  logPath = path.join(mkdtempSync(path.join(tmpdir(), "figma-log-")), "requests.log");
  writeFileSync(logPath, "");
  child = spawn(process.execPath, [FAKE_SERVER], {
    env: { ...process.env, REQUEST_LOG: logPath, FIGMA_FILE_JSON: JSON.stringify(FIGMA_FILE) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("偽Figmaが起動しません")), 10000);
    child.stdout.on("data", (b) => {
      const m = String(b).match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => child?.kill());

/** 直近の sync() で偽Figmaが受けたリクエストのパス一覧。 */
function requestedPaths() {
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

const DESIGN_MD = `---
name: "テスト案件"
colors:
  primary: "#2563EB"
---

# DESIGN.md

## Overview

人が書いた本文。同期で1バイトも変わってはいけない。
`;

/**
 * 一時リポジトリを作ってデザイン同期を走らせ、結果を返す。
 * designDirName は案件でカスタマイズされる（Figma/ にしている案件が実在する）。
 */
function sync(designDirName = "デザイン") {
  const repo = mkdtempSync(path.join(tmpdir(), "design-"));
  const dd = path.join(repo, designDirName);
  mkdirSync(dd, { recursive: true });
  writeFileSync(path.join(dd, "figma.json"), JSON.stringify({ files: [{ key: FILE_KEY }] }));
  writeFileSync(path.join(dd, "DESIGN.md"), DESIGN_MD);
  writeFileSync(logPath, ""); // 記録をこの実行の分だけにする
  const stdout = execFileSync("python3", [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, FIGMA_TOKEN: "dummy", FIGMA_API_BASE: baseUrl },
  });
  const invDir = path.join(dd, "inventory", "テストUI");
  const inventory = existsSync(invDir)
    ? Object.fromEntries(readdirSync(invDir).map((n) => [n, readFileSync(path.join(invDir, n), "utf8")]))
    : {};
  return { repo, designDir: dd, stdout, inventory };
}

test("[正常系] インベントリが実際に生成される（以降の否定形が素通りしないための土台）", () => {
  const r = sync();
  // **これが通らない限り、下の「取らない・触らない」は全部無意味。**
  // 何も動かなければ、何も取らず何も書き換えないので否定形は必ず通る。
  assert.equal(Object.keys(r.inventory).length, 2, `画面が生成されていない: ${r.stdout}`);
  assert.ok(requestedPaths().some((u) => u.startsWith(`/files/${FILE_KEY}`)), "Figma APIを1度も叩いていない");
});

test("[異常系] 画像レンダリングAPI（/images/）を1度も叩かない", () => {
  sync();
  const images = requestedPaths().filter((u) => u.startsWith("/images/"));
  assert.deepEqual(images, [], `サムネイル取得が残っている: ${images.join(", ")}`);
});

test("[異常系] published styles API（/styles）を1度も叩かない", () => {
  sync();
  // DESIGN.mdトークン抽出のためだけに叩いていた。撤去でTier1コールが1ファイルあたり2→1になる。
  const styles = requestedPaths().filter((u) => u.includes("/styles"));
  assert.deepEqual(styles, [], `トークン抽出が残っている: ${styles.join(", ")}`);
});

test("[異常系] resources/ を作らない・PNGを書かない", () => {
  const r = sync();
  assert.equal(existsSync(path.join(r.designDir, "resources")), false, "resources/ が作られている");
});

test("[異常系] インベントリmdに画像行を書かない", () => {
  const r = sync();
  for (const [name, body] of Object.entries(r.inventory)) {
    assert.ok(!body.includes("!["), `${name} に画像行が残っている`);
  }
});

test("[異常系] DESIGN.md をバイト単位で変更しない", () => {
  const r = sync();
  // **フロントマターだけ比べない。** 本文が変わっていても通ってしまう。
  assert.equal(readFileSync(path.join(r.designDir, "DESIGN.md"), "utf8"), DESIGN_MD);
});

test("[正常系] インベントリの中身（画面名・参照ID・ディープリンク・機械抽出）は従来どおり", () => {
  const r = sync();
  const login = r.inventory["ログイン-1-23.md"];
  assert.ok(login, `期待したファイル名で生成されていない: ${Object.keys(r.inventory).join(", ")}`);
  assert.match(login, /^# ログイン\n/);
  assert.match(login, /- ファイル: テストUI \/ ページ: 画面\n/);
  assert.match(login, /- 更新日: 2026-08-05\n/);
  assert.match(login, new RegExp(`- 参照ID: \`design:${FILE_KEY}:1:23\`\n`));
  assert.match(login, new RegExp(`\\[Figmaで開く\\]\\(https://www\\.figma\\.com/design/${FILE_KEY}/.*\\?node-id=1-23\\)`));
  assert.match(login, /## 画面内テキスト（機械抽出）\n- メールアドレス\n/);
  assert.match(login, /## 使用コンポーネント（機械抽出）\n- Button\/Primary\n/);
  // frontmatter は付けない（frontmatterを持つのはGold層のみ＝オントロジー規約）
  assert.ok(!login.startsWith("---"), "inventory md に frontmatter が付いている");
});

test("[正常系] デザインディレクトリ名がカスタマイズされていても動く（Figma/ の案件が実在する）", () => {
  const r = sync("Figma");
  assert.equal(Object.keys(r.inventory).length, 2, `Figma/ で画面が生成されていない: ${r.stdout}`);
  assert.equal(existsSync(path.join(r.designDir, "resources")), false);
});
