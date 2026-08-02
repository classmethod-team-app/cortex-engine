/**
 * 同期系スタブ（sync-designs / sync-backlog）に `AWS_ROLE_TO_ASSUME` の受け渡しを追加する。
 *
 * 背景:
 * トークン（Figma・Backlog APIキー）を設定UIから投入できるようにするため、置き場所を
 * GitHub Actions の repo secret から Secrets Manager へ寄せた。エンジン側のワークフローは
 * 実行時に Secrets Manager を見て、無ければ従来の repo secret にフォールバックする。
 *
 * **その取得には OIDC でロールを引く必要があり、ロールARNはスタブが渡す。**
 * スタブが渡していないと、エンジン側は AWS 認証が無い状態になり、常にフォールバック
 * （＝従来の repo secret）で動く。壊れはしないが、**設定UIから投入した値が一切効かない**。
 *
 * autoApply: true（追記のみ・冪等・非破壊）:
 * 既存行の直後に1行足すだけで、既存の値を書き換えない。既に宣言がある案件は何もしない。
 * 挿入位置が見つからない案件（独自に書き換えている等）は**何もしない**（勝手に足さない）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 31,
  description:
    "同期スタブ（sync-designs / sync-backlog）に AWS_ROLE_TO_ASSUME の受け渡しを追加",
  autoApply: true,
};

/** ワークフローごとの「この行の直後に足す」目印 */
const TARGETS = [
  { file: ".github/workflows/sync-designs.yml", after: "FIGMA_TOKEN" },
  { file: ".github/workflows/sync-backlog.yml", after: "BACKLOG_PROJECT_KEY" },
];

const LINE =
  "      # Secrets Manager からトークンを取得するために使う（未設定なら従来の repo secret を使う）\n" +
  "      AWS_ROLE_TO_ASSUME: ${{ secrets.AWS_ROLE_TO_ASSUME }}\n";

export async function run(repoRoot) {
  for (const t of TARGETS) {
    const p = path.join(repoRoot, t.file);
    const text = await fs.readFile(p, "utf8").catch(() => null);
    if (text === null) continue; // そのワークフローを使っていない案件
    if (text.includes("AWS_ROLE_TO_ASSUME")) continue; // 冪等

    // `      FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}` の行を探して直後に足す。
    // 見つからない案件（独自に書き換えている等）には触らない。
    const re = new RegExp(`( *${t.after}: \\$\\{\\{ secrets\\.${t.after} \\}\\}\\n)`);
    if (!re.test(text)) continue;
    await fs.writeFile(p, text.replace(re, `$1${LINE}`));
  }
}
