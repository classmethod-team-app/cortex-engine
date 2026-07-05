# 開発

このフォルダは、開発に関連するデータを集約するフォルダです。

## ⚠️ 重要: リポジトリの関係

`src/` と `wiki/` は git submodule として管理されています。GitHub Issues は**ミラーせず、GitHub 上の正本をライブ参照**します（`gh` CLI / GitHub MCP で取得可能なため、古くなるコピーを置かない方針）。

| データ      | 元リポジトリ  | 取得方法                          | URL                                          |
| ----------- | ------------- | --------------------------------- | -------------------------------------------- |
| Issues      | {{開発リポ}}      | ミラーしない（`gh` でライブ参照） | https://github.com/{{開発リポ}}/issues |
| `src/`      | {{開発リポ}}      | git submodule                     | https://github.com/{{開発リポ}}        |
| `wiki/`     | {{開発リポ}}.wiki | git submodule                     | https://github.com/{{開発リポ}}.wiki   |

submodule の取得は `/clone-dev-repos` スキル、または以下のコマンドで実行できます：

```bash
git submodule update --init
```

## ディレクトリ構成

```
開発/
├── issues/                  # GitHub Issuesへの道しるべ（ミラーしない）
│   └── README.md            # 一覧URL・gh での取得方法
├── src/                     # ソースコードリポジトリ（git submodule）
├── wiki/                    # GitHub Wiki（git submodule）
└── README.md                # このファイル
```

## GitHub CLIでの操作

このリポジトリからGitHub CLIを使う場合は、必ずソースコードリポジトリを指定してください：

```bash
# Issue の操作
gh issue list --repo {{開発リポ}}
gh issue view 123 --repo {{開発リポ}}

# PR の操作
gh pr list --repo {{開発リポ}}
gh pr view 456 --repo {{開発リポ}}
```

## ソースコード・Wikiの操作

`src/` と `wiki/` は submodule ですが、それぞれ独立した git リポジトリとして操作できます：

```bash
cd 開発/src
git status
git pull origin main
```

```bash
cd 開発/wiki
git pull origin master
```
