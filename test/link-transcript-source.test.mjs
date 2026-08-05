/**
 * 議事録に、その元になった文字起こしの**正本（Drive）URL**を差し込むこと。
 * そして**別の会議のURLを書かないこと**。
 *
 * なぜ必要か:
 *   Gold層の出典は議事録を指す。議事録の元は文字起こしで、その正本は Drive の Doc にある。
 *   取り込むとリポジトリに残るのはコピーだけなので、「どこから来たか」を辿る鎖が
 *   議事録のところで切れていた。
 *
 * **誤った正本へ飛ばすのは、飛べないより悪い。** 別の回の会議のDocが「この議事録の根拠」として
 * 書かれていても、読み手はそれを疑わない。だから同じディレクトリしか見ず、来歴の形が
 * 合わないものからはURLを作らない。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insertSourceLine, findSiblingSource } from "../plugin/scripts/link-transcript-source.mjs";

const DOC_URL = "https://docs.google.com/document/d/1AbCdEf/edit?usp=drivesdk";
const OTHER = "https://docs.google.com/document/d/9ZzZzZz/edit";
const LINE = `- **文字起こし（正本）**: ${DOC_URL}`;

/** 実データと同じ形（箇条書き。188件がこれ） */
const bulletMinutes = [
  "# 【2026/08/04】デザインハーネス定例 議事録",
  "",
  "> ⚠️ この議事録はAIによる自動生成です（人間レビュー前）。",
  "",
  "## 会議情報",
  "",
  "- **日時**: 2026年8月4日（火）",
  "- **出席者**: 鈴木さん、高垣",
  "",
  "## サマリー",
  "",
  "プレイブックのレビュー可否を確認した。",
].join("\n");

/** 実データと同じ形（Markdownの表。GDOの初期に5件） */
const tableMinutes = [
  "# 【2025/12/11】定例 議事録",
  "",
  "## 会議情報",
  "",
  "| 項目 | 内容 |",
  "| --- | --- |",
  "| 日時 | 2025年12月11日 |",
  "| 参加者 | 高垣 |",
  "",
  "## サマリー",
  "",
  "本文。",
].join("\n");

/** `## 会議情報` を持たない議事録（実データに1件） */
const noInfoMinutes = ["# 【2026/07/15】営業ハーネス定例 議事録", "", "## サマリー", "", "本文。"].join("\n");

/** 議事録本文から、差し込まれた正本リンクの行だけを取り出す */
const sourceLines = (t) => t.split("\n").filter((l) => l.includes("文字起こし（正本）"));

// ---- 差し込み位置 ----

test("[正常系] 箇条書きの会議情報では、箇条書きの後・次の見出しの前に入る", () => {
  const out = insertSourceLine(bulletMinutes, DOC_URL);
  const lines = out.split("\n");
  const at = lines.indexOf(LINE);
  assert.ok(at > lines.indexOf("- **出席者**: 鈴木さん、高垣"), "箇条書きの前に入っている");
  assert.ok(at < lines.indexOf("## サマリー"), "サマリーの後ろに入っている");
  // **箇条書きに地続きで入る。** 節末の空行の後ろに置くと、箇条書きが空行で分断されたうえ
  // 次の見出しの直前の空行も失われる（Markdownとしては通るが、人が書いた形と違う）
  assert.equal(lines[at - 1], "- **出席者**: 鈴木さん、高垣", "空行を挟んで離れている");
  assert.equal(lines[at + 1], "", "次の見出しの前の空行が消えている");
});

test("[正常系] 表形式の会議情報でも壊れない（表の後に入る）", () => {
  // **「箇条書きの末尾」を狙うとここで外れる。** 実データに5件ある（GDOの初期）
  const out = insertSourceLine(tableMinutes, DOC_URL);
  const lines = out.split("\n");
  const at = lines.indexOf(LINE);
  assert.ok(at > lines.indexOf("| 参加者 | 高垣 |"), "表の途中や前に入っている");
  assert.ok(at < lines.indexOf("## サマリー"));
  assert.match(out, /\| 参加者 \| 高垣 \|/, "表が壊れている");
});

test("[正常系] 会議情報が無い議事録でもH1の直後に入る", () => {
  const out = insertSourceLine(noInfoMinutes, DOC_URL);
  const lines = out.split("\n");
  assert.ok(lines.indexOf(LINE) > 0 && lines.indexOf(LINE) < lines.indexOf("## サマリー"));
});

test("[正常系] 会議情報より後ろの本文は1バイトも変わらない", () => {
  const out = insertSourceLine(bulletMinutes, DOC_URL);
  const after = (t) => t.slice(t.indexOf("## サマリー"));
  assert.equal(after(out), after(bulletMinutes));
});

// ---- 再実行しても壊れない ----

test("[正常系] 2回走らせても増えない（冪等）", () => {
  const once = insertSourceLine(bulletMinutes, DOC_URL);
  assert.equal(insertSourceLine(once, DOC_URL), null, "2回目で変更ありと判定している");
  assert.equal(sourceLines(once).length, 1);
});

