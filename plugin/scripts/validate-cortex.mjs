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
 *
 * 使い方: node validate-cortex.mjs（案件リポのルートで実行）
 * 終了コード: 0=違反なし（dangling参照は警告のみで終了コードに影響しない） / 1=違反あり
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import yaml from "./vendor/js-yaml.mjs"; // vendor同梱（プラグインキャッシュ内で依存インストール不要にする）

const KNOWLEDGE_DIR = "Cortex";
const META_FILES = new Set(["readme.md", "template.md"]);
const RELS = new Set(["based_on", "derived_from", "relates_to", "supersedes"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// relations.target のうち、実在を検証する型のパターン（= Gold層エンティティのみ）。
// frontmatterを持つのはGold層（Cortex/配下）だけなので、実在検証できるのは decision / term / report / overview。
// Silver/Bronzeへの参照（minute:・material:・design:・課題キー・ドキュメントID等）は
// 「規約ベースのID文字列」であり、参照先にfrontmatterアンカーを要求しない＝実在検証しない（オントロジー規約参照）。
const CHECKABLE_TARGET =
  /^(\d{8}-\d{3}$|term:|member:|report:|overview:|design:)/;

/** ディレクトリ名 → 期待されるtype */
const DIR_TYPE = {
  Decisions: "decision",
  用語集: "term",
  メンバー: "member",
  レポート: "report",
  デザイン: "design",
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
      "relations",
      "references",
    ],
    validate(fm, fileName, errors) {
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
    ],
    validate(fm, fileName, errors) {
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
  design: {
    // デザイン画面の育成ノート（Cortex/デザイン/records/）。inventory（Silverミラー）とは別レコード。
    // AI領域は <!-- cortex-auto:begin/end --> マーカーで囲み、マーカー外の人間の補足は保持する。
    required: ["type", "id", "title", "status"],
    allowed: ["type", "id", "title", "description", "status", "source", "relations"],
    validate(fm, _fileName, errors) {
      if (fm.id && !/^design:/.test(String(fm.id))) {
        errors.push(`idはdesign:{fileKey}:{nodeId}（実際: ${fm.id}）`);
      }
      if (fm.status && !["draft", "active"].includes(fm.status)) {
        errors.push(`statusはdraft|active（実際: ${fm.status}）`);
      }
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
      // エンジン設定（schema_version はマイグレーションが管理・channel は配布チャンネルの表示）
      "engine",
    ],
    validate(fm, _fileName, errors) {
      if (fm.id !== "overview:home")
        errors.push(`Homeのidはoverview:home固定（実際: ${fm.id}）`);
      if (fm.engine != null) {
        if (typeof fm.engine !== "object" || Array.isArray(fm.engine))
          errors.push("engineはマップで書く（schema_version / channel）");
        else {
          if (fm.engine.schema_version != null && !Number.isInteger(fm.engine.schema_version))
            errors.push(`engine.schema_versionは整数（実際: ${fm.engine.schema_version}）`);
          if (fm.engine.channel && !["stable", "canary"].includes(fm.engine.channel))
            errors.push(`engine.channelはstable|canary（実際: ${fm.engine.channel}）`);
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
    (warnings.length ? `。relations警告 ${warnings.length}件は要確認` : ""),
);
