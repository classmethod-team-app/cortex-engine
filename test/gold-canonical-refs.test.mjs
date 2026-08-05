/**
 * Gold層の出典（Decision の `references`・用語の `source`）が、正本（ツール）のURLになること。
 * そして**誤った正本へ飛ばさないこと**。
 *
 * なぜ必要か（実際に起きたこと）:
 *   Decision の「参照」を押すと GitHub の 404 に飛んだ。frontmatter に入っていたのは
 *   `[slack] #tf-project-cortex (8 messages since …)` という**説明文**だった。
 *   調べると Slack だけの問題ではなく、同期ミラーを根拠にしたものは全部
 *   `課題管理/issues/2026/xxx.md` のような**リポジトリ内のコピーのパス**で、
 *   Backlogの課題そのものにも Figmaの画面そのものにも飛べなかった。
 *
 *   出典は一次情報へ辿るためのもので、辿れないなら出典として機能していない。
 *
 * **誤った先へ飛ばすのは、飛べないより悪い。** 議事録に引用された Backlog リンクを拾って
 * 「別の課題を根拠にした」レコードを作ってしまうと、読み手はそれを疑わない。
 * だから解決は必ずディレクトリで限定し、引けなければパスのまま残す。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoSourceUrl, decisionSourceRef } from "../plugin/scripts/update-gold-pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BACKLOG_URL = "https://cm1.backlog.jp/view/PJ_CORTEX-53";
const FIGMA_URL =
  "https://www.figma.com/design/kFfqJDvHYzytINVZCazn4m/GDO?node-id=1170-11346";

/** 実データと同じ形の Backlog 課題ミラー */
const backlogMirror = [
  "# 【定例】PMハーネス定例：20260723",
  "",
  "- 課題キー: PJ_CORTEX-53",
  `- [Backlog Issue Link](${BACKLOG_URL})`,
  "",
  "## 詳細",
  "アジェンダを確認した。",
].join("\n");

/** 実データと同じ形の Figma 画面インベントリ */
const figmaInventory = [
  "# トーク画面_ID連携後",
  "",
  "- ファイル: GDO練習場LINEミニアプリ / ページ: flow",
  "- 参照ID: `design:kFfqJDvHYzytINVZCazn4m:1170:11346`",
  `- [Figmaで開く](${FIGMA_URL})`,
].join("\n");

/** ファイル内容を引く read を差し込んで解決する（実ファイルI/Oなしで判定だけを見る） */
function resolve(filePath, files, dirs = { issuesDir: "課題管理", designDir: "デザイン" }) {
  return repoSourceUrl(filePath, dirs, (p) => (p in files ? files[p] : null));
}

// ---- 正本へ飛ぶ（本題）----

test("[正常系] Backlog課題ミラーのパスが課題そのもののURLになる", () => {
  const p = "課題管理/issues/2026/PMハーネス定例：20260723.md";
  assert.equal(resolve(p, { [p]: backlogMirror }), BACKLOG_URL);
});

test("[正常系] Figmaインベントリのパスが画面そのもののURLになる", () => {
  const p = "デザイン/inventory/GDO/トーク画面-1170-11346.md";
  assert.equal(resolve(p, { [p]: figmaInventory }), FIGMA_URL);
});

test("[正常系] ディレクトリを改名した案件でも解決できる", () => {
  // customize-tooling で 課題管理/→Backlog/・デザイン/→Figma/ に改名した案件が実在する。
  // マーカーファイル由来のディレクトリ名を渡せば効くこと（直書きしていないことの確認）。
  const b = "Backlog/issues/2026/課題.md";
  const f = "Figma/inventory/画面.md";
  const dirs = { issuesDir: "Backlog", designDir: "Figma" };
  assert.equal(resolve(b, { [b]: backlogMirror }, dirs), BACKLOG_URL);
  assert.equal(resolve(f, { [f]: figmaInventory }, dirs), FIGMA_URL);
});

// ---- 誤った正本へ飛ばさない（ここが要）----

test("[異常系] 対象ディレクトリの外にある同じリンク記法は拾わない", () => {
  // 議事録が Backlog の課題を引用していることは普通にある。本文だけを見て解決すると、
  // **その議事録が、引用された課題そのものを根拠にしたことになる**（別の一次情報へ飛ばす）
  const minutes = "会議/Ph.1/全体定例/20260730/20260730_minutes.md";
  const body = ["# 議事録", "", `- 関連: [Backlog Issue Link](${BACKLOG_URL})`].join("\n");
  assert.equal(resolve(minutes, { [minutes]: body }), null, "議事録を課題URLに化けさせている");

  // 共有資料に Figma のリンクが貼られている場合も同じ
  const material = "共有資料/提案書/デザイン方針.md";
  const m = `- [Figmaで開く](${FIGMA_URL})`;
  assert.equal(resolve(material, { [material]: m }), null);
});

test("[異常系] 課題ディレクトリ配下でもリンクが無ければパスのまま", () => {
  const p = "課題管理/issues/2026/リンクなし.md";
  assert.equal(resolve(p, { [p]: "# 課題\n\n本文だけ" }), null);
});

test("[異常系] 読めないファイルはパスのまま（例外を投げない）", () => {
  const p = "課題管理/issues/2026/消えた.md";
  assert.equal(resolve(p, {}), null);
});

