/**
 * 案件リポのドキュメントに残る「実在しないものへの参照」を訂正する。
 *
 * 背景: 参照lint（validate-cortex）が、案件リポの README / USAGE / CLAUDE.md / Cortex/README.md に
 * 削除・改名済みのスキル名（`/fetch-transcript`・`/post-meeting`・`/update-decision-log`・
 * `/rulesync-generate`）、廃止済みの `.rulesync/`、撤去・改名済みの Gold 区画（`Cortex/用語集/`・
 * `Cortex/レポート/`）への参照が残っていることを検出した。scaffold 側は既に正しく、案件リポに配られた
 * コピーだけが古い（0021 のテキスト置換で拾いきれなかった残り）。
 *
 * 陳腐化した参照は、AI に「実在しないスキルを呼べ」「無いディレクトリを読め」と指示するのと同じで、
 * 案件把握の初動を狂わせる。とくに CLAUDE.md の探索戦略は AI が最初に読む記述なので影響が大きい。
 *
 * 安全ガード（0013・0021 と同じ保守則）:
 * - 対象は scaffold 由来のドキュメントの固定 allowlist のみ。Gold 層のレコード・生データには触れない。
 * - **旧文言が完全一致した場合のみ**置換する（案件側で書き換えている文言はそのまま残す）。
 * - 置換後は旧文言が消えるので冪等。
 *
 * autoApply: true（テキスト置換のみ・非破壊・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 24,
  description:
    "案件ドキュメントに残る実在しないスキル名・廃止記法・撤去済みGold区画への参照を訂正（参照lintの検出分）",
  autoApply: true,
};

const TARGET_FILES = ["README.md", "USAGE.md", "CLAUDE.md", path.join("Cortex", "README.md")];

// [旧文言, 新文言]。長い語句を先に置き、部分一致による二重置換を避ける。
const REPLACEMENTS = [
  // CLAUDE.md: 探索戦略の第一段（Gold区画が英語化され、レポートは撤去済み）
  [
    "1. **第一段: `Cortex/`（Gold層）を読む** — `Cortex/Home.md`（全体像）→ `Cortex/用語集/`（語彙）→ `Cortex/Decisions/`（確定事項）→ `Cortex/レポート/`（直近の動き）",
    "1. **第一段: `Cortex/`（Gold層）を読む** — `Cortex/Home.md`（全体像）→ `Cortex/Glossary/`（語彙）→ `Cortex/Decisions/`（確定事項）→ `Cortex/Rules/`（守るべき制約）。台帳的レコード（`Cortex/Members/`）はこの走査に含めず、人物を特定したいときに該当レコードだけ引く",
  ],
  // README.md: コマンド一覧と流れ（fetch-transcript は廃止・post-meeting は削除・update-decision-log は改名）
  [
    "| `/fetch-transcript` | 会議の文字起こしを取得 |\n",
    "",
  ],
  [
    "1. 会議の文字起こし → /fetch-transcript → /create-minute（/post-meeting で一括実行）",
    "1. 会議の文字起こし → 自動取り込み → /create-minute（文字起こしは cortex-notetaker が自動で入る）",
  ],
  [
    "3. 議事録 + 課題     → /update-decision-log → Cortex/Decisions/ に記録",
    "3. 議事録 + 課題     → /update-decision → Cortex/Decisions/ に記録",
  ],
  // USAGE.md: 廃止スキルの行と rulesync の記述
  [
    "| 文字起こしだけ取得したい | `/fetch-transcript` |\n",
    "",
  ],
  [
    "- **生成物を直接編集しない**: AI ツール設定の正本は `.rulesync/`。`CLAUDE.md`・`.claude/`・`.cursor/` は生成物なので直さない（`.rulesync/` を直して `/rulesync-generate`）",
    "- **エンジンが配る生成物を直接編集しない**: `Cortex/` 配下の README・template や `.claude/` の設定は cortex-engine が配布・更新する。改善はエンジン側に提案する（`/submit-feedback`）",
  ],
  // Cortex/README.md: オントロジー規約の置き場（rulesync 廃止でエンジンの docs へ移動）
  [
    "オントロジー規約（`.rulesync/rules/ontology.md`）",
    "オントロジー規約（cortex-engine の `docs/ontology.md`）",
  ],
];

export async function run(repoRoot) {
  for (const name of TARGET_FILES) {
    const p = path.join(repoRoot, name);
    let text;
    try {
      text = await fs.readFile(p, "utf8");
    } catch {
      continue; // 無ければ何もしない
    }
    let next = text;
    for (const [from, to] of REPLACEMENTS) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    if (next !== text) await fs.writeFile(p, next);
  }
}
