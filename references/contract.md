# setup-feedback-loopのCLIと設定

導入担当が使うCLIの呼び方、設定項目、出力と失敗条件を説明します。

以下のコマンドは、スキルに同梱した`${CLAUDE_SKILL_DIR}/scripts/setup.mjs`をBun 1.4.4で呼びます。`${CLAUDE_SKILL_DIR}`はSKILL.mdのあるディレクトリの絶対パスです。展開されない環境では、そのパスへ書き換えて実行します。`--repo`は対象Git checkoutの絶対パスです。CLIはこのrepoのcheckout・git履歴・node_modulesを参照しません。別の版のBunやNode.jsで起動すると、版の不一致を示して非ゼロ終了します。対象repoの日常実行に、スキルのパスやBunの追加導入を要求しません。

## 構成の調査

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs inspect --repo /absolute/project
```

ファイルや依存を変更せず、package manager、runtimeの指定、package scripts、既存のlint・formatter・型検査・fallow・test runner、CI定義の所在をJSONで標準出力へ返します。未導入・不明な項目を区別し、不明なツールを採用済みと推測しません。取得不能や不正なpackage設定は非ゼロ終了と診断で返します。JSONには`packageManager`、`base`、`scripts`、`devDependencies`、`configFiles`を含みます。

```json
{"packageManager":"bun","base":"origin/main","scripts":{"check":"bun run scripts/check.ts"},"devDependencies":{},"configFiles":["mise.toml"]}
```

`packageManager`は`"bun"`・`"npm"`・`null`のいずれかです。競合する指定や判定材料不足は`null`と診断で示し、install・applyは選択不能として止めます。`base`は比較元の候補です。`origin/HEAD`が指す先を優先し、なければ`origin/main`と`origin/master`、次に`main`と`master`のうち、1つだけあるものを返します。どちらも見つからないか、同じ段階で両方あれば`null`と診断を返します。`scripts`と`devDependencies`は名前と文字列値のオブジェクトで、未定義なら空オブジェクトです。`configFiles`は実在するrepo相対パスの文字列配列で、該当なしなら空配列です。

## 不足依存のインストール

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs install --repo /absolute/project --package oxlint@<版> --package oxfmt@<版> --package fallow@<版>
```

`<版>`には、[ツール選定](tools.md)の手順で選んだ完全な版を指定します。自動導入の対象は`oxlint`・`oxfmt`・`fallow`とし、既存ツールのプラグインや型検査の追加は、スキルから対象repoの通常の依存管理で行います。

導入済みの同じ固定版は変更せず、不足分を対象package managerでdevDependenciesとlockfileへ追加します。既存と異なる版、範囲指定、`latest`等は自動で置換しません。無条件の依存更新やpackage managerの変更は行いません。パッケージ取得やlockfile更新の失敗は非ゼロ終了とし、成功した範囲と未完了箇所を表示します。失敗時にローカル差分を一括で巻き戻しません。

## 導入設定

導入担当は内容を確認した`.feedback-loop.json`を対象repoに用意します。この設定は分類と関連選択だけを扱います。静的検査の順序はpackage scripts、ツールごとの規則は既存の専用設定に置きます。必須項目は`runner`・`base`・`collect`・`testGlobs`です。ここで説明する項目以外のキーは拒否します。

```json
{
  "runner": "bun",
  "base": "origin/main",
  "collect": ["bun", "--no-env-file", "scripts/list-tests.ts", "./test"],
  "testGlobs": ["test/**/*.test.ts"],
  "prepare": ["bun", "run", "prepare:tests"],
  "bunArgs": ["--no-env-file"],
  "testArgs": ["--timeout", "15000"],
  "globalChanges": ["config/**", "scripts/**"]
}
```

`testGlobs`は通常checkの収集集合です。パスはrepo相対とし、`*`はその階層、`**`は下位階層にも対応するglobです。既存のfixture等を通常checkへ追加する指定にはしません。qualityは収集集合からassuranceを除いた集合です。`assurance`は省略時に空配列となり、収集集合の全件がqualityになります。assuranceの各要素は`{"path":"test/example.test.ts","reason":"内容を確認した指定理由"}`の形とし、実在するテストファイルを指定します。重複や集合外の指定、空の理由を拒否します。新規テストはglobに合えばqualityへ入ります。

