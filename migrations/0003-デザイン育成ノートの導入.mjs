/**
 * デザイン画面の育成ノート（`Cortex/デザイン/`）の導入 — **廃止済み・no-op**。
 *
 * 本マイグレーションが導入した1画面育成ノート機構は migration 0006 で廃止された。
 * コピー元だった scaffold（`plugin/scaffold/repo/Cortex/デザイン/`）も削除済みのため、
 * 未適用の案件で実行されても何もしない（schema_version の通し番号だけを維持する）。
 * 導入済みの案件では 0006 がディレクトリごと削除する。
 */
export const meta = {
  to: 3,
  description: "Cortex/デザイン/ を導入（0006で廃止・no-op化済み）",
  autoApply: true,
};

export async function run() {
  // no-op（冪等）
}
