#!/usr/bin/env python3
"""Figmaから画面インベントリを同期する（デザイン/inventory/ を機械生成）。

- デザイン/figma.json の files[].key を対象に、各ページ直下のトップレベルフレームを「画面」として列挙する
- 1画面1md（本文に画面名・参照ID design:{fileKey}:{nodeId}・Figmaディープリンク・更新日・サムネイル）。
  frontmatterは付けない（frontmatterはGold層のみ。IDは規約ベースの参照名としてGold層から張られる）
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
from collections import Counter
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


# ── DESIGN.md デザイントークン抽出 ──────────────────────────────────────────
# Figmaの実データからDESIGN.md（公式仕様 https://github.com/google-labs-code/design.md）の
# YAMLフロントマター（colors/typography/rounded/spacing）を機械生成する。
# 分業: フロントマター＝機械可読トークン（ここが生成）／本文（`---`終端以降）＝人間+AIの設計判断
# （バイト単位で保全し、絶対に触らない）。componentsはインスタンス推測の幻覚リスクが高いため生成しない。

# フロントマター先頭に必ず維持する自動生成コメント（scaffoldテンプレと一致させる）
AUTOGEN_COMMENT = "# このフロントマター（デザイントークン）は sync-designs が Figma から自動生成する（手編集しない）"

# 抽出上限（フロントマター肥大・幻覚を防ぐ）
MAX_COLORS = 16
MAX_TYPO = 15
MAX_ROUNDED = 6
MAX_SPACING = 8

# 頻度フォールバックのスケール名（値昇順で割り当てる）
ROUNDED_SCALE = ["sm", "md", "lg", "xl", "2xl", "3xl"]
SPACING_SCALE = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]

# typographyの固定フィールド順（emit順・頻度キーの安定化にも使う）
TYPO_FIELDS = [
    ("fontFamily", "str"),
    ("fontSize", "str"),
    ("fontWeight", "num"),
    ("lineHeight", "num"),
    ("letterSpacing", "str"),
]


def _fmt_num(x) -> str:
    """数値を決定的に文字列化する（整数値は整数表記・それ以外は小数3桁で丸め）。"""
    xr = round(float(x), 3)
    return str(int(xr)) if xr == int(xr) else str(xr)


def _norm_token_name(name: str) -> str:
    """published style名をトークン名へ正規化する（小文字・`/`と空白→`-`・連続`-`畳み）。

    意味の推測はしない。primary等の意味名はスタイルが実際にそう名乗っている場合だけ残る。
    """
    s = (name or "").strip().lower()
    s = re.sub(r"[\s/]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "unnamed"


def _paint_to_hex(paint: dict):
    """SOLIDペイントをhex文字列に変換する（不透明なら#RRGGBB・半透明なら#RRGGBBAA）。"""
    if not isinstance(paint, dict) or paint.get("type") != "SOLID":
        return None
    if paint.get("visible") is False:
        return None
    c = paint.get("color")
    if not isinstance(c, dict) or "r" not in c:
        return None
    r = round(c.get("r", 0) * 255)
    g = round(c.get("g", 0) * 255)
    b = round(c.get("b", 0) * 255)
    a = round(c.get("a", 1.0) * paint.get("opacity", 1.0) * 255)
    if a >= 255:
        return f"#{r:02X}{g:02X}{b:02X}"
    return f"#{r:02X}{g:02X}{b:02X}{a:02X}"


def _node_first_solid_fill_hex(node: dict):
    for p in node.get("fills") or []:
        h = _paint_to_hex(p)
        if h:
            return h
    return None


def _node_typography(node: dict):
    """TEXTノードの typeStyle から typography トークン（1レベル分）を組み立てる。"""
    st = node.get("style")
    if not isinstance(st, dict):
        return None
    fs = st.get("fontSize")
    if not fs:
        return None
    typo = {
        "fontFamily": str(st.get("fontFamily", "")),
        "fontSize": f"{_fmt_num(fs)}px",
        "fontWeight": int(st.get("fontWeight", 400)),
    }
    lh_px = st.get("lineHeightPx")
    if lh_px:
        # 単位なし乗数（推奨CSS慣行）に正規化する: lineHeightPx / fontSize
        typo["lineHeight"] = _fmt_num(lh_px / fs)
    letter = st.get("letterSpacing")
    if letter:
        # px → em（fontSize基準）に正規化する
        typo["letterSpacing"] = f"{_fmt_num(letter / fs)}em"
    return typo


def _typo_key(typo: dict) -> tuple:
    return tuple((k, typo.get(k)) for k, _ in TYPO_FIELDS)


