#!/usr/bin/env python3
"""Figmaから画面インベントリを同期する（デザイン/inventory/ を機械生成）。

- デザイン/figma.json の files[].key を対象に、各ページ直下のトップレベルフレームを「画面」として列挙する
- 1画面1md（本文に画面名・参照ID design:{fileKey}:{nodeId}・Figmaディープリンク・更新日）。
  frontmatterは付けない（frontmatterはGold層のみ。IDは規約ベースの参照名としてGold層から張られる）
- inventory/ は同期ミラー（毎回全消し再生成・手編集禁止）。正本はFigma

**画像は取らない。** インベントリは「どんな画面がどこにあるか」を辿るための地図で、絵そのものは
Figma MCP で当該フレームを直接見る（閲覧権限の境界がFigma側にあるので、そちらのほうが正しい）。
サムネイルPNGは デザイン/resources/ に808件162MB積み上がり、しかも一度も掃除されなかった。
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
TOKEN = os.environ.get("FIGMA_TOKEN", "")
# テストから偽のFigma APIへ向けるための上書き（既定は本番）。本番の設定では触らない。
API_BASE = os.environ.get("FIGMA_API_BASE", "https://api.figma.com/v1")
FRAME_TYPES = {"FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"}


MAX_RETRIES = 5


def api(path: str):
    """Figma REST APIを叩く。429（レート超過）/5xx/一時的ネットワークエラーは再試行する。

    FigmaのTier1（files）はシート種別で上限が決まり、Dev/Fullシートでも
    Organizationプランで20回/分程度。全派生リポが同一トークン・同一cron時刻に走ると
    429に当たりうるため、429時はRetry-Afterヘッダを尊重し、それ以外の一時障害は
    指数backoff（+ランダムジッタでサンダリングハード回避）で再試行する。
    """
    url = API_BASE + path
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, headers={"X-Figma-Token": TOKEN})
        try:
            # 大きいファイル（数百画面）の全ツリー応答は60秒を超えることがあるため180秒
            with urllib.request.urlopen(req, timeout=180) as r:
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
        except (urllib.error.URLError, TimeoutError) as e:
            # 接続失敗に加え、ボディ読み取り中のソケットタイムアウト（素のTimeoutErrorで飛ぶ）も
            # 一時障害として指数backoffで再試行する
            if attempt == MAX_RETRIES - 1:
                raise
            wait = 2 ** attempt + random.uniform(0, 1)
            reason = getattr(e, "reason", e)
            print(
                f"  接続エラー({reason})。{wait:.1f}秒待って再試行 ({attempt + 1}/{MAX_RETRIES}): {path}",
                file=sys.stderr,
            )
            time.sleep(wait)


def slugify(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|#\s]+', "-", name).strip("-")
    return s or "untitled"


# 機械抽出の上限（inventory肥大を防ぐ。超過分は「…他N件」に畳む）
MAX_TEXT_LINES = 50
MAX_COMPONENT_LINES = 20


def _collect_text_and_components(node: dict, texts: list, components: list) -> None:
    """フレーム配下を再帰的に走査し、TEXTノードのcharactersとINSTANCE名を集める。

    追加のAPIコールは発生しない（全ツリーを1回取得済みのノードをメモリ内で走査するだけ）。
    """
    ntype = node.get("type")
    if ntype == "TEXT":
        chars = node.get("characters")
        if chars:
            t = re.sub(r"\s+", " ", chars).strip()  # 改行・連続空白を1つに畳んで1行化
            if t:
                texts.append(t)
    elif ntype == "INSTANCE":
        name = node.get("name")
        if name and name.strip():
            components.append(name.strip())
    for child in node.get("children", []) or []:
        _collect_text_and_components(child, texts, components)


def _dedup(seq: list) -> list:
    """出現順を保ったまま重複を除去する。"""
    seen = set()
    out = []
    for x in seq:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _extract_section(child: dict) -> str:
    """トップレベルフレーム配下から機械抽出した節（画面内テキスト・使用コンポーネント）を組み立てる。

    frontmatterは付けない（inventoryは同期ミラー。frontmatterはGold層のみ）。
    """
    texts: list = []
    components: list = []
    _collect_text_and_components(child, texts, components)
    texts = _dedup(texts)
    components = _dedup(components)
    section = ""
    if texts:
        shown = texts[:MAX_TEXT_LINES]
        section += "\n## 画面内テキスト（機械抽出）\n"
        section += "".join(f"- {t}\n" for t in shown)
        extra = len(texts) - len(shown)
        if extra > 0:
            section += f"- …他{extra}件\n"
    if components:
        shown = components[:MAX_COMPONENT_LINES]
        section += "\n## 使用コンポーネント（機械抽出）\n"
        section += "".join(f"- {c}\n" for c in shown)
        extra = len(components) - len(shown)
        if extra > 0:
            section += f"- …他{extra}件\n"
    return section



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
        # 全ツリーを1回取得する（追加APIコールを増やさない）。旧実装は ?depth=2 で
        # ページ＋トップレベルフレームまでしか取れず、フレーム配下のTEXT/INSTANCEを機械抽出できない。
        # depth指定を外して全ツリーを1コール取得し、抽出はメモリ内走査で賄う（レート制限に影響しない）。
        doc = api(f"/files/{key}")
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

        out_dir = INVENTORY_DIR / slugify(file_name)
        out_dir.mkdir(parents=True, exist_ok=True)

        for page_name, child in frames:
            node_id = child["id"]
            frame_name = child.get("name", node_id)
            safe_node = node_id.replace(":", "-")
            sid = f"design:{key}:{node_id}"
            deep_link = (
                f"https://www.figma.com/design/{key}/{urllib.parse.quote(slugify(file_name))}"
                f"?node-id={safe_node}"
            )
            md = (
                f"# {frame_name}\n\n"
                f"- ファイル: {file_name} / ページ: {page_name}\n"
                f"- 更新日: {updated_at or 'unknown'}\n"
                f"- 参照ID: `{sid}`\n"
                f"- [Figmaで開く]({deep_link})\n"
                f"{_extract_section(child)}"
            )
            (out_dir / f"{slugify(frame_name)}-{safe_node}.md").write_text(md, encoding="utf-8")
            total += 1
        print(f"{file_name}: {len(frames)} 画面")

    # DESIGN.md には触らない。フロントマターのトークン生成もここが持っていたが、DESIGN.md 全体を
    # デザインハーネスの所有物にするため撤去した（1ファイルに所有者が2人いる状態を解消する）。
    print(f"✓ 合計 {total} 画面を {INVENTORY_DIR}/ に同期しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
