#!/usr/bin/env python3
"""Figmaから画面インベントリを同期する（デザイン/inventory/ を機械生成）。

- デザイン/figma.json の files[].key を対象に、各ページ直下のトップレベルフレームを「画面」として列挙する
- 1画面1mdで frontmatter（type: design / 安定ID design:{fileKey}:{nodeId} / Figmaディープリンク）を付与する
- サムネイルPNGを デザイン/resources/{fileKey}/ に保存する
- inventory/ は同期ミラー（毎回全消し再生成・手編集禁止）。正本はFigma
"""
import json
import os
import random
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# デザインディレクトリ名は案件でカスタマイズされ得る（例: デザイン/ ではなく Figma/）ため、
# figma.json の場所から導出する（見つからなければ既定の デザイン/）
def _find_design_dir() -> Path:
    for p in sorted(Path(".").glob("*/figma.json")):
        if "node_modules" not in p.parts:
            return p.parent
    return Path("デザイン")

DESIGN_DIR = _find_design_dir()
CONF_PATH = DESIGN_DIR / "figma.json"
INVENTORY_DIR = DESIGN_DIR / "inventory"
RESOURCES_DIR = DESIGN_DIR / "resources"
TOKEN = os.environ.get("FIGMA_TOKEN", "")
FRAME_TYPES = {"FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"}


MAX_RETRIES = 5


def api(path: str):
    """Figma REST APIを叩く。429（レート超過）/5xx/一時的ネットワークエラーは再試行する。

    FigmaのTier1（files/images）はシート種別で上限が決まり、Dev/Fullシートでも
    Organizationプランで20回/分程度。全派生リポが同一トークン・同一cron時刻に走ると
    429に当たりうるため、429時はRetry-Afterヘッダを尊重し、それ以外の一時障害は
    指数backoff（+ランダムジッタでサンダリングハード回避）で再試行する。
    """
    url = "https://api.figma.com/v1" + path
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, headers={"X-Figma-Token": TOKEN})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            # 429（レート超過）と5xx（一時障害）のみ再試行。401/404等は即中断する
            if e.code != 429 and e.code < 500:
                raise
            if attempt == MAX_RETRIES - 1:
                raise
            retry_after = e.headers.get("Retry-After") if e.headers else None
            wait = float(retry_after) if retry_after and retry_after.isdigit() else 2 ** attempt
            wait += random.uniform(0, 1)
            print(
                f"  {e.code} 受信。{wait:.1f}秒待って再試行 ({attempt + 1}/{MAX_RETRIES}): {path}",
                file=sys.stderr,
            )
            time.sleep(wait)
        except urllib.error.URLError as e:
            # 接続失敗・タイムアウト等の一時障害も指数backoffで再試行する
            if attempt == MAX_RETRIES - 1:
                raise
            wait = 2 ** attempt + random.uniform(0, 1)
            print(
                f"  接続エラー({e.reason})。{wait:.1f}秒待って再試行 ({attempt + 1}/{MAX_RETRIES}): {path}",
                file=sys.stderr,
            )
            time.sleep(wait)


def slugify(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|#\s]+', "-", name).strip("-")
    return s or "untitled"


def main() -> int:
    if not CONF_PATH.exists():
        print(f"{CONF_PATH} が無いためスキップします（このリポジトリではデザイン同期は未設定）")
        return 0
    conf = json.loads(CONF_PATH.read_text(encoding="utf-8"))
    # 雛形のプレースホルダ（{...}を含むキー）は未設定として扱う
    files = [f for f in conf.get("files", []) if f.get("key") and "{" not in f["key"]]
    if not files:
        print("figma.json が未記入（雛形のまま）のためスキップします")
        return 0
    if not TOKEN:
        print("環境変数 FIGMA_TOKEN が未設定です", file=sys.stderr)
        return 1

    if INVENTORY_DIR.exists():
        shutil.rmtree(INVENTORY_DIR)  # 同期ミラー: 削除・改名に追従するため全再生成
    total = 0

    for f in files:
        key = f["key"]
        doc = api(f"/files/{key}?depth=2")
        file_name = doc.get("name", key)
        updated_at = str(doc.get("lastModified", ""))[:10]
        frames = []
        for page in doc.get("document", {}).get("children", []):
            if page.get("type") != "CANVAS":
                continue
            for child in page.get("children", []):
                if child.get("type") in FRAME_TYPES:
                    frames.append((page.get("name", ""), child))
        if not frames:
            print(f"{file_name}: 画面（トップレベルフレーム）が見つかりません")
            continue

        # サムネイルはバッチ取得（一度に多すぎると Figma 側で "Render timeout" になるため分割）
        BATCH = 20
        images: dict = {}
        all_ids = [c["id"] for _, c in frames]
        for i in range(0, len(all_ids), BATCH):
            batch_ids = ",".join(all_ids[i : i + BATCH])
            try:
                images.update(
                    api(f"/images/{key}?ids={urllib.parse.quote(batch_ids)}&format=png&scale=1").get("images", {})
                )
            except urllib.error.HTTPError as e:
                print(f"  バッチ {i // BATCH + 1} のサムネイル取得失敗: HTTP {e.code} {e.reason} — スキップして続行", file=sys.stderr)

        out_dir = INVENTORY_DIR / slugify(file_name)
        out_dir.mkdir(parents=True, exist_ok=True)
        res_dir = RESOURCES_DIR / key
        res_dir.mkdir(parents=True, exist_ok=True)

        for page_name, child in frames:
            node_id = child["id"]
            frame_name = child.get("name", node_id)
            safe_node = node_id.replace(":", "-")
            sid = f"design:{key}:{node_id}"
            deep_link = (
                f"https://www.figma.com/design/{key}/{urllib.parse.quote(slugify(file_name))}"
                f"?node-id={safe_node}"
            )
            thumb_md = ""
            thumb_fm = ""
            thumb_url = images.get(node_id)
            if thumb_url:
                thumb_path = res_dir / f"{safe_node}.png"
                try:
                    with urllib.request.urlopen(thumb_url, timeout=60) as r:
                        thumb_path.write_bytes(r.read())
                    rel = os.path.relpath(thumb_path, out_dir).replace(os.sep, "/")
                    thumb_md = f"\n![{frame_name}]({rel})\n"
                    repo_rel = thumb_path.as_posix()
                    thumb_fm = f'thumbnail: "{repo_rel}"\n'
                except OSError as e:
                    print(f"  サムネイル取得失敗 {frame_name}: {e}", file=sys.stderr)

            md = (
                "---\n"
                "type: design\n"
                f'id: "{sid}"\n'
                f'title: "{frame_name}"\n'
                f'file: "{file_name}"\n'
                f'page: "{page_name}"\n'
                f"updated_at: {updated_at or 'unknown'}\n"
                f'source: "{deep_link}"\n'
                f"{thumb_fm}"
                "---\n\n"
                f"# {frame_name}\n\n"
                f"- ファイル: {file_name} / ページ: {page_name}\n"
                f"- [Figmaで開く]({deep_link})\n"
                f"{thumb_md}"
            )
            (out_dir / f"{slugify(frame_name)}-{safe_node}.md").write_text(md, encoding="utf-8")
            total += 1
        print(f"{file_name}: {len(frames)} 画面")

    print(f"✓ 合計 {total} 画面を {INVENTORY_DIR}/ に同期しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
