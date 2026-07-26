#!/usr/bin/env node
/**
 * Cortex/（Gold層）のfrontmatterをオントロジー規約（cortex-engine の docs/ontology.md）に
 * 照らして検証するリンター。
 *
 * 検証内容:
 *   - frontmatterの存在とYAMLとしての妥当性
 *   - type必須・配置ディレクトリとの一致
 *   - 型ごとの必須フィールド・許可フィールド（規約外フィールドの混入防止）
 *   - IDの形式・ファイル名との整合・リポジトリ内での一意性
 *   - relations（rel種別・target）の妥当性
 *   - relations.target の実在解決（リポジトリ内の安定IDに解決するか）※警告のみ
 *   - 参照lint: 案内文書が「もう存在しないもの」を指していないか ※警告のみ
 *
 * 使い方: node validate-cortex.mjs（案件リポのルートで実行）
 * 終了コード: 0=違反なし（dangling参照・参照lintは警告のみで終了コードに影響しない） / 1=違反あり
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "./vendor/js-yaml.mjs"; // vendor同梱（プラグインキャッシュ内で依存インストール不要にする）

const KNOWLEDGE_DIR = "Cortex";
const META_FILES = new Set(["readme.md", "template.md"]);
// is_a（分類）・part_of（構成）は term→term のみ許可（縦の関係。下の validateCommon で source/target を制限）。
const RELS = new Set([
  "based_on",
  "derived_from",
  "relates_to",
  "supersedes",
  "is_a",
  "part_of",
]);
// term→term に限定するリレーション（用語をドメインの地図に拡張するための縦の関係）
const TERM_ONLY_RELS = new Set(["is_a", "part_of"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// relations.target のうち、実在を検証する型のパターン（= Gold層エンティティのみ）。
// frontmatterを持つのはGold層（Cortex/配下）だけなので、実在検証できるのは
// decision / term / rule / member / report / overview。
// Silver/Bronzeへの参照（minute:・material:・design:・課題キー・ドキュメントID等）は
// 「規約ベースのID文字列」であり、参照先にfrontmatterアンカーを要求しない＝実在検証しない（オントロジー規約参照）。
const CHECKABLE_TARGET =
  /^(\d{8}-\d{3}$|term:|rule:|member:|report:|overview:)/;

/** ディレクトリ名 → 期待されるtype */
const DIR_TYPE = {
  Decisions: "decision",
  Glossary: "term",
  Rules: "rule",
  Members: "member",
  レポート: "report",
};

