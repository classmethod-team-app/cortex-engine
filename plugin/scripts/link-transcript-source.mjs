#!/usr/bin/env node
// 議事録（Silver）に、その元になった文字起こし（Bronze）の**正本URL**へのリンクを差し込む。
//
// なぜ要るか:
//   Gold層の出典は議事録を指す。議事録の元は同じディレクトリの文字起こしで、その正本は
//   Google Drive の Doc にある。取り込むとリポジトリに残るのはコピーだけなので、
//   「どこから来たか」を辿る鎖が議事録のところで切れていた。
//
//     Decision → 議事録 → 文字起こし → Drive の Doc
//                          ↑ ここを繋ぐ
//
//   URLは notetaker が文字起こしの先頭に書いている:
//     <!-- cortex: organizer=xxx@classmethod.jp source=https://docs.google.com/document/d/xxx/edit -->
//
// **なぜ議事録を生成する LLM にやらせないか:**
//   URLは1文字違えば別のドキュメントを指し、しかも読み手はそれを疑わない。
//   誤った正本へ飛ばすのは、飛べないより悪い。だから機械的に転記する。
//
// **出典（Gold層）は議事録のままにする。** Goldパイプラインが読んでいるのは *_minutes.md だけで、
// 文字起こし原本は enumerateRepoSources が明示的に除外している。出典を文字起こしに差し替えると
// 「読んでいないものを根拠だと言う」ことになる。鎖の各段を正直にする。
//
// 使い方: link-transcript-source.mjs [--dry-run]
//   変更したファイルを1行ずつ stdout に出す。**コミットはしない**（呼び出し側の責務）。

import fs from "node:fs";
import path from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");

// notetaker が書く来歴行から source を取り出す。
// **source= が無い行から URL を作らない。** organizer だけの旧い行や、手動投入フォームが書く
// 別系統の来歴行（`> 手動投入 — 投入者: …`）が実在する。形が合うものだけを拾う。
const SOURCE_RE = /<!--\s*cortex:[^>]*\bsource=(https?:\/\/\S+?)\s*(?:\s[^>]*)?-->/;

// 議事録に差し込む行。**この見出し語がこの行の所有者の印**で、再実行時の置き換えの目印にもなる。
const LABEL = "**文字起こし（正本）**";
// **LABEL から導出する。** 別々に書くと、片方だけ変えたときに「自分が前回書いた行を
// 見つけられず、2行目を足す」という壊れ方をする（差し替えのつもりが二重に並ぶ）。
const LINE_RE = new RegExp(`^-\\s*${LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "m");

function readText(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

// ディレクトリ名は案件でカスタマイズされ得る（会議/→MTG/ 等）のでマーカーから導出する
// （fleet-status.mjs / update-gold-pipeline.mjs と同じ流儀）。
export function findDirByMarker(root, marker, fallback) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return fallback;
  }
  for (const d of entries) {
    if (!d.isDirectory() || d.name === "node_modules" || d.name.startsWith(".")) continue;
    if (readText(path.join(root, d.name, marker)) !== null) return d.name;
    let subs = [];
    try {
      subs = fs.readdirSync(path.join(root, d.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      if (s.isDirectory() && readText(path.join(root, d.name, s.name, marker)) !== null) return d.name;
    }
  }
  return fallback;
}

/**
 * 議事録と同じディレクトリにある文字起こしから正本URLを取り出す。
 *
 * **同じディレクトリしか見ない。** 上や隣のディレクトリまで探すと、別の回の会議のDocを
 * その議事録の正本として書き込むことになる。
 *
 * 兄弟が複数ある場合は**ファイル名の昇順で最初の1つ**。readdir の順序はOS依存で保証が無いので、
 * 明示的に並べ替える（実行のたびに違うURLが入ると、差分がちらついて信用を失う）。
 */
export function findSiblingSource(dir, readDir = fs.readdirSync, read = readText) {
  let names;
  try {
    names = readDir(dir).slice().sort();
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.endsWith("_minutes.md")) continue; // 議事録自身（自分の書いた行を拾い直さない）
    const body = read(path.join(dir, name));
    if (body === null) continue;
    const m = body.match(SOURCE_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * 議事録本文に正本リンクを差し込む（既にあれば置き換える）。変更が無ければ null。
 *
 * 差し込み位置は「`## 会議情報` の次に来る `##` 見出しの直前」。
 * **中身の形を問わない**のがこの規則の要点で、実データの会議情報は箇条書き（188件）と
 * Markdownの表（5件）が混在している。「箇条書きの末尾」を狙うと表形式で外れる。
 * `## 会議情報` 自体が無い議事録（1件）は H1 の直後に置く。
 */
export function insertSourceLine(text, url) {
  const line = `- ${LABEL}: ${url}`;
  if (LINE_RE.test(text)) {
    const replaced = text.replace(LINE_RE, line);
    return replaced === text ? null : replaced;
  }

  const lines = text.split("\n");
  const infoIdx = lines.findIndex((l) => /^##\s*会議情報\s*$/.test(l));

  let at;
  if (infoIdx >= 0) {
    // 会議情報の節の終わり＝次の `##` 見出し（無ければ本文の末尾）
    let end = lines.length;
    for (let i = infoIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    // 節末の空行より前に入れる。空行の後ろ（＝次の見出しの直前）に足すと、箇条書きが空行で
    // 分断されたうえ、見出しの前の空行まで失われる
    while (end > infoIdx + 1 && lines[end - 1].trim() === "") end--;
    at = end;
  } else {
    // フォールバック: H1 の直後。
    //
    // **H1 も無ければ何もしない（null）。** 先頭に差し込むと、YAML frontmatter で始まる
    // 別形式の議事録（実データに1件ある。別パイプライン由来）で `---` より前に行が入り、
    // frontmatter がファイル先頭から始まらなくなって壊れる。
    // 形が読めないものに書き込まないのは、このスクリプト全体の方針と同じ。
    const h1 = lines.findIndex((l) => /^#\s/.test(l));
    if (h1 < 0) return null;
    lines.splice(h1 + 1, 0, "");
    at = h1 + 2;
  }

  lines.splice(at, 0, line);
  return lines.join("\n");
}

function walkMinutes(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMinutes(p, out);
    else if (e.name.endsWith("_minutes.md")) out.push(p);
  }
  return out;
}

function main() {
  const meetingDir = findDirByMarker(".", "ingest-config.json", "会議");
  const minutes = walkMinutes(meetingDir);
  const changed = [];

  // **全件を見る（このrunで作られた分だけにしない）。** 文字起こしが後から追加された議事録も
  // 次の実行で繋がる（自己修復）。来歴を持つ文字起こしが無ければ何も起きないので安い。
  for (const file of minutes) {
    const url = findSiblingSource(path.dirname(file));
    if (!url) continue; // 来歴が無い＝過去分。触らない（名寄せによる誤紐付けをしない）
    const body = readText(file);
    if (body === null) continue;
    const next = insertSourceLine(body, url);
    if (next === null) continue;
    if (!DRY_RUN) fs.writeFileSync(file, next);
    changed.push(file);
  }

  for (const f of changed) console.log(f);
  console.error(
    `[link-transcript-source] 議事録 ${minutes.length}件を確認し、${changed.length}件に正本リンクを${DRY_RUN ? "差し込む予定です（dry-run）" : "差し込みました"}。`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
