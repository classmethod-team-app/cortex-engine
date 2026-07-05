/**
 * schema_version フィールドを Cortex/Home.md の識別カードに導入する。
 * ランナー（engine-migrate.mjs）が適用後に schema_version: 1 を書き込むため、
 * 本体は何もしない（フィールドの書き込みはランナーの writeSchemaVersion が行う）。
 */
export const meta = {
  to: 1,
  description: "engine.schema_version を Home.md 識別カードに導入",
  autoApply: true,
};

export async function run() {
  // no-op: schema_version の書き込みはランナーが行う
}