/** 型ごとのスキーマ定義 */
const SCHEMAS = {
  decision: {
    required: [
      "type",
      "id",
      "title",
      "date",
      "category",
      "deciders",
      "description",
      "references",
    ],
    allowed: [
      "type",
      "id",
      "title",
      "date",
      "sprint",
      "category",
      "deciders",
      "description",
      // AI生成・人間未確認の印（draft）／人間が確認済み（active）。
      // 既存レコードには無いものがあるため required にはしない（新規作成時は必ず付ける）。
      "status",
      "relations",
      "references",
    ],
    validate(fm, fileName, errors) {
      if (fm.status && !["draft", "active"].includes(fm.status)) {
        errors.push(`statusはdraft|active（実際: ${fm.status}）`);
      }
      if (fm.id && !/^\d{8}-\d{3}$/.test(String(fm.id))) {
        errors.push(`id「${fm.id}」が YYYYMMDD-NNN 形式ではない`);
      }
      if (fm.id && !fileName.startsWith(`${fm.id}-`)) {
        errors.push(
          `ファイル名がid「${fm.id}」で始まっていない（YYYYMMDD-NNN-要約.md）`,
        );
      }
      if (fm.date && !DATE_RE.test(String(fm.date)))
        errors.push(`dateがYYYY-MM-DD形式ではない: ${fm.date}`);
      if (
        fm.deciders != null &&
        (!Array.isArray(fm.deciders) || fm.deciders.length === 0)
      ) {
        errors.push("decidersが空でないリストではない");
      }
      if (
        fm.references != null &&
        (!Array.isArray(fm.references) || fm.references.length === 0)
      ) {
        errors.push(
          "referencesが空でないリストではない（決定の情報源を必ず記載する）",
        );
      }
    },
  },
  term: {
    required: ["type", "id", "title", "description", "scope", "status", "date"],
    allowed: [
      "type",
      "id",
      "title",
      "description",
      "synonyms",
      "scope",
      "status",
      "date",
      "source",
      "references",
      "relations",
      // ドメイン級の用語のマーカー（任意。値は domain のみ許可）
      "kind",
    ],
    validate(fm, fileName, errors) {
      // kind はドメインの第一級市民化マーカー。付ける場合の値は domain のみ（語彙爆発を避ける）。
      if (fm.kind != null && fm.kind !== "domain") {
        errors.push(
          `term の kind は domain のみ許可（ドメイン級用語のマーカー。実際: ${fm.kind}）`,
        );
      }
      if (fm.title && fm.id !== `term:${fm.title}`) {
        errors.push(
          `idはterm:{代表表記}（期待値: term:${fm.title} / 実際: ${fm.id}）`,
        );
      }
      if (
        fm.references != null &&
        (!Array.isArray(fm.references) || fm.references.length === 0)
      ) {
        errors.push(
          "referencesは空でないリストで書く（一般公開用語の一次情報リンク。案件固有語は省略可）",
        );
      }
      if (fm.title && fileName !== `${fm.title}.md`) {
        errors.push(`ファイル名は{代表表記}.md（期待値: ${fm.title}.md）`);
      }
      if (fm.scope && !["project", "organization"].includes(fm.scope)) {
        errors.push(`scopeはproject|organization（実際: ${fm.scope}）`);
      }
      if (fm.status && !["draft", "active", "superseded"].includes(fm.status)) {
        errors.push(`statusはdraft|active|superseded（実際: ${fm.status}）`);
      }
      if (fm.synonyms != null && !Array.isArray(fm.synonyms))
        errors.push("synonymsはリストで書く");
      if (fm.date && !DATE_RE.test(String(fm.date)))
        errors.push(`dateがYYYY-MM-DD形式ではない: ${fm.date}`);
    },
  },
  rule: {
    required: ["type", "id", "title", "description", "status"],
    allowed: ["type", "id", "title", "description", "status", "relations"],
    validate(fm, _fileName, errors) {
      if (fm.id && !/^rule:.+/.test(String(fm.id))) {
        errors.push(`idはrule:{slug}（実際: ${fm.id}）`);
      }
      if (fm.status && !["draft", "active"].includes(fm.status)) {
        errors.push(`statusはdraft|active（実際: ${fm.status}）`);
      }
    },
  },
  member: {
    required: ["type", "id", "title", "description", "status"],
    allowed: [
      "type",
      "id",
      "title",
      "description",
      "yomi",
      "aliases",
      "org",
      "side",
      "role",
      "email",
      "status",
      "relations",
    ],
    validate(fm, _fileName, errors) {
      if (fm.id && !/^member:/.test(String(fm.id))) {
        errors.push(`idはmember:{氏名（スペース無し）}（実際: ${fm.id}）`);
      }
      if (fm.status && !["active", "inactive", "draft"].includes(fm.status)) {
        errors.push(`statusはactive|inactive|draft（実際: ${fm.status}）`);
      }
      // side は controlled vocabulary（空は許可＝side不明でも登録できる）
      if (fm.side && !["cm", "client", "vendor"].includes(fm.side)) {
        errors.push(`sideはcm|client|vendor（実際: ${fm.side}）`);
      }
      if (fm.aliases != null && !Array.isArray(fm.aliases))
        errors.push("aliasesはリストで書く");
    },
  },
  report: {
    // 週次（report:YYYYMMDD-weekly）と日次（report:YYYYMMDD-daily）の2種を持つ。
    // 必須はvalidate()内で種別ごとに検証する（requiredは共通部のみ）。
    required: ["type", "id", "title", "description"],
    allowed: [
      "type",
      "id",
      "title",
      "description",
      "project",
      "period_start",
      "period_end",
      "generated_at",
      "metrics",
      "date",
      "status",
      "sources",
    ],
    validate(fm, fileName, errors) {
      const id = String(fm.id ?? "");
      if (/^report:\d{8}-daily$/.test(id)) {
        // 日次: date / status(active|skip) / sources(件数マップ) を必須とする
        for (const f of ["date", "status", "sources"]) {
          if (fm[f] == null) errors.push(`日次レポートの必須フィールドがない: ${f}`);
        }
        if (fm.date && !DATE_RE.test(String(fm.date)))
          errors.push(`dateがYYYY-MM-DD形式ではない: ${fm.date}`);
        if (fm.status && !["active", "skip"].includes(fm.status))
          errors.push(`日次レポートのstatusはactive|skip（実際: ${fm.status}）`);
        if (fm.date) {
          const ymd = String(fm.date).replaceAll("-", "");
          if (id !== `report:${ymd}-daily`)
            errors.push(`idの日付がdateと一致しない`);
          if (fileName !== `${ymd}-daily.md`)
            errors.push(`日次のファイル名はYYYYMMDD-daily.md（期待値: ${ymd}-daily.md）`);
        }
        const SRC_KEYS = ["changed_files", "decisions_added", "terms_added", "members_added"];
        if (fm.sources != null) {
          for (const k of SRC_KEYS) {
            if (typeof fm.sources[k] !== "number")
              errors.push(`sources.${k} が数値で記載されていない`);
          }
        }
        return;
      }
      if (!/^report:\d{8}-weekly$/.test(id)) {
        errors.push(`idがreport:YYYYMMDD-weekly|YYYYMMDD-daily形式ではない: ${fm.id}`);
      }
      // 週次: 従来の必須フィールド
      for (const f of ["project", "period_start", "period_end", "generated_at", "metrics"]) {
        if (fm[f] == null) errors.push(`週次レポートの必須フィールドがない: ${f}`);
      }
      for (const f of ["period_start", "period_end", "generated_at"]) {
        if (fm[f] && !DATE_RE.test(String(fm[f])))
          errors.push(`${f}がYYYY-MM-DD形式ではない: ${fm[f]}`);
      }
      if (fm.period_end && fm.id) {
        const ymd = String(fm.period_end).replaceAll("-", "");
        if (fm.id !== `report:${ymd}-weekly`)
          errors.push(`idの日付が期間末日（period_end）と一致しない`);
        if (fileName !== `${ymd}.md`)
          errors.push(`ファイル名は期間末日のYYYYMMDD.md（期待値: ${ymd}.md）`);
      }
      const METRIC_KEYS = [
        "updated_issues",
        "new_minutes",
        "new_decisions",
        "updated_designs",
        "commits",
        "merged_prs",
      ];
      if (fm.metrics != null) {
        for (const k of METRIC_KEYS) {
          if (typeof fm.metrics[k] !== "number")
            errors.push(`metrics.${k} が数値で記載されていない`);
        }
      }
    },
  },
  overview: {
    required: ["type", "id", "title", "description", "kind", "lifecycle"],
    allowed: [
      "type",
      "id",
      "title",
      "description",
      "status",
      "source",
      // プロジェクト識別カード（巡回エージェント/company brainが横断走査時に最初に読む）
      "kind",
      "org",
      "team",
      "project",
      "client",
      "lifecycle",
      "adoption",
      "domains",
      "platforms",
      "tools",
      // AIS Viewer のURL（任意。Slack通知のリンク先等に使う）
      "viewer_url",
      // エンジン設定（schema_version はマイグレーションが管理・channel は配布チャンネルの表示・
      // dev_dir は開発submoduleの置き場宣言＝外部ソース導出の対象範囲）
      "engine",
    ],
    validate(fm, _fileName, errors) {
      if (fm.id !== "overview:home")
        errors.push(`Homeのidはoverview:home固定（実際: ${fm.id}）`);
      if (fm.engine != null) {
        if (typeof fm.engine !== "object" || Array.isArray(fm.engine))
          errors.push("engineはマップで書く（schema_version / channel / dev_dir）");
        else {
          if (fm.engine.schema_version != null && !Number.isInteger(fm.engine.schema_version))
            errors.push(`engine.schema_versionは整数（実際: ${fm.engine.schema_version}）`);
          if (fm.engine.channel && !["stable", "canary"].includes(fm.engine.channel))
            errors.push(`engine.channelはstable|canary（実際: ${fm.engine.channel}）`);
          if (fm.engine.dev_dir != null && typeof fm.engine.dev_dir !== "string")
            errors.push(`engine.dev_dirは文字列（実際: ${fm.engine.dev_dir}）`);
        }
      }
      if (fm.kind && !["案件", "社内プロジェクト"].includes(fm.kind))
        errors.push(`kindは案件|社内プロジェクト（実際: ${fm.kind}）`);
      if (fm.lifecycle && !["active", "archived"].includes(fm.lifecycle))
        errors.push(`lifecycleはactive|archived（実際: ${fm.lifecycle}）`);
      if (fm.adoption && !["new", "existing", "migration"].includes(fm.adoption))
        errors.push(`adoptionはnew|existing|migration（実際: ${fm.adoption}）`);
      for (const f of ["domains", "platforms"]) {
        if (fm[f] != null && !Array.isArray(fm[f]))
          errors.push(`${f}はリストで書く`);
      }
    },
  },
};

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m)
    return {
      fm: null,
      error: "frontmatterがない（---で始まるYAMLブロックが必要）",
    };
  try {
    // CORE_SCHEMA: 日付をDateオブジェクトに暗黙変換しない（文字列のまま形式検証するため）
    const fm = yaml.load(m[1], { schema: yaml.CORE_SCHEMA });
    if (fm == null || typeof fm !== "object")
      return { fm: null, error: "frontmatterが空" };
    return { fm, error: null };
  } catch (e) {
    return {
      fm: null,
      error: `frontmatterのYAMLが不正: ${e.message.split("\n")[0]}`,
    };
  }
}

