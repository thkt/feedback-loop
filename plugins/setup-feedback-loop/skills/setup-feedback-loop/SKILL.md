---
name: setup-feedback-loop
description: JavaScript／TypeScriptのrepoへ静的検査と関連qualityテストの反復コマンド（check:feedback・check:affected・check:classification）を導入・設定する。通常の修正や、テスト分類だけの依頼には使わない。
---

# 検査と修正の反復を導入する

対象repoの既存検証を保ち、不足するツールの固定依存、診断用コマンド、全体check・CIへの接続と、Claude CodeやCodexが反復中に`check:feedback`を使う指示を用意する。新しい修正エンジンや常駐監視は作らない。

## 導入前に確認する

依頼の範囲、対象repoの指示・README・テスト方針、採用commit・設定・作業中差分を確認する。対象はnpm・pnpm・BunとVitest・Bunテストである。[呼出し仕様](references/contract.md)からCLIの入力・出力・失敗条件を確認する。

CLIはスキルに同梱した`${CLAUDE_SKILL_DIR}/scripts/setup.mjs`である。`${CLAUDE_SKILL_DIR}`はこのSKILL.mdのあるディレクトリの絶対パスで、Codex等の展開しない環境ではそのパスへ書き換える。Bun 1.4.4以上で`bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs inspect --repo /absolute/project`のように起動する。Bunが1.4.4より古ければ導入を止め、利用者にBun 1.4.4以上の用意を依頼する。`scripts/`の生成物は直接編集しない。

## 導入する

