[English](README.md) | [Chinese](README.zh-CN.md) | [Japanese](README.ja.md) | [Español](README.es.md) | [Français](README.fr.md)

# Rin

Rin は、ターンをまたいでも使い続けられる、ターミナル中心のローカル AI アシスタントです。

チャット、ファイル編集、長期的な設定の記憶、Web 検索、定期タスク、そして Koishi 経由のチャット連携を、ひとつの入口 `rin` にまとめています。

## Rin が向いていること

Rin は、毎回使い捨てのエージェントを開くのではなく、日々の作業の中に置いて使い続けたい人のために作られています。

たとえば次のような用途です。

- ターミナルからコードベースを確認・編集する
- 安定した記憶や再利用できるスキルを持たせる
- リマインダーや定期チェックを設定する
- 作業を中断せずに最新情報を調べる
- ターミナルとチャットの両方で同じアシスタントを使い続ける

## 現在のプロジェクト状態

Rin はすでに使えますが、いまも継続的に磨いている最中です。

コアの方向性は安定しています。

- ローカルファーストのワークフロー
- 記憶と再呼び出しを標準搭載
- 定期タスクを標準搭載
- Web 検索と取得を標準搭載
- Koishi チャットブリッジ対応
- 一貫した実行・更新パス

ただし、信頼性、UX、ドキュメントはまだ継続的に改善中です。今試すなら、完成品というより進化中の製品として見るのが近いです。

## クイックスタート

インストール:

```bash
./install.sh
```

起動:

```bash
rin
```

状態確認:

```bash
rin doctor
```

## 基本コマンド

```bash
rin            # Rin を開く
rin doctor     # 状態と設定を確認
rin start      # デーモンを起動
rin stop       # デーモンを停止
rin restart    # デーモンを再起動
rin update     # インストール済み Rin ランタイムを更新
```

## Rin に頼めること

例:

- `このディレクトリを見て、重要なものを教えて。`
- `この README を書き直して。`
- `この設定ファイルを整理して。`
- `短い返答を好むことを覚えて。`
- `明日の午後にログ確認をリマインドして。`
- `このツールの最新の公式ドキュメントを調べて。`
- `このフォルダを毎時間確認して、変化があれば知らせて。`

## 標準搭載の機能

Rin には最初から次の機能があります。

- 長期記憶と再呼び出し
- 定期タスクとリマインダー
- ライブ Web 検索
- 直接 URL 取得
- subagent
- Koishi チャットブリッジ

## Rin の更新

通常のインストール済みランタイムなら、次を使います。

```bash
rin update
```

現在のアカウントで `rin` が見つからなくても、すぐに未インストールとは限りません。ランチャー所有ユーザーではないだけ、という場合がよくあります。

完全な復旧・更新フローは次を参照してください。

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)

## ドキュメント

ユーザー向け:

- [`docs/user/getting-started.md`](docs/user/getting-started.md)
- [`docs/development.md`](docs/development.md)
- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- [`docs/architecture.md`](docs/architecture.md)

agent / runtime 向け:

- [`docs/rin/README.md`](docs/rin/README.md)
- [`docs/rin/docs/capabilities.md`](docs/rin/docs/capabilities.md)
- [`docs/rin/docs/runtime-layout.md`](docs/rin/docs/runtime-layout.md)
- [`docs/rin/docs/builtin-extensions.md`](docs/rin/docs/builtin-extensions.md)

## ひとことで言うと

インストールして、`rin` を起動して、アシスタントを作業の中に住まわせる。

それが Rin の核です。
