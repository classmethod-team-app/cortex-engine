/**
 * 案件リポのワークフロースタブを `secrets: inherit` から「明示渡し」に切り替える。
 *
 * 背景: GitHub Actions の `secrets: inherit` は **同一組織（または同一enterprise）内**の
 * reusable workflow を呼ぶときにしか機能しない。案件リポとエンジンの組織が分かれると、
 * 宣言のない secrets は1本も渡らず**すべて空文字**になる。仕様であり、他組織が管理する
 * ワークフローへ自分の secrets を丸ごと注入させないためのサプライチェーン対策。
 *
 * 症状が危険: エンジン側は「secretが空ならskip」と安全側に倒しているため、
 * **run は緑のまま全ステップが skip される**。さらに増分起点 SINCE は「直近**成功** run」基準なので、
 * この緑の skip がカーソルを前進させ、その期間を恒久的に取りこぼす（`since` 入力で backfill は可能）。
 *
 * 対処: エンジン側の `on.workflow_call.secrets:` に受け口を宣言し、スタブから名指しで渡す。
 * 組織境界に依存しなくなり、同一orgからの `inherit` も引き続き有効なので後方互換。
 *
 * 安全ガード（0013・0021・0024 と同じ保守則）:
 * - 対象は **エンジンの reusable workflow を呼ぶスタブ**のみ。案件が独自に足したワークフローは、
 *   呼び先が SECRETS_BY_WORKFLOW に無ければ触らない。
 * - 置換は `secrets: inherit` の**行が完全一致**した場合のみ。既に明示渡しに直してある案件は素通りする。
 * - 置換後は `inherit` が消えるので冪等。
 *
 * autoApply: true（テキスト置換のみ・非破壊・冪等）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 25,
  description:
    "ワークフロースタブのsecretsを inherit から明示渡しへ切り替え（組織をまたぐとinheritが届かず全ジョブが無音でskipするため）",
  autoApply: true,
};

// 呼び先のエンジンワークフローごとに、そのワークフローが宣言している secrets。
// エンジン側の `on.workflow_call.secrets:` と一致させること（増減時は新しいマイグレーションで追随する）。
const SECRETS_BY_WORKFLOW = {
  "backlog-webhook-sync.yml": ["BACKLOG_API_KEY", "BACKLOG_DOMAIN", "BACKLOG_PROJECT_KEY"],
  "engine-migrate.yml": ["ENGINE_REPO_TOKEN"],
  "fleet-status.yml": [
    "AWS_ROLE_TO_ASSUME",
    "BACKLOG_API_KEY",
    "BACKLOG_DOMAIN",
    "BACKLOG_PROJECT_KEY",
    "ENGINE_REPO_TOKEN",
    "EXTERNAL_SOURCES_TOKEN",
    "FIGMA_TOKEN",
    "SLACK_BOT_TOKEN",
  ],
  "ingest-minutes.yml": ["AWS_ROLE_TO_ASSUME", "ENGINE_REPO_TOKEN", "SLACK_BOT_TOKEN"],
  "run-harness-skill.yml": [
    "AWS_ROLE_TO_ASSUME",
    "ENGINE_REPO_TOKEN",
    "EXTERNAL_SOURCES_TOKEN",
    "HARNESS_REPO_TOKEN",
    "SLACK_BOT_TOKEN",
  ],
  "sync-backlog.yml": ["BACKLOG_API_KEY", "BACKLOG_DOMAIN", "BACKLOG_PROJECT_KEY"],
  "sync-designs.yml": ["ENGINE_REPO_TOKEN", "FIGMA_TOKEN"],
  "sync-materials.yml": ["ENGINE_REPO_TOKEN"],
  "update-design-notes.yml": ["AWS_ROLE_TO_ASSUME", "ENGINE_REPO_TOKEN"],
  "update-gold.yml": [
    "AWS_ROLE_TO_ASSUME",
    "BACKLOG_API_KEY",
    "BACKLOG_DOMAIN",
    "BACKLOG_PROJECT_KEY",
    "ENGINE_REPO_TOKEN",
    "EXTERNAL_SOURCES_TOKEN",
    "SLACK_BOT_TOKEN",
  ],
  "validate-cortex.yml": ["ENGINE_REPO_TOKEN"],
};

const INHERIT_LINE = /^([ \t]*)secrets:[ \t]*inherit[ \t]*$/m;
const USES_ENGINE = /uses:\s*\S+\/cortex-engine\/\.github\/workflows\/([\w-]+\.yml)@/;

export async function run(repoRoot) {
  const dir = path.join(repoRoot, ".github", "workflows");
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return; // ワークフローを持たない案件は何もしない
  }

  for (const name of names.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    const p = path.join(dir, name);
    const text = await fs.readFile(p, "utf8");
    if (!INHERIT_LINE.test(text)) continue;

    const uses = text.match(USES_ENGINE);
    if (!uses) continue; // エンジン以外を呼ぶワークフローには触らない
    const secrets = SECRETS_BY_WORKFLOW[uses[1]];
    if (!secrets) continue; // 未知の呼び先（案件独自・将来追加分）は触らない

    const next = text.replace(INHERIT_LINE, (_, indent) =>
      [
        `${indent}# 別orgのエンジンを呼ぶ場合 inherit は届かないため明示的に渡す（同一orgでも同じ挙動）`,
        `${indent}secrets:`,
        ...secrets.map((s) => `${indent}  ${s}: \${{ secrets.${s} }}`),
      ].join("\n"),
    );
    if (next !== text) await fs.writeFile(p, next);
  }
}
