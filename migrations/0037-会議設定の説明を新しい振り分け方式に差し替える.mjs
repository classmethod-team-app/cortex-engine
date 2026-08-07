/**
 * 既存案件の `会議/ingest-config.json` の `_doc`（説明文）を、いまの振り分け方式に差し替える。
 *
 * なぜ要るか:
 *   振り分けは「会議名に `[合図]` / `【合図】` が入っているか」だけになり、顧客名と
 *   `meetingNamePatterns` による照合は廃止された。フィールド自体は全案件から削除済みだが、
 *   **`_doc` は旧文面のまま**で、こう書いてある——
 *
 *     「判定の優先順は ①案件キー → ②Cortex/Home.md の client 名 → ③この meetingNamePatterns。
 *       ①②が会議名に入らない場合のみ③に固有の会議名を足す」
 *
 *   `_doc` はこのファイルを開いた人が真っ先に読む唯一の説明で、**いま「足せば拾われる」と
 *   指示している**。そのとおり足しても何も起きず、しかも何も起きないこと自体に気づけない。
 *
 * **`_doc` だけを差し替える。** `enabled`・`transcriptDir`・`meetingKey` は案件の意思なので触らない。
 * 既に新文面（scaffold の現行版）になっている案件は何もしない。
 */
import fs from "node:fs/promises";
import path from "node:path";

export const meta = {
  to: 37,
  description: "会議/ingest-config.json の説明文を、括弧照合の方式に差し替える",
};

/** scaffold の現行 `_doc`。ここを変えたら scaffold 側と揃えること */
const DOC =
  "顧客会議の文字起こしを Cortex へ自動取り込みする際の、この案件への『ルーティング設定』。中央 Apps Script（cortex-notetaker bot 権限）は、bot に共有された文字起こしを“すべて”取り込み対象とし（取り込むか否かは bot を招待したかどうかで決まる＝フィルタは持たない）、その文字起こしを『どの案件リポへ入れるか』だけをここで判定する。判定は**会議名に [合図] または 【合図】 が入っているか**だけを見る（半角・全角どちらでも可・大小文字は問わない）。合図は既定で艦隊レジストリのキー（cortex-tools/infra/config.ts の key）。長くて会議名に打ちにくい場合だけ meetingKey に短い合図を書く（例: sushiro-googlemaps → sushiro）。**meetingKey には括弧を書かない**（会議名の側に付ける。「[kc]」のように書かれていた場合は剥がして扱い、警告を出す）。空白を含む値・64文字を超える値は使えない（艦隊キーに戻る）。**meetingKey を書いた案件は艦隊キーでは当たらない**（打つものを1つに保つため）。**既に走っている定例で、いまさら改名を頼みにくいものは aliases に会議名をそのまま並べる**（完全一致。1回登録すれば以後ずっと自動で振り分けられる。未仕分けに落ちたファイル名を写しても当たる——記号の置換と空白・大小文字の違いは吸収する）。**新しく作る会議は aliases ではなく合図を使う**（1案件1つの目印に保つため）。合図も別名も無い会議は中央 inbox（未仕分け）へ入り、データは失われない。enabled は既定で true。**取り込むか否かを決めるのは bot を会議に招待したかどうか**であって、このフラグではない（招待しなければ何も起きない）。false にするのは Google Meet 以外（Teams 等）で運用していて自動取り込みを使わない案件だけ。詳細: cortex-tools/apps-script/"

/** 旧文面の目印。どれかを含んでいれば差し替える */
const STALE = ["meetingNamePatterns", "優先順", "client 名"];

async function findConfig(root) {
  // 置き場は案件で違う（`会議/` のほか `MTG/` にリネームしている案件がある）。
  // マーカーファイル名で探すのは本体スクリプトと同じ方針。
  // **探索範囲は scripts/fleet-status.mjs の findConfigPath と揃える**（ルート・深さ1・深さ2）。
  // ここだけ浅いと、あちらが読んでいるファイルをこちらが直せない。
  const candidates = [path.join(root, "ingest-config.json")];
  for (const a of await fs.readdir(root, { withFileTypes: true })) {
    if (!a.isDirectory() || a.name.startsWith(".") || a.name === "node_modules") continue;
    candidates.push(path.join(root, a.name, "ingest-config.json"));
    for (const b of await fs.readdir(path.join(root, a.name), { withFileTypes: true }).catch(() => [])) {
      if (!b.isDirectory() || b.name.startsWith(".") || b.name === "node_modules") continue;
      candidates.push(path.join(root, a.name, b.name, "ingest-config.json"));
    }
  }
  for (const p of candidates) {
    try {
      await fs.stat(p);
      return p;
    } catch {}
  }
  return null;
}

export async function run(repoRoot) {
  const root = repoRoot;
  const p = await findConfig(root);
  if (!p) return;

  const raw = await fs.readFile(p, "utf-8");
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    // **壊れたファイルを書き換えない。** 案件が手で書いた内容を失う可能性がある
    console.log(`::warning:: ${path.relative(root, p)} が JSON として壊れているため説明文を差し替えられません`);
    return;
  }

  const doc = typeof cfg._doc === "string" ? cfg._doc : "";
  // **説明が無い案件にも書く。** 艦隊に1件、`_doc` ごと消えているものがある。
  // 旧文面より害は小さいが、このファイルを開いた人に手がかりが何も無い状態になる
  if (doc && !STALE.some((s) => doc.includes(s))) return; // 既に新文面

  // **キーの順序を保つ。** `_doc` は先頭にある想定だが、案件が足したフィールドの順も崩さない
  cfg._doc = DOC;
  await fs.writeFile(p, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  console.log(`会議設定の説明文を差し替えました: ${path.relative(root, p)}`);
}
