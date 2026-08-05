#!/usr/bin/env node
// 夜間Gold昇格(update-gold)が読み取る「外部ソース」の解決を一元化する。
// 既定ソースは既存の宣言（チャット/channels.json・.gitmodules）から自動導出し、
// Cortex/external-sources.json の明示登録をマージ・重複排除・除外して、
// 正規化済みリスト [{type, ref, name, ...options}] を標準出力にJSONで出す。
// fetcher（external-sources.sh）はこの出力を回すだけになる。
//
// --all フラグ: 対象外（gold が true でないチャンネル・exclude リポ）も落とさず、gold:true/false と
// notify・url（slackのみ・channels.json由来）の注釈付きで全登録を出す。fleet-status の接続状況可視化用。
// 既定動作（フィルタ済み＝update-gold の取得対象）には影響しない。
//
// 入力: cwd（リポジトリルート）。読むもの:
//   - Cortex/Home.md           の frontmatter tools（チャット/開発 のゲート判定）と
//                              engine.dev_dir（開発submoduleの置き場の宣言。省略時は「開発」）
//   - チャット/channels.json    （既定 slack チャンネルの導出元。**gold: true を明示したものだけ**が
//                              Gold昇格の対象。宣言が無いチャンネルは対象外＝安全側）
//   - .gitmodules              （既定 github-issues の導出元。dev_dir 配下のsubmoduleのみ・wiki除外）
//   - Cortex/external-sources.json（特殊ソースの明示登録＋exclude）
// いずれも無ければその導出/マージをスキップする（1件も無ければ空配列）。
//
// 公開範囲の防衛線（重要・変えないこと）:
//   - 開発リポの導出対象は path が dev_dir（既定: 開発/）配下のsubmoduleに限定する。dev_dir 配下以外の
//     submoduleは内部情報用privateリポの可能性があるため絶対に導出対象にしない。
//     wiki（path末尾が /wiki・リポ名が .wiki で終わるもの）も除外する。
//   - dev_dir に危険値（`/`始まり・`.`始まり・`..`セグメント等）が宣言されていたら無効として warn し、
//     既定の「開発」にフォールバックする（宣言ミスで防衛線が広がらないようにする）。
//   - 除外（gold が true でないチャンネル・exclude リポ）は最終フィルタとして常に効かせる（読まない側に倒す）。
//   - **Slackチャンネルの Gold昇格は明示的なopt-in（gold: true）**。channels.json は /read-chat の参照先・
//     通知先(notify)としても使う共用の宣言なので、別目的で足したチャンネルが無言でGold昇格の対象に
//     ならないようにする。「読みに行く」と「顧客が見るGoldに上げる」は重さの違う判断として分ける。
//
// 設計メモ:
//   - tools ゲート: チャット:slack でなければ slack を導出しない・開発:github でなければ github を導出しない。
//   - 導出できない項目（URL解釈不能・非github submodule等）は stderr に ::warning:: を出してその項目だけスキップし、
//     全体は落とさない（external-sources.sh の「1ソース失敗は他を止めない」思想と同じ）。
//   - dedupe は type+ref 単位。明示登録を優先し、そのオプション（decisions 等）を保持する。

import fs from "node:fs";

const DEFAULT_DEV_DIR = "開発";

const warn = (msg) => process.stderr.write(`::warning::resolve-external-sources: ${msg}\n`);

