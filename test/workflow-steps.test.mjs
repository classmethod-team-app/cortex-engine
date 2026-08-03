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

/** `- name:` 単位でステップに切り出す（YAMLパーサを持ち込まずに済ませる） */
function steps(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(\s*)- name:\s*(.*)$/);
    if (m && m[1].length >= 6) {
      if (cur) out.push(cur);
      cur = { name: m[2].trim(), indent: m[1].length, body: [line] };
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

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml"));

test("ステップが自分自身の出力を条件にしていない（常にskipされる）", () => {
  for (const f of files) {
    for (const s of steps(readFileSync(path.join(DIR, f), "utf8"))) {
      if (!s.id) continue;
      const cond = (s.text.match(/^\s+if:\s*(.*)$/m) || [])[1] || "";
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