def _walk_tokens(node: dict, acc: dict) -> None:
    """ツリーを1回走査し、published styleの実値解決と頻度集計を同時に行う（追加APIコールなし）。"""
    styles = node.get("styles")
    if isinstance(styles, dict):
        for prop, sid in styles.items():
            if sid in acc["pub_fill"] and prop in ("fill", "fills") and sid not in acc["sid_hex"]:
                h = _node_first_solid_fill_hex(node)
                if h:
                    acc["sid_hex"][sid] = h
            if sid in acc["pub_text"] and prop == "text" and sid not in acc["sid_typo"]:
                t = _node_typography(node)
                if t:
                    acc["sid_typo"][sid] = t
    # 頻度フォールバック用の集計（published stylesが無い/少ない場合に使う）
    for p in node.get("fills") or []:
        h = _paint_to_hex(p)
        if h:
            acc["fill_ctr"][h] += 1
    if node.get("type") == "TEXT":
        t = _node_typography(node)
        if t:
            key = _typo_key(t)
            acc["typo_ctr"][key] += 1
            acc["typo_map"].setdefault(key, t)
    r = node.get("cornerRadius")
    if isinstance(r, (int, float)):
        acc["radius_ctr"][round(float(r), 3)] += 1
    if node.get("layoutMode") in ("HORIZONTAL", "VERTICAL"):
        isp = node.get("itemSpacing")
        if isinstance(isp, (int, float)) and isp > 0:
            acc["space_ctr"][round(float(isp), 3)] += 1
        for pk in ("paddingLeft", "paddingRight", "paddingTop", "paddingBottom"):
            v = node.get(pk)
            if isinstance(v, (int, float)) and v > 0:
                acc["space_ctr"][round(float(v), 3)] += 1
    for child in node.get("children") or []:
        _walk_tokens(child, acc)


def _scale_by_freq(counter: Counter, scale: list, limit: int, zero_name: str = None) -> dict:
    """頻度上位（上限limit）の distinct 値を値昇順に並べ、スケール名を割り当てる。"""
    items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))
    values = sorted(v for v, _ in items[:limit])
    out = {}
    i = 0
    for v in values:
        if v == 0 and zero_name:
            out[zero_name] = f"{_fmt_num(v)}px"
            continue
        if i < len(scale):
            out[scale[i]] = f"{_fmt_num(v)}px"
            i += 1
    return out


def _extract_tokens(key: str, doc: dict) -> dict:
    """先頭Figmaファイルの全ツリー＋published stylesから DESIGN.md トークン群を抽出する。"""
    # published styles メタ（name/key/style_type/node_id）を取得。node_idはツリーのstyleId参照と一致する。
    pub_fill, pub_text = {}, {}
    try:
        meta = api(f"/files/{key}/styles").get("meta", {}).get("styles", [])
    except (urllib.error.HTTPError, urllib.error.URLError) as e:
        print(f"  published styles取得に失敗（トークンは頻度集計で代替）: {e}", file=sys.stderr)
        meta = []
    for s in meta:
        nid, name, stype = s.get("node_id"), s.get("name"), s.get("style_type")
        if not nid:
            continue
        if stype == "FILL":
            pub_fill[nid] = name
        elif stype == "TEXT":
            pub_text[nid] = name

    acc = {
        "pub_fill": pub_fill,
        "pub_text": pub_text,
        "sid_hex": {},
        "sid_typo": {},
        "fill_ctr": Counter(),
        "typo_ctr": Counter(),
        "typo_map": {},
        "radius_ctr": Counter(),
        "space_ctr": Counter(),
    }
    _walk_tokens(doc.get("document", {}), acc)

    # colors: published FILL styleを名前→hexで。解決できたものが無ければ頻度集計にフォールバック。
    colors = {}
    for sid in sorted(pub_fill):
        if sid in acc["sid_hex"]:
            colors[_norm_token_name(pub_fill[sid])] = acc["sid_hex"][sid]
    if not colors:
        items = sorted(acc["fill_ctr"].items(), key=lambda kv: (-kv[1], kv[0]))
        colors = {f"color-{i + 1}": h for i, (h, _) in enumerate(items[:MAX_COLORS])}
    else:
        colors = dict(sorted(colors.items())[:MAX_COLORS])

    # typography: published TEXT styleを名前→propsで。無ければ頻度集計にフォールバック。
    typography = {}
    for sid in sorted(pub_text):
        if sid in acc["sid_typo"]:
            typography[_norm_token_name(pub_text[sid])] = acc["sid_typo"][sid]
    if not typography:
        items = sorted(acc["typo_ctr"].items(), key=lambda kv: (-kv[1], kv[0]))
        typography = {
            f"text-{i + 1}": acc["typo_map"][k] for i, (k, _) in enumerate(items[:MAX_TYPO])
        }
    else:
        typography = dict(sorted(typography.items())[:MAX_TYPO])

    rounded = _scale_by_freq(acc["radius_ctr"], ROUNDED_SCALE, MAX_ROUNDED, zero_name="none")
    spacing = _scale_by_freq(acc["space_ctr"], SPACING_SCALE, MAX_SPACING)
    return {
        "colors": colors,
        "typography": typography,
        "rounded": rounded,
        "spacing": spacing,
    }