1. `inspect --repo /absolute/project`で既存構成を調べる。
   - `--repo`には対象の`package.json`があるディレクトリを渡す。Gitのルートより下にある場合の扱いは[呼出し仕様](references/contract.md#gitのルートより下のpackage)で確かめる。
   - 次の項目を実際のコードへ照合する：package manager・runtime・lockfile、lint・formatter・型検査・参照解析、通常テストの収集と準備、全体check・coverage・build・CI。
   - 不明な項目は採用済みと推測しない。
   - `inspect`の`base`が`null`のrepoや、既定ブランチ以外へ取り込むrepoでは、比較元を利用者に確かめ、手順3で用意する`.feedback-loop.json`の[`base`](references/contract.md#導入設定)へ指定する。
   - 次へ進む前に、各項目の照合結果と不明な項目を確かめる。前項に当たるrepoでは、比較元が決まっていることも確かめる。
2. [ツール選定](references/tools.md)に従い、既存ツールを優先して不足分だけを固定版で導入する。
   - 初期候補のOxlint・Oxfmt・fallowは必要性を個別に判断し、一律の採用指定としない。
   - `install`には、ツール選定の手順でregistryから選んだ版を渡す。
   - Bunプロジェクトの型検査は、[内蔵型検査の接続手順](references/tools.md#bun内蔵の型検査を接続する)で`bun check --no-script`を候補にし、固定版の機能・既存範囲・互換性を確認して、採用するか既存の型検査を保つかを決める。
   - 次へ進む前に、不足ツールが固定版で導入され、devDependenciesとlockfileの差分を確認したことを確かめる。Bunプロジェクトでは、型検査の採否も確かめる。
3. [分類とrunnerの接続](references/runners.md)に従い、通常checkの収集集合を保ったまま、`.feedback-loop.json`・静的検査の専用設定・診断用package scriptsを用意する。
   - Bunでは[一覧と実行の照合](references/contract.md#導入設定)の`compare-tests`へ通常checkの`bun test`のargvを渡し、ファイル名まで一致させる。
   - `missing`のうち、`test()`を持たずJUnitに出ないファイルは本文を読んで判断する。
   - 収集用コマンドなどの補助スクリプトを書く場合は、[Vitestの収集用コマンド](references/runners.md#vitestの収集用コマンド)と[導入先で書く補助スクリプト](references/runners.md#導入先で書く補助スクリプト)の書き方にする。
   - 次へ進む前に、3つが揃ったことを確かめる。Bunでは、`extra`が空で、`missing`が空か、本文で`test()`を持たないと確かめたファイルだけであることも確かめる。
4. [`apply`](references/contract.md#ファイルの配置と接続)へ採用した診断用コマンドを渡して実行する。
   - `package.json`に`check` scriptがなければ、`--check-command`で全体checkのコマンドも渡す。
   - テストが環境変数を必要とするrepoでは、`apply`の前に`check:affected`と`check:classification`を[環境変数を読み込むコマンドで包む](references/contract.md#ファイルの配置と接続)。
   - 既存の同名コマンドや生成物との衝突は上書きせず、未完了箇所として報告する。
   - 設定・補助ファイルの更新を再実行で自動採用しない。
   - 導入済みの生成物を更新するときは、[`apply --update`](references/contract.md#ファイルの配置と接続)を明示する。
   - 次へ進む前に、`apply`が終了0で終わり、生成物とpackage scriptsの差分を確認したことを確かめる。終了0でなければ進まない。衝突で止まった場合は、報告した未完了箇所を利用者が判断するまで待つ。
5. 収集集合の全テストファイルを読み、[全テストの分類](references/runners.md#全テストの分類)でquality／assuranceを判断する。
   - ファイル名・件数・キーワードの一致だけで確認済みとしない。
   - assuranceは`.feedback-loop.json`へ理由付きで指定する。
   - [分類の独立評価](references/runners.md#分類の独立評価)でassuranceの指定を照合する。
   - 次へ進む前に、全テストファイルを分類し、独立評価で同意を得たか、同意しないものを直すか人の判断へ戻したことを確かめる。
6. 採用した必須検査を既存の全体checkとCIへ追加する。
   - 既存のcoverage・build・準備・全テストを保つ。
   - `check:*`を一括実行している場合は、`check:affected`と`check:feedback`が混入しないよう、従来の明示集合に接続し直す。`check:affected`は変更がなければ非ゼロ終了する。
   - 次へ進む前に、全体checkとCIに必須検査が加わり、既存の検査が残っていることを確かめる。
7. 導入した反復コマンドの動作を確かめる。
   - `check:affected`を実行し、全qualityが実行され、assuranceが実行されないことを確かめる。Bunではその成功で、テストファイルごとの分離と`bunWorkers`の並列数での互換性も確かめる。
   - `check:feedback`を、導入先で反復に使う環境（Codexでは既定のサンドボックス）で全段通す。各段の個別の成功では代えない。
   - 関連するqualityだけが選ばれることは、導入の変更で全件になるためここでは確かめず、完了の報告で利用者へ引き継ぐ。
   - 採用した各検査が小さな既知の違反で診断を出して非ゼロで終わり、直すと通ることを確かめる。
   - 次へ進む前に、引き継ぐ確認を除く上の確認がすべて済み、確認のために入れた違反を取り除いたことを確かめる。
8. [エージェントへの指示](references/agents.md)に従い、エージェント向けの検証指示を整える。
   - `apply`が`AGENTS.md`へ置いた節を確かめ、既存の検証指示と重なれば統合する。
   - `CLAUDE.md`の検証の指示は`AGENTS.md`へ移す。
   - 共有しない`CLAUDE.local.md`だけがあれば、利用者へ`@AGENTS.md`の追加を伝える。
   - Codexでは同じ文書のサンドボックスの扱いも確かめる。
   - 実行漏れが観測された場合だけ、同じ文書のStop hookを追加する。
   - 次へ進む前に、`AGENTS.md`に検証の指示があることを確かめる。`CLAUDE.md`があるrepoではその先頭に`@AGENTS.md`があること、`CLAUDE.local.md`だけのrepoでは利用者へ伝えたことも確かめる。

## 完了と引き継ぎ

`check:feedback`を手順7の環境で全段通し、対象repoの`AGENTS.md`に[エージェントへの指示](references/agents.md)の節を置くまで、導入を完了と報告しない。`CLAUDE.md`があるrepoでは、その先頭の`@AGENTS.md`も完了の条件に含める。これがないとClaude Codeは`AGENTS.md`を読まない。

完了の報告では、導入の変更を比較元へ取り込んだ後の確認を利用者へ引き継ぐ。取り込み後に、qualityのテストが読み込み、`globalChanges`に当たらないソースを1つ、テストが通る範囲で変えて`check:affected`を実行してもらう。その実行で全件へ広げた理由が出ずに関連するqualityだけが選ばれれば、確認は済む。Bunでは、commitが変わって依存記録が採用されず、最初の実行が全件になることがある。全件になったら、commitやbranchの切替をせず、作業ツリーの同じ変更のまま再実行して確かめてもらう。最初の実行が失敗すると記録が消えるため、直してから最初の実行からやり直してもらう。導入の変更をcommit済みなら、取り込む前でも、[`--base HEAD`を付けた実行](references/contract.md#導入後の呼出しと結果)で同じ確認ができる。

検査の失敗・起動失敗・解析不完全・取消・未実行を成功へ読み替えない。

`src/**`等を一括で`globalChanges`へ指定し、通常変更でも常に全qualityを実行する状態は、関連テストの絞り込みを確認したことにならない。
