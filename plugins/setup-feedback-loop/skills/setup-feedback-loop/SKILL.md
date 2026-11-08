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

1. `inspect --repo /absolute/project`で既存構成を調べる。package manager・runtime・lockfile、lint・formatter・型検査・参照解析、通常テストの収集と準備、全体check・coverage・build・CIを実際のコードへ照合する。不明な項目は採用済みと推測しない。`inspect`の`base`を`.feedback-loop.json`の`base`の候補にし、対象repoの既定ブランチと照合する。`base`が`null`なら、既定ブランチを利用者に確かめて指定する。`origin/main`を前提にしない。
2. [ツール選定](references/tools.md)で既存ツールを優先し、不足分だけを固定版で導入する。初期候補はOxlint・Oxfmt・fallowであり、一律の採用指定ではない。`install`には、ツール選定の手順でregistryから選んだ版を渡し、devDependenciesとlockfileの差分を確認する。Bunプロジェクトの型検査は[内蔵型検査の接続手順](references/typecheck.md)で`bun check --no-script`を候補にし、固定版の機能・既存範囲・互換性を確認して採用する。
3. [分類とrunnerの接続](references/runners.md)で通常checkの収集集合を保ち、`.feedback-loop.json`、静的検査の専用設定、診断用package scriptsを用意する。Bunでは[一覧と実行の照合](references/contract.md#導入設定)の`compare-tests`へ通常checkの`bun test`のargvを渡し、ファイル名まで一致させる。
4. `apply`へ採用した診断用コマンドを渡す。生成物とpackage scriptsの差分を確認する。既存の同名コマンドや生成物との衝突は上書きせず、未完了箇所として報告する。設定・補助ファイルの更新を再実行で自動採用しない。導入済みの生成物を更新するときは、[`apply --update`](references/contract.md)を明示する。
5. 収集集合の全テストファイルを読み、[全テストの分類](references/runners.md#全テストの分類)でquality／assuranceを判断する。ファイル名・件数・キーワードの一致だけで確認済みとしない。assuranceは`.feedback-loop.json`へ理由付きで指定する。[分類の独立評価](references/runners.md#分類の独立評価)でassuranceの指定を照合する。
6. 採用した必須検査を既存の全体checkとCIへ追加する。既存のcoverage・build・準備・全テストを保つ。`test:*`等の一括実行へ`test:affected`が混入しないよう、従来の明示集合に接続し直す。
7. `check:classification`、`test:affected`、`check:feedback`と全体checkを確認する。設定変更の影響を除いた通常のソース変更で、必要なqualityが実行され、無関係なqualityとassuranceが除外されることを確認する。Bunでは標準の一括選択と補完依存、`--isolate`と採用した並列数での全qualityの互換性を検証し、[実行結果と失敗・取消の条件](references/contract.md#導入後の呼出しと結果)も確認する。採用した各検査は正常例、小さい既知の違反、修正後の再検査で診断と非ゼロ終了を確かめ、違反を残さない。型検査は[既存の検査範囲の維持](references/typecheck.md#既存の検査範囲を保つ)も行う。依存導入・配置を再実行し、クリーンなcheckoutから固定依存だけで再現することも確認する。`check:feedback`は同じ環境で全段を通す。各段の個別の成功では代えない。
8. [エージェントへの指示](references/agents-md.md)で、`apply`が`AGENTS.md`へ置いた節を確かめ、既存の検証指示と重なれば統合する。`CLAUDE.md`の検証の指示は`AGENTS.md`へ移す。共有しない`CLAUDE.local.md`だけがあれば、利用者へ`@AGENTS.md`の追加を伝える。実行漏れが観測された場合だけ、[Claude Code](references/claude-code.md)か[Codex](references/codex.md)のhookを追加する。Codexでは同じ文書のサンドボックスの扱いも確かめる。

## 完了と引き継ぎ

`check:feedback`を同じ環境で全段通し、対象repoの`AGENTS.md`に[エージェントへの指示](references/agents-md.md)の節を置くまで、導入を完了と報告しない。`CLAUDE.md`があるrepoでは、その先頭の`@AGENTS.md`も完了の条件に含める。これがないとClaude Codeは`AGENTS.md`を読まない。各段の個別の成功では、全段の通しの代わりにならない。

検査の失敗・起動失敗・解析不完全・取消・未実行を成功へ読み替えない。

`src/**`等を一括で`globalChanges`へ指定し、通常変更でも常に全qualityを実行する状態は、関連テストの絞り込みを確認したことにならない。
