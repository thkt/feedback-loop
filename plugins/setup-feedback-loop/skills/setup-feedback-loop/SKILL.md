---
name: setup-feedback-loop
description: JavaScript／TypeScriptのrepoへ静的検査と関連qualityテストの反復コマンド（check:feedback・test:affected・check:classification）を導入・設定する。通常の修正や、テスト分類だけの依頼には使わない。
---

# 検査と修正の反復を導入する

対象repoの既存検証を保ち、不足するツールの固定依存、診断用コマンド、全体check・CIへの接続と、Claude CodeやCodexが反復中に`check:feedback`を使う指示を用意する。新しい修正エンジンや常駐監視は作らない。

## 導入前に確認する

依頼の範囲、対象repoの指示・README・テスト方針、採用commit・設定・作業中差分を確認する。対象はnpm・BunとVitest・Bunテストである。[呼出し仕様](references/contract.md)からCLIの入力・出力・失敗条件を確認する。

CLIはスキルに同梱した`${CLAUDE_SKILL_DIR}/scripts/setup.mjs`である。`${CLAUDE_SKILL_DIR}`はこのSKILL.mdのあるディレクトリの絶対パスで、Codex等の展開しない環境ではそのパスへ書き換える。Bun 1.4.4で`bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs inspect --repo /absolute/project`のように起動する。Bunが1.4.4でなければ導入を止め、利用者にBun 1.4.4の用意を依頼する。`scripts/`の生成物は直接編集しない。

## 導入する

1. `inspect --repo /absolute/project`で既存構成を調べる。package manager・runtime・lockfile、lint・formatter・型検査・参照解析、通常テストの収集と準備、全体check・coverage・build・CIを実際のコードへ照合する。不明な項目は採用済みと推測しない。`.feedback-loop.json`の`base`を省略すると、実行のたびに`inspect`と同じ規則で比較元を決める。既定ブランチ以外へ取り込むrepoでは`base`を指定する。規則で決まらなければテストへ進まずに止まるため、比較元を利用者に確かめて指定する。
2. [ツール選定](references/tools.md)で既存ツールを優先し、不足分だけを固定版で導入する。初期候補はOxlint・Oxfmt・fallowであり、一律の採用指定ではない。`install`には、ツール選定の手順でregistryから選んだ版を渡し、devDependenciesとlockfileの差分を確認する。Bunプロジェクトの型検査は[内蔵型検査の接続手順](references/tools.md#bun内蔵の型検査を接続する)で`bun check --no-script`を候補にし、固定版の機能・既存範囲・互換性を確認して採用する。
3. [分類とrunnerの接続](references/runners.md)で通常checkの収集集合を保ち、`.feedback-loop.json`、静的検査の専用設定、診断用package scriptsを用意する。Bunでは[一覧と実行の照合](references/contract.md#導入設定)の`compare-tests`へ通常checkの`bun test`のargvを渡し、ファイル名まで一致させる。
4. `apply`へ採用した診断用コマンドを渡す。生成物とpackage scriptsの差分を確認する。既存の同名コマンドや生成物との衝突は上書きせず、未完了箇所として報告する。設定・補助ファイルの更新を再実行で自動採用しない。導入済みの生成物を更新するときは、[`apply --update`](references/contract.md)を明示する。
5. 収集集合の全テストファイルを読み、[全テストの分類](references/runners.md#全テストの分類)でquality／assuranceを判断する。ファイル名・件数・キーワードの一致だけで確認済みとしない。assuranceは`.feedback-loop.json`へ理由付きで指定する。[分類の独立評価](references/runners.md#分類の独立評価)でassuranceの指定を照合する。
6. 採用した必須検査を既存の全体checkとCIへ追加する。既存のcoverage・build・準備・全テストを保つ。`test:*`等の一括実行へ`test:affected`が混入しないよう、従来の明示集合に接続し直す。
7. 導入の確認を行う。
   - `check:feedback`を同じ環境で全段通す。各段の個別の成功では代えない。
   - 初回の`test:affected`は記録がないので全qualityを実行する。Bunではその成功で`--isolate`と採用した並列数での互換性も確かめる。
   - 通常のソースを1つ変えて`test:affected`を実行し、全件へ広げた理由が出ずに関連するqualityだけが選ばれ、assuranceが除外されることを確かめる。
   - 採用した各検査が小さな既知の違反で診断を出して非ゼロで終わり、直すと通ることを確かめ、違反を残さない。
8. [エージェントへの指示](references/agents.md)で、`apply`が`AGENTS.md`へ置いた節を確かめ、既存の検証指示と重なれば統合する。`CLAUDE.md`の検証の指示は`AGENTS.md`へ移す。共有しない`CLAUDE.local.md`だけがあれば、利用者へ`@AGENTS.md`の追加を伝える。Codexでは同じ文書のサンドボックスの扱いも確かめる。実行漏れが観測された場合だけ、同じ文書のStop hookを追加する。

## 完了と引き継ぎ

`check:feedback`を同じ環境で全段通し、対象repoの`AGENTS.md`に[エージェントへの指示](references/agents.md)の節を置くまで、導入を完了と報告しない。`CLAUDE.md`があるrepoでは、その先頭の`@AGENTS.md`も完了の条件に含める。これがないとClaude Codeは`AGENTS.md`を読まない。各段の個別の成功では、全段の通しの代わりにならない。

検査の失敗・起動失敗・解析不完全・取消・未実行を成功へ読み替えない。

`src/**`等を一括で`globalChanges`へ指定し、通常変更でも常に全qualityを実行する状態は、関連テストの絞り込みを確認したことにならない。
