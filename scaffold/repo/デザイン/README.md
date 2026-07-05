# デザイン

デザイン（正本はFigma）をAI・人間が辿れるようにするためのディレクトリです。

## 構成

```
デザイン/
├── figma.json     # 同期対象のFigmaファイル設定（案件セットアップ時に記入）
├── inventory/     # 画面インベントリ（自動同期・手編集禁止）
│   └── {ファイル名}/{画面名}-{nodeId}.md   # 1画面1ファイル
└── resources/     # サムネイルPNG・スクリーンショット
```

## 仕組み: 「絵は同期せず、絵への参照を同期する」

デザインの絵そのものはリポジトリに置けませんが、AIに必要なのは「どんな画面が存在し、どこにあり、何と関係しているか」です。`sync-designs` が毎晩（`.github/workflows/sync-designs.yml`）、Figmaの各ページ直下のトップレベルフレームを「画面」として `inventory/` に同期します。

各画面のmdはfrontmatterに**安定ID `design:{fileKey}:{nodeId}`** とFigmaへのディープリンク（`source`）を持ちます。課題・議事録・Decisionsからは `relations` でこのIDを指せます（オントロジー規約参照）:

```yaml
relations:
  - rel: relates_to
    target: "design:abc123XYZ:1023:456"
```

これによりナレッジグラフに画面ノードが現れ、クリックでFigmaの該当フレームが開きます。

## セットアップ（案件ごと）

1. `figma.json` に対象ファイルのキーを記入する（FigmaのURL `figma.com/design/{ここ}/...`）

```json
{
  "files": [{ "key": "abc123XYZ", "name": "アプリUI" }]
}
```

2. リポジトリSecretsに `FIGMA_TOKEN`（read権限のPersonal Access Token）を設定する
3. 手動で初回同期する場合は `/sync-designs` スキルを実行する

## 運用ルール

- **`inventory/` は同期ミラー**（正本はFigma）。手編集しない。毎回全再生成され、Figma側の削除・改名に追従する
- デザインの中身を深掘りしたいときは**Figma MCP**を使う（URLを渡すとデザインコンテキストを取得できる）。インベントリは「探すための地図」、MCPは「見つけた画面の深掘り」という役割分担
- その週に変わった画面は週次レポートの「デザイン更新」セクションに自動で載る