function validateCommon(fm, expectedType, errors) {
  if (!fm.type) errors.push("type がない（必須）");
  else if (expectedType && fm.type !== expectedType) {
    errors.push(
      `配置場所と型が不一致（このディレクトリは type: ${expectedType} / 実際: ${fm.type}）`,
    );
  }
  if (!fm.id || String(fm.id).trim() === "") errors.push("id がない（必須）");
  if (Object.hasOwn(fm, "relations")) {
    if (!Array.isArray(fm.relations)) errors.push("relationsはリストで書く");
    else {
      fm.relations.forEach((r, i) => {
        if (r == null || typeof r !== "object")
          return errors.push(`relations[${i}]がrel/targetの組ではない`);
        if (!RELS.has(r.rel))
          errors.push(
            `relations[${i}].rel「${r.rel}」は未定義（${[...RELS].join(" / ")}）`,
          );
        if (!r.target || String(r.target).trim() === "")
          errors.push(`relations[${i}].target がない`);
        else if (
          String(r.target).includes("/") &&
          String(r.target).includes(".md")
        ) {
          errors.push(
            `relations[${i}].target にファイルパスらしき値（${r.target}）。安定IDを使う`,
          );
        }
        // is_a / part_of は term→term のみ許可（用語間の分類・構成の縦関係）
        if (TERM_ONLY_RELS.has(r.rel)) {
          if (fm.type !== "term") {
            errors.push(
              `relations[${i}].rel「${r.rel}」はterm→termのみ許可（このエンティティは type: ${fm.type}）`,
            );
          } else if (r.target && !/^term:/.test(String(r.target).trim())) {
            errors.push(
              `relations[${i}].rel「${r.rel}」のtargetはterm:で始まる用語IDにする（term→termのみ）`,
            );
          }
        }
      });
    }
  }
}