`base`は関連選択の比較元にするGitの参照です。`inspect`の`base`を候補にし、対象repoの既定ブランチと照合して指定します。上例の`origin/main`は、既定ブランチが`main`のrepoの値です。

`collect`は、通常checkと同じ収集処理からテスト一覧を得るargv配列です。対象repoのcwdで実行し、標準出力へrepo相対パスのJSON文字列配列を返し、診断は標準エラーへ出します。Bunでは[Bunのテスト一覧](collect.md)、Vitestでは[収集用コマンド](runners.md#vitestの収集用コマンド)に従って用意します。収集の失敗、不正な出力、重複、存在しないパス、`testGlobs`との集合の差は非ゼロ終了とします。

`runner`は`bun`または`vitest`です。Bunは固定した実行系と`bunArgs`を使い、テストオプションには`testArgs`を渡します。Vitestは対象repoのローカル依存を使い、既存の設定・global setup・環境変数を引き継ぎます。Vitestでは`bunArgs`を指定しません。`prepare`はテスト前に必要な既存コマンドのargv配列で、省略時は空配列です。例の`prepare:tests`は、対象repoで必要な準備コマンドに置き換えます。

`bunArgs`と`testArgs`は省略時に空配列です。`bunArgs`に`--no-env-file`がある場合は、生成する`test:affected`と`check:classification`のpackage scriptsにもこの引数を維持します。テスト本体だけでなく、補助ファイルを起動する外側のBunも`.env`を先に読み込まないようにします。

`allowSkipped`は任意のbooleanで、省略時は`true`です。対象repoの既存checkがskip・todoを許容する場合は`true`、許容しない場合は`false`を指定します。boolean以外は入力不正として拒否します。この設定はBunとVitestの両runnerへ適用します。

`bunWorkers`はBunの並列worker数で、省略時は4です。正の安全な整数を指定し、1なら直列に実行します。Vitestではこのキーを指定しません。`bunArgs`・`testArgs`には`--isolate`・`--no-isolate`・`--parallel`・`--no-parallel`を指定せず、並列数はこのキーで指定します。

`globalChanges`はquality全件へ広げる入力のglob配列、`dependencies`は入力とテストの対応を指定する配列で、どちらも省略時は空配列です。`dependencies`の各要素は`{"inputs":["data/*.json"],"tests":["test/example.test.ts"]}`の形で、どちらの配列も空にできません。`tests`には収集集合内のテストを指定します。補う範囲の判断は[関連選択の補い方](runners.md#関連選択を補う)に従います。

## ファイルの配置と接続

```sh
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs apply --repo /absolute/project --feedback-command 'bun run lint:feedback && bun run format:feedback && bun run check:unused && bun run test:affected'
```

`apply`は`.feedback-loop.json`を読み、対象repoで実行できる補助ファイルを`scripts/feedback-loop/`へ配置します。Bunのrunnerでは、スキルに同梱した記録器も配置します。

`package.json`へ`test:affected`、`check:classification`、`check:feedback`を接続します。標準出力のJSONの`scripts`は接続したコマンドです。`check:feedback`の値は`--feedback-command`で指定した診断用コマンドです。自動修正用の`format`・`lint:fix`は別の明示操作として用意します。全体checkとCIは導入担当が既存構成へ接続し、このコマンドが任意のCI定義を推測で書き換えることはしません。

`apply`は`AGENTS.md`がなければ「変更後の確認」の節だけのファイルを作り、あれば末尾へ節を足します。同じ見出しがあれば、内容を変えずに保持したことを表示します。節の`check:feedback`の呼出しは対象package managerに合わせます。

節に記載する全体checkは`--check-command '<全体checkのコマンド>'`で指定します。省略時は、対象`package.json`に`check` scriptがあれば`<package manager> run check`を使います。なければ、どのファイルも変更せず、`--check-command`での指定を求めて非ゼロ終了します。

`CLAUDE.md`があり、`@AGENTS.md`の行がなければ先頭へ足します。行があれば変更しません。`CLAUDE.md`がなければ作りません。共有しない`CLAUDE.local.md`だけがあれば変更せず、利用者に`@AGENTS.md`の追加を伝える案内を表示します。導入担当は既存の検証指示と統合し、`CLAUDE.md`にある検証指示を`AGENTS.md`へ移します。[エージェントへの指示](agents-md.md)で確認します。

`test:affected`は、`check:classification`と同じ収集と分類の構造を検査してからテストを実行します。

テストの前提になる準備（codegen・依存の照合・型検査など）は`prepare`に置き、それ以外の静的検査は`check:feedback`に置きます。同じ段を両方に置きません。

Bun内蔵の型検査を採用する場合は、[接続の要点](typecheck.md)に従います。

導入済みの生成物の更新は`apply --update`で明示します。`--feedback-command`・`--check-command`とは併用しません。`AGENTS.md`・`CLAUDE.md`は変更しません。

```bash
bun ${CLAUDE_SKILL_DIR}/scripts/setup.mjs apply --update --repo /absolute/project
```

同梱版と同じ生成物は変更せず、存在しない生成物は配置します。異なる生成物はgitの状態で判定します。未コミットの変更または未追跡のファイルがあれば、どのファイルも変更せず、対象のパスと、コミットするか変更を戻してから再実行する案内を表示して非ゼロ終了します。コミット済みの生成物は手編集を含めて置き換えます。差分はgitで確認し、戻せます。

`package.json`は変更せず、接続先との差分を表示します。差分の採用は導入担当が判断します。同梱版から外れた生成物は消しません。`runner`をBunから変えた場合の`record-modules.ts`がこれに当たります。

初回導入時から、書き換える既存ファイルの内容と差分を確認できるようにします。同じ設定・同じ生成元で再実行した場合は内容を変えません。既存の同名コマンドや生成物が指定内容と食い違う場合は、上書き前に対象と理由を示して非ゼロ終了します。無関係なローカル変更は保持します。入力不正と既知の衝突はファイルの配置前に検出します。OS・インストール障害を含む操作全体の原子性は要求せず、途中失敗した内容を明示します。

## 導入後の呼出しと結果

```sh
bun run check:classification
bun run test:affected
bun run check:feedback
bun run check
```

npmプロジェクトでは同じscript名を`npm run`で呼びます。`check:classification`は、`collect`と`testGlobs`の集合の一致、assuranceの重複・集合外・存在しない指定・空の理由を機械検査します。`prepare`は実行しません。

標準出力のJSONには`all`・`quality`・`assurance`のパス配列を出します。`check:classification`は引数を取りません。引数があれば診断を表示して非ゼロ終了します。

`test:affected`はGitの変更と設定された関連選択からqualityを実行します。候補数・選択数・全件へ広げた理由を表示します。比較元が取得できない等の選択不能を、実行成功へ読み替えません。担当AIは変更したassuranceや影響先が明らかなassuranceを直接実行し、影響を判断できなければ全体checkへ広げます。部分実行の成功は全体checkの成功ではありません。

`test:affected`の`prepare`が失敗すると、診断を表示して非ゼロ終了し、テスト本体へ進みません。`package.json`、使用するlockfile、`tsconfig.json`、分類設定、関連選択器自体の変更では全qualityへ広げます。各変更の影響先を確認できない場合や、実行時の依存記録を信頼できない場合も全qualityへ広げ、理由を表示します。

実行したテストが成功し、対象repoのskip等の扱いを満たした場合だけ終了0にします。`allowSkipped: true`でも、選択したテストがすべてskip・todo等で実行されなければ、未実行として診断を示し非ゼロ終了します。`false`では一部でもskip・todoがあれば非ゼロ終了します。変更なし、候補0件、選択不能、起動・解析・実行の失敗、取消も非ゼロとし、診断で区別します。

Bunの記録付きテストは、記録器のパスに空白があると停止します。`apply`の配置と分類は成功しても、この制約は残るため、導入先repoは空白を含まないパスで用意してください。
