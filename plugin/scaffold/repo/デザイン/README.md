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

## DESIGN.md（デザイン版CLAUDE.md）

`DESIGN.md` は、AI（Claude Code / v0 / Figma Make / Google Stitch 等）がこの案件のUIを一貫して再生産するための**機械可読なデザイン仕様**です。Google Labs が公開したオープン仕様 [DESIGN.md](https://github.com/google-labs-code/design.md)（Apache-2.0）に準拠しているため、対応する外部AIデザインツールとそのまま互換します。

### 2層の分業

1つのファイルが2つの層に分かれています。

- **YAMLフロントマター＝デザイントークン**（色・タイポ・角丸・スペーシング）。`sync-designs` が毎晩Figmaから抽出して自動生成します。**手編集禁止**（夜間同期で上書きされます）
- **Markdown本文＝設計判断・ガードレール**（世界観・役割・やる/やらない）。人間とAIが育てる領域で、**自動生成は本文をバイト単位で保全し上書きしません**

トークンは正となる値、本文はそれを「どう適用するか」の文脈、という役割分担です（公式仕様のprose/tokensモデル）。

本文8節も夜間AI（`.github/workflows/update-design-notes.yml`）が育てます。デザイン（inventory/resources）が変わった夜に、トークン・機械抽出・サムネイルの事実に基づいて `{{ }}` プレースホルダを実文で置き換え、現状と矛盾した記述だけを最小限更新します（人間の記述は尊重されます。育成結果は git diff でレビューしてください）。

### 鉄則

- 抽象語（「プレミアム」「モダン」）で書かない。**具体値と理由で書く**
- 曖昧な語には必ず判断ルールを添える
- 短く・エージェントが追える分量に保つ

### CLI（任意）

公式linter・エクスポータが使えます（Node環境）。

```bash
# 構造・トークン参照・WCAG AAコントラストを検証する
npx -y @google/design.md@0.3.0 lint デザイン/DESIGN.md
# tokens.json（DTCG）を要する下流ツールにトークンを供給する
npx -y @google/design.md@0.3.0 export --format dtcg デザイン/DESIGN.md
```
