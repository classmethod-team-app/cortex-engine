/**
 * トークンを Secrets Manager から取れるように、案件リポのスタブへ
 * `id-token: write` の宣言と、必要な secrets の受け渡しを追加する。
 *
 * 背景:
 * トークン（Figma・Backlog APIキー・外部ソース用）を設定UIから投入できるようにするため、
 * 置き場所を GitHub Actions の repo secret から Secrets Manager へ寄せた。エンジン側は
 * 実行時に Secrets Manager を見て、無ければ従来の repo secret にフォールバックする。
 *
 * **その取得には OIDC でロールを引く必要があり、OIDC の権限は「呼び出し元」で宣言しないと
 * 効かない**（権限は連鎖の中で減らせても増やせない）。呼び先が呼び出し元より広い権限を
 * 要求すると run 全体が startup_failure になり、ジョブが1つも動かない。
 * よってエンジン側は宣言せず、スタブ側に `id-token: write` を置く。
 *
 * ロールARNもスタブが渡す。渡していないとエンジン側は AWS 認証が無い状態になり、
 * 常にフォールバック（＝従来の repo secret）で動く。壊れはしないが、
 * **設定UIから投入した値が一切効かない**。
 *
 * **autoApply: false（手で適用する）**:
 * 変更内容は追記のみ・冪等・非破壊だが、**GITHUB_TOKEN は `.github/workflows/` 配下を
 * push できない**（`workflows` 権限が要り、これはジョブの permissions では付与できない）。
 * 自動適用にすると夜間の engine-migrate が毎晩 push で失敗し、しかも schema_version が
 * 前進しないので、それをゲートにしている Gold昇格・議事録生成まで静かに止まる。
 * 同じ理由で 0027（ワークフローを書き換えた回）も人手で push されている。
 *
 * 手順は scripts/apply-0031.mjs を参照（9案件へまとめて適用し、schema_version も同時に上げる）。
 *
 * 判断がつかない形の案件（permissions を持たない・ジョブレベルで独自に宣言している・
 * secrets ブロックが無い）は**その項目だけ飛ばして警告を出す**（permissions を勝手に新設すると、
 * 既定のトークン権限が丸ごと絞られて案件独自のステップを壊すため）。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export const meta = {
  to: 31,
  description:
    "スタブに id-token: write と AWS_ROLE_TO_ASSUME / ENGINE_REPO_TOKEN の受け渡しを追加（Secrets Manager からトークンを取るため）",
  autoApply: false,
};

/**
 * 呼び先のエンジンワークフローごとに、このマイグレーションで**揃っていることを保証する** secrets。
 * 既にあるものは触らない。ファイル名ではなく `uses:` の参照先で対象を同定する
 * （スタブのファイル名は案件で変えられる）。
 */
const TARGETS = {
  "sync-designs.yml": ["AWS_ROLE_TO_ASSUME", "ENGINE_REPO_TOKEN"],
  "sync-backlog.yml": ["AWS_ROLE_TO_ASSUME", "ENGINE_REPO_TOKEN"],
  "backlog-webhook-sync.yml": ["AWS_ROLE_TO_ASSUME", "ENGINE_REPO_TOKEN"],
  "fleet-status.yml": ["AWS_ROLE_TO_ASSUME", "ENGINE_REPO_TOKEN"],
};

const USES_ENGINE = /uses:\s*\S+\/cortex-engine\/\.github\/workflows\/([\w-]+\.yml)@/;
const ID_TOKEN_LINE = "  id-token: write # Secrets Manager からトークンを取得するための OIDC";

const warn = (msg) => console.log(`::warning::${msg}`);

/** ブロック本文（先頭行より深いインデントの連続行）の直後の行番号を返す */
function blockEnd(lines, start, indent) {
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === "") { i++; continue; }
    if (l.length - l.trimStart().length <= indent) break;
    i++;
  }
  // 末尾の空行はブロックの外に戻す
  while (i > start + 1 && lines[i - 1].trim() === "") i--;
  return i;
}

const indentOf = (line) => line.length - line.trimStart().length;

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

    const u = text.match(USES_ENGINE);
    if (!u) continue; // エンジンを呼んでいない（案件独自のワークフロー）
    const required = TARGETS[u[1]];
    if (!required) continue; // 今回の対象外

    const lines = text.split("\n");
    let changed = false;

    // ---- 1. permissions に id-token: write ----
    if (!/^\s*id-token:/m.test(text)) {
      const jobLevel = lines.findIndex((l) => /^\s+permissions:\s*$/.test(l));
      const topLevel = lines.findIndex((l) => /^permissions:\s*$/.test(l));
      if (jobLevel !== -1) {
        // ジョブレベルの宣言はワークフローレベルを上書きする。どちらを直すべきかの判断を勝手にしない。
        warn(`${name}: ジョブレベルの permissions があるため id-token を自動追加しませんでした。手で追加してください`);
      } else if (topLevel === -1) {
        // 新設すると既定のトークン権限が丸ごと絞られ、案件独自のステップを壊す。
        warn(`${name}: permissions ブロックが無いため id-token を自動追加しませんでした。手で追加してください`);
      } else {
        lines.splice(blockEnd(lines, topLevel, 0), 0, ID_TOKEN_LINE);
        changed = true;
      }
    }

    // ---- 2. secrets の受け渡し ----
    const missing = required.filter((s) => !new RegExp(`^\\s+${s}:`, "m").test(lines.join("\n")));
    if (missing.length) {
      const at = lines.findIndex((l) => /^\s+secrets:\s*$/.test(l));
      if (at === -1) {
        warn(`${name}: secrets ブロックが無いため ${missing.join(", ")} を自動追加しませんでした。手で追加してください`);
      } else {
        const pad = " ".repeat(indentOf(lines[at]) + 2);
        lines.splice(
          blockEnd(lines, at, indentOf(lines[at])),
          0,
          `${pad}# Secrets Manager からトークンを取得するために使う（未設定なら従来の repo secret を使う）`,
          ...missing.map((s) => `${pad}${s}: \${{ secrets.${s} }}`),
        );
        changed = true;
      }
    }

    if (changed) await fs.writeFile(p, lines.join("\n"));
  }
}
