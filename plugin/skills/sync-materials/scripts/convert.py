# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "markitdown[all]>=0.1.5",
#     "openpyxl>=3.1.5",
# ]
# ///
"""ローカルファイルをMarkdownに変換する。

依存はこのファイル先頭のPEP 723インラインメタデータで自己完結している。
`uv run` がmarkitdown等を自動で解決するため、リポジトリのpyproject.tomlに依存しない。

外部サービス（Google Drive等）からの取得は行わない。資料は手元にダウンロード or
`共有資料/` に置いたうえで、そのパスを渡して変換する。

Usage:
    # 手元/外部のファイルを 共有資料/ 配下に取り込んで変換（コピー＋md生成）
    uv run python scripts/convert.py <file_path> --dest <配置先の親dir> [--name <簡潔な名前>]

    # すでに 共有資料/ に置いたファイル（やディレクトリ）を整理して変換
    uv run python scripts/convert.py <path> --organize

    # 単発変換
    uv run python scripts/convert.py <file_path> -o <output_path>
    uv run python scripts/convert.py <file_path>            # 標準出力

--dest:     手元のファイルを <親dir>/<stem>/ にコピーし、md を生成する（元ファイルは残す）。
            --name で簡潔な名前を渡せる（省略時は元ファイル名のstem）。
--organize: ファイル名と同名のディレクトリを作成し、元ファイルを移動して変換結果を保存する。
            ディレクトリを指定した場合は配下を再帰的に走査し、未整理のファイルをまとめて変換する。

変換方式（markitdownのみ・AWS/Bedrock不要）:
    テキスト抽出可能な形式（.xlsx / .docx / .pptx / .pdf / .txt / .csv 等）
        ... markitdownでMarkdownに自動変換する。
    画像（.png / .jpg / .jpeg / .gif / .webp / .bmp / .tiff / .svg）
        ... 変換しない。生ファイルのまま置く（必要時にClaudeが直接読む）。
"""

import shutil
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from markitdown import MarkItDown

# markitdown[all] がテキスト抽出できる形式。少なくとも xlsx/docx/pptx/pdf/txt/csv を含む。
MARKITDOWN_EXTENSIONS = {
    ".xlsx",
    ".docx",
    ".pptx",
    ".pdf",
    ".txt",
    ".csv",
    ".html",
    ".htm",
    ".json",
    ".xml",
    ".rtf",
}
# 変換対象外（生のまま置く）。必要時にClaudeが直接読む。
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".svg"}


def convert(file_path: Path) -> str:
    if not file_path.exists():
        print(f"Error: ファイルが見つかりません: {file_path}", file=sys.stderr)
        sys.exit(1)
    suffix = file_path.suffix.lower()
    if suffix not in MARKITDOWN_EXTENSIONS:
        print(
            f"Error: 未対応の形式です: {file_path.suffix} "
            f"(markitdown対応形式: {', '.join(sorted(MARKITDOWN_EXTENSIONS))})",
            file=sys.stderr,
        )
        sys.exit(1)

    md = MarkItDown()
    result = md.convert(str(file_path))
    jst = timezone(timedelta(hours=9))
    now = datetime.now(jst).strftime("%Y-%m-%d %H:%M JST")
    return f"<!-- converted: {now} -->\n\n{result.text_content}"


def generate_md(original_path: Path, md_path: Path) -> None:
    """元ファイルからmdを生成する。markitdown対象のみ変換し、画像・未知形式はスキップする。"""
    suffix = original_path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        print(f"スキップ（画像は変換対象外・生のまま置く）: {original_path}", file=sys.stderr)
        return
    if suffix not in MARKITDOWN_EXTENSIONS:
        print(f"警告: 未対応の形式のためスキップ（生のまま）: {original_path}", file=sys.stderr)
        return
    if md_path.exists():
        print(f"スキップ（既に変換済み）: {md_path}", file=sys.stderr)
        return
    md_path.write_text(convert(original_path), encoding="utf-8")
    print(f"変換完了: {md_path}", file=sys.stderr)


def is_already_organized(path: Path) -> bool:
    dir_path = path.parent / path.stem
    if not dir_path.is_dir():
        return False
    md_name = path.stem + ".md"
    return (dir_path / md_name).exists()


def is_inside_organized_dir(file_path: Path) -> bool:
    return file_path.parent.name == file_path.stem


