/**
 * fetch-secret アクションのシェルロジックを、偽の `aws` コマンドを PATH に置いて実測する。
 *
 * なぜこの形か:
 *   このアクションは「取れた／無い／読めない」を取り違えると、**同期が緑のまま何もしない**
 *   という一番気づきにくい壊れ方をする。文字列を目視で確かめるのでは足りないので、
 *   実際に走らせて出力（value / source / 終了コード）を突き合わせる。
 *
 *   action.yml から `run:` ブロックを取り出して実行するため、**本番と同じ本文**を試す
 *   （テスト用にロジックを写経すると、本体を直したときに追随せず素通りする）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACTION = path.join(HERE, "..", ".github", "actions", "fetch-secret", "action.yml");

/** action.yml の `run: |` ブロックを取り出す（YAMLパーサを持ち込まずに済ませる） */
function extractRun() {
  const lines = readFileSync(ACTION, "utf8").split("\n");
  const at = lines.findIndex((l) => /^ {6}run: \|\s*$/.test(l));
  assert.notEqual(at, -1, "action.yml に `      run: |` が見つかりません");
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !l.startsWith(" ".repeat(8))) break;
    body.push(l.slice(8));
  }
  assert.ok(body.length > 5, "run ブロックが短すぎます（抽出に失敗している可能性）");
  return body.join("\n");
}

const RUN = extractRun();

/**
 * 偽の `aws` を用意して run ブロックを実行する。
 * @param sts   'ok' | 'fail'                     … 資格情報の有無
 * @param get   {out?: string, err?: string}      … get-secret-value の応答（err があれば失敗）
 */
function runAction({ sts = "ok", get = {}, kind = "figma-token", fallback = "", repo = "classmethod-internal/kc-context" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-secret-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);

  const aws = `#!/bin/bash
if [ "$1" = "sts" ]; then
  ${sts === "ok" ? "exit 0" : "exit 255"}
fi
if [ "$1" = "secretsmanager" ]; then
  echo "SECRET_ID_SEEN=$4" >> "${dir}/seen"
  ${get.err ? `echo "${get.err}" >&2; exit 254` : `cat <<'__AWS_OUT__'\n${get.out ?? ""}\n__AWS_OUT__\n  exit 0`}
fi
exit 0
`;
  writeFileSync(path.join(bin, "aws"), aws);
  chmodSync(path.join(bin, "aws"), 0o755);

  const outFile = path.join(dir, "output");
  writeFileSync(outFile, "");
  const script = path.join(dir, "run.sh");
  writeFileSync(script, RUN);

  let code = 0;
  let stdout = "";
  try {
    // GitHub の `shell: bash` は `bash --noprofile --norc -eo pipefail {0}` で起動する。
    // **-e を付けずに試すと、本番だけ落ちる分岐を素通りさせる。**
    stdout = execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outFile,
        GITHUB_REPOSITORY: repo,
        GITHUB_RUN_ID: "1",
        KIND: kind,
        FALLBACK: fallback,
      },
    });
  } catch (e) {
    code = e.status;
    stdout = (e.stdout || "") + (e.stderr || "");
  }

  const raw = readFileSync(outFile, "utf8");
  // `value<<DELIM ... DELIM` を先に切り出してから source を読む。
  // 先に source を探すと、値の中に紛れ込んだ `source=` を拾ってしまい、
  // 「注入できない」ことを確かめるテストが**自分で注入を見逃す**。
  const m = raw.match(/^value<<(\S+)\n([\s\S]*?)\n\1\n/m);
  const value = m ? m[2] : null;
  const rest = m ? raw.slice(0, m.index) + raw.slice(m.index + m[0].length) : raw;
  const source = (rest.match(/^source=(.*)$/m) || [])[1] ?? null;
  let seen = "";
  try { seen = readFileSync(path.join(dir, "seen"), "utf8").trim(); } catch {}
  return { code, stdout, value, source, seen, delim: m ? m[1] : null };
}

test("[正常系] Secrets Manager から取れたら manager", () => {
  const r = runAction({ get: { out: "figd_ABC" } });
  assert.equal(r.code, 0);
  assert.equal(r.value, "figd_ABC");
  assert.equal(r.source, "manager");
});