function validateSchema(fm, expectedType, fileName, errors) {
  const schema = SCHEMAS[fm.type ?? expectedType];
  if (!schema) return; // 未知のtype（新ディレクトリ等）は共通チェックのみ
  for (const f of schema.required) {
    if (!Object.hasOwn(fm, f) || fm[f] == null || fm[f] === "")
      errors.push(`必須フィールド ${f} がない`);
  }
  for (const f of Object.keys(fm)) {
    if (!schema.allowed.includes(f))
      errors.push(
        `規約外のフィールド ${f}（許可: ${schema.allowed.join(", ")}）`,
      );
  }
  schema.validate(fm, fileName, errors);
}

async function collectTargets(root) {
  const targets = []; // {filePath, fileName, expectedType}
  const knowledgeAbs = path.join(root, KNOWLEDGE_DIR);
  let entries;
  try {
    entries = await fs.readdir(knowledgeAbs, { withFileTypes: true });
  } catch {
    return targets; // Cortex/が無いリポジトリでは何もしない
  }
  for (const e of entries) {
    if (
      e.isFile() &&
      e.name.toLowerCase().endsWith(".md") &&
      !META_FILES.has(e.name.toLowerCase())
    ) {
      targets.push({
        filePath: path.join(knowledgeAbs, e.name),
        fileName: e.name,
        expectedType: "overview",
      });
    }
    if (e.isDirectory()) {
      const recordsAbs = path.join(knowledgeAbs, e.name, "records");
      let records;
      try {
        records = await fs.readdir(recordsAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const r of records) {
        if (
          r.isFile() &&
          r.name.toLowerCase().endsWith(".md") &&
          !META_FILES.has(r.name.toLowerCase())
        ) {
          targets.push({
            filePath: path.join(recordsAbs, r.name),
            fileName: r.name,
            expectedType: DIR_TYPE[e.name] ?? null,
          });
        }
      }
    }
  }
  return targets;
}

/**
 * リポジトリ全体の .md から frontmatter の `id` を集めて索引にする。
 * relations.target の実在解決（Cortexの決定→議事録ID等）に使う。
 */
async function collectAllIds(root) {
  const found = new Set();
  const SKIP = new Set(["node_modules", ".git", ".claude", ".cursor"]);
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(abs);
        continue;
      }
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      let raw;
      try {
        raw = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (raw.includes("{{")) continue; // 未展開テンプレートのIDは未確定なので索引に入れない
      const { fm } = parseFrontmatter(raw);
      if (fm && fm.id) found.add(String(fm.id).trim());
    }
  }
  await walk(root);
  return found;
}

