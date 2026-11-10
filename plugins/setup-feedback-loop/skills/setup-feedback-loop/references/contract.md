<!-- 生成元: references/contract.md。直接編集せず、正本を変更して再生成してください -->

# setup-feedback-loopのCLIと設定

以下のコマンドは、スキルに同梱した`${CLAUDE_SKILL_DIR}/scripts/setup.mjs`をBun 1.4.4以上で呼びます。`${CLAUDE_SKILL_DIR}`はSKILL.mdのあるディレクトリの絶対パスです。展開されない環境では、そのパスへ書き換えて実行します。`--repo`は、対象の`package.json`があるディレクトリの絶対パスです。Git checkoutの中にあれば、[Gitのルートでなくても指定できます](#gitのルートより下のpackage)。1.4.4より古いBunやNode.jsで起動すると、必要な版と現在の版を示して非ゼロ終了します。対象repoの日常実行に、スキルのパスやBunの追加導入を要求しません。

各操作で使えない引数を指定すると、診断を表示して非ゼロ終了し、対象repoのファイルを変更しません。

## 構成の調査

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs inspect --repo /absolute/project
```

ファイルや依存を変更せず、package manager、runtimeの指定、package scripts、既存のlint・formatter・型検査・fallow・test runner、CI定義の所在をJSONで標準出力へ返します。取得不能や不正なpackage設定は非ゼロ終了と診断で返します。

```json
{"packageManager":"bun","base":"origin/main","scripts":{"check":"bun run scripts/check.ts"},"devDependencies":{},"configFiles":["mise.toml"]}
```

`packageManager`は`"bun"`・`"npm"`・`"pnpm"`・`null`のいずれかです。競合する指定や判定材料不足は`null`と診断で示し、install・applyは選択不能として止めます。`base`は比較元の候補です。`origin/HEAD`が指す先を優先し、なければ`origin/main`と`origin/master`、次に`main`と`master`のうち、1つだけあるものを返します。どちらも見つからないか、同じ段階で両方あれば`null`と診断を返します。`scripts`・`devDependencies`・`dependencies`は名前と文字列値のオブジェクトで、未定義なら空オブジェクトです。`configFiles`は実在するファイルの、`--repo`からの相対パスの文字列配列で、該当なしなら空配列です。`runtime`は`engines`、なければ`packageManager`の値で、どちらもなければ`null`です。`tools`は依存のうち、lint・formatter・型検査・参照解析・テストの既知のパッケージ名です。`diagnostics`は`packageManager`・`base`を決められない理由の文字列配列です。

## 不足依存のインストール

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs install --repo /absolute/project --package oxlint@<版> --package oxfmt@<版> --package fallow@<版>
```

`<版>`には、[ツール選定](tools.md)の手順で選んだ完全な版を指定します。自動導入の対象は`oxlint`・`oxfmt`・`fallow`とし、既存ツールのプラグインや型検査の追加は、スキルから対象repoの通常の依存管理で行います。

導入済みの同じ固定版は変更せず、不足分を対象package managerでdevDependenciesとlockfileへ追加します。既存と異なる版、範囲指定、`latest`等は自動で置換しません。無条件の依存更新やpackage managerの変更は行いません。パッケージ取得やlockfile更新の失敗は非ゼロ終了とし、成功した範囲と未完了箇所を表示します。失敗時にローカル差分を一括で巻き戻しません。

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

`testGlobs`は通常checkの収集集合です。パスはrepo相対とし、`*`はその階層、`**`は下位階層にも対応するglobです。既存のfixture等を通常checkへ追加する指定にはしません。qualityは収集集合からassuranceを除いた集合です。`assurance`は省略時に空配列となり、収集集合の全件がqualityになります。assuranceの各要素は`{"path":"test/example.test.ts","reason":"内容を確認した指定理由"}`の形とし、実在するテストファイルを指定します。重複や集合外の指定、空の理由を拒否します。新規テストはglobに合えばqualityへ入ります。

`base`は関連選択の比較元にするGitの参照です。省略すると、実行のたびに`inspect`と同じ規則で決めます。既定ブランチ以外へ取り込むrepoでは指定します。規則で決まらなければ、テストへ進まず、`.feedback-loop.json`への`base`の指定を求めて非ゼロ終了します。

Bunでは`collect`を省略すると、CLIが同じプロセス内でテストを一覧します。探索場所は`testGlobs`の各globの最初の`*`・`?`より前にあるディレクトリとし、重なる場所はまとめます。たとえば`test/*.test.ts`は`test`、`scripts/tests/**/*.test.ts`は`scripts/tests`、`**/*.test.ts`はrepo全体を探索します。`.test`・`_test`・`.spec`・`_spec`に拡張子`js`・`jsx`・`ts`・`tsx`・`mjs`・`cjs`・`mts`・`cts`が続くファイルをrepo相対パスで並べ、`node_modules`と`.`で始まるディレクトリは除きます。探索場所のディレクトリがなければ、その場所を示して非ゼロ終了します。内蔵の一覧で検出できるのは、この探索場所の中での名前の規則と`testGlobs`の食い違いです。

独自の収集処理があるrepoでは、`"collect": ["bun", "scripts/custom-collect.ts"]`のようにコマンドのargv配列を指定します。対象repoのcwdで実行し、標準出力へrepo相対パスのJSON文字列配列を返し、診断は標準エラーへ出します。Vitestでは[収集用コマンド](runners.md#vitestの収集用コマンド)を必ず指定します。収集の失敗、不正な出力、重複、存在しないパス、`testGlobs`との集合の差は非ゼロ終了とします。

導入時は、通常checkが実行する`bun test`のargvを導入担当AIがコードから確認し、次の操作で分類の`all`と実行されたファイルを照合します。

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs compare-tests --repo /absolute/project -- bun test ./test
```

CLIがJUnitの出力引数を足して実行し、`{"missing":[],"extra":[]}`なら終了0、差があれば終了1を返します。`missing`は一覧にある未実行のファイル、`extra`は一覧にない実行済みのファイルです。テストが失敗してもJUnitがあれば照合し、一時ファイルは操作後に削除します。`test()`を1件も持たないファイルはJUnitに出ず`missing`に出るため、本文を読んで判断します。

`runner`は`bun`または`vitest`です。Bunは固定した実行系と`bunArgs`を使い、テストオプションには`testArgs`を渡します。Vitestは対象repoのローカル依存を使い、既存の設定・global setup・環境変数を引き継ぎます。Vitestでは`bunArgs`を指定しません。`prepare`はテスト前に必要な既存コマンドのargv配列で、省略時は空配列です。例の`prepare:tests`は、対象repoで必要な準備コマンドに置き換えます。

`bunArgs`と`testArgs`は省略時に空配列です。`bunArgs`に`--no-env-file`がある場合は、生成する`test:affected`と`check:classification`のpackage scriptsにもこの引数を維持します。テスト本体だけでなく、補助ファイルを起動する外側のBunも`.env`を先に読み込まないようにします。

`allowSkipped`は任意のbooleanで、省略時は`true`です。対象repoの既存checkがskip・todoを許容する場合は`true`、許容しない場合は`false`を指定します。boolean以外は入力不正として拒否します。この設定はBunとVitestの両runnerへ適用します。

`bunWorkers`はBunの並列worker数で、省略時は4です。正の安全な整数を指定し、1なら直列に実行します。Vitestではこのキーを指定しません。`bunArgs`・`testArgs`には`--isolate`・`--no-isolate`・`--parallel`・`--no-parallel`を指定しません。

`globalChanges`はquality全件へ広げる入力のglob配列、`dependencies`は入力とテストの対応を指定する配列で、どちらも省略時は空配列です。`dependencies`の各要素は`{"inputs":["data/*.json"],"tests":["test/example.test.ts"]}`の形で、どちらの配列も空にできません。`tests`には収集集合内のテストを指定します。補う範囲の判断は[関連選択の補い方](runners.md#関連選択を補う)に従います。

`ignoredChanges`は、テストに影響しない入力のglob配列で、省略時は空配列です。たとえば`["docs/**", "*.md"]`です。どのテストにも届かない変更は全qualityへ広げますが、このglobに当たる変更は広げる理由にしません。効くのは、`globalChanges`にも`dependencies`にも当たらず、依存関係でもテストに届かない変更だけです。届く変更は、globに当たっても選択に使います。globに当たる変更だけの場合は、テストを実行せず、`変更なし: ignoredChangesに当たる変更だけのため、テストを実行しません`を表示して非ゼロ終了します。この設定はBunとVitestの両runnerへ適用します。

## ファイルの配置と接続

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs apply --repo /absolute/project --feedback-command 'bun run lint:feedback && bun run format:feedback && bun run check:unused && bun run test:affected'
```

`apply`は`.feedback-loop.json`を読み、対象repoで実行できる補助ファイルを`scripts/feedback-loop/`へ配置します。Bunのrunnerでは、スキルに同梱した記録器も配置します。

`package.json`へ`test:affected`、`check:classification`、`check:feedback`を接続します。標準出力のJSONの`scripts`は接続したコマンドです。`check:feedback`の値は`--feedback-command`で指定した診断用コマンドです。自動修正用の`format`・`lint:fix`は別の明示操作として用意します。全体checkとCIは導入担当が既存構成へ接続し、このコマンドが任意のCI定義を推測で書き換えることはしません。

テストが環境変数を必要とするrepoでは、`apply`の前に`test:affected`と`check:classification`を、環境変数を読み込むコマンドで包んで`package.json`へ書きます。たとえば`dotenv -e .env.sample -- node scripts/feedback-loop/runtime.mjs affected`です。既存のscriptが生成するコマンドを含んでいれば、`apply`は衝突とせずに保持し、`apply --update`も差分として表示しません。`check:feedback`だけを包むと、診断が案内する`test:affected`の再実行が、環境変数のないまま動いて失敗します。

`apply`は`AGENTS.md`がなければ「変更後の確認」の節だけのファイルを作り、あれば末尾へ節を足します。同じ見出しがあれば、内容を変えずに保持したことを表示します。節の`check:feedback`の呼出しは対象package managerに合わせます。

節に記載する全体checkは`--check-command '<全体checkのコマンド>'`で指定します。省略時は、対象`package.json`に`check` scriptがあれば`<package manager> run check`を使います。なければ、どのファイルも変更せず、`--check-command`での指定を求めて非ゼロ終了します。

`CLAUDE.md`があり、`@AGENTS.md`の行がなければ先頭へ足します。行があれば変更しません。`CLAUDE.md`がなければ作りません。共有しない`CLAUDE.local.md`だけがあれば変更せず、利用者に`@AGENTS.md`の追加を伝える案内を表示します。既存の検証指示との統合は[エージェントへの指示](agents.md)に従います。

テストの前提になる準備（codegen・依存の照合・型検査など）は`prepare`に置き、それ以外の静的検査は`check:feedback`に置きます。同じ段を両方に置きません。

導入済みの生成物の更新は`apply --update`で明示します。`AGENTS.md`・`CLAUDE.md`は変更しません。

```bash
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs apply --update --repo /absolute/project
```

同梱版と同じ生成物は変更せず、存在しない生成物は配置します。異なる生成物はgitの状態で判定します。未コミットの変更または未追跡のファイルがあれば、どのファイルも変更せず、対象のパスと、コミットするか変更を戻してから再実行する案内を表示して非ゼロ終了します。コミット済みの生成物は手編集を含めて置き換えます。差分はgitで確認し、戻せます。

`package.json`は変更せず、接続先との差分を表示します。差分の採用は導入担当が判断します。同梱版から外れた生成物は消しません。`runner`をBunから変えた場合の`record-modules.ts`がこれに当たります。

同じ設定・同じ生成元で再実行した場合は内容を変えません。既存の同名コマンドや生成物が指定内容と食い違う場合は、上書き前に対象と理由を示して非ゼロ終了します。無関係なローカル変更は保持します。入力不正と既知の衝突はファイルの配置前に検出します。OS・インストール障害を含む操作全体の原子性は要求せず、途中失敗した内容を明示します。

## Gitのルートより下のpackage

`package.json`がGitのルートより下にあるrepoでは、`--repo`にそのディレクトリを指定します。Git checkoutの外のディレクトリと、`package.json`のないディレクトリは、変更前に診断を表示して非ゼロ終了します。

| 対象 | 扱い |
| --- | --- |
| `.feedback-loop.json`・`scripts/feedback-loop/`・package scripts・`.feedback-loop-records/` | `--repo`のディレクトリに置く。パスはそのディレクトリからの相対で書く |
| `inspect`の`configFiles` | `--repo`のディレクトリに加えて、Gitのルートの設定ファイルと`.github/workflows`を読む。Gitのルートの分は`../.github/workflows/ci.yml`のように`--repo`からの相対パスで返す |
| `AGENTS.md`・`CLAUDE.md` | Gitのルートのファイルを扱う。節のコマンドは`cd workspace && npm run check:feedback`の形になり、対象を「`workspace/`のコードやテスト」と書く |
| `--check-command` | 指定した文字列をそのまま節へ書く。ディレクトリの移動が必要なら、指定に含める |
| package managerの判定とlockfile | `--repo`のディレクトリにあるファイルだけを見る。Gitのルートにlockfileを置くworkspace構成は扱わない |
| 関連選択の変更 | `--repo`のディレクトリの中の変更を数える。外の変更は、全qualityへ広げる理由にしない。他のpackageの変更が大半のためで、中の届かない変更を広げない場合は`ignoredChanges`で宣言する |
| 外にある追跡済みファイルの変更（Vitest） | importでつながるqualityだけを選ぶ。どのテストにも届かず、中の変更もなければ、変更なしとして非ゼロ終了する。削除したファイルも、importしているテストを選ぶ。未追跡のファイルは対象にしない |
| 外にあるファイルの変更（Bun） | 中の変更がなければ、変更なしとして非ゼロ終了する。中の変更があり、外のファイルが依存記録に載っていれば、全qualityを実行する |

1つのrepoに複数のpackageがある場合は、packageごとに`apply`を実行します。2つ目以降は`AGENTS.md`に同じ見出しがあるため節を足しません。導入担当が節を統合します。

## 導入後の呼出しと結果

```sh
bun run check:classification
bun run test:affected
bun run check:feedback
bun run check
```

npmプロジェクトでは同じscript名を`npm run`で、pnpmプロジェクトでは`pnpm run`で呼びます。`check:classification`は、一覧と`testGlobs`の集合の一致、assuranceの重複・集合外・存在しない指定・空の理由を機械検査します。`prepare`は実行しません。

標準出力のJSONには`all`・`quality`・`assurance`のパス配列を出します。`check:classification`は引数を取りません。引数があれば診断を表示して非ゼロ終了します。

`test:affected`は、`check:classification`と同じ収集と分類の構造を検査してから、Gitの変更と設定された関連選択からqualityを実行します。候補数・選択数・全件へ広げた理由を表示します。比較元が取得できない等の選択不能を、実行成功へ読み替えません。部分実行の成功は全体checkの成功ではありません。

`test:affected`の`prepare`が失敗すると、診断を表示して非ゼロ終了し、テスト本体へ進みません。`package.json`、使用するlockfile、`tsconfig.json`、分類設定、関連選択器自体の変更では全qualityへ広げます。各変更の影響先を確認できない場合や、実行時の依存記録を信頼できない場合も全qualityへ広げ、理由を表示します。

実行したテストが成功し、対象repoのskip等の扱いを満たした場合だけ終了0にします。`allowSkipped: true`でも、選択したテストがすべてskip・todo等で実行されなければ、未実行として診断を示し非ゼロ終了します。`false`では一部でもskip・todoがあれば非ゼロ終了します。変更なし、候補0件、選択不能、起動・解析・実行の失敗、取消も非ゼロとし、診断で区別します。

Bunの依存記録は対象repoの`.feedback-loop-records/`に保存します。このディレクトリはGitの変更に現れません。記録の基点には、現在のcommit、Node.jsとBunの版、`scripts/feedback-loop/`の実行部と記録器、`.feedback-loop.json`・`bunfig.toml`・`package.json`・`bun.lock`・`package-lock.json`・`pnpm-lock.yaml`が含まれます。いずれかが変わるか記録を消すと、次の`test:affected`は全qualityを実行します。Vitestはこの記録を使いません。

Bunの記録付きテストは、記録器のパスに空白があると停止します。`apply`の配置と分類は成功しても、この制約は残るため、導入先repoは空白を含まないパスで用意してください。

`bun run test:affected`の外側のプロセスだけをSIGKILLすると、`runtime.mjs`本体とその子孫が残る場合があります。取消の確認では、`runtime.mjs`本体への取消と強制終了を対象にします。外側だけを止めた場合は、残った`runtime.mjs`とテストのプロセスを探して終了させてから、次の実行に進みます。