test("[正常系] 別のURLが入っていれば置き換える（2行に増やさない）", () => {
  // 誤挿入のやり直し・手で直した後の再実行。**2つの正本が並ぶ状態を作らない**
  const stale = insertSourceLine(bulletMinutes, OTHER);
  const fixed = insertSourceLine(stale, DOC_URL);
  assert.equal(sourceLines(fixed).length, 1, "2行になっている");
  assert.match(fixed, new RegExp(DOC_URL.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&")));
  assert.ok(!fixed.includes(OTHER), "古いURLが残っている");
});

// ---- 誤った正本を書かない（ここが要）----

test("[正常系] 兄弟の文字起こしから正本URLを拾う", () => {
  const files = { "cortex_定例.md": `<!-- cortex: organizer=a@b.jp source=${DOC_URL} -->\n00:00:26\n本文` };
  assert.equal(
    findSiblingSource("/d", () => Object.keys(files), (p) => files[p.split("/").pop()] ?? null),
    DOC_URL,
  );
});

test("[異常系] source= が無い来歴行からURLを作らない", () => {
  // 旧い文字起こしは organizer だけを持つ（実データの大半）。**過去分は触らない**
  const files = { "旧_定例.md": "<!-- cortex: organizer=a@b.jp -->\n00:00:26\n本文" };
  assert.equal(
    findSiblingSource("/d", () => Object.keys(files), (p) => files[p.split("/").pop()] ?? null),
    null,
  );
});

test("[異常系] 手動投入フォームの来歴行にマッチしない", () => {
  // 投入フォームのLambdaは別系統の来歴を書く。正規表現を緩めると投入者名をURL扱いしかねない
  const files = { "投入_定例.md": "> 手動投入 — 投入者: 高垣 / 投入日時: 2026-08-05T10:00:00Z\n00:00:26" };
  assert.equal(
    findSiblingSource("/d", () => Object.keys(files), (p) => files[p.split("/").pop()] ?? null),
    null,
  );
});

test("[異常系] 議事録自身は読まない", () => {
  // 自分が書いた行を次の実行で拾い直すと、置き換えではなく「兄弟から来た」ことになる
  const files = { "20260804_minutes.md": `- **文字起こし（正本）**: ${DOC_URL}\n<!-- cortex: source=${DOC_URL} -->` };
  assert.equal(
    findSiblingSource("/d", () => Object.keys(files), (p) => files[p.split("/").pop()] ?? null),
    null,
  );
});

test("[正常系] 兄弟が複数あればファイル名の昇順で決まる", () => {
  // readdir の順序はOS依存。実行のたびに違うURLが入ると差分がちらついて信用を失う
  const files = {
    "b_メモ.md": `<!-- cortex: source=${OTHER} -->`,
    "a_メモ.md": `<!-- cortex: source=${DOC_URL} -->`,
  };
  const read = (p) => files[p.split("/").pop()] ?? null;
  // readdir が逆順を返しても結果が変わらないこと
  assert.equal(findSiblingSource("/d", () => ["b_メモ.md", "a_メモ.md"], read), DOC_URL);
  assert.equal(findSiblingSource("/d", () => ["a_メモ.md", "b_メモ.md"], read), DOC_URL);
});

test("[異常系] 来歴が壊れていてもURLを作らない", () => {
  for (const body of [
    "<!-- cortex: source= -->",
    "<!-- cortex: source=notaurl -->",
    "<!-- cortex: -->",
    "source=https://docs.google.com/document/d/x/edit", // コメントの外
  ]) {
    assert.equal(
      findSiblingSource("/d", () => ["x.md"], () => body),
      null,
      `壊れた来歴を通している: ${body}`,
    );
  }
});

// ---- ワークフローとの結線（書いただけで消えないこと）----

test("[正常系] 差し込みステップがcommitしてからpushに渡る", () => {
  // **これが無いと機能ごと消える。** robust-push は「呼び出し側が staging と commit まで
  // 済ませてから呼ぶ」規約なので、書き込んだだけでは runner の破棄と同時に消え、
  // ワークフローは緑のまま何も起きない。
  const yml = readFileSync(
    new URL("../.github/workflows/ingest-minutes.yml", import.meta.url),
    "utf-8",
  );
  const i = yml.indexOf("link-transcript-source.mjs");
  assert.ok(i > 0, "差し込みステップがワークフローに繋がっていない");

  const push = yml.indexOf("robust-push@v1");
  assert.ok(i < push, "push より後ろに置かれている（その run では push されない）");

  // ステップ内（次のステップの `- name:` まで）で commit していること
  const step = yml.slice(yml.lastIndexOf("- name:", i), yml.indexOf("\n      - name:", i));
  assert.match(step, /git add/, "staging していない");
  assert.match(step, /\bcommit -m/, "commit していない（書いた分が捨てられる）");
  assert.match(step, /if: always\(\)/, "生成が打ち切られた晩に繋がらない");
});

test("[正常系] organizerの抽出がハイフン入りメールで切れない", () => {
  // `[^ >-]` はハイフンを除外しており、foo-bar@… が foo で切れて
  // 議事録レビュー依頼のメンションが無言で外れていた
  const yml = readFileSync(
    new URL("../.github/workflows/ingest-minutes.yml", import.meta.url),
    "utf-8",
  );
  const m = yml.match(/grep -rhoE 'cortex: organizer=(\[\^[^\]]*\])\+'/);
  assert.ok(m, "organizer 抽出の grep が見つからない");
  const re = new RegExp(`^${m[1]}+`);
  assert.equal(
    "foo-bar@classmethod.jp source=https://x".match(re)?.[0],
    "foo-bar@classmethod.jp",
    "メールが途中で切れている／source まで飲み込んでいる",
  );
});