test("[正常系] シークレット名はリポジトリ名と種別から組み立てる", () => {
  const r = runAction({ get: { out: "x" }, kind: "backlog-api-key", repo: "classmethod-internal/kc-context" });
  assert.equal(r.seen, "SECRET_ID_SEEN=cortex/kc-context/backlog-api-key");
});

test("[正常系] 未投入（ResourceNotFound）はフォールバックへ静かに落ちる", () => {
  const r = runAction({
    get: { err: "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret." },
    fallback: "repo_secret_value",
  });
  assert.equal(r.code, 0);
  assert.equal(r.value, "repo_secret_value");
  assert.equal(r.source, "fallback");
  assert.doesNotMatch(r.stdout, /::warning::/);
});

test("[正常系] AWS認証が無ければフォールバックへ静かに落ちる", () => {
  const r = runAction({ sts: "fail", fallback: "repo_secret_value" });
  assert.equal(r.code, 0);
  assert.equal(r.source, "fallback");
  assert.equal(r.seen, ""); // 認証が無いときは get-secret-value を呼ばない
});

test("[正常系] どちらにも無ければ空で返す（呼び出し側の前提チェックがskipに倒す）", () => {
  const r = runAction({
    get: { err: "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.value, "");
  assert.equal(r.source, "none");
});

test("[異常系] 読めなかった末のフォールバックは fallback と区別する", () => {
  const r = runAction({
    get: { err: "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: not authorized" },
    fallback: "repo_secret_value",
  });
  assert.equal(r.code, 0, "フォールバックがあるうちは落とさない");
  assert.equal(r.value, "repo_secret_value");
  assert.equal(r.source, "fallback-after-error");
  assert.match(r.stdout, /::warning::/);
});

test("[異常系] 読めず、フォールバックも無くてもジョブは落とさない（大きく警告する）", () => {
  // ここで落とすと、権限をデプロイする前の移行途中に艦隊の夜間処理が一斉に赤くなる。
  // このアクションは「そのトークンが必須か」を知らないので、判断を持たない。
  const r = runAction({
    get: { err: "An error occurred (AccessDeniedException) when calling the GetSecretValue operation: not authorized" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.value, "");
  assert.equal(r.source, "unreadable", "「未投入(none)」と同じに丸めてはいけない");
  assert.match(r.stdout, /::warning::/);
});

test("[異常系] スロットリングも「無い」に丸めない", () => {
  const r = runAction({
    get: { err: "An error occurred (ThrottlingException) when calling the GetSecretValue operation" },
    fallback: "repo_secret_value",
  });
  assert.equal(r.source, "fallback-after-error");
});

test("[異常系] SecretString が無いときの文字列 None をトークンとして扱わない", () => {
  const r = runAction({ get: { out: "None" }, fallback: "repo_secret_value" });
  assert.equal(r.value, "repo_secret_value");
  assert.equal(r.source, "fallback-after-error");
});

test("[異常系] 値に改行が混ざっても GITHUB_OUTPUT に別の行を注入できない", () => {
  // `echo "value=$VALUE"` で書くと、この値は source を上書きする行を注入できてしまう。
  const r = runAction({ get: { out: "abc\nsource=injected-source\nvalue=injected" } });
  assert.equal(r.value, "abc\nsource=injected-source\nvalue=injected", "値は丸ごと1つの出力に収まる");
  assert.equal(r.source, "manager", "値の中の source= が宣言として読まれてはいけない");
});

test("[正常系] 値は必ずマスクしてから出力する", () => {
  const r = runAction({ get: { out: "figd_SECRET" } });
  const mask = r.stdout.indexOf("::add-mask::figd_SECRET");
  assert.notEqual(mask, -1, "::add-mask:: が出ていません");
});

test("[異常系] 複数行の値は行ごとにマスクする（1行目だけだと2行目以降が素で出る）", () => {
  const r = runAction({ get: { out: "line1-SECRET\nline2-SECRET" } });
  assert.match(r.stdout, /::add-mask::line1-SECRET/);
  assert.match(r.stdout, /::add-mask::line2-SECRET/, "2行目がマスク登録されていません");
});

test("[正常系] 区切り記号は毎回変わる（値の中の文字列で終端させられない）", () => {
  const a = runAction({ get: { out: "x" } });
  const b = runAction({ get: { out: "x" } });
  assert.notEqual(a.delim, b.delim);
  assert.match(a.delim, /^CORTEX_EOF_[0-9a-f]{32}$/);
});
