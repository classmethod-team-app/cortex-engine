/**
 * レポートディレクトリ（`Cortex/レポート/`）を「生成終了・凍結」と注記する。
 *
 * 設計判断: 日次/週次レポートは「コンテキストレイヤーの消費」であってGold層への蓄積ではないため、
 * PMハーネスが Slack 配信に一本化した（エンジンの精製ワークフローはレポートを生成しない）。
 * 既存の report レコードは凍結された歴史として読み取り専用で残す（validator も引き続き受理する）。
 *
 * 本migrationは `Cortex/レポート/README.md` の先頭に凍結注記を1度だけ追記する**だけ**。
 * `レポート/` の物理削除はしない（削除は autoApply:false が必要になり全艦隊が赤で止まる。凍結で実害なし。
 * 物理削除をやるなら後日、手動適用の別migrationで）。
 *
 * autoApply: true（追記のみ・非破壊）。
 * 冪等（2回実行しても壊れない）: 注記マーカーが既にあれば何もしない。READMEが無ければ何もしない。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 12,
  description:
    "レポートディレクトリ（Cortex/レポート/）に生成終了・凍結の注記を追記（PMハーネスがSlack配信に一本化）",
  autoApply: true,
};

// 冪等判定のマーカー（この文字列がREADMEにあれば適用済みとみなす）
const MARKER = "生成終了・凍結";
const NOTE = `> **⚠️ ${MARKER}**: 日次/週次レポートの生成は終了しました。レポートは「コンテキストレイヤーの消費」であってGold層への蓄積ではないため、PMハーネスが Slack 配信に一本化しています。ここにある既存レコードは履歴として凍結され、読み取り専用で残ります（\`Cortex/レポート/\` の物理削除はしません）。

`;

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function run(repoRoot) {
  const readme = path.join(repoRoot, "Cortex", "レポート", "README.md");
  if (!(await exists(readme))) return; // レポート/README.md が無ければ何もしない（冪等）

  const text = await fs.readFile(readme, "utf8");
  if (text.includes(MARKER)) return; // 既に注記済み（冪等）

  await fs.writeFile(readme, NOTE + text);
}
