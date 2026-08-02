/**
 * Slackチャンネルの Gold昇格（顧客も見る Decision・用語集への蒸留）を opt-out から opt-in へ変える。
 * それに伴い、各案件の `チャット/channels.json` に `gold` を**明示的に書き込む**。
 *
 * 背景（実際に起きた事故）:
 * `channels.json` は3つの目的で共用されている——(1) `/read-chat` のライブ参照先、(2) 通知先（`notify`）、
 * (3) Gold昇格の対象。そして (3) は既定が「対象にする」（`gold: false` を書いたときだけ外れる）だった。
 * つまり **(1) や (2) のつもりでチャンネルを1行足した人が、無言で顧客可視のGold昇格対象を増やせた**。
 *
 * 結果、説明に「本案件の社内チャンネル」と明記されたチャンネルが顧客可視のGoldへ昇格していた。
 *
 * 書き込む値の決め方:
 *   - `gold` キーが既にある → 一切触らない（人間の判断を尊重・冪等。真偽値でない誤記も残す＝警告が鳴り続ける）
 *   - `Cortex/external-sources.json` に明示登録がある → `true`
 *   - それ以外 → **何も書かない**
 *
 * **未宣言のものに `false` を書き込まない。** ここは一度そうしかけて、やめた:
 *   - 「今の挙動をそのまま保存する」＝全部 `true` は、事故をそのまま固定するので採れない
 *     （既定 true は「誰も判断していない」状態であって「昇格してよい」と判断された状態ではない）
 *   - かといって `false` を書き切ると、resolver の「gold の宣言がありません」警告が消え、
 *     **止まったことが二度と誰にも届かなくなる**。実データで確認したところ、説明に顧客との
 *     やり取りの場と明記されたチャンネルや、顧客側ワークスペースのチャンネルが、
 *     この方式では黙って止まる状態になっていた
 *   - `external-sources.json` を持つ案件は少数なので、「明示登録＝意図の証拠」は多くの案件で
 *     機能しない。証拠が無いものを機械的に確定させてはいけない
 *
 * よって未宣言は**未宣言のまま残す**。resolver が毎晩チャンネル名を挙げて警告し続けるので、
 * 人間が「これは顧客共有だから true」「これは社内だから false」と判断できる。
 * 判断されるまでの間は対象外（安全側）で、実害は「昇格が止まっていること」だけ。
 *
 * autoApply: true（機械的・冪等・非破壊）:
 * **止めて人間に書かせる方式は採れない。** 理由は2つ、いずれも実物で確認済み——
 *   (1) `engine-migrate.mjs` は `autoApply: false` のとき `run()` を呼ばずに break するため、
 *       ここに書いたメッセージは一切表示されない（出るのは meta.description の1行だけ）。
 *   (2) `schema_version` のゲートは update-gold / ingest-minutes / update-design-notes /
 *       run-harness-skill の4つに配線済みで、停止中は**議事録の自動生成やPMハーネスの日報まで止まる**。
 * よって機械的に書ける分だけ書き、残りは resolver の警告で人間に判断を促す。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 30,
  description:
    "Slackチャンネルのgold昇格をopt-in化し、明示登録済みのチャンネルに gold: true を書き込む",
  autoApply: true,
};

const CHANNELS = "チャット/channels.json";
const EXTERNAL = "Cortex/external-sources.json";

/** url から Slack チャンネルIDを取り出す。resolver と同じ判定にする */
function refOf(url) {
  const m = String(url || "").match(/\/archives\/([A-Z0-9]+)/);
  return m ? m[1] : null;
}

export async function run(repoRoot) {
  // **まず tools ゲートを見る。** resolver は Home.md の `tools.チャット` が slack のときだけ
  // Slack を導出する。ここを見ないと、Teams の案件やチャット未使用の案件の channels.json まで
  // 書き換えてしまう（チャットに Teams を使う案件・チャットを使わない案件が実際にある）。
  const home = await fs
    .readFile(path.join(repoRoot, "Cortex/Home.md"), "utf8")
    .catch(() => "");
  if ((home.match(/^\s*チャット:\s*([^\s#]+)/m) || [])[1] !== "slack") return;

  const p = path.join(repoRoot, CHANNELS);
  const raw = await fs.readFile(p, "utf8").catch(() => null);
  if (raw === null) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 壊れたJSONを書き換えると復旧が難しくなる。触らずに次へ進める（resolver 側も無視する）
    return;
  }
  // 想定外の形（null・配列でない）で例外を投げない。ここで throw すると engine-migrate が
  // 赤で終わり schema_version が進まず、議事録生成やPMハーネスの日報まで止まる
  if (!data || typeof data !== "object" || !Array.isArray(data.channels)) return;

  // external-sources.json の明示登録＝「Goldに上げてよい」という人間の判断
  const explicit = new Set();
  const extRaw = await fs.readFile(path.join(repoRoot, EXTERNAL), "utf8").catch(() => null);
  if (extRaw !== null) {
    try {
      for (const s of JSON.parse(extRaw).sources || []) {
        if (s && s.type === "slack" && s.channel) explicit.add(String(s.channel));
      }
    } catch {
      // 読めなければ明示登録なしとして扱う（安全側）
    }
  }

  let changed = false;
  for (const c of data.channels) {
    if (!c || typeof c !== "object") continue;
    if ((c.platform || "slack").toLowerCase() !== "slack") continue;
    // **`"gold" in c` で見る（`typeof === "boolean"` ではない）。**
    // `"gold": "true"`（真偽値のつもりの誤記）を false に書き換えてしまうと、
    // resolver の「真偽値ではありません」警告まで消えて誤記が埋もれる。書かれているものには触らない。
    if ("gold" in c) continue;
    const ref = refOf(c.url);
    // 実在しないエントリ（空行・プレースホルダ）には書かない。resolver も同じ条件でスキップする
    if (!ref || String(c.url).includes("CHANNEL_ID")) continue;
    // 明示登録があるものだけ true にする。無いものは**未宣言のまま残す**（警告で催促させる）
    if (!explicit.has(ref)) continue;
    c.gold = true;
    changed = true;
  }

  if (!changed) return;
  await fs.writeFile(p, `${JSON.stringify(data, null, 2)}\n`);
}
