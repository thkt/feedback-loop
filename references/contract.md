# setup-feedback-loopのCLIと設定

以下のコマンドは、スキルに同梱した`${CLAUDE_SKILL_DIR}/scripts/setup.mjs`をBun 1.4.5以上で呼びます。`${CLAUDE_SKILL_DIR}`はSKILL.mdのあるディレクトリの絶対パスです。展開されない環境では、そのパスへ書き換えて実行します。`--repo`は、対象の`package.json`があるディレクトリの絶対パスです。Git checkoutの中にあれば、[Gitのルートでなくても指定できます](#gitのルートより下のpackage)。1.4.5より古いBunやNode.jsで起動すると、必要なバージョンと現在のバージョンを示して非ゼロ終了します。対象repoの日常実行に、スキルのパスやBunの追加導入を要求しません。

各操作で使えない引数を指定すると、診断を表示して非ゼロ終了し、対象repoのファイルを変更しません。

## 構成の調査

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs inspect --repo /absolute/project
```

ファイルや依存を変更せず、package manager、runtimeの指定、package scripts、既存のlint・formatter・型検査・fallow・test runner、CI定義の所在をJSONで標準出力へ返します。取得不能や不正なpackage設定は非ゼロ終了と診断で返します。

```json
{"packageManager":"bun","base":"origin/main","scripts":{"check":"bun run scripts/check.ts"},"devDependencies":{},"configFiles":["mise.toml"]}
```

| 項目 | 値 |
| --- | --- |
| `packageManager` | `"bun"`・`"npm"`・`"pnpm"`・`null`のいずれか。競合する指定や判定材料不足は`null`と診断で示し、`install`・`apply`は選択不能として止める |
| `packageManagerFrom` | 祖先のlockfileで判定したときの、そのlockfileのパスの配列。`--repo`のディレクトリで判定したときは`null` |
| `base` | 比較元の候補。`origin/HEAD`が指す先を優先し、なければ`origin/main`と`origin/master`、次に`main`と`master`のうち、1つだけあるものを返す。どちらも見つからないか、同じ段階で両方あれば`null`と診断を返す |
| `scripts`・`devDependencies`・`dependencies` | 名前と文字列値のオブジェクト。未定義なら空オブジェクト |
| `configFiles` | 実在するファイルの、`--repo`からの相対パスの文字列配列。該当なしなら空配列 |
| `runtime` | `engines`、なければ`packageManager`の値。どちらもなく、祖先で判定したときは、その祖先の`packageManager`の値。いずれもなければ`null` |
| `tools` | 依存のうち、lint・formatter・型検査・参照解析・テストの既知のパッケージ名 |
| `diagnostics` | `packageManager`・`base`を決められない理由の文字列配列。理由ごとの文は次の表のとおり |

| 状況 | 診断 |
| --- | --- |
| `packageManager`もlockfileもない | `package managerを判定できません。package.jsonのpackageManagerかlockfileが必要です` |
| `packageManager`の値に名前がない（空文字か`@`で始まる） | `package.jsonのpackageManagerの値「@4.0.0」からpackage managerを読み取れません` |
| 祖先で判定し、診断がある | 競合と未対応の診断の末尾に`（..で判定）`のように、判定に使ったディレクトリを付ける。名前を読めない診断は、`../package.jsonのpackageManagerの値…`のように祖先の`package.json`のパスで始める |
| 指定が複数のpackage managerを指す | `package managerの指定が競合しています: bun, npm` |
| 対応していないpackage managerを指す | `yarnには対応していません。対応するのはbun・npm・pnpmです` |
| `main`と`master`の両方がある | `比較元を決められません。mainとmasterの両方があります`（`origin/`の側なら`origin/mainとorigin/masterの両方があります`） |
| `origin/HEAD`も`main`も`master`もない | `比較元を決められません。origin/HEADがなく、mainもmasterもありません` |
| `origin/HEAD`の指す先がない。リモートで既定のブランチを改名した後の`git fetch --prune`がこれに当たる | `比較元を決められません。origin/HEADの指す先のorigin/masterがありません` |

`install`と`apply`は、`package managerを選択できません: `に同じ理由を続けて表示します。`check:affected`は収集の前に、実行部の`changed`はコマンドの実行の前に止まり、`比較元を決められません（origin/HEADがなく、mainもmasterもありません）。差分を取る比較元を、.feedback-loop.jsonのbase（例: "origin/main"）か、git remote set-head origin --autoで決めてください`のように表示します。`origin`のない repo では、`base`の指定だけを`（例: "main"）`の形で示します。

## 不足依存のインストール

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs install --repo /absolute/project --package oxlint@<バージョン> --package oxfmt@<バージョン> --package fallow@<バージョン>
```

`<バージョン>`には、[ツール選定](tools.md)の手順で選んだ完全なバージョンを指定します。自動導入の対象は`oxlint`・`oxfmt`・`fallow`とし、既存ツールのプラグインや型検査の追加は、スキルから対象repoの通常の依存管理で行います。

導入済みの同じ固定バージョンは変更せず、不足分を対象package managerでdevDependenciesとlockfileへ追加します。既存と異なるバージョン、範囲指定、`latest`等は自動で置換しません。無条件の依存更新やpackage managerの変更は行いません。pnpmで、`--repo`に`pnpm-workspace.yaml`があれば、`--workspace-root`を付けて追加します。pnpmは、この指定のない、workspaceのrootへの追加を拒否するためです（[pnpm addの`--ignore-workspace-root-check`](https://pnpm.io/cli/add#--ignore-workspace-root-check)）。パッケージ取得やlockfile更新の失敗は非ゼロ終了とし、成功した範囲と未完了箇所を表示します。失敗時にローカル差分を一括で巻き戻しません。

## 導入設定

導入担当は内容を確認した`.feedback-loop.json`を対象repoに用意します。この設定は分類と関連選択だけを扱います。静的検査の順序はpackage scripts、ツールごとの規則は既存の専用設定に置きます。必須項目は`runner`・`testGlobs`です。Vitestでは`collect`も必須です。ここで説明する項目以外のキーは拒否します。

```json
{
  "runner": "bun",
  "testGlobs": ["test/**/*.test.ts"],
  "prepare": ["bun", "run", "prepare:tests"],
  "bunArgs": ["--no-env-file"],
  "testArgs": ["--timeout", "15000"],
  "globalChanges": ["config/**", "scripts/**"]
}
```

`testGlobs`は通常checkの収集集合です。パスはrepo相対とし、`*`はその階層、`**`は下位階層にも対応するglobです。既存のfixture等を通常checkへ追加する指定にはしません。qualityは収集集合からassuranceを除いた集合です。`assurance`は省略時に空配列となり、収集集合の全件がqualityになります。assuranceの各要素は`{"path":"test/example.test.ts","reason":"内容を確認した指定理由"}`の形とし、実在するテストファイルを指定します。重複や集合外の指定、空の理由を拒否します。新規テストはglobに合えばqualityへ入ります。`testGlobs`は、通常checkのtest runnerがテストを収集する範囲に合わせて書きます。いま収集されるファイルだけに合わせて狭く書くと、範囲の外にテストが増えたときに食い違います。`collect`を指定したrepoでは、導入後の別の変更で`check:classification`が集合の不一致で非ゼロ終了します。`collect`を省略したBunのrepoでは、探索場所の外のテストは検出されず、qualityにも入りません。

`base`は関連選択の比較元にするGitの参照です。省略すると、実行のたびに`inspect`と同じ規則で決めます。既定ブランチ以外へ取り込むrepoでは指定します。規則で決まらなければ、収集とテストへ進まず、`.feedback-loop.json`への`base`の指定か`origin/HEAD`の設定を求めて非ゼロ終了します。`base`を Git の commit として読めない場合も、収集とテストへ進まず、`.feedback-loop.jsonのbaseをGitのcommitとして読めません: `に続けて参照を表示します。比較元と HEAD に分岐点がない場合は、収集の後に、`とHEADの分岐点を求められません: `に続けて参照を表示します。

Bunでは`collect`を省略すると、CLIが同じプロセス内でテストを一覧します。探索場所は`testGlobs`の各globの最初の`*`・`?`より前にあるディレクトリとし、重なる場所はまとめます。たとえば`test/*.test.ts`は`test`、`scripts/tests/**/*.test.ts`は`scripts/tests`、`**/*.test.ts`はrepo全体を探索します。`.test`・`_test`・`.spec`・`_spec`に拡張子`js`・`jsx`・`ts`・`tsx`・`mjs`・`cjs`・`mts`・`cts`が続くファイルをrepo相対パスで並べ、`node_modules`と`.`で始まるディレクトリは除きます。探索場所のディレクトリがなければ、その場所を示して非ゼロ終了します。内蔵の一覧で検出できるのは、この探索場所の中での名前の規則と`testGlobs`の食い違いです。

独自の収集処理があるrepoでは、`"collect": ["bun", "scripts/custom-collect.ts"]`のようにコマンドのargv配列を指定します。対象repoのcwdで実行し、標準出力へrepo相対パスのJSON文字列配列を返し、診断は標準エラーへ出します。Vitestでは[収集用コマンド](runners.md#vitestの収集用コマンド)を必ず指定します。収集の失敗、不正な出力、重複、存在しないパス、`testGlobs`との集合の差は非ゼロ終了とします。収集用コマンドの標準出力を読めないとき、収集を行う`apply`・`check:classification`・`check:affected`は、読めなかった理由と、標準出力の先頭と末尾の200文字ずつを表示して非ゼロ終了します。

`collect`を指定したrepoでも、収集結果と比べる`testGlobs`の側の集合は探索で作ります。探索場所の決め方は、`collect`を省略した場合と同じです。ただし、`.`で始まるディレクトリも探索場所にし、その下もたどります。`.git`・`node_modules`という名前のディレクトリと、その下にある探索場所は使いません。探索は、`.git`と`node_modules`の下に入りません。探索場所のディレクトリがなければ、その場所は0件とします。見つかった通常ファイルのうち、`testGlobs`に当たるものが集合になります。

`runner`は`bun`または`vitest`です。Bunは固定した実行系と`bunArgs`を使い、テストオプションには`testArgs`を渡します。Vitestは対象repoのローカル依存を使い、既存の設定・global setup・環境変数を引き継ぎます。Vitestでは`bunArgs`を指定しません。`prepare`はテスト前に必要な既存コマンドのargv配列で、省略時は空配列です。例の`prepare:tests`は、対象repoで必要な準備コマンドに置き換えます。

`bunArgs`と`testArgs`は省略時に空配列です。`bunArgs`に`--no-env-file`がある場合は、生成する`check:affected`・`check:classification`・`mutation`のpackage scriptsにもこの引数を維持します。テスト本体だけでなく、補助ファイルを起動する外側のBunも`.env`を先に読み込まないようにします。

`allowSkipped`は任意のbooleanで、省略時は`true`です。対象repoの既存checkがskip・todoを許容する場合は`true`、許容しない場合は`false`を指定します。boolean以外は入力不正として拒否します。この設定はBunとVitestの両runnerへ適用します。

`mutation`は任意のbooleanで、省略時は`true`です。`true`なら、`apply`が`@mizchi/mutator`を入れ、[改善のコマンド](mutation.md#改善のコマンド)を`mutation` scriptとして接続し、[改善の手順](mutation.md#改善の手順の呼び出し)を`scripts/feedback-loop/improve-tests.md`に置きます。Bunテストのrepoでは、`mutation`がテストに読ませるpreloadを`scripts/feedback-loop/mutation-preload.ts`にも置きます。Vitestのrepoには、preloadを置きません。`apply --update`も手順と、Bunテストのrepoではpreloadを置きます。`false`なら、どれも行いません。boolean以外は入力不正として拒否します。このキーを読む前の実行部は、`mutation`を未知のキーとして拒否します。導入済みのrepoでは、`apply --update`で`scripts/feedback-loop/`を更新してから書きます。

`commitHook`は任意のbooleanで、省略時は`true`です。`false`なら、プラグインが同梱する[commitの前のPreToolUse hook](agent-instructions.md#commitの前のpretooluse-hook)が、このディレクトリの`check:feedback`を実行しません。boolean以外は入力不正として拒否します。実行部はこの値を読むだけで、ほかの動きは変えません。このキーを読む前の実行部は、`commitHook`を未知のキーとして拒否します。導入済みのrepoでは、`apply --update`で`scripts/feedback-loop/`を更新してから書きます。

`bunWorkers`はBunの並列worker数で、省略時は4です。正の安全な整数を指定し、1なら直列に実行します。Bunは`--parallel`で起動するため、テストファイルごとに分離して実行します。前のファイルが変えたモジュールの状態とグローバルは、次のファイルへ引き継がれません。Vitestではこのキーを指定しません。`bunArgs`・`testArgs`には`--isolate`・`--no-isolate`・`--parallel`・`--no-parallel`を指定しません。

`globalChanges`はquality全件へ広げる入力のglob配列、`dependencies`は入力とテストの対応を指定する配列で、どちらも省略時は空配列です。`dependencies`の各要素は`{"inputs":["data/*.json"],"tests":["test/example.test.ts"]}`の形で、どちらの配列も空にできません。`tests`には収集集合内のテストを指定します。補う範囲の判断は[関連選択の補い方](runners.md#関連選択を補う)に従います。

`ignoredChanges`は、テストに影響しない入力のglob配列で、省略時は空配列です。たとえば`["docs/**", "*.md"]`です。どのテストにも届かない変更は全qualityへ広げますが、このglobに当たる変更は広げる理由にしません。この設定はBunとVitestの両runnerへ適用します。

| globに当たる変更 | 扱い |
| --- | --- |
| `globalChanges`か`dependencies`に当たるか、依存関係でテストに届く | globに当たらない変更と同じく、選択に使う |
| 変更がglobに当たるものだけ | テストを実行せず、`変更なし: ignoredChangesに当たる変更だけのため、テストを実行していません`を表示して終了0にする。影響しないと宣言した変更なので、実行するテストがないことを失敗にしない |
| 変更がglobに当たるものだけで、依存記録のないqualityがある。Vitestでは`experimental.recordDependencies`を有効にしたrepo、Bunでは依存記録を使える状態がこれに当たる | 依存記録のないqualityを実行し、`変更なし:`は表示しない。そのqualityが変更したファイルを読むか分からないためである |
| 変更がglobに当たるものだけで、Bunで依存記録を使えない | 依存記録の理由で全qualityを実行する |

## 一覧と実行の照合

導入時は、通常checkが実行する`bun test`のargvを導入担当AIがコードから確認し、次の操作で分類の`all`と実行されたファイルを照合します。

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs compare-tests --repo /absolute/project -- bun test ./test
```

CLIがJUnitの出力引数を足して実行し、`{"missing":[],"extra":[]}`なら終了0、差があれば終了1を返します。`missing`は一覧にある未実行のファイル、`extra`は一覧にない実行済みのファイルです。テストが失敗してもJUnitがあれば照合し、一時ファイルは操作後に削除します。比較のコマンドが終わった後にJUnitが無ければ、`比較のコマンドがJUnitを書かずに終わりました`を表示して非ゼロ終了します。`bun test`がSIGINT・SIGTERM・SIGHUPのほかのシグナルで終わったときは、その前に`コマンドが<シグナル>で終わりました`を表示します。`test()`を1件も持たないファイルはJUnitに出ず`missing`に出るため、本文を読んで判断します。

## ファイルの配置と接続

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs apply --repo /absolute/project --feedback-command 'bun run lint:feedback && bun run format:feedback && bun run check:unused && bun run check:affected'
```

`apply`は`.feedback-loop.json`を読み、対象repoで実行できる補助ファイルを`scripts/feedback-loop/`へ配置します。Bunのrunnerでは、スキルに同梱した記録器も配置します。`mutation`を接続するときに配置するファイルは、[`.feedback-loop.json`の`mutation`](#導入設定)のとおりです。

`package.json`へ`check:affected`、`check:classification`、`check:feedback`を接続します。`.feedback-loop.json`の`mutation`が`true`なら、`mutation`も接続します。`check:affected`・`check:classification`・`mutation`の実行系は同じで、Vitestのrepoは`node`、Bunテストのrepoは`bun`です。標準出力のJSONの`scripts`は接続したコマンドです。`check:feedback`の値は`--feedback-command`で指定した診断用コマンドです。自動修正用の`format`・`lint:fix`は別の明示操作として用意します。全体checkとCIは導入担当が既存構成へ接続し、このコマンドが任意のCI定義を推測で書き換えることはしません。

テストが環境変数を必要とするrepoでは、`apply`の前に`check:affected`と`check:classification`を、環境変数を読み込むコマンドで包んで`package.json`へ書きます。`mutation`を接続するrepoでは、`mutation`も包みます。`mutation`は`bunArgs`のスクリプトを使えないため、`bunArgs`でスクリプトに環境変数を設定させるrepoも、そのスクリプトを`bunArgs`から外し、同じスクリプトでscriptを包みます。たとえば`dotenv -e .env.sample -- node scripts/feedback-loop/runtime.mjs affected`です。既存のscriptが生成するコマンドを含んでいれば、`apply`は衝突とせずに保持し、`apply --update`も差分として表示しません。`check:feedback`だけを包むと、診断が案内する`check:affected`の再実行が、環境変数のないまま動いて失敗します。

`apply`は`AGENTS.md`がなければ「変更後の確認」の節だけのファイルを作り、あれば末尾へ節を足します。同じ見出しがあれば、内容を変えずに保持したことを表示します。節の`check:feedback`の呼出しは対象package managerに合わせます。

節に記載する全体checkは`--check-command '<全体checkのコマンド>'`で指定します。省略時は、対象`package.json`に`check` scriptがあれば`<package manager> run check`を使います。なければ、どのファイルも変更せず、`--check-command`での指定を求めて非ゼロ終了します。

`CLAUDE.md`と共有しない`CLAUDE.local.md`の扱い、既存の検証指示との統合は、[CLAUDE.mdとの関係](agent-instructions.md#claudemdとの関係)の表に従います。

テストの前提になる準備（codegen・依存の照合・型検査など）は`prepare`に置き、それ以外の静的検査は`check:feedback`に置きます。同じ段を両方に置きません。

`check:affected`の名前は`test:`で始めません。`test:*`を一括実行するrepoで、変更がなければ非ゼロ終了するこのコマンドが全テストの実行に混ざるためです。`check:*`を一括実行するrepoでは、`check:affected`と`check:feedback`を除く明示集合へ接続し直します。

`mutation`の名前は`check:`でも`test:`でも始めません。一括実行に混ざると、引数のないまま起動して止まるか、壊し方の数だけテストを実行するためです。生成するコマンドを含まない`mutation` scriptが既にあれば、`apply`はほかのscriptと同じく衝突として止まり、`.feedback-loop.json`の`mutation`を`false`にすれば接続しないと示します。

[`mutation`](#導入設定)を接続するとき、`apply`はscriptを書く前に、[改善のコマンド](mutation.md#改善のコマンド)が起こす`@mizchi/mutator`を、対象package managerでdevDependenciesとlockfileへ固定バージョンで入れます。バージョンは、スキルを生成したfeedback-loopの`devDependencies`のバージョンで、`導入: `の行に表示します。パッケージの取得にネットワークを使います。

| 導入先の`@mizchi/mutator` | 扱い |
| --- | --- |
| devDependenciesにもdependenciesにもない | 入れる。導入後のdevDependenciesにそのバージョンがなければ非ゼロ終了する。package managerの失敗も非ゼロ終了とし、[不足依存のインストール](#不足依存のインストール)と同じく部分変更を保持する |
| devDependenciesとdependenciesのうち、入っている方がどれも同じバージョン | 入れ直さない |
| devDependenciesかdependenciesに、違うバージョンか範囲の指定で入っている | どのファイルも変えず、`既存のバージョンを置換しません: @mizchi/mutator=<既存の指定>。`に続けて、バージョンをそろえるか`.feedback-loop.json`の`mutation`を`false`にするよう示して非ゼロ終了する。`mutation`はmutatorの公開されていない型検査の関数を使うため、置き換えない |

`apply`は、scriptと生成物の衝突と`@mizchi/mutator`のバージョンを確かめ、`AGENTS.md`・`CLAUDE.md`に書く内容を決めてから、`@mizchi/mutator`を入れます。確かめる段で止まれば、`package.json`とlockfileは変わりません。`package.json`には、`@mizchi/mutator`を入れた後の内容の上にscriptsを足して書きます。

`mutation`を実行するときは、`@mizchi/mutator`のバージョンを確かめません。

導入済みの生成物の更新は`apply --update`で明示します。`AGENTS.md`・`CLAUDE.md`は変更しません。

```bash
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs apply --update --repo /absolute/project
```

生成物の2行目には、`// バージョン: <バージョン>`の形で、生成したプラグインの`plugin.json`の`version`があります。`apply --update`は、配置済みの生成物と同梱版のバージョンを、この行で比べます。

| 配置済みの生成物 | 扱い |
| --- | --- |
| 同梱版と内容が同じ | 変更しない。どの生成物も同じなら、`生成物は最新です（<バージョン>）。変更しません`を表示する |
| バージョンが同梱版より新しい | どのファイルも変更せず、`配置済みの生成物が、このプラグインのバージョン（<バージョン>）より新しいため、どのファイルも更新しません。プラグインを更新してから再実行してください: `に続けて、対象のパスと配置済みのバージョンを表示して非ゼロ終了する |
| バージョンが同梱版と同じか古い。バージョンの行がない生成物も、これに当たる | 内容が違えば、gitの状態で判定して置き換える |
| 存在しない | 配置する |

改善の手順`improve-tests.md`にはバージョンの行がなく、`apply --update`はバージョンを比べずに、内容が違えばgitの状態で判定して置き換えます。古いバージョンのプラグインで置き換えることは、同じ実行の`runtime.mjs`のバージョンの確認が止めます。

古いバージョンのプラグインの生成物へ戻すときは、配置済みの生成物を削除してから`apply --update`を実行します。存在しない生成物は配置するためです。

内容の違う生成物はgitの状態で判定します。未コミットの変更または未追跡のファイルがあれば、どのファイルも変更せず、対象のパスと、コミットするか変更を戻してから再実行する案内を表示して非ゼロ終了します。コミット済みの生成物は手編集を含めて置き換えます。差分はgitで確認し、戻せます。

`package.json`は変更せず、接続先との差分を表示します。`mutation`が`true`で、`mutation` scriptのない導入先では、`mutation`の差分も表示します。`@mizchi/mutator`は入れません。差分を採用するときは、`apply --update`の後に、導入時と同じ引数のうち`--feedback-command`だけを今の`check:feedback`の値にして、`apply`を再実行します。導入の後に`check:feedback`を直した導入先で導入時の値を渡すと、`既存コマンドと衝突しています: check:feedback`で止まります。生成物が最新なら、`apply`は`@mizchi/mutator`を入れ、足りない`mutation`を接続します。差分の採用は導入担当が判断します。同梱版から外れた生成物は消しません。`runner`をBunから変えた場合の`record-modules.ts`がこれに当たります。

同じ設定・同じ生成元で再実行した場合は内容を変えません。既存の同名コマンドや生成物が指定内容と食い違う場合は、上書き前に対象と理由を示して非ゼロ終了します。無関係なローカル変更は保持します。入力不正と既知の衝突はファイルの配置前に検出します。OS・インストール障害を含む操作全体の原子性は要求せず、途中失敗した内容を明示します。

## Gitのルートより下のpackage

`package.json`がGitのルートより下にあるrepoでは、`--repo`にそのディレクトリを指定します。Git checkoutの外のディレクトリと、`package.json`のないディレクトリは、変更前に診断を表示して非ゼロ終了します。

| 対象 | 扱い |
| --- | --- |
| `.feedback-loop.json`・`scripts/feedback-loop/`・package scripts・`.feedback-loop-records/` | `--repo`のディレクトリに置く。パスはそのディレクトリからの相対で書く |
| `inspect`の`configFiles` | `--repo`のディレクトリに加えて、Gitのルートの設定ファイルと`.github/workflows`を読む。Gitのルートの分は`../.github/workflows/ci.yml`のように`--repo`からの相対パスで返す |
| `AGENTS.md`・`CLAUDE.md` | Gitのルートのファイルを扱う。節のコマンドは`cd workspace && npm run check:feedback`の形になり、対象を「`workspace/`のコードやテスト」と書く |
| `--check-command` | 指定した文字列をそのまま節へ書く。ディレクトリの移動が必要なら、指定に含める |
| package managerの判定 | `--repo`のディレクトリの`package.json`の`packageManager`とlockfileで判定する。どちらもなければ、Gitのルートまでの祖先のうち、lockfileがあるいちばん近いディレクトリで判定する。そのディレクトリのlockfileと、`package.json`の`packageManager`を使う。lockfileをworkspaceのルートに置く構成がこれに当たる。`inspect`は、判定に使ったlockfileを`packageManagerFrom`と`configFiles`に、祖先の`packageManager`を`runtime`に返す。`--repo`のpackageがそのworkspaceに属することは確かめない。導入担当が`packageManagerFrom`を見て確かめる |
| 祖先のlockfileの変更 | `--repo`のディレクトリにlockfileがなければ、導入時に判定したpackage managerのlockfileを祖先から探し、いちばん近いものの変更と削除で全qualityを実行する。未追跡のものも含む。理由に`../pnpm-lock.yaml`のようにパスを表示する。ほかのpackage managerのlockfile、いちばん近いものより遠い祖先のlockfile、`--repo`のディレクトリにlockfileがある場合の祖先のlockfileは、外の変更として扱う |
| 関連選択の変更 | `--repo`のディレクトリの中の変更を数える。祖先のlockfileを除く外の変更は、全qualityへ広げる理由にしない。他のpackageの変更が大半のためで、中の届かない変更を広げない場合は`ignoredChanges`で宣言する |
| 外にある追跡済みファイルの変更（Vitest） | importでつながるqualityだけを選ぶ。どのテストにも届かず、中の変更もなければ、変更なしとして非ゼロ終了する。削除したファイルも、importしているテストを選ぶ。未追跡のファイルは対象にしない |
| 外にあるファイルの変更（Bun） | 中の変更がなければ、変更なしとして非ゼロ終了する。中の変更があり、外のファイルが依存記録に載っていれば、全qualityを実行する |

1つのrepoに複数のpackageがある場合は、packageごとに`apply`を実行します。2つ目以降は`AGENTS.md`に同じ見出しがあるため節を足しません。導入担当が節を統合します。

## 導入後の呼出しと結果

```sh
bun run check:classification
bun run check:affected
bun run check:feedback
bun run check
```

npmプロジェクトでは同じscript名を`npm run`で、pnpmプロジェクトでは`pnpm run`で呼びます。`check:classification`は、一覧と`testGlobs`の集合の一致、assuranceの重複・集合外・存在しない指定・空の理由を機械検査します。`prepare`は実行しません。集合が一致しなければ、片方にしかないパスを向きごとに表示して非ゼロ終了します。収集にあって`testGlobs`に当たらないパスには、直し方を続けて表示します。テストなら、`.feedback-loop.json`の`testGlobs`へそのパスに当たるglobを足します。globに当たるテストは、`assurance`へ登録しなければqualityになります。テストでなければ、収集に入らないようにします。`collect`を指定していれば収集用コマンドの出力から外し、指定していなければファイルの名前を変えます。

成功すると、`分類: all 3件、quality 2件、assurance 1件（パスの一覧: bun run check:classification --json）`の形で、件数を1行で表示します。括弧の中は、パスの一覧を出す呼び方です。`--json`を付けると、件数の行の代わりに、`all`・`quality`・`assurance`のパス配列を持つJSONを標準出力へ出します。再実行の案内も`--json`を含みます。

| package manager | 呼び方 |
| --- | --- |
| npm | `npm run check:classification -- --json`。`--`を省くと、npmが`--json`を自分の設定として読み、scriptへ渡さない。件数の行を表示して終了0になる |
| pnpm | `pnpm run check:classification --json` |
| Bun | `bun run check:classification --json` |

`--json`以外の引数があれば、`classificationの指定は--jsonだけです: `に続けて引数を表示して非ゼロ終了します。

診断の`再実行: `に続くコマンドのscript名は、次の順で決めます。

1. `package.json`に、`apply`が接続する名前（`check:affected`・`check:classification`）があれば、その名前を使う。どのscriptから実行しても同じである。
2. なければ、`package.json`から、`scripts/feedback-loop/runtime.mjs`の同じ操作を呼ぶscriptを探す。実行部のパスを引用して書いたscriptも、これに当たる。package managerが実行したscript、`test:affected`、ほかのscriptの順に調べ、最初に見つかった名前を使う。`test:affected`のままの導入先がこれに当たる。
3. 見つからなければ、`apply`が接続する名前を使う。

`check:affected`は、`check:classification`と同じ収集と分類の構造を検査してから、Gitの変更と設定された関連選択からqualityを実行します。候補数・選択数・全件へ広げた理由を表示します。比較元が取得できない等の選択不能を、実行成功へ読み替えません。部分実行の成功は全体checkの成功ではありません。

Vitestの`experimental.recordDependencies`を有効にしたrepoでは、`check:affected`はimport graphと依存記録の両方で照会し、どちらかで届くテストを選びます。依存記録は手元のキャッシュにあり、取り込んだ変更でimportが増えても、次にテストを実行するまで古いままです。import graphは、実行時に組み立てたパスのimportを追えません。依存記録のないqualityのテストは、Vitestの決まりに合わせて、変更によらず選びます。

`check:affected`は、引数`--base <参照>`を受け取ります。`--base=<参照>`の形でも受け取ります。複数あれば、最後のものを使います。指定すると、その実行だけ、`.feedback-loop.json`の`base`と既定の規則より優先して、その参照を比較元にします。出力に`比較元: <参照>（実行時の指定）`を表示します。ほかの引数は読みません。

npmでは`npm run check:affected -- --base HEAD`、pnpmとBunでは`pnpm run check:affected --base HEAD`の形で渡します。診断が案内する再実行のコマンドは、同じ`--base`を含みます。

`check:affected`と`changed`を1つのscriptから呼ぶときは、環境変数`FEEDBACK_LOOP_BASE`で比較元を指定します。package managerは、scriptの名前の後に足した引数を、scriptの本文の末尾にだけ付けます。`&&`でつないだscriptでは、`--base`は最後のコマンドにしか届きません。環境変数は、つないだscriptにも入れ子のscriptにも届き、npm・pnpm・Bunで同じ書き方になります。

```bash
FEEDBACK_LOOP_BASE=HEAD npm run check:feedback
```

| 項目 | 扱い |
| --- | --- |
| 優先順位 | `--base`、`FEEDBACK_LOOP_BASE`、`.feedback-loop.json`の`base`、既定の規則の順に使う。scriptの本文に書いた`--base`も、`FEEDBACK_LOOP_BASE`より優先する |
| 表示 | `比較元: <参照>（FEEDBACK_LOOP_BASEの指定）` |
| 再実行の案内 | `FEEDBACK_LOOP_BASE=<参照> `を先頭に付ける。`--base`も指定した実行では付けない |
| 値が空 | `FEEDBACK_LOOP_BASEには参照を指定してください`を表示して非ゼロ終了する。未設定の変数を展開した指定が、これに当たる |
| 参照を読めない、分岐点がない | `--base`と同じ診断を、`FEEDBACK_LOOP_BASEに指定した参照`を主語にして表示する |

指定は、1回のコマンドに付けます。`export`したままにすると、その後の実行すべての比較元が変わります。Bunは`.env`を読み込むため、Bunのrepoでは`.env`に書いた`FEEDBACK_LOOP_BASE`も比較元になります。`.env`には書きません。前後の空白は、参照に含めません。実行部は、読んだ指定を、起動するコマンドへ引き継ぎません。テストや`prepare`が別のrepoで実行部を起動しても、同じ参照を読まないようにするためです。

| 状況 | 診断 |
| --- | --- |
| 参照をGitのcommitとして読めない。参照がない、`^HEAD`のような除外の指定、`-`で始まる名前がこれに当たる | `--baseに指定した参照をGitのcommitとして読めません: `に続けて参照を表示する。gitが理由を示せば、括弧に入れて続ける |
| 参照とHEADに分岐点がない。浅いcloneや、履歴を共有しないbranchがこれに当たる | `--baseに指定した参照とHEADの分岐点を求められません: `に続けて参照を表示する |
| `--base`に参照がない | `--baseには参照を指定してください: `に続けて引数を表示する |
| npmで`--`を付けずに`--base`を渡した。npmは`--base`を自分の設定として読み、参照だけを渡す。`check:feedback`のように`check:affected`を呼ぶscriptへ渡した場合も同じである | `npmが--baseを自分の設定として読み、参照だけを渡しました`に続けて、渡った引数と書き方を表示する |

参照を読めない場合と引数の誤りは、収集とテストへ進まず非ゼロ終了します。分岐点がない場合は、収集の後に非ゼロ終了します。

`assurance`に指定したテストファイルは、変更されても`check:affected`の実行対象に選ばず、全qualityへ広げる理由にもしません。assuranceは全体checkとCIが実行するためです。変更にassuranceのテストファイルがあれば、`assuranceのテストファイルは、このコマンドの実行対象に選びません。全体checkとCIで実行します: `に続けてそのパスを表示します。この扱いはBunとVitestの両runnerへ適用します。

| 変更の内容 | 扱い |
| --- | --- |
| assuranceのテストファイル、`ignoredChanges`に当たる変更、壊し方の記録ファイル、Vitestでassuranceのテストだけがimportするファイルだけ。次の行の、記録ファイルだけの変更を除く | テストを実行せず、`変更なし: `に続けて理由を表示して終了0にする。依存記録のないqualityがあれば、そのqualityを実行し、`変更なし:`は表示しない。Bunで依存記録を使えなければ、依存記録の理由で全qualityを実行する |
| 壊し方の記録ファイル`mutator.accepted.json`だけ | テストを実行せず、`変更なし: 壊し方の記録ファイルの変更だけのため、テストを実行していません`を表示して終了0にする。依存記録のないqualityの有無と、依存記録を使えるかによらない。Vitestでは、`--repo`の外の変更もないときに限る。`ignoredChanges`に書かなくてよい。記録ファイルを読むqualityも選ばないため、そのqualityを実行するには、`dependencies`の`inputs`に記録ファイルを、`tests`にそのテストを書く。書いたrepoでは、記録ファイルの変更で対応するqualityを選ぶ |
| assuranceのテストファイルか、assuranceのテストがimportするファイルが、`dependencies`の対応、Vitestのimport、Bunの依存記録のいずれかでqualityに届く | 届くqualityを実行する |
| 全qualityへ広げる変更 | 全qualityを実行する。届く先のない変更、`globalChanges`に当たるassuranceのテストファイル、`dependencies`の対応先がassuranceだけの入力、Vitestで読み込みに失敗するassuranceのテストだけがimportするファイル、Bunでassuranceのテストだけがimportするファイルがこれに当たる。Bunの最後の場合は、`check:affected`がassuranceを実行しないため、assuranceの依存記録がない |

Vitestで、assuranceのテストにしか届かない変更があれば、`assuranceのテストにしか届かない変更は、このコマンドでは確かめません。全体checkとCIで実行します: `に続けてパスを表示します。

`check:affected`の`prepare`が失敗すると、診断を表示して非ゼロ終了し、テスト本体へ進みません。`package.json`、使用するlockfile、`tsconfig.json`、分類設定、関連選択器自体の変更では全qualityへ広げます。各変更の影響先を確認できない場合や、実行時の依存記録を信頼できない場合も全qualityへ広げます。理由は`quality全件の理由: `に続けて、変更したファイルのパス、依存記録の理由の順に表示します。依存記録の理由が`依存記録がありません`か`依存記録が古いため採用しません`なら、実行したテストの記録が書き直されます。commitやbranchを切り替えずに、作業ツリーの同じ変更のまま再実行します。記録ファイルを読めないか形が不正な場合は、そのパスを含む理由を表示します。

実行したテストが成功し、対象repoのskip等の扱いを満たした場合だけ終了0にします。`allowSkipped: true`でも、選択したテストがすべてskip・todo等で実行されなければ、未実行として診断を示し非ゼロ終了します。`false`では一部でもskip・todoがあれば非ゼロ終了します。変更なし、候補0件、選択不能、起動・解析・実行の失敗、取消も非ゼロとし、診断で区別します。`ignoredChanges`に当たる変更、壊し方の記録ファイル`mutator.accepted.json`の変更、assuranceのテストファイルの変更、assuranceのテストにしか届かない変更だけの場合は例外で、終了0にします。届く先があるかどうかは`prepare`の後に判定するため、テストを実行しない場合も`prepare`は実行されます。Vitestで`--repo`の外の変更だけがあり、変更なしとして非ゼロ終了する場合も、`prepare`は先に実行されます。

`check:affected`は、選んだテストを対象repoのtest runnerで実行します。実行環境の負荷が高いと、テストがタイムアウトで失敗します。たとえば、DBを使うテストのhookがタイムアウトします。次の2点がそろえば、関連選択ではなく負荷による失敗です。

- 失敗するファイルが、実行のたびに変わる
- 失敗したファイルだけを単独で実行すると、成功する

負荷は、`check:affected`の実行の仕方からも生じます。Bunでは`bunWorkers`の数だけ並列に実行するため、通常checkが直列なら`bunWorkers`を下げます。通常checkがタイムアウトを延ばしていれば、同じ値を`testArgs`へ指定します。

関連選択の失敗は、選択不能・変更なし・候補0件などの診断になり、テストのタイムアウトとしては現れません。

Bunでは、qualityのテストファイルが別のテストファイルをimportすると、importされたファイルの`test()`もimportした側のテストとして実行され、読み込んだモジュールもimportした側の依存記録に入ります。assuranceのテストファイルをimportするqualityを選ぶと、そのassuranceのテストも`check:affected`で実行され、skipもimportした側の件数に入ります。記録の持ち主を決められなければ、`依存記録の持ち主を決められません`に続けて`Bun.main`の値とBunのバージョンを表示して失敗します。

Bunの依存記録は対象repoの`.feedback-loop-records/`に置き、Gitの変更に現れません。commit、Node.jsとBunのバージョン、`scripts/feedback-loop/`、`.feedback-loop.json`・`bunfig.toml`・`package.json`・lockfileのいずれかが変わるか、記録を消すと、次の`check:affected`は全qualityを実行します。Vitestはこの記録を使いません。

Bunの記録付きテストは、記録器のパスに空白があると停止します。`apply`の配置と分類は成功しても、この制約は残るため、導入先repoは空白を含まないパスで用意してください。

取消として受けるシグナルは、SIGINT・SIGTERM・SIGHUPです。実行部は、受けたシグナルを子のコマンドのプロセスグループへ送って止め、非ゼロ終了します。SIGHUPは、SIGTERMとして送ります。テストのコードが`detached`などで別のプロセスグループに起動したプロセスには、このシグナルは届きません。取消の後も、そのプロセスは残ります。取消の診断は、実行部が受けたシグナルを示します。端末を閉じたときと、`nohup`で起動したときに届くSIGHUPも取消になります。ログアウトの後も続けるには、`setsid`やtmuxで端末から切り離して起動します。

`bun run check:affected`の外側のプロセスだけをSIGKILLすると、`runtime.mjs`本体とその子孫が残ることがあります。その場合は、残った`runtime.mjs`とテストのプロセスを終了させてから、次の実行に進みます。

### 導入したブランチでの関連選択の確認

導入したブランチでは、比較元からの変更に`package.json`・`.feedback-loop.json`・`scripts/feedback-loop/`が含まれます。そのため、導入の変更を比較元へ取り込むまで、`check:affected`は毎回全qualityを実行します。関連するqualityだけが選ばれることは、次の手順で確かめます。

1. 導入の変更を比較元へ取り込む。取り込む前に確かめるときは、導入の変更をcommitし、以降の実行に`--base HEAD`を付ける。commitしていない変更だけが比較の対象になる。
2. qualityのテストが読み込み、`globalChanges`に当たらないソースを1つ、テストが通る範囲で変える。
3. `check:affected`を実行する。`quality全件の理由: `が出ずに、関連するqualityだけが選ばれれば、確認は済む。
4. Bunで全件になったら、commitやbranchを切り替えずに、作業ツリーの同じ変更のまま再実行する。commitの直後の最初の実行は、依存記録を採用せず全qualityを実行するためである。
5. Bunで最初の実行が失敗したら、直してから3からやり直す。失敗した実行は、落ちたテストファイルの依存記録に、その実行で読んだモジュールを足して残す。前の記録が無いテストファイルは、記録を消す。通ったテストファイルと実行しなかったテストファイルの記録も残す。そのため、やり直しの実行は、変更が届くテストファイルと、記録の無いテストファイルを選ぶ。取消の実行と、Bunの終了コードがJUnitの結果と食い違う実行は、すべての記録を消す。

比較元の参照（リモート追跡ブランチなど）を書き換えて確かめることはしません。

### 変更したファイルをコマンドへ渡す

実行部の`changed`は、変更したファイルをコマンドの引数の後に足して実行します。lintやformatterを変更したファイルだけへ実行するために、導入先のpackage scriptから呼びます。`apply`はこのscriptを接続しません。

```bash
node scripts/feedback-loop/runtime.mjs changed --ext .ts,.tsx -- eslint --max-warnings 0
```

実行系は`check:affected`の値と同じにします。Vitestのrepoは`node`、Bunテストのrepoは`bun`です。`--`の前が`changed`への指定、後が実行するコマンドです。

| 項目 | 扱い |
| --- | --- |
| 集める変更 | `check:affected`と同じ規則で決めた比較元との分岐点からの、`--repo`のディレクトリの中の変更。commit・staged・unstaged・未追跡を含む。削除したファイルと改名前のパスは渡さない。壊れたsymlink、ディレクトリへのsymlink、入れ子のrepoのように、ファイルでないパスも渡さない |
| 渡すパス | `--repo`のディレクトリからの相対パスを、名前の順で渡す。改名したファイルは改名後のパスを渡す。空白や非ASCII文字を含むパスも、シェルを通さず1つの引数として渡す。`-`で始まるパスは、コマンドがオプションとして読まないよう`./`を付ける |
| `--ext` | 対象の拡張子をカンマ区切りで指定する。`--ext=.ts,.tsx`の形でも受け取る。先頭の`.`は省ける。複数書けば、すべての拡張子を対象にする。指定しなければ、変更したファイルをすべて渡す |
| `--base` | `--base <参照>`を付けた実行だけ、`.feedback-loop.json`の`base`と既定の規則より優先して、指定した参照を比較元にする。`--base=<参照>`の形でも受け取る。複数書けば、最後の指定を使う。`--ext`と同時に指定できる。出力に`比較元: <参照>（実行時の指定）`を表示する。`--`の前に書く。`--`の後に書いた`--base`は、実行するコマンドの引数になる |
| `--base`の参照をGitのcommitとして読めない | コマンドを実行する前に、`--baseに指定した参照をGitのcommitとして読めません: `に続けて参照を表示して非ゼロ終了する |
| `--base`の参照とHEADに分岐点がない。浅いcloneや、履歴を共有しないbranchがこれに当たる | コマンドを実行する前に、`--baseに指定した参照とHEADの分岐点を求められません: `に続けて参照を表示して非ゼロ終了する |
| `--base`に参照がない。値が空の`--base=`、後に何も続かない`--base`、次が`-`で始まる`--base`がこれに当たる | `--baseには参照を指定してください: `に続けて指定を表示して非ゼロ終了する |
| `--ext`の値が拡張子でない。空、globの記号、空白がこれに当たる | `--extには拡張子をカンマ区切りで指定してください: `に続けて値を表示して非ゼロ終了する。どのパスにも当たらない指定を、対象0件の成功にしないためである |
| 対象が多い | パスの長さの合計が約100KBを超えるごとに、コマンドを分けて実行する。OSが1回のコマンドに渡せる引数の長さを制限するためである。失敗した回で止まる |
| 実行の表示 | `実行: `の行には、回ごとに先頭の20件と、残りの件数を表示する |
| `FEEDBACK_LOOP_BASE` | `check:affected`と同じ[環境変数](#導入後の呼出しと結果)を読む。`check:affected`と`changed`を1つのscriptから呼ぶときは、scriptの前に付けると両方が同じ比較元になる。`--`の前の`--base`があれば、`--base`を使う |
| 対象が0件 | コマンドを実行せず、`変更したファイルがありません。コマンドを実行しません: `に続けてコマンドを表示して終了0にする。その前に、`比較元: <参照>（<出どころ>）`を、指定がなくても表示する。出どころは、`.feedback-loop.jsonのbase`か`既定の比較元`である。scriptの名前の後に足した`--base`は実行するコマンドへ渡るので、比較元にならなかったことを、この行で確かめられる |
| コマンドの非ゼロ終了 | `検査失敗または取消: `に続けてコマンドの終了コードを表示し、非ゼロ終了する |
| 再実行の案内 | package managerが起動したscriptの本文が`changed`を呼んでいれば、そのscriptの名前を案内する。それ以外は、起動したコマンドをそのまま案内する。scriptから起動したシェルで直接呼んだ場合も、こちらになる。この場合、コマンドは`node_modules/.bin`を探さない。scriptの本文に書いた`--base`はscriptの名前の案内で、直接の起動に付けた`--base`は起動したコマンドの案内で、同じ比較元になる。scriptの名前の案内は、scriptの名前の後に足した引数を含まない |
| `--`かコマンドがない | `changedは「changed [--ext <拡張子>] [--base <参照>] -- <コマンド>」の形で呼びます`を表示して非ゼロ終了する |
| `--ext <拡張子>`と`--base <参照>`以外の指定。値のない`--ext`もこれに当たる | `changedの指定は--ext <拡張子>と--base <参照>だけです: `に続けて指定を表示して非ゼロ終了する |

導入したブランチで、対象が0件のときにコマンドを実行しないことを確かめるには、[関連選択の確認](#導入したブランチでの関連選択の確認)と同じく導入の変更をcommitし、scriptに書いた`changed`の呼出しの`--`の前に`--base HEAD`を足して直接実行します。対象が0件ならコマンドを起動しないため、`node_modules/.bin`にあるコマンドの名前のままで確かめられます。

```bash
node scripts/feedback-loop/runtime.mjs changed --base HEAD --ext .ts,.tsx -- eslint --max-warnings 0
```

変更したファイルは、lintの無視の設定に当たるものも渡します。ESLintは、明示して渡した無視の対象に警告を出し、`--max-warnings 0`と併用すると非ゼロ終了します。flat configでは、`--no-warn-ignored`を付けると、この警告を出しません（[ESLintの`--no-warn-ignored`](https://eslint.org/docs/latest/use/command-line-interface#--no-warn-ignored)）。eslintrc形式のESLint 8は、このオプションを受け付けません。

## 旧版からの移行

### バージョンの行がない生成物

リリース済みの0.4.2までの生成物には、バージョンの行がありません。`apply --update`は、その生成物を同梱版と同じか古いものとして扱います。

バージョンを比べるのは、バージョンの行を書くようになった後のプラグインだけです。リリース済みの0.4.2までのプラグインで`apply --update`を実行すると、新しいバージョンの生成物を置き換えます。

### `test:affected`から`check:affected`へ

0.2.1までの導入は、`check:affected`を`test:affected`の名前で接続しています。`test:affected`のままでも実行でき、`check:affected`がなければ診断もその名前の再実行を案内します。ただし、`test:*`の一括実行には混ざったままです。名前を移す場合は、`apply --update`が表示する差分に従って、次の順で`package.json`を直します。

1. `test:affected`の値を、`check:affected`の名前へ移す。環境変数を読み込むコマンドで包んだ値は、そのまま移す。
2. `test:affected`を消す。`pretest:affected`・`posttest:affected`があれば、`precheck:affected`・`postcheck:affected`へ名前を変える。
3. `test:affected`を呼ぶほかのscriptと、全体check、CIの中の呼出しを`check:affected`へ変える。`package.json`のscriptは差分に出る。`test:*`のようなglobで呼んでいる箇所は差分に出ない。
4. `test:*`の一括実行をやめて明示集合へ変えていた場合は、一括実行へ戻せる。
5. `check:*`を一括実行している場合は、`check:affected`を除く明示集合へ接続し直す。

`test:affected`が生成するコマンドを含まない場合は、導入先が独自に定義したscriptとして扱い、差分に出しません。`test:affected`を消した後に呼出しが残っている場合と、`apply`を実行した場合も、残る名前と呼出しを差分に示します。包んだ値がそのまま移す先に出るのは、生成するコマンドを途切れなく含む値だけです。実行系と`scripts/feedback-loop/runtime.mjs`のあいだに引数を足した値は、消す側の差分で確かめて手で移します。
