#!/usr/bin/env node
/**
 * Backlogドキュメントの取りこぼしを検出し、取り直す。
 *
 * ## なぜ要るか（実際に起きたこと）
 *
 * 同期に使っている backlog-exporter は、**ドキュメントの取得元をツリーAPI
 * （`/documents/tree`）だけに置いている**。ところが Backlog は、新規作成した
 * ドキュメントを画面と一覧API（`/documents`）には即座に出すのに、**ツリーAPIには
 * 1時間40分ものあいだ出さなかった**（実測。別のドキュメントを作った拍子にまとめて現れた）。
 *
 * これだけなら「遅れて入る」で済む。恒久的な欠落に変えているのは差分カーソルのほうで、
 * exporter は取得できたかどうかに関わらず **`lastUpdated` に「同期を実行した時刻」を
 * 書き込む**。結果:
 *
 *   9:32  ドキュメント作成（ツリーに出ない）
 *   〜11:16 同期が6回走る。存在に気づかないまま、カーソルだけが前進
 *   11:15 ツリーにやっと出る
 *   11:16 同期。ドキュメントの更新日時(10:54) < カーソル(11:16) → **「もう見た」と判定してスキップ**
 *
 * 以後どれだけ同期しても入らない。しかも同期は成功（緑）のまま終わるので、
 * **人が指摘するまで誰も気づけない**。実際、顧客側のメンバーの指摘で発覚した。
 *
 * 引き金は Backlog 側の不整合だが、同じことは1件の通信エラー・403でも起きる
 * （exporter は1件ごとの失敗を握りつぶして先へ進む）。つまり引き金は何でもよかった。
 *
 * ## ここで何をするか
 *
 * 一覧API（全件・本文つき・**ツリーに依存しない**）を正として、手元のミラーと突き合わせる。
 * 欠けていれば `--documentId` で狙い撃ちして取り直す（このオプションはカーソルを無視する）。
 *
 * **取り直しもツリーを歩く**ので、ツリーにまだ出ていないものは回収できない。
 * それは「遅れているだけ」なので警告に留め、**古いのに欠けているものだけを失敗**にする
 * （新しい欠けで毎回赤くすると、赤が読まれなくなる）。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** ミラーのMarkdownに埋まっている Backlog ドキュメントID（本文先頭のリンク） */
const DOC_LINK = /\/document\/[^/\s)]+\/([0-9a-z]{20,})/i;

/** 取り直しても入らない状態が続いたら失敗にする閾値（時間）。それ未満は「反映待ち」とみなす */
export const STALE_HOURS = 24;

/**
 * ミラー配下の .md から、取り込み済みドキュメントIDを集める。
 *
 * **ファイル名では突き合わせない。** タイトルの空白は `_` に、記号は別の文字に置換されるうえ、
 * 親ドキュメントは `00_index.md` になる。IDだけが安定して比較できる。
 */
export function collectLocalDocumentIds(dir, { readdir = readdirSync, read = readFileSync } = {}) {
  const ids = new Set();
  const walk = (d) => {
    let entries;
    try {
      entries = readdir(d, { withFileTypes: true });
    } catch {
      return; // ディレクトリが無い・読めない → 空として扱う（ここで落とさない）
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) {
        const m = DOC_LINK.exec(String(read(p, "utf8")));
        if (m) ids.add(m[1].toLowerCase());
      }
    }
  };
  walk(dir);
  return ids;
}

/**
 * そもそもミラーにファイルが出来ないドキュメントか。
 *
 * **ここを外すと警告が誤報だらけになり、読まれなくなる。** 実データ（カナリア）で当てたら
 * 8件の誤検知が出て、内訳は次の2種類だけだった:
 *
 * - **ゴミ箱** … 一覧APIは削除済みも返す。ミラーからは prune が消すので、無いのが正しい
 * - **本文が空の親ドキュメント** … 子を持つドキュメントはフォルダ内の `00_index.md` として
 *   保存されるが、exporter は**本文が空なら作らない**（`planDocumentSave` の `skip-empty-parent`）。
 *   フォルダの見出しとして使われている親は、たいてい本文が空。
 *
 * ツリーAPIは**除外の材料にしか使わない**（ゴミ箱・子の有無）ので、ツリーが古くても
 * 取りこぼしが隠れる方向には効かない。ツリーに載っていないものは「子を持たない」と
 * みなされ、検出側に倒れる。
 */