def _yq(v) -> str:
    """YAML用にダブルクォートする（hexの`#`・空白を含む値も安全に）。"""
    return '"' + str(v).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _serialize_tokens(tokens: dict) -> list:
    """トークン群を決定的なYAML行リストにする（キーは安定ソート済み・毎回バイト同一）。"""
    lines = []
    if tokens["colors"]:
        lines.append("colors:")
        for name, hexv in tokens["colors"].items():
            lines.append(f"  {name}: {_yq(hexv)}")
    if tokens["typography"]:
        lines.append("typography:")
        for name, typo in tokens["typography"].items():
            lines.append(f"  {name}:")
            for field, kind in TYPO_FIELDS:
                if field not in typo:
                    continue
                val = typo[field]
                lines.append(f"    {field}: {val if kind == 'num' else _yq(val)}")
    if tokens["rounded"]:
        lines.append("rounded:")
        for name, dim in tokens["rounded"].items():
            lines.append(f"  {name}: {_yq(dim)}")
    if tokens["spacing"]:
        lines.append("spacing:")
        for name, dim in tokens["spacing"].items():
            lines.append(f"  {name}: {_yq(dim)}")
    return lines


def _split_frontmatter(raw: bytes):
    """raw から (frontmatter文字列, 本文bytes) を返す。本文はバイト単位で保全する。

    frontmatterが無ければ (None, raw)。本文＝閉じ`---`行の次のバイト以降。
    """
    if not re.match(rb"^---[ \t]*\r?\n", raw):
        return None, raw
    lines = raw.split(b"\n")
    close = None
    for i in range(1, len(lines)):
        if lines[i].rstrip(b"\r").strip() == b"---":
            close = i
            break
    if close is None:
        return None, raw  # 壊れたfrontmatter: 触らず全体を本文扱いにする
    fm_text = b"\n".join(lines[1:close]).decode("utf-8", "replace")
    body = b"\n".join(lines[close + 1:])  # 閉じ`---\n`以降のバイトを厳密に復元
    return fm_text, body


def _preserved_meta(fm_text):
    """既存frontmatterから version / name をそのまま引き継ぐ（トークン群は再生成で捨てる）。"""
    version = name = None
    if fm_text:
        for line in fm_text.split("\n"):
            if re.match(r"^version:\s*", line):
                version = line.split(":", 1)[1].strip()
            elif re.match(r"^name:\s*", line):
                name = line.split(":", 1)[1].strip()
    return version, name


def _scaffold_template_path() -> Path:
    """スクリプト自身の相対位置からエンジン同梱のDESIGN.mdテンプレを解決する。"""
    # .../plugin/skills/sync-designs/scripts/sync_designs.py → parents[3] == plugin/
    return Path(__file__).resolve().parents[3] / "scaffold" / "repo" / "デザイン" / "DESIGN.md"


