/**
 * 偽の Figma API（sync-designs のテスト用）。**別プロセスで動かす必要がある。**
 *
 * テスト本体は `execFileSync("python3", ...)` で同期実行するため、同一プロセスにサーバーを置くと
 * イベントループが止まって応答できず、Python 側が接続待ちのままハングする（一度そうなった）。
 *
 * 受けたリクエストのパスを1行1件で `REQUEST_LOG` に追記する。テストはそれを読んで
 * 「何を取りに来たか」を検証する。
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const LOG = process.env.REQUEST_LOG;
const FILE_BODY = JSON.parse(process.env.FIGMA_FILE_JSON);

const server = createServer((req, res) => {
  appendFileSync(LOG, req.url + "\n");
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/files/") && !req.url.includes("/styles")) {
    res.end(JSON.stringify(FILE_BODY));
    return;
  }
  // /images/ や /styles を叩かれたら **成功で返す**。404 を返すとスクリプトが落ち、
  // 「画像が無い」理由が取り違えられる。検証したいのは取りに来た事実そのもの。
  res.end(JSON.stringify({ images: {}, meta: { styles: {} } }));
});

server.listen(0, "127.0.0.1", () => {
  // 親はこの1行を待って baseUrl を得る
  process.stdout.write(`PORT=${server.address().port}\n`);
});
