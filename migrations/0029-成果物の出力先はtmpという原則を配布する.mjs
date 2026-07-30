/**
 * 「AIが生成したファイルは原則 `tmp/` に出力する」という規律を、案件リポの CLAUDE.md に配布する。
 *
 * 背景: Bronze/Silver のディレクトリ（`課題管理/`・`共有資料/`・`デザイン/`・`開発/`）は、リモートの正本
 * （Backlog・Google Drive・Figma・GitHub）から同期ミラーで降ってくるための箱であって、AIや人が直接ファイルを
 * 置く場所ではない。にもかかわらず CLAUDE.md に出力先の規律が無く、AIが作業物をここへ置きうる状態だった。
 *
 * ここに書くと、(1) 次の同期で上書き・消失する (2) Gold昇格の抽出源に入りAIが自分の出力を事実として読み直す
 * (3) 他メンバーのクローンに降りてレビューされないまま残る、という3つの事故が起きる。
 *
 * `tmp/` は gitignore 済みなので、コミットされず・他メンバーに影響せず・Gold昇格の抽出源にも入らない。
 * 例外は「Gold層（`Cortex/`）」「議事録（`会議/**_minutes.md`。安定ID `minute:` を成立させるため配置が規約で
 * 決まっており、正本がこのリポジトリにしか無い）」「設定ファイル」の3つだけ。
 *
 * 安全ガード（0013・0021・0024 と同じ保守則）:
 * - 対象は CLAUDE.md のみ。挿入位置は `## 視覚成果物のデザイン` の直前（scaffold と同じ並び）。
 * - 見出しが見つからない案件（独自に書き換えている等）は**何もしない**（勝手に末尾へ足さない）。
 * - 既に同じ節がある場合は何もしない（冪等）。
 *
 * autoApply: true（テキスト挿入のみ・非破壊・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 29,
  description:
    "AIの成果物はtmp/へ出力しBronze/Silverのミラーに書かない規律をCLAUDE.mdへ配布",
  autoApply: true,
};

const ANCHOR = "## 視覚成果物のデザイン";

const SECTION = `## 成果物の出力先は \`tmp/\`（AIが守る規律）

**AIが生成したファイルは、原則として \`tmp/\` 配下に出力する。** \`tmp/\` は gitignore 済みなので、コミットされず・他のメンバーに影響せず・Gold昇格の抽出源にも入らない。

対象は「AIとのやり取りの中で生まれる作業物」全般。たとえば定例のアジェンダ・課題への返信文・スケジュール表・調査メモ・比較検討・レポート・HTML成果物など、**ハーネスのスキルが出す中間成果物はすべて \`tmp/\`**。

**\`tmp/\` 以外に書いてよいのは、次の3つだけ。**

| 書いてよい先 | 何を | 誰が |
| --- | --- | --- |
| \`Cortex/\` 配下（Gold層） | Decisions・Glossary・Members・Rules・Home | 精製スキル／夜間ワークフロー |
| \`会議/\` の議事録（\`*_minutes.md\`） | 文字起こしから生成した議事録 | \`/create-minute\`（安定ID \`minute:{定例名}:{日付}\` を成立させるため配置が規約で決まっている） |
| 設定ファイル | \`チャット/channels.json\`・\`会議/ingest-config.json\`・\`Cortex/external-sources.json\` 等 | セットアップ・カスタマイズ時 |

議事録が例外なのは、**それ自体がGold昇格の原料（Silver）** であり、正本がこのリポジトリにしか無いため。逆に言えば、**正本が外部にあるもの（課題・資料・デザイン・コード）は書かない**。

### Bronze / Silver のディレクトリに書き込まない

\`課題管理/\`・\`共有資料/\`・\`デザイン/\`・\`開発/\`（および \`会議/\` の議事録以外）は、**リモートの正本（Backlog・Google Drive・Figma・GitHub）から同期ミラーで降ってくるための箱**であって、AIや人が直接ファイルを置く場所ではない。ここに書くと:

- 次の同期で**上書き・消失する**（正本ではないため）
- Gold昇格の抽出源に入り、**AIが自分の出力を事実として読み直す**（自己参照）
- 他のメンバーのクローンに降りていき、レビューされないまま残る

**内容を正本に残したいときは、ファイルを置くのではなく正本側へ書く**（Backlogなら \`/backlog-push\`、資料ならビューアの投入フォーム等）。同期でミラーに降りてくるのが正しい経路。

`;

export async function run(repoRoot) {
  const p = path.join(repoRoot, "CLAUDE.md");
  let text;
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    return; // CLAUDE.md が無い案件には配らない
  }

  if (text.includes("## 成果物の出力先は")) return; // 冪等
  const i = text.indexOf(ANCHOR);
  if (i < 0) return; // 見出しが無い（独自構成）案件には触らない

  await fs.writeFile(p, text.slice(0, i) + SECTION + text.slice(i));
}