// ---------- 参照lint（陳腐化の機械的検出） ----------
// 案件の案内文書（リポルートのREADME/USAGE/CLAUDE・Gold層のREADME等）が「もう存在しないもの」を
// 指していないかを検出する。実際に起きた陳腐化はいずれも機械的に検出できたはずのものだった:
//   - 撤去済みのGold区画（`Cortex/レポート/`）の案内が残る
//   - 改名・削除済みスキル（`/update-decision-log` 等）への導線が残る
//   - 廃止済みの rulesync（`.rulesync/`）を設定の正本として案内し続ける
// relations.target の dangling（決定ID・用語ID の指し先不存在）は、上の CHECKABLE_TARGET による
// 既存の実在解決チェックが担っている（同じ「指し先が無い」の検出なので二重には持たない）。
//
// すべて警告のみ（既存データを一気にブロックすると夜間のGold昇格が赤くなり艦隊が止まる）。
// 将来、案件リポの追随が済んだら errors 側に積み替えてエラーへ昇格できる。
const ROOT_DOCS = ["README.md", "USAGE.md", "CLAUDE.md"];
// Claude Code の組み込みスラッシュコマンド（スキルではないので「実在しない」と誤検知しない）
const BUILTIN_COMMANDS = new Set([
  "add-dir", "agents", "bug", "clear", "compact", "config", "context", "cost",
  "doctor", "exit", "export", "help", "hooks", "ide", "init", "install",
  "login", "logout", "mcp", "memory", "model", "permissions", "plugin",
  "pr-comments", "release-notes", "resume", "review", "status", "terminal-setup",
  "todos", "usage", "vim",
]);
// スラッシュコマンド参照。行頭・空白・記号の直後にあるものだけを拾う（`課題管理/issues/` のような
// パスの途中の `/xxx` を拾わないための位置制約）。末尾に `/`・`.`・`:` が続くものもパス扱いで除外。
const SLASH_COMMAND_RE =
  /(?<=^|[\s`([「（"'*、,|>→])\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w\-/:.])/gm;
// Gold区画のパス参照（`Cortex/○○/`）。`Cortex/` から境界（空白・引用符・括弧・句読点）までを
// 1つのパストークンとして取り、**末尾が `/` で終わるもの＝ディレクトリ参照**だけを対象にする。
// この制約により、日本語の散文中の列挙（「Cortex/巡回エージェント/開発ハーネスの各リーダー」）や
// 文が続くだけの `Cortex/`（「Gold層（Cortex/）のディレクトリ構成…」）を拾わない。
// glob（`Cortex/**/*.md`）・brace（`Cortex/{A,B}/`）・ファイル参照（`Cortex/Home.md`）も末尾が
// `/` で終わらない／除外文字を含むため対象外になる。
const GOLD_PATH_SEG = "[^\\s`\"'()\\[\\]{}|、。，）（「」]";
const GOLD_PATH_RE = new RegExp(
  `(?<![\\w/])Cortex\\/(${GOLD_PATH_SEG}*?\\/)(?=[\\s\`"'()\\[\\]{}|、。，）」]|$)`,
  "gm",
);
const RULESYNC_RE = /\.rulesync\//g;

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * スキル名の索引を返す（照合できないときは null＝スキル参照チェックをスキップ）。
 * エンジンの `plugin/skills/` を第一の根拠にし、案件リポ固有のスキル・コマンド、
 * ハーネススタブが呼ぶスキル名（`run-harness-skill` の `skill:`）も実在として扱う。
 */
async function collectKnownSkills(root) {
  const dirNames = async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

  // エンジンのスキル: このスクリプト自身の位置（ワークフローの .cortex-engine/ でも
  // プラグインキャッシュでも解決する）→ 案件リポ内のチェックアウト の順に探す
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills"),
    path.join(root, ".cortex-engine", "plugin", "skills"),
  ];
  let engineSkills = null;
  for (const c of candidates) {
    const names = await dirNames(c);
    if (names.length) {
      engineSkills = names;
      break;
    }
  }
  if (engineSkills === null) return null; // 案件リポ単体で実行された場合は照合できない

  const known = new Set([...engineSkills, ...BUILTIN_COMMANDS]);
  for (const n of await dirNames(path.join(root, ".claude", "skills"))) known.add(n);
  for (const e of await fs
    .readdir(path.join(root, ".claude", "commands"))
    .catch(() => []))
    known.add(e.replace(/\.md$/, ""));
  // ハーネス（エンジン外のプラグイン）のスキルは案件リポのスタブが名前を宣言している
  const wfDir = path.join(root, ".github", "workflows");
  for (const f of await fs.readdir(wfDir).catch(() => [])) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = await fs.readFile(path.join(wfDir, f), "utf8").catch(() => "");
    for (const m of text.matchAll(/^\s*skill:\s*([a-z][a-z0-9-]*)\s*$/gm))
      known.add(m[1]);
  }
  return known;
}