def write_design_tokens(key: str, doc: dict) -> None:
    """DESIGN.mdのフロントマターだけを再生成して差し替える（本文はバイト単位で不変）。

    best-effort: 失敗しても画面インベントリ同期本体は成功扱いのままにする。
    """
    design_path = DESIGN_DIR / "DESIGN.md"
    created = False
    if design_path.exists():
        raw = design_path.read_bytes()
    else:
        tmpl = _scaffold_template_path()
        if not tmpl.exists():
            print(f"  DESIGN.mdもテンプレも見つからないためトークン生成をスキップ: {tmpl}", file=sys.stderr)
            return
        raw = tmpl.read_bytes()
        created = True

    fm_text, body = _split_frontmatter(raw)
    if fm_text is None:
        # frontmatterが無い（独自形式）: 本文をバイト保全したまま先頭にfrontmatterを付ける
        body = raw

    tokens = _extract_tokens(key, doc)
    version, name = _preserved_meta(fm_text)
    file_name = doc.get("name") or key

    fm_lines = ["---", AUTOGEN_COMMENT]
    fm_lines.append(f"version: {version or 'alpha'}")
    fm_lines.append(f"name: {name if name else _yq(file_name)}")
    fm_lines.extend(_serialize_tokens(tokens))
    fm_lines.append("---")
    new_fm = ("\n".join(fm_lines) + "\n").encode("utf-8")

    if fm_text is None:
        # 元に閉じ`---\n`が無いので、本文との間に区切りの空行を1つ入れる
        new_raw = new_fm + b"\n" + body
    else:
        new_raw = new_fm + body

    if not created and new_raw == raw:
        print("  DESIGN.md フロントマター: 変更なし")
        return
    design_path.write_bytes(new_raw)
    n = sum(len(tokens[k]) for k in ("colors", "typography", "rounded", "spacing"))
    print(
        f"  DESIGN.md フロントマターを{'生成' if created else '更新'}"
        f"（colors {len(tokens['colors'])} / typography {len(tokens['typography'])} /"
        f" rounded {len(tokens['rounded'])} / spacing {len(tokens['spacing'])}、計{n}トークン）"
    )


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
    first_token_src = None  # DESIGN.mdトークンの生成元（先頭ファイルの (key, doc)）

    for idx, f in enumerate(files):
        key = f["key"]
        # 全ツリーを1回取得する（追加APIコールを増やさない）。旧実装は ?depth=2 で
        # ページ＋トップレベルフレームまでしか取れず、フレーム配下のTEXT/INSTANCEを機械抽出できない。
        # depth指定を外して全ツリーを1コール取得し、抽出はメモリ内走査で賄う（レート制限に影響しない）。
        doc = api(f"/files/{key}")
        if idx == 0:
            first_token_src = (key, doc)  # トークン源は先頭ファイルのみ
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
        BATCH = 8  # 20だと重い画面のレンダリングがFigma側でタイムアウトする実績があるため小さめに
        images: dict = {}
        all_ids = [c["id"] for _, c in frames]
        for i in range(0, len(all_ids), BATCH):
            batch_ids = ",".join(all_ids[i : i + BATCH])
            try:
                images.update(
                    api(f"/images/{key}?ids={urllib.parse.quote(batch_ids)}&format=png&scale=1").get("images", {})
                )
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
                # 特定バッチのレンダリングが繰り返しタイムアウトしても全体を殺さない（毒バッチのスキップ。
                # 該当画面のサムネイルだけ欠け、翌晩の同期で再試行される）
                detail = f"HTTP {e.code} {e.reason}" if isinstance(e, urllib.error.HTTPError) else str(getattr(e, "reason", e))
                print(f"  バッチ {i // BATCH + 1} のサムネイル取得失敗: {detail} — スキップして続行", file=sys.stderr)

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
            thumb_url = images.get(node_id)
            if thumb_url:
                thumb_path = res_dir / f"{safe_node}.png"
                try:
                    with urllib.request.urlopen(thumb_url, timeout=60) as r:
                        thumb_path.write_bytes(r.read())
                    rel = os.path.relpath(thumb_path, out_dir).replace(os.sep, "/")
                    thumb_md = f"\n![{frame_name}]({rel})\n"
                except OSError as e:
                    print(f"  サムネイル取得失敗 {frame_name}: {e}", file=sys.stderr)

            md = (
                f"# {frame_name}\n\n"
                f"- ファイル: {file_name} / ページ: {page_name}\n"
                f"- 更新日: {updated_at or 'unknown'}\n"
                f"- 参照ID: `{sid}`\n"
                f"- [Figmaで開く]({deep_link})\n"
                f"{thumb_md}"
                f"{_extract_section(child)}"
            )
            (out_dir / f"{slugify(frame_name)}-{safe_node}.md").write_text(md, encoding="utf-8")
            total += 1
        print(f"{file_name}: {len(frames)} 画面")

    # DESIGN.mdのデザイントークン（フロントマター）を先頭ファイルから機械生成する。
    # best-effort: ここでの失敗は画面インベントリ同期本体の成否に影響させない。
    if first_token_src:
        if len(files) > 1:
            print("DESIGN.mdトークンは先頭ファイルのみを源に生成します（figma.jsonに複数ファイルあり）")
        try:
            write_design_tokens(*first_token_src)
        except Exception as e:  # noqa: BLE001 — トークン生成は補助機能。同期本体を落とさない
            print(f"  DESIGN.mdトークン生成をスキップ（同期は成功扱い）: {e}", file=sys.stderr)

    print(f"✓ 合計 {total} 画面を {INVENTORY_DIR}/ に同期しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
