/**
 * 案件リポのシード文書に残る「プラグインはトラスト時に自動で案内される」という誤った手順を訂正する。
 *
 * 背景: 現行の Claude Code は、リポジトリの `.claude/settings.json` に `enabledPlugins` を宣言しても
 * 外部ソースのプラグインを自動インストールしない（各メンバーが `claude plugin install` を実行するまで
 * ロードされない仕様）。案件リポの README.md / USAGE.md はこの誤った前提で書かれており、新しく参加した
 * メンバーが「トラストしたのにコマンドが出てこない」と詰まる。正しい2コマンドと、環境ごとの制約
 * （クラウド実行ではプラグインが読み込まれない）への導線に差し替える。
 *
 * 安全ガード（0013 と同じ保守則）:
 *   - 対象は scaffold 由来の README.md / USAGE.md のみ。
 *   - **旧文言が完全一致した場合のみ**置換する（案件側で書き換えている文言には触れない）。
 *   - 置換後は旧文言が消えるので冪等。
 *
 * autoApply: true（テキスト置換のみ・非破壊・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 21,
  description:
    "案件リポのREADME・USAGEに残る「トラスト時に自動でプラグイン案内」という誤った手順を、実際に必要な手動インストール手順に訂正",
  autoApply: true,
};

const TARGET_FILES = ["README.md", "USAGE.md"];

// 正しい導入手順（短く書き、詳細はエンジンの onboarding へ送る）
const INSTALL_STEPS =
  "手元で1回だけ次の2コマンドを実行します（マシンごとに1回。デスクトップアプリなら プロンプト欄の ＋ → Plugins → Add plugin から GUI でも可）。\n" +
  "\n" +
  "```bash\n" +
  "claude plugin marketplace add classmethod-team-app/cortex-engine@stable\n" +
  "claude plugin install cortex@cortex-engine\n" +
  "```\n" +
  "\n" +
  "**クラウド実行（Web版・デスクトップの Cloud セッション）ではコマンドが使えません**（プラグインが読み込まれない仕様。不具合ではありません）。詳しい手順と環境の選び方は cortex-engine の `docs/onboarding.md` を参照。";

// [旧文言, 新文言]。複数トークンを含む語句を先に置き、その後に単独トークンを置く（二重置換を避ける順序）。
const REPLACEMENTS = [
  // USAGE.md 冒頭
  [
    "仕組み（スキル・自動化）は中央の **cortex-engine** から配布されており、**このリポジトリでは初回に一度プラグインを入れるだけ**で使えます（リポジトリを Claude Code で開いてトラスト → インストール案内に「はい」）。",
    "仕組み（スキル・自動化）は中央の **cortex-engine** から配布されています。" + INSTALL_STEPS,
  ],
  // README.md 配布経路の表
  [
    "`.claude/settings.json` のマーケットプレイス参照。リポジトリをトラストしたメンバーに自動でインストール案内が出る（1人1回）",
    "`.claude/settings.json` のマーケットプレイス宣言（**宣言だけでは入らない**。各メンバーが手元で1回インストールする）",
  ],
  // README.md セットアップ手順
  [
    "1. このリポジトリを Claude Code で開き、フォルダをトラストする → cortex プラグインのインストール案内に「はい」",
    "1. 手元で cortex プラグインを入れる（`claude plugin marketplace add classmethod-team-app/cortex-engine@stable` → `claude plugin install cortex@cortex-engine`）。詳細は cortex-engine の `docs/onboarding.md`",
  ],
  [
    "新規参加メンバーは cortex プラグインの導入案内（リポジトリのトラスト時に自動表示） を実行してください（環境準備＋Gold起点のオリエン）。",
    "新規参加メンバーは、上記の2コマンドで cortex プラグインを入れてください（マシンごとに1回）。案件の理解は `USAGE.md` と AIS Viewer の「はじめに」チュートリアルから始められます。",
  ],
  [
    "> **PM・開発・デザイン・運用などの職能ハーネスは部カタログから導入します**（案件がプラグインを有効化していればトラスト時にまとめて案内されます）。",
    "> **PM・開発・デザイン・運用などの職能ハーネスは部カタログから各自で導入します**（社内メンバーのみ。`claude plugin marketplace add classmethod-team-app/retail-app-harnesses` の後、必要なハーネスを `claude plugin install`）。",
  ],
  // 表・本文に散らばる旧スキル名の名残（プラグイン導入案内という架空のコマンド表記）
  [
    "cortex プラグインの導入案内（リポジトリのトラスト時に自動表示）（プラグイン導入の案内＋Gold起点のオリエン）",
    "手元で cortex プラグインを入れる（マシンごとに1回。手順は `README.md`）。理解は AIS Viewer の「はじめに」チュートリアル・`/catch-up-recent-status` から",
  ],
  [
    "個人の API キーが必要 → cortex プラグインの導入案内（リポジトリのトラスト時に自動表示） 参照",
    "本人名義で書くには Backlog MCP の接続か個人の API キーが必要",
  ],
  [
    "| cortex プラグインの導入案内（リポジトリのトラスト時に自動表示） | 新メンバーのローカル環境準備＋案件理解 |\n",
    "",
  ],
  // Gold層の構成（レポートは撤去済み・ルールを追加）
  ["Decisions・用語集・レポート・Home", "Decisions・用語集・メンバー・ルール・Home"],
  ["Decisions・用語集・レポート・メンバー・Home", "Decisions・用語集・メンバー・ルール・Home"],
];

export async function run(repoRoot) {
  for (const name of TARGET_FILES) {
    const p = path.join(repoRoot, name);
    let text;
    try {
      text = await fs.readFile(p, "utf8");
    } catch {
      continue; // 無ければ何もしない
    }
    let next = text;
    for (const [from, to] of REPLACEMENTS) {
      if (next.includes(from)) next = next.split(from).join(to);
    }
    if (next !== text) await fs.writeFile(p, next);
  }
}
