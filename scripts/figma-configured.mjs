#!/usr/bin/env node
/**
 * `figma.json` が**実際に使える状態か**を判定する。
 *
 * なぜ1箇所に集約するか:
 *   同じ宣言を2つのスクリプトが別々に解釈すると、片方だけ直したときに静かにずれる
 *   （`Cortex/Home.md` の `tools:` で実際にそうなった）。ここを唯一の判定にして、
 *   `sync-designs`（同期するか）と `fleet-status`（デザイン連携を使っているか）の両方から呼ぶ。
 *
 * なぜ「"key" という文字列があるか」では足りないか:
 *   scaffold が配る figma.json は
 *     "key": "{FigmaのURL figma.com/design/この部分/... をここに}"
 *   というプレースホルダを持つ。文字列の有無だけを見ると**未設定の案件が「設定済み」になる**。
 *   これまでは FIGMA_TOKEN が空で手前で止まっていたので表面化しなかったが、
 *   設定UIからトークンを入れられるようになると、未設定の案件で無駄な同期が走る。
 *
 * Figma のファイルキーは英数（と稀に `_` `-`）のみ。プレースホルダは波括弧・空白・日本語を含む。
 */
import { readFileSync } from "node:fs";

/** 実在しそうなFigmaファイルキーが1つ以上あるか */
export function hasRealFigmaKey(text) {
  if (typeof text !== "string" || !text) return false;
  return /"key"\s*:\s*"[A-Za-z0-9_-]{8,}"/.test(text);
}

// スクリプトとして呼ばれたとき: 使える状態なら 0、そうでなければ 1
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const path = process.argv[2];
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    process.exit(1);
  }
  process.exit(hasRealFigmaKey(text) ? 0 : 1);
}
