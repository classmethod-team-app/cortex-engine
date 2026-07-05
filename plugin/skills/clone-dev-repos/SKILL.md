---
name: clone-dev-repos
description: 開発リポジトリ（ソースコード・Wiki）をsubmoduleとしてクローンする
---
開発リポジトリ（ソースコード・Wiki）を git submodule として `開発/` フォルダにクローンします。

## いつ使うか

- コンテキストリポジトリのセットアップ後、ソースコードリポジトリが作成されたタイミング
- 新しい環境でコンテキストリポジトリを clone した後

## 実行手順

### 1. `.gitmodules` の URL を確認

`.gitmodules` の URL がプレースホルダーのままの場合、実際のリポジトリ URL に書き換えます。

```
[submodule "開発/src"]
	path = 開発/src
	url = https://github.com/{{開発リポ}}
[submodule "開発/wiki"]
	path = 開発/wiki
	url = https://github.com/{{開発リポ}}.wiki
```

`{{開発リポ}}`（ソースコードリポジトリの `owner/repo`）を実際の値に置き換えてください。`/setup-project` で `--開発リポ` を渡していれば埋め込み済みです。

### 2. submodule を取得

```bash
git submodule update --init
```

### 3. 変更をコミット

`.gitmodules` を書き換えた場合はコミットしてください。

## トラブルシューティング

- リポジトリがまだ作成されていない場合、submodule の取得は失敗します。リポジトリが作成されてから再度実行してください
- 認証エラーの場合は `gh auth login` でログインし直してください
- うまく動作しない場合は `.gitmodules` の URL が正しいか確認してください