test("[正常系] スコープ外のソースは触らない", () => {
  // 議事録・共有資料・開発配下は今回のスコープ外。**パスのまま**であることを固定する
  // （共有資料は正本URLの保存場所自体がまだ無い＝別Issue）
  for (const p of [
    "会議/Ph.1/全体定例/20260730/20260730_minutes.md",
    "共有資料/提案書/v2.md",
    "開発/wiki/設計.md",
    "Cortex/Home.md",
  ]) {
    assert.equal(resolve(p, { [p]: backlogMirror }), null, `${p} を勝手にURL化している`);
  }
});

test("[異常系] 課題ディレクトリと前方一致する別ディレクトリを巻き込まない", () => {
  // `課題管理/issues/` で限定する。`課題管理/issues-old/` のような隣は対象外
  const p = "課題管理/issues-old/2025/旧課題.md";
  assert.equal(resolve(p, { [p]: backlogMirror }), null);
});

// ---- Slack: 素材に URL 行が出る ----

/** 案件リポを模した一時ディレクトリで resolve-external-sources.mjs を走らせる */
function resolveSources(channels) {
  const dir = mkdtempSync(path.join(tmpdir(), "goldrefs-"));
  mkdirSync(path.join(dir, "Cortex"), { recursive: true });
  mkdirSync(path.join(dir, "チャット"), { recursive: true });
  writeFileSync(
    path.join(dir, "Cortex", "Home.md"),
    ["---", "type: overview", "tools:", "  チャット: slack", "  開発: none", "---", "", "# Home"].join("\n"),
  );
  writeFileSync(path.join(dir, "チャット", "channels.json"), JSON.stringify({ channels }));
  const out = execFileSync(
    "node",
    [path.join(HERE, "..", "plugin", "scripts", "resolve-external-sources.mjs")],
    { cwd: dir, encoding: "utf-8" },
  );
  return JSON.parse(out);
}

const CH_URL = "https://classmethod.enterprise.slack.com/archives/C0ATMCUAR8U";

test("[正常系] 既定出力に slack の url が載る", () => {
  // **ここを落とすと Gold層の出典が説明文になる。** チャンネルの正本URLは channels.json にしか無い
  const got = resolveSources([{ name: "#tf-project-cortex", url: CH_URL, gold: true }]);
  assert.equal(got.length, 1);
  assert.equal(got[0].url, CH_URL, "url が出力から落ちている（Slackへ飛べなくなる）");
  assert.equal(got[0].ref, "C0ATMCUAR8U");
});

test("[正常系] gold/notify は今までどおり既定出力に出さない", () => {
  // 内部判定・表示用。url を戻したついでに他まで漏らしていないこと
  const got = resolveSources([{ name: "#a", url: CH_URL, gold: true, notify: true }]);
  assert.deepEqual(Object.keys(got[0]).sort(), ["name", "ref", "type", "url"]);
});

test("[正常系] URL行の有無で decisionSourceRef の戻りが変わる", () => {
  // 書く側（external-sources.sh の `URL:` 行）と読む側（decisionSourceRef）の噛み合わせ。
  // github系と同じ規約なので、読む側は1つの形だけを知っていればよい
  const withUrl = { kind: "external", label: "[slack] #a (3 messages)", content: `URL: ${CH_URL}\n[誰か] やあ` };
  const without = { kind: "external", label: "[slack] #a (3 messages)", content: "[誰か] やあ" };
  assert.equal(decisionSourceRef(withUrl), CH_URL);
  assert.equal(
    decisionSourceRef(without),
    "[slack] #a (3 messages)",
    "URLが無いときは説明文のまま（壊れたURLを作らない）",
  );
});

// ---- 壊れたURLからリンクを作らない ----

test("[異常系] 壊れたチャンネルURLは素材の URL 行にしない", () => {
  // 実データにあるもの: テンプレのプレースホルダ・全フィールド空・httpsでない
  const sh = path.join(HERE, "..", "plugin", "scripts", "external-sources.sh");
  const check = (url) =>
    execFileSync("bash", ["-c", `source <(sed -n '/^slack_channel_url()/,/^}/p' ${JSON.stringify(sh)}); slack_channel_url ${JSON.stringify(url)}`], {
      encoding: "utf-8",
    });

  for (const bad of [
    "https://your-workspace.slack.com/archives/CHANNEL_ID", // テンプレのまま（gift-stvv に実在した）
    "https://example.slack.com/archives/CHANNEL_ID",
    "",
    "not-a-url",
    "http://x.slack.com/archives/C123", // https でない
    "https://x.slack.com/archives/C123/p1700000000123456", // メッセージ単位（チャンネルではない）
  ]) {
    assert.equal(check(bad), "", `壊れたURL "${bad}" を通している`);
  }

  // 正しいものは通る（判定が厳しすぎないことの確認）
  assert.equal(check(CH_URL), CH_URL);
  assert.equal(
    check("https://tokyuline.slack.com/archives/C02AWDADZGC"),
    "https://tokyuline.slack.com/archives/C02AWDADZGC",
    "別ワークスペースのチャンネル（Slack Connect）を弾いている",
  );
});

test("[正常系] リポ内ソースは url があればURL・無ければパス", () => {
  // 列挙時に解決した url を出典に載せる。Decision の references と用語の source が同じ関数を通る
  assert.equal(
    decisionSourceRef({ kind: "repo", label: "x", path: "課題管理/issues/2026/x.md", url: BACKLOG_URL }),
    BACKLOG_URL,
  );
  assert.equal(
    decisionSourceRef({ kind: "repo", label: "y", path: "会議/Ph.1/全体定例/20260730/20260730_minutes.md" }),
    "会議/Ph.1/全体定例/20260730/20260730_minutes.md",
    "解決できないものまでURL化しようとしている",
  );
});