/** 参照lintの対象ファイル（Cortex配下の全.md ＋ リポルートの案内文書）をリポ相対パスで返す */
async function collectDocFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const e of await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => [])) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md"))
        files.push(path.relative(root, abs));
    }
  }
  await walk(path.join(root, KNOWLEDGE_DIR));
  for (const d of ROOT_DOCS) {
    const abs = path.join(root, d);
    if (await fs.stat(abs).then(() => true, () => false)) files.push(d);
  }
  return files;
}

/** 参照lintを実行して警告メッセージのリストを返す（終了コードには影響させない） */
async function lintReferences(root) {
  const warns = [];
  const skills = await collectKnownSkills(root);
  const goldDirs = new Set(
    (await fs.readdir(path.join(root, KNOWLEDGE_DIR), { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  for (const rel of await collectDocFiles(root)) {
    const text = await fs.readFile(path.join(root, rel), "utf8").catch(() => null);
    if (text === null) continue;
    const seen = new Set(); // 同じ文書内の同一参照は1件にまとめる
    const found = []; // この文書の検出。出力順を行番号に揃えるため一旦ためる
    const once = (key, line, message) => {
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ line, message: `${rel}:${line}  ${message}` });
    };
    // 1) スキル参照（エンジンの plugin/skills/ を照合できるときだけ）
    if (skills) {
      for (const m of text.matchAll(SLASH_COMMAND_RE)) {
        if (skills.has(m[1])) continue;
        once(
          `skill:${m[1]}`,
          lineOf(text, m.index),
          `スキル「/${m[1]}」が実在しない（改名・削除の可能性）`,
        );
      }
    }
    // 2) Gold区画のパス参照（撤去・改名済みの区画を指していないか）
    if (goldDirs.size) {
      for (const m of text.matchAll(GOLD_PATH_RE)) {
        const name = m[1].split("/")[0]; // 検証するのは直下の区画名だけ（`Decisions/records/` → `Decisions`）
        if (name === "" || name.includes("{{") || goldDirs.has(name)) continue;
        once(
          `gold:${name}`,
          lineOf(text, m.index),
          `Gold区画「${KNOWLEDGE_DIR}/${name}/」が実在しない（撤去・改名済みの可能性）`,
        );
      }
    }
    // 3) 廃止された記法（rulesync は廃止済み。AIツール設定の正本はエンジン側にある）
    for (const m of text.matchAll(RULESYNC_RE)) {
      once("rulesync", lineOf(text, m.index), "廃止済みの「.rulesync/」を参照している");
    }
    found.sort((a, b) => a.line - b.line);
    for (const f of found) warns.push(f.message);
  }
  return warns;
}

const root = process.cwd();
const targets = await collectTargets(root);
const allIds = await collectAllIds(root); // 実在解決用のID索引
const ids = new Map(); // id -> 最初に登場したファイル
const warnings = []; // dangling参照（非ブロック）
let errorCount = 0;
let skippedCount = 0;

for (const t of targets) {
  const raw = await fs.readFile(t.filePath, "utf8");
  const rel = path.relative(root, t.filePath);
  // テンプレート未展開（複製前のサンプル）はセットアップ用プレースホルダ `{{ }}` を
  // 含む。setup-fill で値が埋まるまでは日付・IDが規約形式にならないため検証をスキップ。
  if (raw.includes("{{")) {
    skippedCount++;
    continue;
  }
  const errors = [];
  const { fm, error } = parseFrontmatter(raw);
  if (error) errors.push(error);
  else {
    validateCommon(fm, t.expectedType, errors);
    validateSchema(fm, t.expectedType, t.fileName, errors);
    if (fm.id) {
      if (ids.has(fm.id))
        errors.push(`idが重複している（既出: ${ids.get(fm.id)}）`);
      else ids.set(fm.id, rel);
    }
    // relations.target が実在の安定IDに解決するかを確認（解決しなければ警告）
    if (Array.isArray(fm.relations)) {
      for (const r of fm.relations) {
        if (!r || !r.target) continue;
        const target = String(r.target).trim();
        if (CHECKABLE_TARGET.test(target) && !allIds.has(target)) {
          warnings.push(
            `${rel}  relations.target「${target}」（rel: ${r.rel}）に対応する実体が見つからない`,
          );
        }
      }
    }
  }
  if (errors.length) {
    errorCount += errors.length;
    console.error(`\n✗ ${rel}`);
    for (const e of errors) console.error(`    - ${e}`);
  }
}

if (warnings.length) {
  console.warn(
    `\n⚠ relations の dangling 参照 ${warnings.length}件（要確認・ブロックはしない）`,
  );
  for (const w of warnings) console.warn(`    - ${w}`);
  console.warn(
    "  ※ target が実在の安定IDに解決しません。生データの同期漏れ、ID誤記、または supersedes 先の不存在の可能性があります。",
  );
}

// 参照lint（陳腐化の機械的検出）。dangling参照と同じく警告のみでブロックしない。
const refWarnings = await lintReferences(root);
if (refWarnings.length) {
  console.warn(
    `\n⚠ 参照lint: 陳腐化のおそれ ${refWarnings.length}件（要確認・ブロックはしない）`,
  );
  for (const w of refWarnings) console.warn(`    - ${w}`);
  console.warn(
    "  ※ 参照先が実在しません。撤去・改名に文書が追随できていない可能性があります（他ハーネス由来のスキル参照は誤検知のことがあります）。",
  );
}

if (errorCount > 0) {
  console.error(
    `\n${targets.length}ファイル中、${errorCount}件の規約違反があります。`,
  );
  console.error(
    "スキーマの定義は cortex-engine の docs/ontology.md と各ディレクトリのREADME.mdを参照してください。",
  );
  process.exit(1);
}
console.log(
  `✓ Cortex配下 ${targets.length - skippedCount}ファイルがオントロジー規約に適合しています` +
    (skippedCount
      ? `（テンプレート未展開の ${skippedCount}ファイルはスキップ）`
      : "") +
    (warnings.length ? `。relations警告 ${warnings.length}件は要確認` : "") +
    (refWarnings.length ? `。参照lint警告 ${refWarnings.length}件は要確認` : ""),
);