def organize_file(file_path: Path) -> None:
    # 拡張子を除いた名前のディレクトリを作り、実ファイルを移動して同居させる
    dir_path = file_path.parent / file_path.stem
    dir_path.mkdir(parents=True, exist_ok=True)
    moved = dir_path / file_path.name
    shutil.move(str(file_path), str(moved))
    generate_md(moved, dir_path / (file_path.stem + ".md"))


def reconvert_file(file_path: Path) -> None:
    generate_md(file_path, file_path.parent / (file_path.stem + ".md"))


def import_to_dest(file_path: Path, dest_dir: Path, name_override: str | None = None) -> None:
    """手元のファイルを dest_dir/<stem>/ にコピーして変換する（元ファイルは残す）。"""
    if not file_path.is_file():
        print(f"Error: ファイルが見つかりません: {file_path}", file=sys.stderr)
        sys.exit(1)
    stem = name_override if name_override else file_path.stem
    dir_path = dest_dir / stem
    dir_path.mkdir(parents=True, exist_ok=True)
    dest_file = dir_path / (stem + file_path.suffix.lower())
    shutil.copy2(str(file_path), str(dest_file))
    print(f"取り込み: {file_path} → {dest_file}", file=sys.stderr)
    generate_md(dest_file, dir_path / (stem + ".md"))


def organize(path: Path) -> None:
    if path.is_file():
        suffix = path.suffix.lower()
        if suffix in IMAGE_EXTENSIONS:
            print(f"スキップ（画像は変換対象外・生のまま置く）: {path}", file=sys.stderr)
            return
        if suffix not in MARKITDOWN_EXTENSIONS:
            print(f"警告: 未対応の形式のためスキップ（生のまま）: {path}", file=sys.stderr)
            return
        # 既に整理済みフォルダ内（{名}/{名}.ext）のファイルは、再度moveせずその場でmdを生成する
        if is_inside_organized_dir(path):
            reconvert_file(path)
            return
        organize_file(path)
        return

    if path.is_dir():
        # 配下を再帰走査。markitdown対象のみ対象にし、画像・未知形式は最初から数えない。
        targets = sorted(
            f
            for f in path.rglob("*")
            if f.is_file() and f.suffix.lower() in MARKITDOWN_EXTENSIONS
        )
        processed = 0
        for f in targets:
            if is_inside_organized_dir(f):
                # ① 既に整理済みフォルダ内 → その場で md 生成（未変換のもののみ）
                md_path = f.parent / (f.stem + ".md")
                if md_path.exists():
                    continue
                generate_md(f, md_path)
                processed += 1
            else:
                # ② ルート直下等の未整理ファイル → {stem}/ に move して md 生成
                if is_already_organized(f):
                    continue
                organize_file(f)
                processed += 1
        if processed == 0:
            print(f"変換対象の未処理ファイルはありません: {path}", file=sys.stderr)
        else:
            print(f"\n完了: {processed} 件処理", file=sys.stderr)
        return

    print(f"Error: パスが見つかりません: {path}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(
            f"Usage: python {sys.argv[0]} <path> [--dest <親dir> [--name <名前>] | --organize | -o <output_path>]",
            file=sys.stderr,
        )
        sys.exit(1)

    target = Path(sys.argv[1]).resolve()

    if "--dest" in sys.argv:
        idx = sys.argv.index("--dest")
        if idx + 1 >= len(sys.argv):
            print("Error: --dest の後に配置先の親ディレクトリを指定してください", file=sys.stderr)
            sys.exit(1)
        name_override = None
        if "--name" in sys.argv:
            nidx = sys.argv.index("--name")
            if nidx + 1 >= len(sys.argv):
                print("Error: --name の後に簡潔な名前を指定してください", file=sys.stderr)
                sys.exit(1)
            name_override = sys.argv[nidx + 1]
        import_to_dest(target, Path(sys.argv[idx + 1]).resolve(), name_override)
    elif "--organize" in sys.argv:
        organize(target)
    elif "-o" in sys.argv:
        idx = sys.argv.index("-o")
        if idx + 1 >= len(sys.argv):
            print("Error: -o の後に出力先パスを指定してください", file=sys.stderr)
            sys.exit(1)
        output_path = Path(sys.argv[idx + 1]).resolve()
        content = convert(target)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(content, encoding="utf-8")
        print(f"変換完了: {output_path}", file=sys.stderr)
    else:
        print(convert(target))