export function expectsLocalFile(doc, { trashIds = new Set(), parentIds = new Set() } = {}) {
  if (!doc || !doc.id) return false;
  const id = String(doc.id).toLowerCase();
  if (trashIds.has(id)) return false;
  // **子の有無はツリーから見る。** 一覧APIの childDocumentIds は、子を持つドキュメントでも
  // 常に空で返ってくる（詳細APIとは違う。実データで確認）。ここを一覧API側で判定すると
  // 親ドキュメントが全部「欠けている」に化ける。
  const blank = !String(doc.plain ?? "").trim();
  return !(parentIds.has(id) && blank);
}

/** ツリーで子を持っているID（＝ミラーではフォルダになるもの）を集める */
export function collectParentIds(tree) {
  const ids = new Set();
  const walk = (n) => {
    const kids = (n && n.children) || [];
    if (kids.length && n.id) ids.add(String(n.id).toLowerCase());
    for (const c of kids) walk(c);
  };
  for (const c of (tree && tree.activeTree && tree.activeTree.children) || []) walk(c);
  return ids;
}

/**
 * 一覧API の全件と手元を突き合わせ、欠けているものを返す。
 *
 * @param remote 一覧APIの返り値（[{id, title, updated, created, plain, childDocumentIds}]）
 * @param localIds 取り込み済みID
 * @param opts ツリーAPI由来の除外材料（ゴミ箱・子を持つID）
 */
export function findMissing(remote, localIds, opts = {}) {
  return (remote || [])
    .filter((d) => expectsLocalFile(d, opts) && !localIds.has(String(d.id).toLowerCase()))
    .map((d) => ({ id: String(d.id), title: String(d.title ?? ""), updated: d.updated, created: d.created }));
}

/** ツリーAPIのゴミ箱にあるIDを集める（除外にのみ使う） */
export function collectTrashIds(tree) {
  const ids = new Set();
  const walk = (n) => {
    if (n && n.id) ids.add(String(n.id).toLowerCase());
    for (const c of (n && n.children) || []) walk(c);
  };
  for (const c of (tree && tree.trashTree && tree.trashTree.children) || []) walk(c);
  return ids;
}

/**
 * 回収できなかった欠けを、どう扱うか決める。
 *
 * - `waiting` … 作成が新しい。ツリーAPIへの反映待ちの可能性が高い → 警告だけ
 * - `stale`   … 反映待ちでは説明がつかない → 失敗にして人を呼ぶ
 *
 * **新しい欠けで毎回失敗させない。** ドキュメントを作った直後は必ずこの状態を通るため、
 * 赤が常態化して読まれなくなる（それが今回いちばん避けたい失敗の仕方）。
 */
export function classifyMissing(missing, nowMs, staleHours = STALE_HOURS) {
  const waiting = [];
  const stale = [];
  for (const m of missing) {
    const t = Date.parse(m.created ?? m.updated ?? "");
    // 日付が読めないものは stale 側に倒す（判断できないものを黙って見逃さない）
    const ageH = Number.isNaN(t) ? Infinity : (nowMs - t) / 3_600_000;
    (ageH >= staleHours ? stale : waiting).push({ ...m, ageHours: Number.isFinite(ageH) ? Math.round(ageH) : null });
  }
  return { waiting, stale };
}

/** 突き合わせの結果を1行で読める形にする（GitHub Actions の注記・ログの両方で使う） */
export function formatMissing(list) {
  return list
    .map((m) => `「${m.title || m.id}」(${m.id}${m.ageHours == null ? "" : ` / ${m.ageHours}時間前に作成`})`)
    .join(", ");
}

// ---------- ここから I/O ----------

/** documents のミラーを置いているディレクトリを探す（案件で置き場が違うので固定しない） */
export function findDocumentsDir(root = ".", { readdir = readdirSync, read = readFileSync } = {}) {
  const found = [];
  const walk = (d, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // .cortex-engine はワークフローが同じ場所に展開するエンジン本体。案件のミラーではない
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".cortex-engine") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "backlog-settings.json") {
        try {
          if (JSON.parse(String(read(p, "utf8"))).folderType === "document") found.push(d);
        } catch {
          // 壊れた設定ファイルは候補にしない
        }
      }
    }
  };
  walk(root, 0);
  // 読み手・書き手と同じ「浅い方を選ぶ」（複数ある案件が実在する）
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
  return found[0] ?? null;
}

