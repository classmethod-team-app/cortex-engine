/**
 * スキル棚卸し（改名・削除・統合）に伴い、案件リポの scaffold 由来ドキュメントに残る
 * 旧スキル名・旧導線を新名称・新導線にテキスト置換する。
 *
 * 背景: エンジン側でスキルを改名（update-decision-log → update-decision）・統合
 * （git-save/git-pull/git-fix-push → git-sync）・削除（post-meeting / onboard-member /
 * setup-status / customize-tooling / clone-dev-repos 等）したが、案件リポに散在する
 * ドキュメント（README.md・USAGE.md・会議/README.md 等の scaffold 由来の文言）は
 * 自動では変わらない。その結合点をこのマイグレーションが解く。
 *
 * 安全ガード（保守的な作り）:
 * - **対象は scaffold 由来のドキュメントファイルの固定 allowlist のみ**。Gold 層のレコード
 *   （Cortex 配下の records ディレクトリ）・生データ（会議の文字起こし・課題ミラー等）には一切触れない。
 * - **旧文言が完全一致した場合のみ**置換する（案件側でカスタマイズ済みの文言は一致せず、そのまま残る）。
 * - **冪等**: 置換後は旧文言が消えるので、2回実行しても追加変更は起きない。バッククォート付きの
 *   トークンで一致させ、部分マッチによる二次破壊を避ける。
 *
 * 冪等（テキスト置換のみ・非破壊・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 13,
  description:
    "スキルの改名・削除・統合に伴い案件ドキュメントの旧スキル名・旧導線を新名称・新導線に差し替え",
};

// 対象ファイル（scaffold 由来のドキュメントのみ。存在しないものはスキップ）。
// 日本語ディレクトリを改名した案件では 会議/開発 は一致しないが、その場合はもともと
// カスタマイズ済みとみなし触れない（保守的）。README/USAGE/Cortex 配下は固定パス。
const TARGET_FILES = [
  "README.md",
  "USAGE.md",
  "会議/README.md",
  "開発/README.md",
  "Cortex/README.md",
  "Cortex/Home.md",
  "Cortex/Decisions/README.md",
  "Cortex/Glossary/README.md",
];

// [旧文言, 新文言] の順に適用する（完全一致した箇所のみ全件置換）。
// 複数トークンを含む語句を先に置き、その後に単独トークンを置く（二重置換を避ける順序）。
const REPLACEMENTS = [
  // 非エンジニア向け git 3スキルの統合（旧 USAGE の1セル分をまとめて差し替え）
  [
    "`/git-save`（保存）・`/git-pull`（最新化）・`/git-fix-push`（push 失敗時の復旧）",
    "`/git-sync`（保存・最新化・push 失敗時の復旧を一気通貫）",
  ],
  // 決定記録スキルの改名
  ["`/update-decision-log`", "`/update-decision`"],
  ["update-decision-log系", "update-decision系"],
  // git 3スキル → git-sync（上のまとめ置換で拾えなかった単独トークン）
  ["`/git-save`", "`/git-sync`"],
  ["`/git-pull`", "`/git-sync`"],
  ["`/git-fix-push`", "`/git-sync`"],
  // 開発リポの submodule 取り込み（clone-dev-repos は setup-project に吸収）
  ["`/clone-dev-repos`", "`git submodule update --init`"],
  // 議事録生成（post-meeting は削除。手動導線は create-minute とビューアの投入フォーム）
  ["`/post-meeting`", "`/create-minute`"],
  // 新メンバーのオンボーディング（onboard-member は削除。プラグイン導入案内＋ビューアのチュートリアル）
  ["`/onboard-member`", "cortex プラグインの導入案内（リポジトリのトラスト時に自動表示）"],
  // 既定外ツールの差し替え（customize-tooling は削除。考え方は docs に集約）
  ["`/customize-tooling`", "cortex-engine の `docs/customize-tooling.md`"],
  ["（customize-tooling 参照）", "（別ツールへの差し替えには設計が必要）"],
  // セットアップ進捗確認（setup-status は削除。自動版の fleet-status に一本化）
  ["`/setup-status`", "`fleet-status`（`gh workflow run fleet-status.yml`）"],
  // 用語の夜間自動追記（update-glossary-auto は update-gold-auto に統合）
  ["update-glossary-auto", "update-gold（用語フェーズ）"],
];

async function readFileOrNull(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

export async function run(repoRoot) {
  for (const rel of TARGET_FILES) {
    const abs = path.join(repoRoot, rel);
    const original = await readFileOrNull(abs);
    if (original == null) continue; // ファイルが無ければスキップ（冪等）

    let text = original;
    for (const [oldStr, newStr] of REPLACEMENTS) {
      if (text.includes(oldStr)) {
        text = text.split(oldStr).join(newStr);
      }
    }
    if (text !== original) {
      await fs.writeFile(abs, text);
    }
  }
}
