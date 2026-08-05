# デザイン

デザイン（正本はFigma）をAI・人間が辿れるようにするためのディレクトリです。

## 構成

```
デザイン/
├── figma.json     # 同期対象のFigmaファイル設定（案件セットアップ時に記入）
├── inventory/     # 画面インベントリ（自動同期・手編集禁止）
│   └── {ファイル名}/{画面名}-{nodeId}.md   # 1画面1ファイル
└── DESIGN.md      # デザイン規約（デザインハーネスが育てる）
```

**画像はこのディレクトリに置きません。** 以前は同期がサムネイルPNGを `resources/` に保存していましたが、
やめました（絵の正本はFigmaにあり、ミラーに複製する理由がないため）。実機キャプチャ等を残したいときも、
ここではなく正本側（Figma・共有資料のDrive）に置いてください。同期でミラーに降りてくるのが正しい経路です。

## 仕組み: 「絵は同期せず、絵への参照を同期する」

AIに必要なのは絵そのものではなく「どんな画面が存在し、どこにあり、何と関係しているか」です。`sync-designs` が毎晩（`.github/workflows/sync-designs.yml`）、Figmaの各ページ直下のトップレベルフレームを「画面」として `inventory/` に同期します。

**画像（サムネイル）は取り込みません。** 絵を見たいときはディープリンクからFigmaを開くか、Figma MCPで当該フレームを直接読みます。閲覧権限の境界はFigma側にあるので、そのほうが正しく、リポジトリも重くなりません。

各画面のmdは本文に**安定ID `design:{fileKey}:{nodeId}`** とFigmaへのディープリンクを持ちます（frontmatterは付きません。frontmatterを持つのはGold層だけ＝オントロジー規約）。課題・議事録・DecisionsからはGold層の `relations` でこのIDを指せます:

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
- **画像はリポジトリに置かない**。絵が要るときはディープリンクからFigmaを開く

## DESIGN.md（デザイン版CLAUDE.md）

`DESIGN.md` は、AI（Claude Code / v0 / Figma Make / Google Stitch 等）がこの案件のUIを一貫して再生産するための**機械可読なデザイン仕様**です。Google Labs が公開したオープン仕様 [DESIGN.md](https://github.com/google-labs-code/design.md)（Apache-2.0）に準拠しているため、対応する外部AIデザインツールとそのまま互換します。

### 誰が育てるか

**このファイルを育てるのはデザインハーネスの `design-md` スキルです。** 成果物はこのパス（`デザイン/DESIGN.md`）に置きます。Cortexは同期しません（読んで従うだけ）。

以前は Figma の published styles からフロントマター（トークン）を毎晩機械生成していましたが、やめました。lintを通して仕上げたトークンが夜間に機械で差し替わる——1つのファイルに所有者が2人いる状態——を解消するためです。**自動更新はありません。人が `design-md` を呼んで更新します。**

このファイルが無い案件で始めるときは、エンジン同梱の雛形（`plugin/scaffold/repo/デザイン/DESIGN.md`）をコピーしてください。Cortex 既定のニュートラルテーマが入っています。

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