async function backlogJson(domain, apiKey, endpoint, params = {}) {
  const url = new URL(`https://${domain}/api/v2${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, String(v));
  url.searchParams.set("apiKey", apiKey);
  // 一時的な不調でその回の突き合わせを丸ごと落とさない（落ちると、その回は検知が無いのと同じ）。
  // 同期本体も同じ理由で3回リトライしている。
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${endpoint} が ${res.status} を返しました`);
      return await res.json();
    } catch (err) {
      last = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  throw last;
}

/** 一覧APIで全件を取る（100件ずつページング） */
async function fetchAllDocuments(domain, apiKey, projectId) {
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await backlogJson(domain, apiKey, "/documents", {
      "projectId[]": projectId,
      count: 100,
      offset,
    });
    if (!Array.isArray(page)) throw new Error("/documents の返り値が配列ではありません");
    all.push(...page);
    if (page.length < 100) return all;
  }
}

function note(level, message) {
  // GitHub Actions の注記。ローカル実行でもそのまま読める
  console.log(`::${level}::${message}`);
}

async function main() {
  const domain = process.env.BACKLOG_DOMAIN;
  const projectKey = process.env.BACKLOG_PROJECT_KEY;
  const apiKey = process.env.BACKLOG_API_KEY;
  // 前提が無い案件（Backlogを使っていない・キー未設定）は黙って正常終了する。
  // ここで落とすと、関係ない案件の同期まで赤くなる。
  if (!domain || !projectKey || !apiKey) return 0;

  const dir = findDocumentsDir(".");
  if (!dir) return 0; // ドキュメントを同期していない案件

  const project = await backlogJson(domain, apiKey, `/projects/${encodeURIComponent(projectKey)}`);
  const remote = await fetchAllDocuments(domain, apiKey, project.id);
  // ゴミ箱の除外にだけツリーを使う。取得漏れの検出は一覧APIが正なので、
  // ツリーが古くても「取りこぼしを隠す」方向には効かない。
  const tree = await backlogJson(domain, apiKey, "/documents/tree", { projectIdOrKey: projectKey });
  const exclude = { trashIds: collectTrashIds(tree), parentIds: collectParentIds(tree) };

  let missing = findMissing(remote, collectLocalDocumentIds(dir), exclude);
  if (!missing.length) {
    console.log(`ドキュメントの取りこぼしはありません（Backlog ${remote.length}件）`);
    return 0;
  }

  note("warning", `Backlogに在るのにミラーに無いドキュメントが${missing.length}件あります。取り直します: ${formatMissing(missing)}`);
  try {
    execFileSync(
      "npx",
      ["--yes", "backlog-exporter@1", "update", dir, "--force", "--documentId", missing.map((m) => m.id).join(",")],
      { stdio: "inherit", env: { ...process.env, BACKLOG_API_KEY: apiKey }, timeout: 15 * 60 * 1000 },
    );
  } catch {
    note("warning", "取り直しの実行に失敗しました（次回の同期で再試行します）");
  }

  // 取り直した結果を数え直す。**「実行できたか」ではなく「入ったか」で判定する。**
  missing = findMissing(remote, collectLocalDocumentIds(dir), exclude);
  if (!missing.length) {
    console.log("取りこぼしを回収しました");
    return 0;
  }

  const { waiting, stale } = classifyMissing(missing, Date.now());
  if (waiting.length) {
    note(
      "warning",
      `${waiting.length}件はまだ取り込めません。Backlogのツリーへの反映待ちの可能性が高く、次回の同期で再試行します: ${formatMissing(waiting)}`,
    );
  }
  if (stale.length) {
    note(
      "error",
      `${stale.length}件が${STALE_HOURS}時間以上ミラーに入っていません。Backlogのツリーに現れていない可能性があります（該当ドキュメントを開いて一度編集・保存すると入ります）: ${formatMissing(stale)}`,
    );
    return 1;
  }
  return 0;
}

// 直接実行されたときだけ走らせる（テストからは純粋関数だけを使う）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      // 突き合わせ自体の失敗で同期を赤くしない（同期そのものは成功している）
      note("warning", `ドキュメントの突き合わせに失敗しました: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(0);
    },
  );
}