function readFileOr(path) {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readJsonOr(path) {
  const raw = readFileOr(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    warn(`${path} のJSON解析に失敗しました。無視します。`);
    return null;
  }
}

// Home.md frontmatter から指定マップブロック（tools / engine 等）の key:value を読む（YAML依存なしの最小パース）。
function readFrontmatterMap(raw, blockName) {
  const map = {};
  if (raw === null) return map;
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return map;
  // frontmatter（先頭 --- 〜 次の ---）を切り出す
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  const fm = end === -1 ? lines.slice(1) : lines.slice(1, end);
  let inBlock = false;
  let blockIndent = 0;
  const blockRe = new RegExp(`^${blockName}:\\s*(#.*)?$`);
  for (const line of fm) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inBlock) {
      if (indent === 0 && blockRe.test(line)) {
        inBlock = true;
        blockIndent = indent;
      }
      continue;
    }
    // ブロックはネスト（blockIndentより深い）。同階層以下に戻ったら終了。
    if (indent <= blockIndent) break;
    const m = line.match(/^\s*([^:#]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    // インラインコメント除去 → クォート除去
    let val = m[2].split("#")[0].trim().replace(/^["']|["']$/g, "");
    map[key] = val;
  }
  return map;
}

// engine.dev_dir を検証して開発submodule置き場を決める。危険値・不正値は warn して既定にフォールバック。
// 防衛線: 宣言ミス（絶対パス・上方参照等）で導出範囲が広がることを防ぐ（読まない側に倒す）。
function resolveDevDir(engine) {
  const declared = (engine.dev_dir || "").trim();
  if (!declared) return DEFAULT_DEV_DIR;
  // 末尾スラッシュだけは正規化として許容
  const v = declared.replace(/\/+$/, "");
  const segments = v.split("/");
  const dangerous =
    v === "" ||
    v.startsWith("/") ||
    v.startsWith(".") ||
    v.includes("\\") ||
    segments.some((s) => s === "" || s === "." || s === "..");
  if (dangerous) {
    warn(`engine.dev_dir '${declared}' は無効な値のため無視し、既定の「${DEFAULT_DEV_DIR}」を使います。`);
    return DEFAULT_DEV_DIR;
  }
  return v;
}

// channels.json の slack チャンネルを {ref(ID), name, gold, notify, url} に正規化。platform 省略時は slack。
function deriveSlackChannels() {
  const data = readJsonOr("チャット/channels.json");
  if (!data) return [];
  const out = [];
  for (const c of data.channels || []) {
    const platform = (c.platform || "slack").toLowerCase();
    if (platform !== "slack") continue; // teams 等は slack ソースとして導出しない
    const url = c.url || "";
    const m = url.match(/\/archives\/([A-Z0-9]+)/);
    if (!m) {
      const label = c.name || url || "?";
      warn(`チャンネル '${label}' の url からIDを抽出できません。スキップします。`);
      continue;
    }
    // **Gold昇格は明示的なopt-in（gold: true）でのみ有効にする。**
    // 以前は既定 true（gold: false を書いたときだけ除外）だった。しかし channels.json は
    // /read-chat の参照先・通知先(notify)としても使う共用の宣言なので、**別の目的でチャンネルを
    // 1行足した人が、無言でGold昇格の対象を増やせる**構造になっていた。
    // 実際に、説明に「本案件の社内チャンネル」と書かれたチャンネルが顧客可視のGoldへ昇格しており、
    // 単価・工数が顧客向けビューアに載る事故が起きた。
    // 「チャットを読みに行く」ことと「顧客が見るGoldに上げる」ことは重さの違う判断なので、
    // 後者は必ず明示させる（書き忘れは繋がらない側＝安全側に倒れる）。
    // 三値で持つ: true=昇格する / false=昇格しない（意思表示）/ undefined=未宣言。
    // undefined は既定では対象外だが、external-sources.json に明示登録があればそちらを勝たせる
    // （false との違いはそこ。詳細は下の goldFalseChannels のコメント）。
    const gold = typeof c.gold === "boolean" ? c.gold : undefined;
    // 黙って対象外にすると「昇格されない」ことに気づけないので、名前を挙げて知らせる。
    // **boolean 以外もすべて警告する。** `"true"`（文字列）や `1` を書いた場合、
    // 「true と書いたつもりなのに効いていない」方向のミスだけが無音になってしまうため。
    if (typeof c.gold !== "boolean") {
      const label = c.name || m[1];
      warn(
        c.gold === undefined
          ? `チャンネル '${label}' は Gold昇格の対象外です（gold の宣言がありません）。` +
              `顧客が見るGoldに上げてよいチャンネルには "gold": true を明示してください。` +
              `意図して外しているなら "gold": false を明示すればこの警告は消えます。`
          : `チャンネル '${label}' の gold が真偽値ではありません（${JSON.stringify(c.gold)}）。` +
              `対象外として扱います。true / false で書いてください。`,
      );
    }
    out.push({ ref: m[1], name: c.name || m[1], gold, notify: c.notify === true, url });
  }
  return out;
}

// git@github.com:owner/repo(.git) / https://github.com/owner/repo(.git) → owner/repo。github以外はnull。
function normalizeGithubRepo(url) {
  if (!url) return null;
  let s = url.trim().replace(/\.git$/, "");
  let m = s.match(/^git@github\.com:(.+)$/);
  if (m) return m[1];
  m = s.match(/^(?:https?:\/\/|ssh:\/\/git@)github\.com\/(.+)$/);
  if (m) return m[1];
  return null;
}

// .gitmodules から dev_dir 配下（wiki除外）のsubmoduleを github-issues として導出。
function deriveGithubRepos(devDir) {
  const raw = readFileOr(".gitmodules");
  if (raw === null) return [];
  const out = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const path = cur.path || "";
    // 公開範囲の防衛線: dev_dir 配下のみ。dev_dir 外は絶対に導出しない。
    const underDev = path === devDir || path.startsWith(`${devDir}/`);
    // wiki 除外: path 末尾が /wiki のもの（配下含む）
    const isWikiPath = path === `${devDir}/wiki` || path.endsWith("/wiki") || path.includes("/wiki/");
    if (underDev && !isWikiPath) {
      const repo = normalizeGithubRepo(cur.url || "");
      if (!repo) {
        warn(`submodule '${path}' の url (${cur.url || ""}) をGitHubリポとして解釈できません。導出をスキップします。`);
      } else if (repo.endsWith(".wiki")) {
        // wiki 除外: リポ名が .wiki で終わるもの（pathがwiki風でなくても除外）
      } else {
        out.push({ ref: repo, name: repo });
      }
    }
    cur = null;
  };
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (/^\[submodule /.test(t)) {
      flush();
      cur = {};
      continue;
    }
    if (!cur) continue;
    let m = t.match(/^path\s*=\s*(.+)$/);
    if (m) {
      cur.path = m[1].trim();
      continue;
    }
    m = t.match(/^url\s*=\s*(.+)$/);
    if (m) {
      cur.url = m[1].trim();
      continue;
    }
  }
  flush();
  return out;
}

function main() {
  // --all: 除外（gold:false チャンネル・exclude リポ）も落とさず、gold/notify の注釈付きで全登録を出す。
  // fleet-status（接続状況の可視化）用。既定動作（フィルタ済みリスト＝update-gold の取得対象）は不変。
  const ALL = process.argv.includes("--all");
  const home = readFileOr("Cortex/Home.md");
  const tools = readFrontmatterMap(home, "tools");
  const engine = readFrontmatterMap(home, "engine");
  const derived = [];

  // ゲート: チャット:slack のときだけ slack を導出
  if ((tools["チャット"] || "").toLowerCase() === "slack") {
    for (const ch of deriveSlackChannels()) {
      derived.push({ type: "slack", ref: ch.ref, name: ch.name, gold: ch.gold, notify: ch.notify, url: ch.url });
    }
  }
  // ゲート: 開発:github のときだけ github-issues を導出（対象は dev_dir 配下のsubmodule）
  if ((tools["開発"] || "").toLowerCase() === "github") {
    const devDir = resolveDevDir(engine);
    for (const r of deriveGithubRepos(devDir)) {
      derived.push({ type: "github-issues", ref: r.ref, name: r.name });
    }
  }

  // 明示登録（external-sources.json）。name は登録に書かれた場合だけ持つ
  // （無い場合にここで ref を入れてしまうと、マージ時に導出側の表示名（channels.json の name）を潰すため）。
  const cfg = readJsonOr("Cortex/external-sources.json") || {};
  const explicit = [];
  for (const s of cfg.sources || []) {
    const type = s.type || "";
    const ref = s.repo || s.channel || "";
    if (!type || !ref) continue;
    const item = { type, ref };
    if (s.name) item.name = s.name;
    if (s.decisions !== undefined) item.decisions = s.decisions;
    explicit.push(item);
  }
  // **GitHubのリポジタリ名は大小文字を区別しない。** 照合も区別しない。
  // `.gitmodules` が `Owner/Repo` で exclude が `owner/repo` だと、**除外したつもりが効かない**。
  // 「読まない側に倒す」という最終フィルタの趣旨からも、揃わないことによる取りこぼしは許容できない。
  const excludeRepos = new Set((cfg.exclude || []).map((r) => String(r).toLowerCase()));

  // Gold昇格の対象外チャンネルID集合（最終フィルタで常に除外）。
  //
  // **「明示的に false」と「宣言なし」を区別する。** どちらも channels.json 単独では対象外だが、
  // external-sources.json への明示登録（＝「このソースをGoldに上げてよい」という人間の判断）と
  // ぶつかったときの強さが違う:
  //   - `gold: false`  … 除外の意思表示。明示登録より強い（人間が「上げるな」と書いている）
  //   - 宣言なし        … 単なる未記入。明示登録があるならそちらが人間の判断なので、そちらを勝たせる
  // 区別しないと、external-sources.json に登録した9チャンネルが channels.json の書き忘れ1つで
  // 全部黙って消える（実際にそうなっていた）。
  const goldFalseChannels = new Set(
    derived.filter((d) => d.type === "slack" && d.gold === false).map((d) => d.ref),
  );
  // 宣言なしのチャンネル。明示登録が無ければ対象外にする（opt-in の既定）。
  const goldUndeclaredChannels = new Set(
    derived
      .filter((d) => d.type === "slack" && d.gold === undefined)
      .map((d) => d.ref),
  );
  const explicitSlackRefs = new Set(
    explicit.filter((e) => e.type === "slack").map((e) => e.ref),
  );

  // マージ＋dedupe（type+ref単位・明示登録優先）。まず導出→上書きで明示を反映。
  // 明示側に無いフィールド（name・notify・url 等の表示系）は導出側から補完し、
  // 明示側にあるフィールド（decisions 等の動作オプション・明示的な name）は明示を優先する。
  const byKey = new Map();
  // github系は大小文字を区別しないので、dedupeのキーも揃える。
  // 揃えないと `Owner/Repo`（.gitmodules 由来）と `owner/repo`（明示登録）が別物として
  // 2件出力され、同じリポを2回読みに行く。
  const keyOf = (s) =>
    `${s.type}\t${s.type.startsWith("github") ? String(s.ref).toLowerCase() : s.ref}`;
  // **どこから来たかを残す（origin）。** 設定UIが「消してよいか」を判断するために要る。
  //   derived  … 既存宣言からの自動導出（channels.json の gold:true / dev_dir 配下の submodule）
  //   explicit … Cortex/external-sources.json への明示登録
  //   both     … 両方にある
  // 導出されたものは「消す」対象が無い（消しても導出で戻る／exclude を消すと逆に読み始める）。
  // 設定UIはこれを見て、explicit のときだけ削除を出す。
  for (const d of derived) {
    byKey.set(keyOf(d), { ...d, origin: "derived" });
  }
  for (const e of explicit) {
    const prev = byKey.get(keyOf(e));
    byKey.set(keyOf(e), prev ? { ...prev, ...e, origin: "both" } : { ...e, origin: "explicit" });
  }

  const result = [];
  for (const s of byKey.values()) {
    // `gold: false` は明示的な除外の意思表示なので、明示登録より強い（常に落とす）。
    const isGoldFalse = s.type === "slack" && goldFalseChannels.has(s.ref);
    // 宣言なしは、external-sources.json への明示登録がある場合のみ通す（無ければ opt-in の既定で落とす）。
    const isGoldUndeclared =
      s.type === "slack" &&
      goldUndeclaredChannels.has(s.ref) &&
      !explicitSlackRefs.has(s.ref);
    const isExcluded = s.type.startsWith("github") && excludeRepos.has(String(s.ref).toLowerCase());
    if (ALL) {
      // --all: 除外も落とさず gold で表現。slack は notify（channels.json 由来・既定false）と url も注釈する。
      //
      // **`goldState` で理由まで伝える。** `gold` は真偽値なので「意図的に外した」「宣言し忘れ」
      // 「exclude リストに入っている」の3つが同じ false に潰れる。表示側はこれらを区別できないと
      // 「正常な除外」にまで警告を出して麻痺する（意図的なOFFに⚠️が付くのは誤り）。
      //   on         … 対象。読まれる
      //   off        … 意図的に外している（gold: false）。正常な状態であり警告してはいけない
      //   undeclared … 宣言し忘れ。判断されていないので促す価値がある
      //   excluded   … exclude リストによる除外（github系）
      const goldState = isGoldFalse
        ? "off"
        : isGoldUndeclared
          ? "undeclared"
          : isExcluded
            ? "excluded"
            : "on";
      const item = {
        type: s.type,
        ref: s.ref,
        name: s.name || s.ref,
        gold: goldState === "on",
        goldState,
        // どこから来たか。設定UIが「消してよいか」を判断するために使う
        // （derived / both は消す対象が無い。消しても導出で戻る・exclude を消すと逆に読み始める）
        origin: s.origin || "derived",
      };
      if (s.type === "slack") item.notify = s.notify === true;
      if (s.url) item.url = s.url;
      if (s.decisions !== undefined) item.decisions = s.decisions;
      result.push(item);
      continue;
    }
    // 既定: 最終フィルタ（対象外は常に落とす＝読まない側に倒す）。gold/notify は内部判定・表示用なので出力に残さない。
    //
    // **url だけは残す。** Slackチャンネルの正本URLは channels.json にしか無く、
    // external-sources.sh が素材に `URL:` 行として書き、Gold層の出典（Decision の references・
    // 用語の source）がそれを読む。落とすと出典が `[slack] #channel (8 messages since …)` という
    // **説明文**になり、そこからSlackへ飛べない。ID→URLの導出はここの責務なので、
    // 消費側（シェル）に正規表現とファイル位置を二重に持たせない。
    if (isGoldFalse || isGoldUndeclared || isExcluded) continue;
    const item = { type: s.type, ref: s.ref, name: s.name || s.ref };
    if (s.type === "slack" && s.url) item.url = s.url;
    if (s.decisions !== undefined) item.decisions = s.decisions;
    result.push(item);
  }

  process.stdout.write(JSON.stringify(result) + "\n");
}

main();
